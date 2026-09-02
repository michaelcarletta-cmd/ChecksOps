import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(ROOT, 'sql');
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');

const readSql = (name) => fs.readFileSync(path.join(SQL_DIR, name), 'utf8');

const adminClient = async (database) => {
  const arn = process.env.ADMIN_SECRET_ARN;
  if (!arn) throw new Error('ADMIN_SECRET_ARN is not configured');
  if (!/checksops_admin/i.test(arn)) throw new Error('ADMIN_SECRET_ARN must be the checksops_admin secret');
  const sm = new SecretsManagerClient({});
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
  const parsed = JSON.parse(secret.SecretString);
  if (!/checksops_admin/i.test(parsed.username || '')) {
    throw new Error('secret username is not checksops_admin');
  }
  const host = parsed.host || parsed.hostname || process.env.RDS_HOST;
  if (!host || host === 'localhost' || host === '127.0.0.1') {
    throw new Error('admin secret host is missing or loopback');
  }
  const client = new Client({
    host,
    port: Number(parsed.port || 5432),
    user: parsed.username,
    password: parsed.password,
    database,
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000,
    query_timeout: 20000,
  });
  await client.connect();
  return client;
};

const runStatements = async (client, sql) => {
  await client.query(sql);
};

export const handler = async (event = {}) => {
  const step = event.step || 'all';
  const out = { ok: false, step, productionSupabaseChanged: false, database: 'checksops' };
  let client;
  try {
    client = await adminClient('checksops');
    const db = (await client.query('SELECT current_database() AS d, current_user AS u')).rows[0];
    if (db.d !== 'checksops') throw new Error(`connected to ${db.d}, expected checksops`);
    out.connectedAs = db.u;

    if (step === 'inventory' || step === 'all') {
      out.inventory = (await client.query(readSql('04_inventory.sql'))).rows;
    }
    if (step === 'classify' || step === 'all') {
      out.functions = (await client.query(readSql('05_classify_auth_uid_functions.sql'))).rows;
    }
    if (step === 'ddl' || step === 'all') {
      await runStatements(client, readSql('01_identity_accounts.sql'));
      await runStatements(client, readSql('02_auth_uid_guc.sql'));
      await runStatements(client, readSql('03_grants.sql'));
      await runStatements(client, readSql('07_seed_pending.sql'));
      out.ddlApplied = true;
      out.identityAccounts = Number((await client.query(
        'SELECT count(*)::int AS n FROM public.identity_accounts',
      )).rows[0].n);
    }
    if (step === 'link_isolated_test') {
      const sub = event.cognitoSub;
      const appId = event.applicationUserId;
      if (!sub || !appId) throw new Error('cognitoSub and applicationUserId are required');
      if (String(sub) === String(appId)) throw new Error('refusing to set cognito_sub equal to application_user_id');
      const updated = await client.query(
        `UPDATE public.identity_accounts
         SET cognito_sub = $1,
             status = 'isolated_test',
             linked_at = now()
         WHERE application_user_id = $2::uuid
           AND status IN ('pending', 'isolated_test')
         RETURNING application_user_id::text AS application_user_id, status, email`,
        [sub, appId],
      );
      out.linked = updated.rows[0] || null;
      if (!out.linked) throw new Error('no pending identity_accounts row for that application_user_id');
    }
    if (step === 'unlink_isolated_test') {
      const appId = event.applicationUserId;
      const updated = await client.query(
        `UPDATE public.identity_accounts
         SET cognito_sub = NULL,
             status = 'pending',
             linked_at = NULL
         WHERE application_user_id = $1::uuid
           AND status = 'isolated_test'
         RETURNING application_user_id::text AS application_user_id, status`,
        [appId],
      );
      out.unlinked = updated.rows[0] || null;
    }
    out.ok = true;
    return out;
  } catch (error) {
    out.error = String(error?.message || error)
      .replace(/password\s*=\s*\S+/gi, 'password=redacted');
    return out;
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};
