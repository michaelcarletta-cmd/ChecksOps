import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = fs.existsSync(path.join(ROOT, 'sql'))
  ? path.join(ROOT, 'sql')
  : path.join(ROOT, '..', 'sql');
const RLS_SQL_DIR = fs.existsSync(path.join(ROOT, 'rls-sql'))
  ? path.join(ROOT, 'rls-sql')
  : path.join(ROOT, '..', '..', 'rls', 'sql');
const CA_PATH = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  path.join(ROOT, '..', '..', 'functions', 'api', 'rds-global-bundle.pem'),
  path.join(ROOT, '..', 'oneshot', 'rds-global-bundle.pem'),
].find((p) => fs.existsSync(p));

export const TESTER_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
export const C1C_ADMIN_ID = 'fd857564-9534-4b0f-95ac-624ed1273725';
export const NINTH_ID = 'dd24eea5-5d12-47d1-999e-d5930c278b7d';
export const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
export const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';

const readSql = (dir, name) => fs.readFileSync(path.join(dir, name), 'utf8');

const adminClient = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn) throw new Error('ADMIN_SECRET_ARN is not configured');
  if (!/checksops_admin/i.test(arn)) throw new Error('ADMIN_SECRET_ARN must be the checksops_admin secret');
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
  const client = new Client({
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
    database: process.env.DATABASE_NAME || 'checksops',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000,
    query_timeout: 120000,
  });
  await client.connect();
  return client;
};

const tablePrivileges = async (client) => {
  const { rows } = await client.query(`
    SELECT grantee, table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN (
        'check_message_reads', 'notification_preferences',
        'check_intake_items', 'check_payees', 'check_endorsements',
        'check_endorsement_events', 'check_audit_log', 'check_messages',
        'check_files', 'claim_checks',
        'claim_payments', 'homeowner_ledger_events'
      )
      AND grantee IN ('checksops', 'authenticated')
    ORDER BY table_name, grantee, privilege_type
  `);
  return rows;
};

const intakeUpdateColumns = async (client) => {
  const { rows } = await client.query(`
    SELECT column_name
    FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND table_name = 'check_intake_items'
      AND grantee = 'checksops'
      AND privilege_type = 'UPDATE'
    ORDER BY 1
  `);
  return rows.map((row) => row.column_name);
};

const inspectIntegrationGrants = async (client) => {
  const intake = await intakeUpdateColumns(client);
  const { rows: settlement } = await client.query(`
    SELECT grantee, privilege_type, column_name
    FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND table_name = 'claim_settlements'
      AND grantee IN ('checksops', 'authenticated')
      AND privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    ORDER BY grantee, privilege_type, column_name
  `);
  const { rows: sensitive } = await client.query(`
    SELECT table_name, grantee, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN (
        'claim_payments', 'claim_disbursements', 'payment_wallets',
        'payment_wallet_ledger', 'disbursement_splits', 'actum_transactions'
      )
      AND grantee IN ('checksops', 'authenticated')
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
    ORDER BY 1, 2, 3
  `);
  const settlementInsertGranted = settlement.some((row) => (
    row.grantee === 'checksops' && row.privilege_type === 'INSERT' && row.column_name === 'replacement_cost_value'
  ));
  const settlementUpdateGranted = settlement.some((row) => (
    row.grantee === 'checksops' && row.privilege_type === 'UPDATE' && row.column_name === 'replacement_cost_value'
  ));
  const settlementDeleteGranted = settlement.some((row) => row.privilege_type === 'DELETE');
  const { rows: claimsInsert } = await client.query(`
    SELECT column_name
    FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND table_name = 'claims'
      AND grantee = 'checksops'
      AND privilege_type = 'INSERT'
    ORDER BY 1
  `);
  const claimsInsertColumns = claimsInsert.map((row) => row.column_name);
  const { rows: dtpFn } = await client.query(`
    SELECT p.proname,
           has_function_privilege('checksops', p.oid, 'EXECUTE') AS checksops_execute,
           has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'aws_public_homeowner_claim_sign_dtp'
  `);
  const { rows: orgCounts } = await client.query(`
    SELECT count(*)::int AS claims,
           count(org_id)::int AS with_org_id,
           count(*) FILTER (WHERE org_id IS NULL)::int AS org_id_null
    FROM public.claims
  `);
  const { rows: fixture } = await client.query(`
    SELECT id::text, claim_number, org_id::text, status
    FROM public.claims
    WHERE id = '266e1ae8-ec20-4ed5-9243-3e1424304ec6'::uuid
  `);
  return {
    intakeUpdateColumns: intake,
    detectedClaimNumberGranted: intake.includes('detected_claim_number'),
    intakeClaimIdStillDenied: !intake.includes('claim_id'),
    intakeAmountStillDenied: !intake.includes('amount'),
    intakeStatusStillDenied: !intake.includes('status'),
    settlementInsertGranted,
    settlementUpdateGranted,
    settlementDeleteGranted: settlementDeleteGranted === true,
    paymentWritesStillDenied: !sensitive.some((row) => ['claim_payments', 'claim_disbursements', 'disbursement_splits', 'actum_transactions'].includes(row.table_name)),
    walletWritesStillDenied: !sensitive.some((row) => ['payment_wallets', 'payment_wallet_ledger'].includes(row.table_name)),
    claimsInsertColumns,
    claimsOrgIdInsertGranted: claimsInsertColumns.includes('org_id')
      && claimsInsertColumns.includes('claim_number')
      && claimsInsertColumns.includes('status')
      && !claimsInsertColumns.some((col) => ['claim_amount', 'deductible'].includes(col)),
    dtpSignFn: dtpFn[0] || null,
    dtpSignGranted: dtpFn.length === 1 && dtpFn[0].checksops_execute === true,
    orgCounts: orgCounts[0] || null,
    c1cFixture: fixture[0] || null,
    settlementColumns: settlement,
    sensitiveWrites: sensitive,
  };
};

const financialAggregates = async (client) => {
  const sql = readSql(RLS_SQL_DIR, '28_financial_aggregates.sql');
  const { rows } = await client.query(sql);
  const out = {};
  for (const row of rows) out[row.metric] = String(row.value);
  return out;
};

const ninthWriteDenied = async (client) => {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE checksops');
    await client.query("SELECT set_config('request.app_user_id', $1, true)", [NINTH_ID]);
    const updated = await client.query(`
      UPDATE public.check_intake_items
      SET carrier_name = carrier_name
      WHERE tenant_id = $1::uuid
      RETURNING id
    `, [FREEDOM_TENANT]);
    await client.query('ROLLBACK');
    return { denied: updated.rowCount === 0, n: updated.rowCount };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return {
      denied: /row-level security|permission denied/i.test(String(error?.message || '')),
      error: String(error?.message || error).slice(0, 240),
    };
  }
};

export const handler = async (event) => {
  const step = event?.step || event?.queryStringParameters?.step || 'grants';
  const client = await adminClient();
  try {
    if (step === 'financial') {
      return { ok: true, financial: await financialAggregates(client) };
    }
    if (step === 'columns') {
      const { rows } = await client.query(`
        SELECT table_name, column_name, privilege_type
        FROM information_schema.column_privileges
        WHERE table_schema = 'public'
          AND table_name IN ('claim_checks', 'check_intake_items', 'check_files', 'check_messages')
          AND grantee = 'checksops'
          AND privilege_type IN ('UPDATE', 'INSERT')
        ORDER BY 1, 3, 2
      `);
      return { ok: true, columns: rows };
    }
    if (step === 'cleanup-t2') {
      const deleted = await client.query(`
        DELETE FROM public.check_audit_log
        WHERE event_type IN ('aws_tranche2_test', 'aws_tranche2_isolation')
        RETURNING id
      `);
      const payees = await client.query(`
        DELETE FROM public.check_payees
        WHERE payee_name LIKE 'AWS T2 TEST%'
        RETURNING id
      `);
      return {
        ok: true,
        auditDeleted: deleted.rowCount,
        payeesDeleted: payees.rowCount,
      };
    }
    if (step === 'sample-checks') {
      const rows = (await client.query(`
        SELECT tenant_id::text AS tenant_id, count(*)::int AS n
        FROM public.check_intake_items
        GROUP BY 1
        ORDER BY 2 DESC
      `)).rows;
      const samples = (await client.query(`
        SELECT DISTINCT ON (tenant_id) id::text AS id, tenant_id::text AS tenant_id
        FROM public.check_intake_items
        ORDER BY tenant_id, id
      `)).rows;
      return {
        ok: true,
        byTenant: rows,
        samples,
        freedom: samples.find((row) => row.tenant_id === FREEDOM_TENANT) || null,
        c1c: samples.find((row) => row.tenant_id === C1C_TENANT) || null,
      };
    }
    if (step === 'cleanup-t3') {
      const notes = await client.query(`
        DELETE FROM public.check_messages
        WHERE body LIKE 'AWS T3 TEST%'
        RETURNING id
      `);
      const noteIds = notes.rows.map((row) => row.id);
      let ledgerFromNotes = { rowCount: 0 };
      if (noteIds.length) {
        ledgerFromNotes = await client.query(`
          DELETE FROM public.homeowner_ledger_events
          WHERE event_type = 'ops_note'
            AND payload_json->>'check_message_id' = ANY($1::text[])
          RETURNING id
        `, [noteIds.map(String)]);
      }
      const files = await client.query(`
        DELETE FROM public.check_files
        WHERE file_path LIKE '%/aws-t3-test/%'
           OR file_name LIKE 'aws-t3-test%'
        RETURNING id
      `);
      const fileIds = files.rows.map((row) => row.id);
      let ledgerFromFiles = { rowCount: 0 };
      if (fileIds.length) {
        ledgerFromFiles = await client.query(`
          DELETE FROM public.homeowner_ledger_events
          WHERE event_type = 'document_uploaded'
            AND payload_json->>'check_file_id' = ANY($1::text[])
          RETURNING id
        `, [fileIds.map(String)]);
      }
      const leftoverLedger = await client.query(`
        DELETE FROM public.homeowner_ledger_events
        WHERE event_type IN ('ops_note', 'document_uploaded')
          AND (
            payload_json->>'note' LIKE 'AWS T3 TEST%'
            OR payload_json->>'file_name' LIKE 'aws-t3-test%'
            OR payload_json->>'document_name' LIKE 'aws-t3-test%'
          )
        RETURNING id
      `);
      const audit = await client.query(`
        DELETE FROM public.check_audit_log
        WHERE event_type LIKE 'aws_tranche3%'
        RETURNING id
      `);
      return {
        ok: true,
        messagesDeleted: notes.rowCount,
        noteLedgerDeleted: ledgerFromNotes.rowCount,
        filesDeleted: files.rowCount,
        fileLedgerDeleted: ledgerFromFiles.rowCount,
        leftoverLedgerDeleted: leftoverLedger.rowCount,
        auditDeleted: audit.rowCount,
      };
    }
    if (step === 'revoke') {
      await client.query(readSql(SQL_DIR, '36_tranche3_revoke_write_grants.sql'));
      return { ok: true, revoked: true, privileges: await tablePrivileges(client) };
    }
    if (step === 'revoke-t2') {
      await client.query(readSql(SQL_DIR, '34_tranche2_revoke_write_grants.sql'));
      return { ok: true, revoked: true, privileges: await tablePrivileges(client) };
    }
    if (step === 'grant-detected-claim-number') {
      const before = await intakeUpdateColumns(client);
      await client.query(readSql(SQL_DIR, '39_detected_claim_number_grant.sql'));
      const after = await intakeUpdateColumns(client);
      const financialStillBlocked = !after.includes('amount')
        && !after.includes('claim_id')
        && !after.includes('routing_number')
        && !after.includes('deposited_at');
      return {
        ok: after.includes('detected_claim_number') && financialStillBlocked,
        step,
        before,
        after,
        granted: after.includes('detected_claim_number'),
        financialStillBlocked,
      };
    }
    if (step === 'inspect-integration-grants') {
      return { ok: true, step, ...(await inspectIntegrationGrants(client)) };
    }
    if (step === 'repair-one-synthetic-claim-org-id') {
      const claimId = event?.claim_id || event?.queryStringParameters?.claim_id
        || '266e1ae8-ec20-4ed5-9243-3e1424304ec6';
      const { rows: before } = await client.query(`
        SELECT
          c.id::text AS claim_id,
          c.claim_number,
          c.org_id::text AS org_id,
          count(ci.id)::int AS check_n,
          count(DISTINCT ci.tenant_id)::int AS tenant_n,
          array_remove(array_agg(DISTINCT ci.tenant_id::text), NULL) AS tenants,
          array_remove(array_agg(DISTINCT ci.check_number), NULL) AS check_numbers
        FROM public.claims c
        LEFT JOIN public.check_intake_items ci ON ci.claim_id = c.id
        WHERE c.id = $1::uuid
        GROUP BY c.id, c.claim_number, c.org_id
      `, [claimId]);
      const row = before[0];
      if (!row) return { ok: false, step, error: 'claim_not_found', claimId };
      if (row.org_id) {
        return { ok: true, step, applied: false, reason: 'already_has_org_id', before: row };
      }
      if (row.tenant_n !== 1 || !row.tenants?.[0]) {
        return { ok: false, step, applied: false, reason: 'ownership_not_unique', before: row };
      }
      const orgId = row.tenants[0];
      const { rows: after } = await client.query(`
        UPDATE public.claims
        SET org_id = $2::uuid
        WHERE id = $1::uuid AND org_id IS NULL
        RETURNING id::text AS claim_id, claim_number, org_id::text AS org_id
      `, [claimId, orgId]);
      return {
        ok: after.length === 1 && after[0].org_id === orgId,
        step,
        applied: after.length === 1,
        before: row,
        after: after[0] || null,
      };
    }
    if (step === 'grant-claims-org-id-insert') {
      const before = await inspectIntegrationGrants(client);
      await client.query(readSql(SQL_DIR, '41_claims_org_id_insert_grant.sql'));
      await client.query(readSql(SQL_DIR, '41_create_claim_for_staff_org_id.sql'));
      const { rows: insertGrant } = await client.query(`
        SELECT column_name, privilege_type
        FROM information_schema.column_privileges
        WHERE table_schema = 'public'
          AND table_name = 'claims'
          AND grantee = 'checksops'
          AND privilege_type = 'INSERT'
        ORDER BY 1
      `);
      return {
        ok: insertGrant.some((row) => row.column_name === 'org_id')
          && insertGrant.some((row) => row.column_name === 'claim_number')
          && !insertGrant.some((row) => ['claim_amount', 'deductible'].includes(row.column_name)),
        step,
        before,
        insertGrant,
      };
    }
    if (step === 'probe-c1c-settlement') {
      const claimId = '266e1ae8-ec20-4ed5-9243-3e1424304ec6';
      const figures = {
        rcv: 10000, rec: 2000, non: 500, ded: 1000, notes: 'P2-ORG-ID-SAFE-TEST',
      };
      const { rows: claim } = await client.query(
        `SELECT id::text, claim_number, org_id::text, status FROM public.claims WHERE id = $1::uuid`,
        [claimId],
      );
      const runAs = async (userId, fn) => {
        await client.query('BEGIN');
        try {
          await client.query('SET LOCAL ROLE checksops');
          await client.query("SELECT set_config('request.app_user_id', $1, true)", [userId]);
          const result = await fn();
          await client.query('COMMIT');
          return { ok: true, ...result };
        } catch (error) {
          try { await client.query('ROLLBACK'); } catch { /* ignore */ }
          return {
            ok: false,
            denied: /row-level security|permission denied|not found or not writable/i.test(String(error?.message || '')),
            error: String(error?.message || error).slice(0, 240),
          };
        }
      };
      const c1cWrite = await runAs(C1C_ADMIN_ID, async () => {
        const existing = (await client.query(
          'SELECT id::text FROM public.claim_settlements WHERE claim_id = $1::uuid LIMIT 1',
          [claimId],
        )).rows[0];
        if (existing) {
          const rows = (await client.query(
            `UPDATE public.claim_settlements
             SET replacement_cost_value = $2::numeric,
                 recoverable_depreciation = $3::numeric,
                 non_recoverable_depreciation = $4::numeric,
                 deductible = $5::numeric,
                 notes = $6::text,
                 updated_at = now()
             WHERE id = $1::uuid AND claim_id = $7::uuid
             RETURNING id::text, claim_id::text, replacement_cost_value::text,
                       recoverable_depreciation::text, non_recoverable_depreciation::text,
                       deductible::text, notes`,
            [existing.id, figures.rcv, figures.rec, figures.non, figures.ded, figures.notes, claimId],
          )).rows;
          return { op: 'update', rows };
        }
        const rows = (await client.query(
          `INSERT INTO public.claim_settlements (
             claim_id, created_by, replacement_cost_value, recoverable_depreciation,
             non_recoverable_depreciation, deductible, notes
           ) VALUES (
             $1::uuid, $2::uuid, $3::numeric, $4::numeric, $5::numeric, $6::numeric, $7::text
           ) RETURNING id::text, claim_id::text, replacement_cost_value::text,
                     recoverable_depreciation::text, non_recoverable_depreciation::text,
                     deductible::text, notes`,
          [claimId, C1C_ADMIN_ID, figures.rcv, figures.rec, figures.non, figures.ded, figures.notes],
        )).rows;
        return { op: 'insert', rows };
      });
      const freedomWrite = await runAs(TESTER_ID, async () => {
        const rows = (await client.query(
          `INSERT INTO public.claim_settlements (
             claim_id, created_by, replacement_cost_value, notes
           ) VALUES ($1::uuid, $2::uuid, 1, 'P2-SHOULD-DENY')
           RETURNING id::text`,
          [claimId, TESTER_ID],
        )).rows;
        return { rows };
      });
      const ninthWrite = await runAs(NINTH_ID, async () => {
        const rows = (await client.query(
          `INSERT INTO public.claim_settlements (
             claim_id, created_by, replacement_cost_value, notes
           ) VALUES ($1::uuid, $2::uuid, 1, 'P2-SHOULD-DENY')
           RETURNING id::text`,
          [claimId, NINTH_ID],
        )).rows;
        return { rows };
      });
      const stored = (await client.query(
        `SELECT replacement_cost_value::text AS rcv, recoverable_depreciation::text AS rec,
                non_recoverable_depreciation::text AS non, deductible::text AS ded, notes
         FROM public.claim_settlements WHERE claim_id = $1::uuid LIMIT 1`,
        [claimId],
      )).rows[0] || null;
      const acv = stored
        ? Math.max(0, Number(stored.rcv) - Number(stored.rec) - Number(stored.non) - Number(stored.ded))
        : null;
      return {
        ok: Boolean(c1cWrite.ok && c1cWrite.rows?.length)
          && (freedomWrite.denied === true || (freedomWrite.ok && !freedomWrite.rows?.length))
          && (ninthWrite.denied === true || (ninthWrite.ok && !ninthWrite.rows?.length)),
        step,
        claim: claim[0] || null,
        c1cWrite,
        freedomWrite,
        ninthWrite,
        stored,
        acv,
        expectedAcv: 6500,
      };
    }
    if (step === 'mint-pending-portal') {
      const profileId = '3b57edc6-8e37-4445-9fff-8439516630e1';
      const contractorUser = C1C_ADMIN_ID;
      const inserted = (await client.query(
        `INSERT INTO public.homeowner_intro_requests (
           contractor_profile_id, contractor_user_id,
           homeowner_name, homeowner_email, property_zip, loss_type, message, status
         ) VALUES (
           $1::uuid, $2::uuid, 'P2 Pending Fixture', 'p2-pending@example.invalid',
           '33101', 'wind', 'phase2 synthetic SES-free pending token', 'new'
         ) RETURNING id::text, access_token, status, accepted_at`,
        [profileId, contractorUser],
      )).rows[0];
      return {
        ok: Boolean(inserted?.access_token) && inserted.status === 'new' && !inserted.accepted_at,
        step,
        leadId: inserted.id,
        tokenLen: inserted.access_token?.length || 0,
        tokenPrefix: String(inserted.access_token || '').slice(0, 8),
        status: inserted.status,
        access_token: inserted.access_token,
      };
    }
    if (step === 'mint-portal-fixture') {
      const profileId = '3b57edc6-8e37-4445-9fff-8439516630e1';
      const contractorUser = C1C_ADMIN_ID;
      const inserted = (await client.query(
        `INSERT INTO public.homeowner_intro_requests (
           contractor_profile_id, contractor_user_id,
           homeowner_name, homeowner_email, property_zip, loss_type, message, status
         ) VALUES (
           $1::uuid, $2::uuid, 'P2 Portal Fixture', 'p2-portal@example.invalid',
           '33101', 'wind', 'phase2 synthetic SES-free token', 'new'
         ) RETURNING id::text, access_token, status`,
        [profileId, contractorUser],
      )).rows[0];
      const accepted = (await client.query(
        `UPDATE public.homeowner_intro_requests
         SET status = 'accepted', accepted_at = now(), updated_at = now()
         WHERE id = $1::uuid
         RETURNING id::text, access_token, status, accepted_at`,
        [inserted.id],
      )).rows[0];
      return {
        ok: Boolean(accepted?.access_token) && accepted.status === 'accepted',
        step,
        leadId: accepted.id,
        tokenLen: accepted.access_token?.length || 0,
        tokenPrefix: String(accepted.access_token || '').slice(0, 8),
        status: accepted.status,
        access_token: accepted.access_token,
      };
    }
    if (step === 'inspect-phase2-extras') {
      const { rows: orgAfter } = await client.query(`
        SELECT count(*)::int AS claims, count(org_id)::int AS with_org_id,
               count(*) FILTER (WHERE org_id IS NULL)::int AS org_id_null
        FROM public.claims
      `);
      const { rows: providerAccounts } = await client.query(`
        SELECT t.id::text AS tenant_id, t.name,
               count(ppa.id)::int AS accounts,
               bool_or(ppa.status IN ('active','verified','approved')) AS any_active
        FROM public.tenants t
        LEFT JOIN public.payment_provider_accounts ppa ON ppa.tenant_id = t.id
        GROUP BY t.id, t.name
        ORDER BY t.name
      `).catch(async (error) => ({
        rows: [{ error: String(error.message || error).slice(0, 200) }],
      }));
      const { rows: contractors } = await client.query(`
        SELECT id::text, display_name, is_directory_listed, directory_opt_in, user_id::text
        FROM public.contractor_profiles
        WHERE is_directory_listed = true AND directory_opt_in = true
        LIMIT 10
      `);
      const { rows: leads } = await client.query(`
        SELECT id::text, status, (access_token IS NOT NULL) AS has_token,
               length(access_token) AS token_len, accepted_at IS NOT NULL AS accepted
        FROM public.homeowner_intro_requests
        ORDER BY created_at DESC NULLS LAST
        LIMIT 10
      `);
      const { rows: settlement } = await client.query(`
        SELECT id::text, claim_id::text, replacement_cost_value::text AS rcv,
               recoverable_depreciation::text AS rec, non_recoverable_depreciation::text AS non,
               deductible::text AS ded, notes
        FROM public.claim_settlements
        WHERE claim_id = '266e1ae8-ec20-4ed5-9243-3e1424304ec6'::uuid
      `);
      const { rows: pipelineUsers } = await client.query(`
        SELECT tu.user_id::text, tu.role, p.email
        FROM public.tenant_users tu
        LEFT JOIN public.profiles p ON p.id = tu.user_id
        WHERE tu.tenant_id = '3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43'::uuid
        LIMIT 10
      `);
      return {
        ok: true,
        step,
        orgAfter: orgAfter[0],
        providerAccounts,
        contractors,
        leads,
        settlement,
        pipelineUsers,
      };
    }
    if (step === 'inspect-org-id-distribution') {
      const { rows: totals } = await client.query(`
        SELECT
          count(*)::int AS claims,
          count(org_id)::int AS with_org_id,
          count(*) FILTER (WHERE org_id IS NULL)::int AS org_id_null
        FROM public.claims
      `);
      const { rows: byOrg } = await client.query(`
        SELECT COALESCE(org_id::text, 'NULL') AS org_id, count(*)::int AS n
        FROM public.claims
        GROUP BY 1
        ORDER BY 2 DESC
      `);
      const { rows: ownership } = await client.query(`
        WITH linked AS (
          SELECT
            c.id,
            c.org_id,
            count(DISTINCT ci.tenant_id) FILTER (WHERE ci.tenant_id IS NOT NULL)::int AS tenant_n,
            array_remove(array_agg(DISTINCT ci.tenant_id::text), NULL) AS tenants
          FROM public.claims c
          LEFT JOIN public.check_intake_items ci ON ci.claim_id = c.id
          GROUP BY c.id, c.org_id
        )
        SELECT
          count(*)::int AS claims,
          count(*) FILTER (WHERE tenant_n = 1)::int AS single_tenant_linked,
          count(*) FILTER (WHERE tenant_n > 1)::int AS multi_tenant_linked,
          count(*) FILTER (WHERE tenant_n = 0)::int AS unlinked,
          count(*) FILTER (WHERE tenant_n = 1 AND org_id IS NULL)::int AS single_tenant_null_org,
          count(*) FILTER (WHERE tenant_n = 1 AND org_id IS NOT NULL)::int AS single_tenant_with_org,
          count(*) FILTER (
            WHERE tenant_n = 1 AND org_id IS NOT NULL AND org_id::text <> tenants[1]
          )::int AS single_tenant_org_mismatch,
          count(*) FILTER (WHERE tenant_n = 1 AND org_id IS NULL AND tenants[1] = $1)::int AS c1c_single_null,
          count(*) FILTER (WHERE tenant_n = 1 AND org_id IS NULL AND tenants[1] = $2)::int AS freedom_single_null
        FROM linked
      `, [C1C_TENANT, FREEDOM_TENANT]);
      const { rows: c1cSynthetic } = await client.query(`
        SELECT
          c.id::text AS claim_id,
          c.claim_number,
          c.org_id::text AS org_id,
          c.status,
          count(ci.id)::int AS check_n,
          count(DISTINCT ci.tenant_id)::int AS tenant_n,
          array_remove(array_agg(DISTINCT ci.tenant_id::text), NULL) AS tenants,
          array_remove(array_agg(DISTINCT ci.check_number), NULL) AS check_numbers
        FROM public.claims c
        LEFT JOIN public.check_intake_items ci ON ci.claim_id = c.id
        WHERE c.id = $1::uuid
        GROUP BY c.id, c.claim_number, c.org_id, c.status
      `, ['266e1ae8-ec20-4ed5-9243-3e1424304ec6']);
      const { rows: triggers } = await client.query(`
        SELECT t.tgname, p.proname
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE n.nspname = 'public' AND c.relname = 'claims' AND NOT t.tgisinternal
        ORDER BY 1
      `);
      const { rows: fns } = await client.query(`
        SELECT p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('create_claim_for_staff', 'set_claim_org_id')
        ORDER BY 1
      `);
      let createClaimSrc = null;
      if (fns.some((row) => row.proname === 'create_claim_for_staff')) {
        const { rows } = await client.query(
          `SELECT pg_get_functiondef(p.oid) AS def
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'create_claim_for_staff'
           LIMIT 1`,
        );
        createClaimSrc = String(rows[0]?.def || '');
      }
      const { rows: leadTokens } = await client.query(`
        SELECT
          count(*)::int AS leads,
          count(access_token)::int AS with_token,
          count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
          count(*) FILTER (WHERE status = 'accepted' AND access_token IS NOT NULL)::int AS accepted_with_token
        FROM public.homeowner_intro_requests
      `);
      const { rows: paySetup } = await client.query(`
        SELECT
          count(*)::int AS recipients,
          count(secure_token)::int AS with_token,
          count(*) FILTER (WHERE token_expires_at IS NULL OR token_expires_at > now())::int AS unexpired
        FROM public.external_payment_recipients
      `).catch(() => ({ rows: [{ recipients: null }] }));
      const { rows: invoices } = await client.query(`
        SELECT
          (SELECT count(*)::int FROM public.moov_invoices) AS moov_invoices,
          (SELECT count(*) FILTER (WHERE public_token IS NOT NULL)::int FROM public.moov_invoices) AS moov_with_token,
          (SELECT count(*)::int FROM public.payment_invoices) AS payment_invoices,
          (SELECT count(*) FILTER (WHERE public_token IS NOT NULL)::int FROM public.payment_invoices) AS payment_with_token
      `).catch(() => ({ rows: [{}] }));
      const { rows: paymentAccounts } = await client.query(`
        SELECT t.id::text AS tenant_id, t.name, (pa.id IS NOT NULL) AS has_payment_account
        FROM public.tenants t
        LEFT JOIN public.payment_accounts pa ON pa.tenant_id = t.id
        ORDER BY t.name
      `).catch(async () => {
        const fallback = await client.query(`
          SELECT t.id::text AS tenant_id, t.name, false AS has_payment_account
          FROM public.tenants t
          ORDER BY t.name
        `);
        return { rows: fallback.rows, error: 'payment_accounts_unreadable' };
      });
      const { rows: listedContractors } = await client.query(`
        SELECT count(*)::int AS n
        FROM public.contractor_profiles
        WHERE is_directory_listed = true AND directory_opt_in = true
      `);
      return {
        ok: true,
        step,
        totals: totals[0],
        byOrg,
        ownership: ownership[0],
        c1cSynthetic: c1cSynthetic[0] || null,
        claimTriggers: triggers,
        claimFunctions: fns.map((row) => row.proname),
        createClaimSetsOrgId: /org_id/.test(createClaimSrc || '') && /INSERT INTO public.claims/i.test(createClaimSrc || ''),
        createClaimInsertOmitsOrgId: /INSERT INTO public.claims/i.test(createClaimSrc || '') && !/\borg_id\b/.test((createClaimSrc || '').split('INSERT INTO public.claims')[1]?.slice(0, 800) || ''),
        leadTokens: leadTokens[0],
        paySetup: paySetup[0],
        invoices: invoices[0],
        paymentAccounts,
        listedContractors: listedContractors[0]?.n ?? 0,
      };
    }
    if (step === 'inspect-claim-fixtures') {
      const { rows } = await client.query(`
        SELECT
          ci.id::text AS check_id,
          ci.check_number,
          ci.tenant_id::text AS tenant_id,
          ci.claim_id::text AS claim_id,
          ci.status,
          ci.check_stage,
          (c.id IS NOT NULL) AS claim_row_exists,
          c.org_id::text AS claim_org_id
        FROM public.check_intake_items ci
        LEFT JOIN public.claims c ON c.id = ci.claim_id
        WHERE ci.claim_id IS NOT NULL
        ORDER BY (c.id IS NOT NULL) DESC, ci.updated_at DESC NULLS LAST
        LIMIT 40
      `);
      const { rows: claimCounts } = await client.query(`
        SELECT
          count(*)::int AS claims,
          count(org_id)::int AS claims_with_org_id,
          count(*) FILTER (WHERE org_id IS NULL)::int AS claims_org_id_null
        FROM public.claims
      `);
      return {
        ok: true,
        step,
        claimCount: claimCounts[0]?.claims ?? 0,
        claimsWithOrgId: claimCounts[0]?.claims_with_org_id ?? 0,
        claimsOrgIdNull: claimCounts[0]?.claims_org_id_null ?? 0,
        withClaimId: rows.length,
        withExistingClaimRow: rows.filter((row) => row.claim_row_exists).length,
        withClaimAndOrg: rows.filter((row) => row.claim_row_exists && row.claim_org_id).length,
        rows,
      };
    }
    if (step === 'inspect-c1c-identity') {
      const { rows: c1cUsers } = await client.query(`
        SELECT tu.user_id::text, tu.role, p.email AS profile_email,
               ia.cognito_sub, ia.status AS identity_status, ia.email AS identity_email
        FROM public.tenant_users tu
        LEFT JOIN public.profiles p ON p.id = tu.user_id
        LEFT JOIN public.identity_accounts ia ON ia.application_user_id = tu.user_id
        WHERE tu.tenant_id = $1::uuid
        ORDER BY coalesce(p.email, ia.email)
      `, [C1C_TENANT]);
      const { rows: adminMap } = await client.query(`
        SELECT application_user_id::text, cognito_sub, email, status
        FROM public.identity_accounts
        WHERE application_user_id = $1::uuid
           OR application_user_id = $2::uuid
           OR lower(coalesce(email, '')) IN (
             'payments@condition1commercial.com',
             'staging-master@checksops.invalid'
           )
      `, [C1C_ADMIN_ID, '7dbb3009-f059-4767-b5dc-1c5c72379330']);
      const { rows: fixture } = await client.query(`
        SELECT id::text, claim_number, org_id::text, status
        FROM public.claims
        WHERE id = '266e1ae8-ec20-4ed5-9243-3e1424304ec6'::uuid
      `);
      const { rows: orgCounts } = await client.query(`
        SELECT count(*)::int AS claims, count(org_id)::int AS with_org_id,
               count(*) FILTER (WHERE org_id IS NULL)::int AS org_id_null
        FROM public.claims
      `);
      return { ok: true, step, c1cUsers, adminMap, fixture: fixture[0] || null, orgCounts: orgCounts[0] };
    }
    if (step === 'inspect-portal-dtp') {
      const leadId = event.leadId || 'ccee4d05-835e-4015-a9bf-7f29c07945f6';
      const { rows: lead } = await client.query(`
        SELECT id::text, status,
               accepted_at IS NOT NULL AS accepted,
               dtp_signed_at IS NOT NULL AS dtp_signed,
               dtp_signed_at,
               dtp_signature_name,
               length(access_token) AS token_len
        FROM public.homeowner_intro_requests
        WHERE id = $1::uuid
      `, [leadId]);
      const { rows: uploads } = await client.query(`
        SELECT id::text, file_path, file_mime, status, created_at
        FROM public.homeowner_check_uploads
        WHERE lead_id = $1::uuid
        ORDER BY created_at DESC NULLS LAST
        LIMIT 5
      `).catch((error) => ({ rows: [{ error: String(error.message || error).slice(0, 200) }] }));
      const { rows: uploadFn } = await client.query(`
        SELECT p.proname,
               has_function_privilege('checksops', p.oid, 'EXECUTE') AS checksops_execute
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'aws_public_homeowner_check_upload_insert'
      `);
      return {
        ok: true,
        step,
        leadId,
        lead: lead[0] || null,
        uploads,
        uploadFn: uploadFn[0] || null,
      };
    }
    if (step === 'inspect-phase2-grants') {
      return { ok: true, step, ...(await inspectIntegrationGrants(client)) };
    }
    if (step === 'probe-phase2-claim-create') {
      const claimNumber = `P2-INT-ORG-${Date.now()}`;
      const runAs = async (userId, fn) => {
        await client.query('BEGIN');
        try {
          await client.query('SET LOCAL ROLE checksops');
          await client.query("SELECT set_config('request.app_user_id', $1, true)", [userId]);
          const result = await fn();
          await client.query('COMMIT');
          return { ok: true, ...result };
        } catch (error) {
          try { await client.query('ROLLBACK'); } catch { /* ignore */ }
          return {
            ok: false,
            denied: /row-level security|permission denied|not allowed|not authorized|org_id/i.test(String(error?.message || '')),
            error: String(error?.message || error).slice(0, 240),
          };
        }
      };
      const c1cInsert = await runAs(C1C_ADMIN_ID, async () => {
        const rows = (await client.query(
          `INSERT INTO public.claims (claim_number, status, org_id)
           VALUES ($1, 'tracking', $2::uuid)
           RETURNING id::text, claim_number, status, org_id::text`,
          [claimNumber, C1C_TENANT],
        )).rows;
        return { rows };
      });
      const freedomSpoof = await runAs(TESTER_ID, async () => {
        const rows = (await client.query(
          `INSERT INTO public.claims (claim_number, status, org_id)
           VALUES ($1, 'tracking', $2::uuid)
           RETURNING id::text, org_id::text`,
          [`${claimNumber}-FREEDOM`, C1C_TENANT],
        )).rows;
        return { rows };
      });
      const ninthInsert = await runAs(NINTH_ID, async () => {
        const rows = (await client.query(
          `INSERT INTO public.claims (claim_number, status, org_id)
           VALUES ($1, 'tracking', $2::uuid)
           RETURNING id::text`,
          [`${claimNumber}-NINTH`, C1C_TENANT],
        )).rows;
        return { rows };
      });
      if (c1cInsert.rows?.[0]?.id) {
        await client.query('DELETE FROM public.claims WHERE id = $1::uuid', [c1cInsert.rows[0].id]);
      }
      const { rows: leftover } = await client.query(
        'SELECT id::text FROM public.claims WHERE claim_number LIKE $1',
        [`${claimNumber}%`],
      );
      return {
        ok: Boolean(c1cInsert.ok && c1cInsert.rows?.[0]?.org_id === C1C_TENANT)
          && (freedomSpoof.denied === true || (freedomSpoof.ok && !freedomSpoof.rows?.length))
          && (ninthInsert.denied === true || (ninthInsert.ok && !ninthInsert.rows?.length))
          && leftover.length === 0,
        step,
        claimNumber,
        c1cInsert,
        freedomSpoof,
        ninthInsert,
        leftover,
      };
    }
    if (step === 'grant-sign-dtp') {
      await client.query(readSql(SQL_DIR, '42_public_homeowner_claim_sign_dtp.sql'));
      const { rows } = await client.query(`
        SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
               has_function_privilege('checksops', p.oid, 'EXECUTE') AS checksops_execute,
               has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'aws_public_homeowner_claim_sign_dtp'
      `);
      return {
        ok: rows.length === 1 && rows[0].checksops_execute === true,
        step,
        fn: rows[0] || null,
      };
    }
    if (step === 'grant-claim-settlements') {
      const before = await inspectIntegrationGrants(client);
      await client.query(readSql(SQL_DIR, '40_claim_settlements_grant.sql'));
      const after = await inspectIntegrationGrants(client);
      const ok = after.settlementInsertGranted
        && after.settlementUpdateGranted
        && after.intakeClaimIdStillDenied
        && after.paymentWritesStillDenied
        && after.walletWritesStillDenied;
      return { ok, step, before, after };
    }
    const before = await financialAggregates(client);
    await client.query(readSql(SQL_DIR, '33_tranche2_write_grants.sql'));
    await client.query(readSql(SQL_DIR, '35_tranche3_write_grants.sql'));
    const privileges = await tablePrivileges(client);
    const ninth = await ninthWriteDenied(client);
    const after = await financialAggregates(client);
    const financialUnchanged = JSON.stringify(before) === JSON.stringify(after);
    const intakeCols = await intakeUpdateColumns(client);
    const amountNotGranted = !intakeCols.includes('amount') && !intakeCols.includes('routing_number') && !intakeCols.includes('status');
    const imagePathsGranted = intakeCols.includes('front_image_path') && intakeCols.includes('back_image_path');
    const messagesInsertGranted = privileges.some((row) => (
      row.table_name === 'check_messages' && row.grantee === 'checksops' && row.privilege_type === 'INSERT'
    ));
    const filesInsertGranted = privileges.some((row) => (
      row.table_name === 'check_files' && row.grantee === 'checksops' && row.privilege_type === 'INSERT'
    ));
    const claimChecksUpdateGranted = privileges.some((row) => (
      row.table_name === 'claim_checks' && row.grantee === 'checksops' && row.privilege_type === 'UPDATE'
    ));
    const financialStillSelectOnly = !privileges.some((row) => (
      ['claim_payments', 'homeowner_ledger_events'].includes(row.table_name)
      && ['INSERT', 'UPDATE', 'DELETE'].includes(row.privilege_type)
    ));
    return {
      ok: ninth.denied && financialUnchanged && amountNotGranted
        && messagesInsertGranted && filesInsertGranted && claimChecksUpdateGranted
        && imagePathsGranted && financialStillSelectOnly,
      step,
      ninth,
      financialUnchanged,
      amountNotGranted,
      imagePathsGranted,
      intakeUpdateColumns: intakeCols,
      messagesInsertGranted,
      filesInsertGranted,
      claimChecksUpdateGranted,
      financialStillSelectOnly,
      financial: after,
      privileges,
    };
  } finally {
    await client.end();
  }
};

