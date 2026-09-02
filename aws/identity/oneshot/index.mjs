import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  NINTH_ID,
  PROBE_SUB,
  applyLinks,
  clearIsolatedTest,
  isolationMatrix,
  ninthStatus,
  policySnapshot,
  reconcileKnownUsers,
} from './onboard.mjs';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(ROOT, '..', 'sql');
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
    database,
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 8000,
    query_timeout: 120000,
  });
  await client.connect();
  return client;
};

export const handler = async (event = {}) => {
  const step = event.step || 'reconcile';
  const out = {
    ok: false,
    step,
    productionSupabaseChanged: false,
    database: 'checksops',
    realInvitationEmailsSent: false,
    ninthUuidModified: false,
  };
  let client;
  try {
    client = await adminClient('checksops');
    const db = (await client.query('SELECT current_database() AS d, current_user AS u')).rows[0];
    if (db.d !== 'checksops') throw new Error(`connected to ${db.d}, expected checksops`);
    out.connectedAs = db.u;
    out.policies = await policySnapshot(client);
    out.ninth = await ninthStatus(client);

    if (step === 'inventory' || step === 'all') {
      out.inventory = (await client.query(readSql('04_inventory.sql'))).rows;
    }
    if (step === 'reconcile' || step === 'onboard' || step === 'all') {
      out.reconcile = await reconcileKnownUsers(client);
    }
    if (step === 'clearProbe' || step === 'onboard' || step === 'unlink_isolated_test') {
      out.clearProbe = await clearIsolatedTest(client);
    }
    if (step === 'applyLinks' || step === 'onboard') {
      out.links = await applyLinks(client, event.links || []);
      out.ninth = await ninthStatus(client);
      out.policies = await policySnapshot(client);
    }
    if (step === 'isolation' || step === 'onboard') {
      const users = (event.users || out.reconcile?.eligible || []).map((row) => ({
        applicationUserId: row.applicationUserId || row.application_user_id,
        email: row.email,
        tenants: row.tenants || [],
        appRoles: row.appRoles || row.app_roles || [],
      }));
      out.isolation = await isolationMatrix(client, users);
      out.ninth = await ninthStatus(client);
    }
    if (step === 'verifyProbeGone') {
      const probe = (await client.query(
        `SELECT application_user_id::text AS application_user_id, status
         FROM public.identity_accounts WHERE cognito_sub = $1`,
        [PROBE_SUB],
      )).rows;
      const isolated = Number((await client.query(
        `SELECT count(*)::int AS n FROM public.identity_accounts WHERE status = 'isolated_test'`,
      )).rows[0].n);
      out.probeGone = { probeSubRows: probe, isolatedTestRows: isolated, pass: probe.length === 0 && isolated === 0 };
    }

    out.ninthUuidModified = out.ninth?.identity?.cognito_sub != null
      || out.ninth?.identity?.email != null
      || out.ninth?.identity?.application_user_id !== NINTH_ID;
    out.ok = !out.error
      && out.policies?.pass === true
      && out.ninth?.pass === true
      && (out.reconcile ? out.reconcile.pass : true)
      && (out.clearProbe ? out.clearProbe.pass : true)
      && (out.links ? out.links.pass : true)
      && (out.isolation ? out.isolation.pass : true)
      && (out.probeGone ? out.probeGone.pass : true)
      && out.realInvitationEmailsSent === false
      && out.ninthUuidModified === false;
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
