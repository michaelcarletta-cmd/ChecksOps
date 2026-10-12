/**
 * Temporary in-VPC oneshot: apply hire-mortgage-agent SECURITY DEFINER provisioning function.
 * Delete this Lambda + IAM role after invoke.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL_PATH = path.join(ROOT, '..', 'sql', '12_hire_mortgage_agent_provision_rpc.sql');
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');

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
  const out = {
    ok: false,
    productionSupabaseChanged: false,
    applied: '12_hire_mortgage_agent_provision_rpc.sql',
  };
  let client;
  try {
    client = await adminClient();
    const db = (await client.query('SELECT current_database() AS d, current_user AS u')).rows[0];
    out.connectedAs = db.u;
    out.database = db.d;
    if (db.d !== 'checksops') throw new Error(`expected checksops, got ${db.d}`);
    const sql = fs.readFileSync(SQL_PATH, 'utf8');
    await client.query(sql);
    const fn = (await client.query(
      `SELECT p.proname,
              pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='aws_hire_mortgage_agent_provision'`,
    )).rows;
    out.function = fn;
    out.ok = fn.length === 1;
    return out;
  } catch (error) {
    out.error = String(error?.message || error).slice(0, 400);
    return out;
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};

