import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const SQL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sql', '01_public_token_lookup.sql');

const loadAdmin = async () => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn) throw new Error('ADMIN_SECRET_ARN is required');
  const client = new SecretsManagerClient({});
  const out = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(out.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) {
    throw new Error('refusing non-admin secret');
  }
  const host = parsed.host || parsed.hostname || parsed.endpoint || process.env.RDS_HOST;
  if (!host) throw new Error(`admin secret is missing host (keys=${Object.keys(parsed).join(',')})`);
  return {
    username: parsed.username,
    password: parsed.password,
    host,
    port: Number(parsed.port || 5432),
    database: parsed.dbname || parsed.database || process.env.DATABASE_NAME || 'checksops',
  };
};

export const handler = async () => {
  const credentials = await loadAdmin();
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  delete process.env.PGHOST;
  delete process.env.PGPORT;
  const client = new Client({
    host: credentials.host,
    port: credentials.port || 5432,
    user: credentials.username,
    password: credentials.password,
    database: process.env.DATABASE_NAME || credentials.database || 'checksops',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'rds-global-bundle.pem'), 'utf8') },
    connectionTimeoutMillis: 8000,
  });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(sql);
    const check = await client.query(`
      SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('aws_public_signature_by_token_hash', 'aws_public_endorsement_by_token')
      ORDER BY 1
    `);
    await client.query('COMMIT');
    return {
      ok: true,
      functions: check.rows.map((r) => r.proname),
      productionSupabaseChanged: false,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return {
      ok: false,
      error: String(error.message || error).slice(0, 500),
      hostSuffix: String(credentials.host || '').slice(-40),
      pghost: process.env.PGHOST || null,
    };
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
};
