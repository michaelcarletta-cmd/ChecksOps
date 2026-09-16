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
  await client.query('SAVEPOINT share_probe');
  try {
    await client.query('SET LOCAL ROLE checksops');
    await client.query('SET LOCAL row_security = on');
    await client.query("SELECT set_config('request.app_user_id', $1, true)", [appUserId]);
    const result = await fn();
    await client.query('ROLLBACK TO SAVEPOINT share_probe');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK TO SAVEPOINT share_probe'); } catch { /* ignore */ }
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

  const c1cVisible = await asAppUser(client, C1C_ADMIN, async () => {
    const intake = await client.query('SELECT count(*)::int AS n FROM public.check_intake_items');
    const owned = await client.query(
      'SELECT count(*)::int AS n FROM public.check_intake_items WHERE tenant_id = $1::uuid',
      [C1C],
    );
    const shared = await client.query(`
      SELECT count(*)::int AS n
      FROM public.shared_checks
      WHERE target_tenant_id = $1::uuid AND revoked_at IS NULL
    `, [C1C]);
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
    return {
      intakeVisible: Number(intake.rows[0].n),
      ownedVisible: Number(owned.rows[0].n),
      sharedActiveVisible: Number(shared.rows[0].n),
      partnerPayeesVisible: payees.rows[0].n,
      partnerEndorsementsVisible: endorsements.rows[0].n,
      tenantsPublicVisible: tenants.rows[0].n,
      freedomTenantViaTenantsTable: Number(partnerTenants.rows[0].n),
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
