import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(ROOT, '..', 'sql');
const RLS_SQL_DIR = path.join(ROOT, '..', '..', 'rls', 'sql');
const CA_PATH = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  path.join(ROOT, '..', '..', 'functions', 'api', 'rds-global-bundle.pem'),
  path.join(ROOT, '..', '..', 'write-path', 'oneshot', 'rds-global-bundle.pem'),
].find((p) => fs.existsSync(p));

export const NINTH_ID = 'dd24eea5-5d12-47d1-999e-d5930c278b7d';
export const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';

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

const financialAggregates = async (client) => {
  const sql = readSql(RLS_SQL_DIR, '28_financial_aggregates.sql');
  const { rows } = await client.query(sql);
  const out = {};
  for (const row of rows) out[row.metric] = String(row.value);
  return out;
};

const tablePrivileges = async (client) => {
  const { rows } = await client.query(`
    SELECT grantee, table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN (
        'check_intake_items', 'loss_draft_tracking', 'mortgage_handling_requests',
        'loss_draft_audit_log', 'claim_payments', 'homeowner_ledger_events',
        'checkalt_deposits', 'payment_transfers'
      )
      AND grantee IN ('checksops', 'authenticated')
    ORDER BY table_name, grantee, privilege_type
  `);
  return rows;
};

const ninthWriteDenied = async (client) => {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE checksops');
    await client.query("SELECT set_config('request.app_user_id', $1, true)", [NINTH_ID]);
    const inserted = await client.query(`
      INSERT INTO public.check_intake_items (front_image_path, tenant_id)
      VALUES ('checks/ninth-denied/pending_front.jpg', $1::uuid)
      RETURNING id
    `, [FREEDOM_TENANT]);
    await client.query('ROLLBACK');
    return { denied: inserted.rowCount === 0, n: inserted.rowCount };
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
    if (step === 'revoke') {
      await client.query(readSql(SQL_DIR, '51_tranche5_revoke_write_grants.sql'));
      return { ok: true, revoked: true, privileges: await tablePrivileges(client) };
    }
    if (step === 'cleanup-t5') {
      const marker = event?.marker || 'AWS T5 TEST%';
      const found = await client.query(`
        SELECT id FROM public.check_intake_items
        WHERE claim_id IS NULL
          AND (
            carrier_name LIKE $1
            OR review_notes LIKE $1
            OR front_image_path LIKE 'checks/%/aws-t5-test%'
          )
      `, [marker]);
      const ids = found.rows.map((row) => row.id);
      if (!ids.length) return { ok: true, deleted: 0 };
      await client.query('DELETE FROM public.check_endorsement_events WHERE check_id = ANY($1::uuid[])', [ids]);
      await client.query('DELETE FROM public.check_endorsements WHERE check_id = ANY($1::uuid[])', [ids]);
      await client.query('DELETE FROM public.check_payees WHERE check_id = ANY($1::uuid[])', [ids]);
      await client.query('DELETE FROM public.check_messages WHERE check_id = ANY($1::uuid[])', [ids]);
      await client.query('DELETE FROM public.check_files WHERE check_intake_item_id = ANY($1::uuid[])', [ids]);
      await client.query('DELETE FROM public.check_message_reads WHERE check_id = ANY($1::uuid[])', [ids]);
      await client.query('DELETE FROM public.check_audit_log WHERE check_id = ANY($1::uuid[])', [ids]);
      await client.query('DELETE FROM public.mortgage_handling_requests WHERE check_intake_item_id = ANY($1::uuid[])', [ids]);
      const drafts = (await client.query(
        'SELECT id FROM public.loss_draft_tracking WHERE check_intake_item_id = ANY($1::uuid[])',
        [ids],
      )).rows.map((row) => row.id);
      if (drafts.length) {
        await client.query('DELETE FROM public.loss_draft_audit_log WHERE loss_draft_id = ANY($1::uuid[])', [drafts]);
        await client.query('DELETE FROM public.loss_draft_documents WHERE loss_draft_id = ANY($1::uuid[])', [drafts]);
        await client.query('DELETE FROM public.loss_draft_tracking WHERE id = ANY($1::uuid[])', [drafts]);
      }
      await client.query('DELETE FROM public.check_review_decisions WHERE check_id = ANY($1::uuid[])', [ids]);
      await client.query('DELETE FROM public.check_status_audit WHERE check_intake_item_id = ANY($1::uuid[])', [ids]);
      const deleted = await client.query(
        'DELETE FROM public.check_intake_items WHERE id = ANY($1::uuid[]) RETURNING id',
        [ids],
      );
      return { ok: true, deleted: deleted.rowCount, ids: deleted.rows.map((row) => row.id) };
    }
    const before = await financialAggregates(client);
    await client.query(readSql(SQL_DIR, '50_tranche5_write_grants.sql'));
    const privileges = await tablePrivileges(client);
    const ninth = await ninthWriteDenied(client);
    const after = await financialAggregates(client);
    const financialUnchanged = JSON.stringify(before) === JSON.stringify(after);
    const insertGranted = privileges.some((row) => (
      row.table_name === 'check_intake_items' && row.grantee === 'checksops' && row.privilege_type === 'INSERT'
    ));
    const financialStillSelectOnly = !privileges.some((row) => (
      ['claim_payments', 'homeowner_ledger_events', 'checkalt_deposits', 'payment_transfers'].includes(row.table_name)
      && ['INSERT', 'UPDATE', 'DELETE'].includes(row.privilege_type)
    ));
    return {
      ok: ninth.denied && financialUnchanged && insertGranted && financialStillSelectOnly,
      step,
      ninth,
      financialUnchanged,
      insertGranted,
      financialStillSelectOnly,
      financial: after,
      privileges,
    };
  } finally {
    await client.end();
  }
};
