/**
 * Staging-only apply of 72_external_recording_grants.sql.
 * Does not enable Moov/CheckAlt and does not apply 64_financial_activation_grants.sql.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL_PATH = [
  path.join(ROOT, 'sql', '72_external_recording_grants.sql'),
  path.join(ROOT, '..', 'sql', '72_external_recording_grants.sql'),
].find((p) => fs.existsSync(p));
const CA_PATH = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  path.join(ROOT, '..', '..', 'functions', 'api', 'rds-global-bundle.pem'),
].find((p) => fs.existsSync(p));

const TABLES = [
  'deposit_items',
  'deposit_batches',
  'deposit_audit_log',
  'disbursement_batches',
  'disbursement_splits',
];

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
    query_timeout: 60000,
  });
  await client.connect();
  return client;
};

const privileges = async (client) => {
  const { rows } = await client.query(`
    SELECT grantee, table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
      AND grantee IN ('checksops', 'authenticated')
    ORDER BY table_name, grantee, privilege_type
  `, [TABLES]);
  return rows;
};

export const handler = async () => {
  if (!SQL_PATH) throw new Error('72_external_recording_grants.sql missing');
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  if (/\bGRANT\b[\s\S]{0,120}(checkalt_deposits|payment_transfers|64_financial_activation)/i.test(sql)) {
    throw new Error('refusing to apply SQL that grants financial-activation or provider tables');
  }
  const client = await adminClient();
  try {
    const before = await privileges(client);
    const grantSql = sql
      .split(/DROP POLICY/i)[0]
      .trim();
    await client.query(grantSql);
    let policy = { applied: false };
    try {
      await client.query(sql.slice(sql.indexOf('DROP POLICY')));
      policy = { applied: true };
    } catch (error) {
      policy = { applied: false, error: String(error?.message || error).slice(0, 240) };
    }
    const after = await privileges(client);
    const granted = (table, priv) => after.some((row) => (
      row.table_name === table && row.grantee === 'checksops' && row.privilege_type === priv
    ));
    const moneyTablesUntouched = !after.some((row) => (
      ['checkalt_deposits', 'payment_transfers', 'moov_transfers'].includes(row.table_name)
    ));
    return {
      ok: granted('deposit_items', 'INSERT')
        && granted('deposit_items', 'UPDATE')
        && granted('disbursement_batches', 'INSERT')
        && granted('disbursement_splits', 'INSERT')
        && moneyTablesUntouched,
      applied: '72_external_recording_grants.sql',
      policy,
      productionTargeted: false,
      providerExecution: false,
      beforeCount: before.length,
      afterCount: after.length,
      after,
    };
  } finally {
    await client.end();
  }
};
