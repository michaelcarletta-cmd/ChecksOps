/**
 * Temporary in-VPC oneshot: sanitized staging inventory for migration rehearsal.
 * READ-ONLY queries against database `checksops`. No production access.
 * Delete Lambda + IAM role after invoke.
 *
 * Emits counts, financial aggregates, identity mapping stats, FK violation
 * counts — never emails, names, account numbers, or document paths.
 */
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
    query_timeout: 180000,
  });
  await client.connect();
  return client;
};

const catalog = async (client) => {
  const q = async (sql) => (await client.query(sql)).rows[0];
  const base = await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`);
  const views = await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='VIEW'`);
  const routines = await q(`SELECT count(*)::int AS n FROM information_schema.routines WHERE routine_schema='public'`);
  const triggers = await q(`SELECT count(*)::int AS n FROM information_schema.triggers WHERE trigger_schema='public'`);
  const rls = await q(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public'`);
  const ext = (await client.query(`SELECT extname FROM pg_extension ORDER BY 1`)).rows.map((r) => r.extname);
  const identityExists = (await client.query(
    `SELECT to_regclass('public.identity_accounts') IS NOT NULL AS ok`,
  )).rows[0].ok;
  return {
    baseTables: base.n,
    views: views.n,
    routines: routines.n,
    triggers: triggers.n,
    rlsPolicies: rls.n,
    extensions: ext,
    identityAccountsTablePresent: identityExists,
  };
};

const identityStats = async (client) => {
  const exists = (await client.query(
    `SELECT to_regclass('public.identity_accounts') IS NOT NULL AS ok`,
  )).rows[0].ok;
  if (!exists) return { present: false };
  const rows = (await client.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'active')::int AS active,
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (WHERE status = 'isolated_test')::int AS isolated_test,
      count(*) FILTER (WHERE cognito_sub IS NOT NULL)::int AS with_cognito_sub,
      count(*) FILTER (WHERE cognito_sub IS NOT NULL AND cognito_sub = application_user_id::text)::int AS unsafe_sub_eq_app
    FROM public.identity_accounts
  `)).rows[0];
  const roles = (await client.query(`
    SELECT role, count(*)::int AS n
    FROM public.user_roles
    GROUP BY role
    ORDER BY role
  `)).rows;
  const tenants = (await client.query(`
    SELECT count(*)::int AS tenants
    FROM public.tenants
  `)).rows[0];
  return {
    present: true,
    ...rows,
    rolesByName: Object.fromEntries(roles.map((r) => [r.role, r.n])),
    tenants: tenants.tenants,
  };
};

const fkViolations = async (client) => {
  // Sample critical FKs without exposing IDs — count orphans only.
  const checks = [
    {
      name: 'check_endorsements_check_id',
      sql: `SELECT count(*)::int AS n FROM public.check_endorsements e
            LEFT JOIN public.check_intake_items i ON i.id = e.check_id
            WHERE e.check_id IS NOT NULL AND i.id IS NULL`,
    },
    {
      name: 'deposit_items_batch_id',
      sql: `SELECT count(*)::int AS n FROM public.deposit_items d
            LEFT JOIN public.deposit_batches b ON b.id = d.batch_id
            WHERE d.batch_id IS NOT NULL AND b.id IS NULL`,
    },
    {
      name: 'disbursement_splits_batch_id',
      sql: `SELECT count(*)::int AS n FROM public.disbursement_splits s
            LEFT JOIN public.disbursement_batches b ON b.id = s.batch_id
            WHERE s.batch_id IS NOT NULL AND b.id IS NULL`,
    },
    {
      name: 'user_roles_user_id_identity',
      sql: `SELECT count(*)::int AS n FROM public.user_roles ur
            LEFT JOIN public.identity_accounts ia ON ia.application_user_id = ur.user_id
            WHERE to_regclass('public.identity_accounts') IS NOT NULL
              AND ia.application_user_id IS NULL`,
    },
    {
      name: 'profiles_id_identity',
      sql: `SELECT count(*)::int AS n FROM public.profiles p
            LEFT JOIN public.identity_accounts ia ON ia.application_user_id = p.id
            WHERE to_regclass('public.identity_accounts') IS NOT NULL
              AND ia.application_user_id IS NULL`,
    },
  ];
  const out = {};
  for (const c of checks) {
    try {
      out[c.name] = (await client.query(c.sql)).rows[0].n;
    } catch (error) {
      out[c.name] = { error: String(error.message || error).slice(0, 120) };
    }
  }
  return out;
};

const stagingOnlyMarkers = async (client) => {
  const markers = {};
  for (const table of [
    'identity_accounts',
    '_checksops_restore_complete',
    'aws_provider_sandbox_operations',
    'homeowner_upload_otp_sessions',
  ]) {
    const reg = (await client.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`])).rows[0].ok;
    if (!reg) {
      markers[table] = { present: false };
      continue;
    }
    const n = (await client.query(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0].n;
    markers[table] = { present: true, rows: n };
  }
  return markers;
};

export const handler = async () => {
  const out = {
    ok: false,
    productionSupabaseChanged: false,
    productionCutoverPerformed: false,
    providerFlagsTouched: false,
    database: 'checksops',
    inventoriedAt: new Date().toISOString(),
    baselineReference: 'checksops_260901 (2026-09-01)',
  };
  let client;
  try {
    client = await adminClient();
    const db = (await client.query('SELECT current_database() AS d, current_user AS u, version() AS v')).rows[0];
    if (db.d !== 'checksops') throw new Error(`connected to ${db.d}, expected checksops`);
    out.connectedAs = db.u;
    out.postgresqlVersion = String(db.v).split(',')[0];

    out.catalog = await catalog(client);

    const countsSql = readSql('reconciliation_counts.sql');
    const countRows = (await client.query(countsSql)).rows;
    out.tableCounts = Object.fromEntries(countRows.map((r) => [r.table_name, Number(r.row_count)]));
    out.tableCountTotal = countRows.length;
    out.tablesWithRows = countRows.filter((r) => Number(r.row_count) > 0).length;

    const finSql = readSql('reconciliation_financial.sql');
    const finRows = (await client.query(finSql)).rows;
    out.financialAggregates = Object.fromEntries(finRows.map((r) => [r.metric, String(r.value)]));

    out.identity = await identityStats(client);
    out.fkOrphanCounts = await fkViolations(client);
    out.stagingOnlyMarkers = await stagingOnlyMarkers(client);

    out.ok = true;
    return out;
  } catch (error) {
    out.error = String(error.message || error).slice(0, 400);
    return out;
  } finally {
    if (client) {
      try { await client.end(); } catch { /* ignore */ }
    }
  }
};
