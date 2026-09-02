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

