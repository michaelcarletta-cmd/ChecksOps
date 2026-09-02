import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(ROOT, '..', 'sql');
const RLS_SQL_DIR = path.join(ROOT, '..', '..', 'rls', 'sql');
const CA_PATH = path.join(ROOT, '..', '..', 'functions', 'api', 'rds-global-bundle.pem');

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
      AND table_name IN ('check_message_reads', 'notification_preferences', 'check_intake_items', 'claim_payments')
      AND grantee IN ('checksops', 'authenticated')
    ORDER BY table_name, grantee, privilege_type
  `);
  return rows;
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
    const inserted = await client.query(`
      INSERT INTO public.notification_preferences (user_id, in_app_enabled, email_enabled, sms_enabled)
      VALUES ($1::uuid, false, false, false)
      RETURNING user_id
    `, [NINTH_ID]);
    await client.query('ROLLBACK');
    return { denied: false, n: inserted.rowCount };
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
      await client.query(readSql(SQL_DIR, '32_tranche1_revoke_write_grants.sql'));
      return { ok: true, revoked: true, privileges: await tablePrivileges(client) };
    }
    const before = await financialAggregates(client);
    await client.query(readSql(SQL_DIR, '31_tranche1_write_grants.sql'));
    const privileges = await tablePrivileges(client);
    const ninth = await ninthWriteDenied(client);
    const after = await financialAggregates(client);
    const financialUnchanged = JSON.stringify(before) === JSON.stringify(after);
    const dmlGranted = privileges.filter((row) => (
      ['check_message_reads', 'notification_preferences'].includes(row.table_name)
      && row.grantee === 'checksops'
      && ['INSERT', 'UPDATE', 'DELETE'].includes(row.privilege_type)
    ));
    const financialStillSelectOnly = !privileges.some((row) => (
      ['check_intake_items', 'claim_payments'].includes(row.table_name)
      && ['INSERT', 'UPDATE', 'DELETE'].includes(row.privilege_type)
    ));
    return {
      ok: dmlGranted.length >= 6 && ninth.denied && financialUnchanged && financialStillSelectOnly,
      step,
      dmlGranted: dmlGranted.length,
      ninth,
      financialUnchanged,
      financialStillSelectOnly,
      financial: after,
      privileges,
    };
  } finally {
    await client.end();
  }
};
