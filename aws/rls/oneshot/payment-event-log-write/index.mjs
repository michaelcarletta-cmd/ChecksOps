/**
 * Apply 43_payment_event_log_write.sql on the target AWS RDS database.
 * Verifies the INSERT policy exists. Does not disable RLS.
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
  path.join(ROOT, '..', 'rds-global-bundle.pem'),
].find((file) => fs.existsSync(file));
const SQL = fs.readFileSync(path.join(ROOT, '43_payment_event_log_write.sql'), 'utf8');

const adminClient = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn || !/checksops_admin/i.test(arn)) throw new Error('ADMIN_SECRET_ARN must be checksops_admin');
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  const expectedHost = process.env.RDS_HOST || null;
  const host = parsed.host && parsed.host !== 'localhost' ? parsed.host : expectedHost;
  if (expectedHost && host && host !== expectedHost) {
    throw new Error('admin_secret_host_mismatch');
  }
  const client = new Client({
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
    database: process.env.DATABASE_NAME || 'checksops',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000,
    query_timeout: 60000,
  });
  await client.connect();
  return client;
};

export const handler = async () => {
  let client;
  try {
    client = await adminClient();
    await client.query('BEGIN');
    await client.query(SQL);
    const policy = (await client.query(`
      SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr,
             pg_get_expr(polwithcheck, polrelid) AS with_check
      FROM pg_policy
      WHERE polrelid = 'public.payment_event_log'::regclass
        AND polname = 'aws_write_payment_event_log'
    `)).rows[0] || null;
    const grants = (await client.query(`
      SELECT grantee, privilege_type
      FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'payment_event_log'
        AND privilege_type = 'INSERT'
      ORDER BY 1
    `)).rows;
    if (!policy) throw new Error('policy_missing');
    await client.query('COMMIT');

    const isolation = {
      noIdentityDenied: false,
      spoofTenantDenied: false,
      noIdentitySqlstate: null,
      spoofTenantSqlstate: null,
    };
    const spoofTenant = '00000000-0000-4000-8000-000000000099';
    const isolationSql = `
      INSERT INTO public.payment_event_log
        (provider, environment, tenant_id, event_type, new_status)
      VALUES ('moov', 'sandbox', $1::uuid, 'invoice.inv6_isolation_probe', 'denied')`;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE checksops');
      try {
        await client.query(isolationSql, [spoofTenant]);
      } catch (error) {
        isolation.noIdentityDenied = error?.code === '42501';
        isolation.noIdentitySqlstate = error?.code || null;
      }
      await client.query('ROLLBACK');
    } catch {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE checksops');
      await client.query("SELECT set_config('request.app_user_id', $1, true)", [
        '00000000-0000-4000-8000-000000000001',
      ]);
      try {
        await client.query(isolationSql, [spoofTenant]);
      } catch (error) {
        isolation.spoofTenantDenied = error?.code === '42501';
        isolation.spoofTenantSqlstate = error?.code || null;
      }
      await client.query('ROLLBACK');
    } catch {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    }

    return {
      ok: true,
      database: process.env.DATABASE_NAME || 'checksops',
      policy,
      insertGrants: grants,
      isolation,
      rlsDisabled: false,
    };
  } catch (error) {
    try { if (client) await client.query('ROLLBACK'); } catch { /* ignore */ }
    return { ok: false, error: String(error.message || error).slice(0, 500) };
  } finally {
    try { if (client) await client.end(); } catch { /* ignore */ }
  }
};
