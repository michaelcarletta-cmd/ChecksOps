/**
 * Temporary in-VPC oneshot for Condition One Commercial partner-share repair.
 * Default step is read-only inspect. Restore requires step=restore AND confirm=RESTORE_MISSING_ACTIVE_SHARES.
 * Never mutates check_intake_items.tenant_id. Never calls Moov/CheckAlt/Cognito.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CA_PATH = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  '/var/task/rds-global-bundle.pem',
].find((p) => fs.existsSync(p));

const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_ADMIN = 'fd857564-9534-4b0f-95ac-624ed1273725';
const FREEDOM_TESTER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const adminClient = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops_admin/i.test(arn)) {
    throw new Error('ADMIN_SECRET_ARN must be the checksops_admin secret');
  }
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) {
    throw new Error('secret username is not checksops_admin');
  }
  const host = parsed.host && parsed.host !== 'localhost' && parsed.host !== '127.0.0.1'
    ? parsed.host
    : process.env.RDS_HOST;
  if (!host || host === 'localhost' || host === '127.0.0.1') {
    throw new Error('admin secret host is missing or loopback');
  }
  const database = process.env.DATABASE_NAME || 'checksops';
  if (database !== 'checksops') throw new Error(`refusing database name ${database}`);
  const client = new Client({
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
    database,
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000,
    query_timeout: 120000,
  });
  await client.connect();
  return client;
};

const asAppUser = async (client, appUserId, fn) => {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE checksops');
    await client.query('SET LOCAL row_security = on');
    await client.query("SELECT set_config('request.app_user_id', $1, true)", [appUserId]);
    const result = await fn();
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return { error: String(error?.message || error).slice(0, 240) };
  }
};

const inspect = async (client) => {
  const db = (await client.query('SELECT current_database() AS d, current_user AS u')).rows[0];
  if (db.d !== 'checksops') throw new Error(`connected to ${db.d}, expected checksops`);

  const shares = (await client.query(`
    SELECT id, check_id, source_tenant_id, target_tenant_id, created_at, revoked_at, shared_by
    FROM public.shared_checks
    WHERE target_tenant_id = $1::uuid
    ORDER BY created_at
  `, [C1C])).rows;

  const checkIds = [...new Set(shares.map((r) => r.check_id))];
  const parents = checkIds.length
    ? (await client.query(`
        SELECT id, tenant_id, status, check_stage::text AS check_stage
        FROM public.check_intake_items
        WHERE id = ANY($1::uuid[])
      `, [checkIds])).rows
    : [];
  const parentById = new Map(parents.map((r) => [r.id, r]));

  const ownedCounts = (await client.query(`
    SELECT
      count(*) FILTER (WHERE tenant_id = $1::uuid)::int AS freedom,
      count(*) FILTER (WHERE tenant_id = $2::uuid)::int AS c1c,
      count(*)::int AS total
    FROM public.check_intake_items
  `, [FREEDOM, C1C])).rows[0];

  const views = (await client.query(`
    SELECT
      to_regclass('public.aws_partner_check_payees') IS NOT NULL AS payees,
      to_regclass('public.aws_partner_check_endorsements') IS NOT NULL AS endorsements,
      to_regclass('public.tenants_public') IS NOT NULL AS tenants_public
  `)).rows[0];

  const totalsDef = (await client.query(`
    SELECT pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_check_stage_totals'
    LIMIT 1
  `)).rows[0]?.def || '';

  const partnership = (await client.query(`
    SELECT id, status, revoked_at IS NOT NULL AS revoked
    FROM public.tenant_partnerships
    WHERE (
      (inviter_tenant_id = $1::uuid AND invitee_tenant_id = $2::uuid)
      OR (inviter_tenant_id = $2::uuid AND invitee_tenant_id = $1::uuid)
    )
  `, [C1C, FREEDOM])).rows;

  const sampleShared = shares.find((r) => !r.revoked_at)?.check_id || null;
  const helperExists = (await client.query(`
    SELECT
      EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'aws_is_active_shared_check_target'
      ) AS target_proc,
      EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'aws_can_access_check'
      ) AS access_proc,
      EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'aws_can_access_tenant'
      ) AS tenant_proc,
      EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'user_belongs_to_tenant'
      ) AS lovable_belongs_proc
  `)).rows[0];
  const livePolicies = (await client.query(`
    SELECT tablename, policyname, cmd, qual
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('check_intake_items', 'shared_checks', 'check_payees', 'check_endorsements')
    ORDER BY tablename, policyname
  `)).rows;

  const c1cVisible = await asAppUser(client, C1C_ADMIN, async () => {
    const uid = await client.query('SELECT auth.uid()::text AS uid');
    const tenantsOfUser = await client.query('SELECT public.aws_user_tenant_ids()::text AS tenant_id');
    const intake = await client.query('SELECT count(*)::int AS n FROM public.check_intake_items');
    const owned = await client.query(
      'SELECT count(*)::int AS n FROM public.check_intake_items WHERE tenant_id = $1::uuid',
      [C1C],
    );
    const sharedParents = await client.query(
      'SELECT count(*)::int AS n FROM public.check_intake_items WHERE tenant_id = $1::uuid',
      [FREEDOM],
    );
    const shared = await client.query(`
      SELECT count(*)::int AS n
      FROM public.shared_checks
      WHERE target_tenant_id = $1::uuid AND revoked_at IS NULL
    `, [C1C]);
    let sampleIsActiveTarget = null;
    let sampleCanAccessCheck = null;
    if (sampleShared && helperExists.target_proc) {
      sampleIsActiveTarget = (await client.query(
        'SELECT public.aws_is_active_shared_check_target($1::uuid) AS ok',
        [sampleShared],
      )).rows[0]?.ok ?? null;
    }
    if (sampleShared && helperExists.access_proc) {
      sampleCanAccessCheck = (await client.query(
        'SELECT public.aws_can_access_check($1::uuid) AS ok',
        [sampleShared],
      )).rows[0]?.ok ?? null;
    }
    const payees = views.payees
      ? await client.query('SELECT count(*)::int AS n FROM public.aws_partner_check_payees')
      : { rows: [{ n: null }] };
    const endorsements = views.endorsements
      ? await client.query('SELECT count(*)::int AS n FROM public.aws_partner_check_endorsements')
      : { rows: [{ n: null }] };
    const tenants = views.tenants_public
      ? await client.query('SELECT count(*)::int AS n FROM public.tenants_public')
      : { rows: [{ n: null }] };
    const partnerTenants = await client.query(
      'SELECT count(*)::int AS n FROM public.tenants WHERE id = $1::uuid',
      [FREEDOM],
    );
    let stageTotals = null;
    try {
      const totals = await client.query(
        'SELECT stage, count::int AS count FROM public.get_check_stage_totals($1::uuid)',
        [C1C],
      );
      stageTotals = {
        rows: totals.rows,
        sum: totals.rows.reduce((n, r) => n + Number(r.count || 0), 0),
      };
    } catch (error) {
      stageTotals = { error: String(error.message || error).slice(0, 160) };
    }
    return {
      authUid: uid.rows[0]?.uid || null,
      tenantIds: tenantsOfUser.rows.map((r) => r.tenant_id),
      intakeVisible: Number(intake.rows[0].n),
      ownedVisible: Number(owned.rows[0].n),
      freedomOwnedVisible: Number(sharedParents.rows[0].n),
      sharedActiveVisible: Number(shared.rows[0].n),
      sampleIsActiveTarget,
      sampleCanAccessCheck,
      partnerPayeesVisible: payees.rows[0].n,
      partnerEndorsementsVisible: endorsements.rows[0].n,
      tenantsPublicVisible: tenants.rows[0].n,
      freedomTenantViaTenantsTable: Number(partnerTenants.rows[0].n),
      stageTotals,
    };
  });

  const freedomVisible = await asAppUser(client, FREEDOM_TESTER, async () => {
    const partners = await client.query(`
      SELECT invitee_tenant_id, inviter_tenant_id
      FROM public.tenant_partnerships
      WHERE status = 'active' AND revoked_at IS NULL
        AND (inviter_tenant_id = $1::uuid OR invitee_tenant_id = $1::uuid)
    `, [FREEDOM]);
    const c1cTenant = await client.query(
      'SELECT count(*)::int AS n FROM public.tenants WHERE id = $1::uuid',
      [C1C],
    );
    const c1cPublic = views.tenants_public
      ? await client.query('SELECT count(*)::int AS n FROM public.tenants_public WHERE id = $1::uuid', [C1C])
      : { rows: [{ n: null }] };
    const sharesOut = await client.query(`
      SELECT count(*)::int AS n
      FROM public.shared_checks
      WHERE source_tenant_id = $1::uuid AND target_tenant_id = $2::uuid AND revoked_at IS NULL
    `, [FREEDOM, C1C]);
    return {
      activePartnerships: partners.rows.length,
      c1cViaTenantsTable: Number(c1cTenant.rows[0].n),
      c1cViaTenantsPublic: c1cPublic.rows[0].n,
      activeSharesToC1c: Number(sharesOut.rows[0].n),
    };
  });

  return {
    ok: true,
    readOnly: true,
    writesAttempted: false,
    liveChecksopsMutated: false,
    productionSupabaseChanged: false,
    connectedAs: db.u,
    database: db.d,
    ownedCounts,
    views,
    partnership,
    totalsIncludesSharedChecks: /shared_checks/i.test(totalsDef),
    helperExists,
    livePolicies: livePolicies.map((p) => ({
      table: p.tablename,
      policy: p.policyname,
      cmd: p.cmd,
      usesShareTarget: /aws_is_active_shared_check_target|shared_checks/i.test(String(p.qual || '')),
      usesCanAccessCheck: /aws_can_access_check/i.test(String(p.qual || '')),
      usesTenant: /aws_can_access_tenant|user_belongs_to_tenant|tenant_id/i.test(String(p.qual || '')),
    })),
    shares: shares.map((r) => ({
      id: r.id,
      check_id: r.check_id,
      source_tenant_id: r.source_tenant_id,
      target_tenant_id: r.target_tenant_id,
      created_at: r.created_at,
      revoked: Boolean(r.revoked_at),
      parent_tenant_id: parentById.get(r.check_id)?.tenant_id || null,
      parent_missing: !parentById.has(r.check_id),
    })),
    c1cVisible,
    freedomVisible,
    fundsReceived: await fundsInspect(client),
  };
};

const callMaybe = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 220) };
  }
};

const fundsInspect = async (client) => {
  const functionRows = (await client.query(`
    SELECT p.proname, p.prosecdef, p.prorettype::regtype::text AS return_type
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'get_tenant_funds_received',
        'get_check_claim_settlement',
        'current_tenant_is_check_funds_recipient'
      )
    ORDER BY p.proname
  `)).rows;

  const policies = (await client.query(`
    SELECT tablename, policyname, cmd, qual
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'disbursement_splits',
        'disbursement_batches',
        'claim_check_payments',
        'claim_settlements',
        'claims'
      )
    ORDER BY tablename, policyname
  `)).rows.map((p) => ({
    table: p.tablename,
    policy: p.policyname,
    cmd: p.cmd,
    usesShareTarget: /aws_is_active_shared_check_target|shared_checks/i.test(String(p.qual || '')),
    usesCanAccessCheck: /aws_can_access_check/i.test(String(p.qual || '')),
    usesRecipient: /recipient_tenant_id|current_tenant_is_check_funds_recipient|stakeholder_account/i.test(String(p.qual || '')),
    usesTenantOwner: /aws_can_access_tenant\(tenant_id\)|user_belongs_to_tenant/i.test(String(p.qual || '')),
  }));

  const physical = (await client.query(`
    WITH shared AS (
      SELECT sc.check_id
      FROM public.shared_checks sc
      WHERE sc.source_tenant_id = $1::uuid
        AND sc.target_tenant_id = $2::uuid
        AND sc.revoked_at IS NULL
    )
    SELECT
      (SELECT count(*) FROM shared)::int AS shared_active,
      (
        SELECT count(*)::int
        FROM public.disbursement_splits ds
        JOIN public.disbursement_batches db ON db.id = ds.batch_id
        JOIN shared s ON s.check_id = db.check_intake_item_id
        WHERE ds.status = 'settled'
      ) AS settled_splits_on_shared_checks,
      (
        SELECT count(DISTINCT db.check_intake_item_id)::int
        FROM public.disbursement_splits ds
        JOIN public.disbursement_batches db ON db.id = ds.batch_id
        JOIN shared s ON s.check_id = db.check_intake_item_id
        WHERE ds.status = 'settled'
      ) AS shared_checks_with_settled_splits,
      (
        SELECT count(*)::int
        FROM public.disbursement_splits ds
        JOIN public.disbursement_batches db ON db.id = ds.batch_id
        JOIN shared s ON s.check_id = db.check_intake_item_id
        WHERE ds.status = 'settled'
          AND ds.tenant_id = $1::uuid
          AND ds.recipient_tenant_id = $2::uuid
      ) AS freedom_to_c1c_recipient_splits,
      (
        SELECT count(DISTINCT db.check_intake_item_id)::int
        FROM public.disbursement_splits ds
        JOIN public.disbursement_batches db ON db.id = ds.batch_id
        JOIN shared s ON s.check_id = db.check_intake_item_id
        WHERE ds.status = 'settled'
          AND ds.tenant_id = $1::uuid
          AND ds.recipient_tenant_id = $2::uuid
      ) AS shared_checks_with_c1c_recipient_splits,
      (
        SELECT count(*)::int
        FROM public.disbursement_splits ds
        JOIN public.disbursement_batches db ON db.id = ds.batch_id
        JOIN shared s ON s.check_id = db.check_intake_item_id
        WHERE ds.status = 'settled' AND ds.recipient_tenant_id IS NULL
      ) AS settled_splits_null_recipient_on_shared,
      (
        SELECT count(*)::int
        FROM public.claim_check_payments ccp
        JOIN shared s ON s.check_id = ccp.check_intake_item_id
        WHERE ccp.recipient_tenant_id = $2::uuid
      ) AS claim_check_payments_to_c1c_on_shared,
      (
        SELECT count(*)::int
        FROM public.disbursement_splits ds
        WHERE ds.status = 'settled'
          AND ds.recipient_tenant_id = $2::uuid
          AND ds.tenant_id IS DISTINCT FROM $2::uuid
      ) AS all_c1c_recipient_settled_splits,
      (
        SELECT count(DISTINCT sc.target_tenant_id)::int
        FROM public.shared_checks sc
        JOIN public.disbursement_batches db ON db.check_intake_item_id = sc.check_id
        JOIN public.disbursement_splits ds ON ds.batch_id = db.id AND ds.status = 'settled'
        WHERE sc.revoked_at IS NULL AND sc.target_tenant_id <> $1::uuid
      ) AS other_partner_tenants_with_settled_splits_on_shared_checks
  `, [FREEDOM, C1C])).rows[0];

  const sample = (await client.query(`
    WITH shared AS (
      SELECT sc.check_id
      FROM public.shared_checks sc
      WHERE sc.source_tenant_id = $1::uuid
        AND sc.target_tenant_id = $2::uuid
        AND sc.revoked_at IS NULL
    )
    SELECT
      db.check_intake_item_id AS check_id,
      cii.tenant_id AS owner_tenant_id,
      count(*)::int AS settled_split_count,
      coalesce(sum(ds.amount), 0)::numeric AS settled_amount,
      count(*) FILTER (WHERE ds.recipient_tenant_id = $2::uuid)::int AS c1c_recipient_count,
      count(*) FILTER (WHERE ds.recipient_tenant_id IS NULL)::int AS null_recipient_count,
      array_agg(ds.id ORDER BY ds.settled_at DESC NULLS LAST) AS split_ids
    FROM public.disbursement_splits ds
    JOIN public.disbursement_batches db ON db.id = ds.batch_id
    JOIN shared s ON s.check_id = db.check_intake_item_id
    JOIN public.check_intake_items cii ON cii.id = db.check_intake_item_id
    WHERE ds.status = 'settled'
    GROUP BY db.check_intake_item_id, cii.tenant_id
    ORDER BY count(*) FILTER (WHERE ds.recipient_tenant_id = $2::uuid) DESC, count(*) DESC
    LIMIT 1
  `, [FREEDOM, C1C])).rows[0] || null;

  const sampleCheckId = sample?.check_id || null;
  const sessionFor = async (appUserId) => asAppUser(client, appUserId, async () => {
    const checkVisible = sampleCheckId
      ? Number((await client.query(
        'SELECT count(*)::int AS n FROM public.check_intake_items WHERE id = $1::uuid',
        [sampleCheckId],
      )).rows[0].n)
      : 0;
    const splitsOnSample = sampleCheckId
      ? await callMaybe(async () => {
        const rows = (await client.query(`
          SELECT ds.id, ds.amount, ds.status, ds.tenant_id, ds.recipient_tenant_id
          FROM public.disbursement_splits ds
          JOIN public.disbursement_batches db ON db.id = ds.batch_id
          WHERE db.check_intake_item_id = $1::uuid AND ds.status = 'settled'
        `, [sampleCheckId])).rows;
        return {
          count: rows.length,
          amountSum: rows.reduce((n, r) => n + Number(r.amount || 0), 0),
          ids: rows.map((r) => r.id),
          recipientMatchesC1c: rows.filter((r) => r.recipient_tenant_id === C1C).length,
        };
      })
      : { count: 0, amountSum: 0, ids: [], recipientMatchesC1c: 0 };
    const incomingFilter = sampleCheckId
      ? await callMaybe(async () => {
        const rows = (await client.query(`
          SELECT ds.id, ds.amount
          FROM public.disbursement_splits ds
          JOIN public.disbursement_batches db ON db.id = ds.batch_id
          WHERE db.check_intake_item_id = $1::uuid
            AND ds.recipient_tenant_id = $2::uuid
            AND ds.tenant_id IS DISTINCT FROM $2::uuid
        `, [sampleCheckId, C1C])).rows;
        return { count: rows.length, amountSum: rows.reduce((n, r) => n + Number(r.amount || 0), 0), ids: rows.map((r) => r.id) };
      })
      : { count: 0 };
    const paymentsFilter = sampleCheckId
      ? await callMaybe(async () => {
        const rows = (await client.query(`
          SELECT id, payment_amount
          FROM public.claim_check_payments
          WHERE check_intake_item_id = $1::uuid AND recipient_tenant_id = $2::uuid
        `, [sampleCheckId, C1C])).rows;
        return { count: rows.length, amountSum: rows.reduce((n, r) => n + Number(r.payment_amount || 0), 0), ids: rows.map((r) => r.id) };
      })
      : { count: 0 };
    const rpcLane = await callMaybe(async () => {
      const rows = (await client.query(
        'SELECT id, amount, check_intake_item_id FROM public.get_tenant_funds_received($1::uuid)',
        [appUserId === C1C_ADMIN ? C1C : FREEDOM],
      )).rows;
      const onSample = sampleCheckId
        ? rows.filter((r) => r.check_intake_item_id === sampleCheckId)
        : [];
      return {
        totalCount: rows.length,
        totalAmount: rows.reduce((n, r) => n + Number(r.amount || 0), 0),
        sampleCount: onSample.length,
        sampleAmount: onSample.reduce((n, r) => n + Number(r.amount || 0), 0),
        sampleIds: onSample.map((r) => r.id),
      };
    });
    const settlement = sampleCheckId
      ? await callMaybe(async () => {
        const row = (await client.query(
          'SELECT public.get_check_claim_settlement($1::uuid) AS payload',
          [sampleCheckId],
        )).rows[0]?.payload;
        return {
          present: row != null,
          hasClaim: Boolean(row?.claim),
          hasSettlement: Boolean(row?.settlement),
          siblingCheckCount: Array.isArray(row?.sibling_checks) ? row.sibling_checks.length : 0,
        };
      })
      : null;
    return {
      checkVisible: checkVisible > 0,
      splitsOnSample,
      incomingRecipientFilter: incomingFilter,
      claimCheckPaymentsFilter: paymentsFilter,
      getTenantFundsReceived: rpcLane,
      getCheckClaimSettlement: settlement,
    };
  });

  const functionNames = functionRows.map((r) => r.proname);
  const sampleSplits = sampleCheckId
    ? (await client.query(`
        SELECT ds.id, ds.amount, ds.status, ds.method, ds.tenant_id, ds.recipient_tenant_id,
               (ds.recipient_name IS NOT NULL) AS has_recipient_name
        FROM public.disbursement_splits ds
        JOIN public.disbursement_batches db ON db.id = ds.batch_id
        WHERE db.check_intake_item_id = $1::uuid AND ds.status = 'settled'
        ORDER BY ds.settled_at DESC NULLS LAST
      `, [sampleCheckId])).rows.map((r) => ({
      id: r.id,
      amount: Number(r.amount),
      status: r.status,
      method: r.method,
      ownerIsFreedom: r.tenant_id === FREEDOM,
      recipientIsC1c: r.recipient_tenant_id === C1C,
      recipientIsNull: r.recipient_tenant_id == null,
      hasRecipientName: Boolean(r.has_recipient_name),
    }))
    : [];

  const otherPartnerTenants = (await client.query(`
    SELECT sc.target_tenant_id, count(DISTINCT sc.check_id)::int AS shared_checks_with_settled_splits
    FROM public.shared_checks sc
    JOIN public.disbursement_batches db ON db.check_intake_item_id = sc.check_id
    JOIN public.disbursement_splits ds ON ds.batch_id = db.id AND ds.status = 'settled'
    WHERE sc.revoked_at IS NULL
      AND sc.target_tenant_id <> $1::uuid
    GROUP BY sc.target_tenant_id
    ORDER BY count(DISTINCT sc.check_id) DESC
  `, [FREEDOM])).rows;

  return {
    ok: true,
    readOnly: true,
    functionsPresent: functionNames,
    functionMeta: functionRows.map((r) => ({
      name: r.proname,
      securityDefiner: r.prosecdef === true,
      returnType: r.return_type,
    })),
    missingFunctions: [
      'get_tenant_funds_received',
      'get_check_claim_settlement',
      'current_tenant_is_check_funds_recipient',
    ].filter((name) => !functionNames.includes(name)),
    policies,
    physical,
    sample: sample ? {
      check_id: sample.check_id,
      owner_tenant_id: sample.owner_tenant_id,
      ownerIsFreedom: sample.owner_tenant_id === FREEDOM,
      settled_split_count: Number(sample.settled_split_count),
      settled_amount: Number(sample.settled_amount),
      c1c_recipient_count: Number(sample.c1c_recipient_count),
      null_recipient_count: Number(sample.null_recipient_count),
      split_ids: sample.split_ids,
      splits: sampleSplits,
    } : null,
    otherPartnerTenants,
    awsApiUnwrapSimulation: {
      note: 'AWS data.mjs RPC_UNWRAP_SINGLE_COLUMN includes get_tenant_funds_received and returns only rows[0] when the function has multiple columns',
      c1cLaneWouldReceive: 'single_object_first_row_or_null_not_array',
      frontendMapWouldThrow: true,
    },
    freedomSession: await sessionFor(FREEDOM_TESTER),
    c1cSession: await sessionFor(C1C_ADMIN),
  };
};

const restore = async (client, event) => {
  if (event.confirm !== 'RESTORE_MISSING_ACTIVE_SHARES') {
    throw new Error('restore refused: confirm token missing');
  }
  const wanted = Array.isArray(event.shares) ? event.shares : [];
  if (!wanted.length) throw new Error('restore refused: empty share set');
  if (wanted.length > 200) throw new Error('restore refused: share set too large');

  const normalized = wanted.map((row) => {
    const id = String(row.id || '');
    const checkId = String(row.check_id || '');
    const source = String(row.source_tenant_id || FREEDOM);
    const target = String(row.target_tenant_id || C1C);
    const sharedBy = String(row.shared_by || FREEDOM_TESTER);
    if (![id, checkId, source, target, sharedBy].every((v) => UUID_RE.test(v))) {
      throw new Error('restore refused: invalid uuid');
    }
    if (source !== FREEDOM || target !== C1C) {
      throw new Error('restore refused: source/target must be Freedom → C1C');
    }
    return {
      id,
      check_id: checkId,
      source_tenant_id: source,
      target_tenant_id: target,
      shared_by: sharedBy,
      created_at: row.created_at || null,
      access_level: row.access_level || 'read_only',
    };
  });

  await client.query('BEGIN');
  try {
    const checkIds = normalized.map((r) => r.check_id);
    const parents = (await client.query(`
      SELECT id, tenant_id
      FROM public.check_intake_items
      WHERE id = ANY($1::uuid[])
      FOR UPDATE
    `, [checkIds])).rows;
    const parentById = new Map(parents.map((r) => [r.id, r]));
    const conflicts = [];
    for (const row of normalized) {
      const parent = parentById.get(row.check_id);
      if (!parent) {
        conflicts.push({ check_id: row.check_id, reason: 'parent_missing' });
        continue;
      }
      if (parent.tenant_id !== FREEDOM) {
        conflicts.push({ check_id: row.check_id, reason: 'ownership_not_freedom', tenant_id: parent.tenant_id });
      }
    }
    if (conflicts.length) {
      await client.query('ROLLBACK');
      return { ok: false, failClosed: true, inserted: 0, updated: 0, deleted: 0, ownershipChanges: 0, conflicts };
    }

    const existing = (await client.query(`
      SELECT id, check_id, source_tenant_id, target_tenant_id, revoked_at
      FROM public.shared_checks
      WHERE target_tenant_id = $1::uuid
        AND source_tenant_id = $2::uuid
        AND check_id = ANY($3::uuid[])
      FOR UPDATE
    `, [C1C, FREEDOM, checkIds])).rows;
    const existingByCheck = new Map(existing.map((r) => [r.check_id, r]));

    let inserted = 0;
    let updated = 0;
    const insertedIds = [];
    const updatedIds = [];
    for (const row of normalized) {
      const found = existingByCheck.get(row.check_id);
      if (!found) {
        await client.query(`
          INSERT INTO public.shared_checks (
            id, check_id, source_tenant_id, target_tenant_id, shared_by, access_level, created_at, revoked_at
          ) VALUES (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, COALESCE($7::timestamptz, now()), NULL
          )
        `, [row.id, row.check_id, row.source_tenant_id, row.target_tenant_id, row.shared_by, row.access_level, row.created_at]);
        inserted += 1;
        insertedIds.push(row.check_id);
        continue;
      }
      if (found.source_tenant_id !== FREEDOM || found.target_tenant_id !== C1C) {
        conflicts.push({ check_id: row.check_id, reason: 'existing_tenant_mismatch' });
        continue;
      }
      if (found.revoked_at) {
        await client.query(`
          UPDATE public.shared_checks
          SET revoked_at = NULL
          WHERE id = $1::uuid
            AND source_tenant_id = $2::uuid
            AND target_tenant_id = $3::uuid
            AND revoked_at IS NOT NULL
        `, [found.id, FREEDOM, C1C]);
        updated += 1;
        updatedIds.push(row.check_id);
      }
    }
    if (conflicts.length) {
      await client.query('ROLLBACK');
      return { ok: false, failClosed: true, inserted: 0, updated: 0, deleted: 0, ownershipChanges: 0, conflicts };
    }

    const ownershipTouched = Number((await client.query(`
      SELECT count(*)::int AS n
      FROM public.check_intake_items
      WHERE id = ANY($1::uuid[]) AND tenant_id IS DISTINCT FROM $2::uuid
    `, [checkIds, FREEDOM])).rows[0].n);
    if (ownershipTouched > 0) {
      await client.query('ROLLBACK');
      return { ok: false, failClosed: true, inserted: 0, updated: 0, deleted: 0, ownershipChanges: ownershipTouched };
    }

    await client.query('COMMIT');
    return {
      ok: true,
      inserted,
      updated,
      deleted: 0,
      ownershipChanges: 0,
      insertedIds,
      updatedIds,
      liveChecksopsMutated: inserted + updated > 0,
      productionSupabaseChanged: false,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
};

const applyPartnerDdl = async (client, event) => {
  if (event.confirm !== 'APPLY_PARTNER_SAFE_DDL') {
    throw new Error('apply_partner_ddl refused: confirm token missing');
  }
  const db = (await client.query('SELECT current_database() AS d')).rows[0];
  if (db.d !== 'checksops') throw new Error(`connected to ${db.d}, expected checksops`);
  const files = [
    '34_c1c_partner_visibility.sql',
    '32_partner_share_lifecycle.sql',
    '31_partner_safe_read.sql',
    '33_partner_stage_totals.sql',
  ];
  const applied = [];
  for (const name of files) {
    const sqlPath = [
      path.join(ROOT, 'sql', name),
      `/var/task/sql/${name}`,
    ].find((p) => fs.existsSync(p));
    if (!sqlPath) throw new Error(`${name} missing from Lambda package`);
    await client.query(fs.readFileSync(sqlPath, 'utf8'));
    applied.push(name);
  }
  const views = (await client.query(`
    SELECT
      to_regclass('public.aws_partner_check_payees') IS NOT NULL AS payees,
      to_regclass('public.aws_partner_check_endorsements') IS NOT NULL AS endorsements
  `)).rows[0];
  const totalsDef = (await client.query(`
    SELECT pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_check_stage_totals'
    LIMIT 1
  `)).rows[0]?.def || '';
  return {
    ok: views.payees === true && views.endorsements === true && /shared_checks/i.test(totalsDef),
    ddlOnly: true,
    applied,
    views,
    totalsIncludesSharedChecks: /shared_checks/i.test(totalsDef),
    liveChecksopsMutated: false,
    checksopsDdl: true,
    productionSupabaseChanged: false,
    ownershipChanges: 0,
    deleted: 0,
  };
};

const lifecycle = async (client) => {
  const shareFn = (await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'aws_share_check_with_partner'
    ) AS ok
  `)).rows[0].ok;
  const revokeFn = (await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'aws_revoke_shared_check'
    ) AS ok
  `)).rows[0].ok;
  const fixture = (await client.query(`
    SELECT ci.id
    FROM public.check_intake_items ci
    WHERE ci.tenant_id = $1::uuid
      AND NOT EXISTS (
        SELECT 1 FROM public.shared_checks sc
        WHERE sc.check_id = ci.id
          AND sc.source_tenant_id = $1::uuid
          AND sc.target_tenant_id = $2::uuid
      )
    ORDER BY ci.created_at DESC
    LIMIT 1
  `, [FREEDOM, C1C])).rows[0];
  if (!fixture) throw new Error('no unshared Freedom fixture check');

  const asWriter = async (fn, { asApp = true } = {}) => {
    await client.query('BEGIN');
    try {
      if (asApp) {
        await client.query('SET LOCAL ROLE checksops');
        await client.query("SELECT set_config('request.app_user_id', $1, true)", [FREEDOM_TESTER]);
      }
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
  };

  const c1cSees = async (checkId) => asAppUser(client, C1C_ADMIN, async () => {
    const intake = await client.query(
      'SELECT count(*)::int AS n FROM public.check_intake_items WHERE id = $1::uuid',
      [checkId],
    );
    const share = await client.query(`
      SELECT count(*)::int AS n
      FROM public.shared_checks
      WHERE check_id = $1::uuid AND target_tenant_id = $2::uuid AND revoked_at IS NULL
    `, [checkId, C1C]);
    return { intake: Number(intake.rows[0].n), share: Number(share.rows[0].n) };
  });

  const ownerSees = async (checkId) => asAppUser(client, FREEDOM_TESTER, async () => {
    const intake = await client.query(
      'SELECT count(*)::int AS n, min(tenant_id::text) AS tenant_id FROM public.check_intake_items WHERE id = $1::uuid',
      [checkId],
    );
    return {
      intake: Number(intake.rows[0].n),
      tenant_id: intake.rows[0].tenant_id,
    };
  });

  const before = await c1cSees(fixture.id);
  let created;
  if (shareFn) {
    created = await asWriter(async () => {
      const result = await client.query(
        'SELECT public.aws_share_check_with_partner($1::uuid, $2::uuid) AS result',
        [fixture.id, C1C],
      );
      return result.rows[0].result;
    });
  } else {
    created = await asWriter(async () => {
      const result = await client.query(`
        INSERT INTO public.shared_checks (check_id, source_tenant_id, target_tenant_id, shared_by)
        VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)
        RETURNING id
      `, [fixture.id, FREEDOM, C1C, FREEDOM_TESTER]);
      return { ok: true, created: true, share_id: result.rows[0].id, usedAdminInsert: true };
    }, { asApp: false });
  }
  const afterShare = await c1cSees(fixture.id);
  const ownerAfterShare = await ownerSees(fixture.id);
  const retry = shareFn
    ? await asWriter(async () => (
      await client.query(
        'SELECT public.aws_share_check_with_partner($1::uuid, $2::uuid) AS result',
        [fixture.id, C1C],
      )
    ).rows[0].result)
    : { ok: true, created: false, reactivated: false };

  const shareId = created.share_id || (await client.query(`
    SELECT id FROM public.shared_checks
    WHERE check_id = $1::uuid AND source_tenant_id = $2::uuid AND target_tenant_id = $3::uuid
    LIMIT 1
  `, [fixture.id, FREEDOM, C1C])).rows[0]?.id;

  let revoked;
  if (revokeFn) {
    revoked = await asWriter(async () => (
      await client.query('SELECT public.aws_revoke_shared_check($1::uuid) AS result', [shareId])
    ).rows[0].result);
  } else {
    revoked = await asWriter(async () => {
      await client.query('UPDATE public.shared_checks SET revoked_at = now() WHERE id = $1::uuid', [shareId]);
      return { ok: true, revoked: true, share_id: shareId };
    }, { asApp: false });
  }
  const afterRevoke = await c1cSees(fixture.id);
  const ownerAfterRevoke = await ownerSees(fixture.id);

  const reshared = shareFn
    ? await asWriter(async () => (
      await client.query(
        'SELECT public.aws_share_check_with_partner($1::uuid, $2::uuid) AS result',
        [fixture.id, C1C],
      )
    ).rows[0].result)
    : await asWriter(async () => {
      await client.query('UPDATE public.shared_checks SET revoked_at = NULL WHERE id = $1::uuid', [shareId]);
      return { ok: true, created: false, reactivated: true, share_id: shareId };
    }, { asApp: false });
  const afterReshare = await c1cSees(fixture.id);

  // Leave the fixture unshared so historical 94 stay the only C1C Freedom shares.
  if (revokeFn) {
    await asWriter(async () => (
      await client.query('SELECT public.aws_revoke_shared_check($1::uuid) AS result', [shareId])
    ).rows[0].result);
  } else {
    await asWriter(async () => {
      await client.query('UPDATE public.shared_checks SET revoked_at = now() WHERE id = $1::uuid', [shareId]);
      return { ok: true };
    }, { asApp: false });
  }
  const cleaned = await c1cSees(fixture.id);
  const ownerFinal = await ownerSees(fixture.id);

  return {
    ok: before.intake === 0
      && afterShare.intake === 1
      && afterShare.share === 1
      && ownerAfterShare.intake === 1
      && ownerAfterShare.tenant_id === FREEDOM
      && retry.created === false
      && afterRevoke.intake === 0
      && ownerAfterRevoke.intake === 1
      && ownerAfterRevoke.tenant_id === FREEDOM
      && afterReshare.intake === 1
      && cleaned.intake === 0
      && ownerFinal.tenant_id === FREEDOM,
    usedRpc: Boolean(shareFn && revokeFn),
    fixtureCheckId: fixture.id,
    before,
    created,
    afterShare,
    retry,
    revoked,
    afterRevoke,
    reshared,
    afterReshare,
    cleaned,
    ownerFinal,
    ownershipChanged: ownerFinal.tenant_id !== FREEDOM,
    productionSupabaseChanged: false,
  };
};

export const handler = async (event = {}) => {
  const step = event.step || 'inspect';
  const out = {
    ok: false,
    step,
    productionSupabaseChanged: false,
    productionCutoverPerformed: false,
    liveChecksopsMutated: false,
  };
  let client;
  try {
    client = await adminClient();
    if (step === 'inspect') return { ...out, ...(await inspect(client)) };
    if (step === 'apply_partner_ddl') return { ...out, ...(await applyPartnerDdl(client, event)) };
    if (step === 'lifecycle') return { ...out, ...(await lifecycle(client)) };
    if (step === 'restore') return { ...out, ...(await restore(client, event)) };
    throw new Error(`unknown step ${step}`);
  } catch (error) {
    return { ...out, error: String(error.message || error).slice(0, 500) };
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};
