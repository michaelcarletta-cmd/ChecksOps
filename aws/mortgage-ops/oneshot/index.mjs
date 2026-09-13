import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RLS_SQL = path.join(ROOT, '..', '..', 'rls', 'sql', '29_mortgage_ops_agent_access.sql');
const GRANT_SQL = path.join(ROOT, '..', '..', 'workflows', 'sql', '52_mortgage_ops_staff_grants.sql');
const FINANCIAL_SQL = path.join(ROOT, '..', '..', 'rls', 'sql', '28_financial_aggregates.sql');
const CA_PATH = [
  path.join(ROOT, 'rds-global-bundle.pem'),
  path.join(ROOT, '..', '..', 'rls', 'oneshot', 'rds-global-bundle.pem'),
  path.join(ROOT, '..', '..', 'functions', 'api', 'rds-global-bundle.pem'),
].find((p) => fs.existsSync(p));

const AGENT_ID = 'b100f05d-9e81-4a7b-b9cc-9baf173131d9';
const C1C_ADMIN_ID = 'fd857564-9534-4b0f-95ac-624ed1273725';
const FREEDOM_STAFF_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const OWNER_ID = '233c588f-dc33-4307-8c3f-3da49c9fd2b3';
const NINTH_ID = 'dd24eea5-5d12-47d1-999e-d5930c278b7d';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';

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
  const { rows } = await client.query(fs.readFileSync(FINANCIAL_SQL, 'utf8'));
  const out = {};
  for (const row of rows) out[row.metric] = String(row.value);
  return out;
};

const asChecksops = async (client, appUserId, sql, params = []) => {
  await client.query('SAVEPOINT mortgage_ops_probe');
  try {
    await client.query('SET LOCAL ROLE checksops');
    if (appUserId) {
      await client.query("SELECT set_config('request.app_user_id', $1, true)", [appUserId]);
    } else {
      await client.query("SELECT set_config('request.app_user_id', '', true)");
    }
    const result = await client.query(sql, params);
    await client.query('ROLLBACK TO SAVEPOINT mortgage_ops_probe');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK TO SAVEPOINT mortgage_ops_probe'); } catch { /* ignore */ }
    throw error;
  }
};

const tryAsChecksops = async (client, appUserId, sql, params = []) => {
  try {
    const result = await asChecksops(client, appUserId, sql, params);
    return { ok: true, rowCount: result.rowCount, rows: result.rows };
  } catch (error) {
    return {
      ok: false,
      denied: /row-level security|permission denied/i.test(String(error?.message || '')),
      error: String(error?.message || error).slice(0, 240),
    };
  }
};

export const handler = async (event = {}) => {
  const step = event.step || event.queryStringParameters?.step || 'apply';
  const client = await adminClient();
  const out = {
    ok: false,
    step,
    productionSupabaseChanged: false,
    providerExecution: false,
    sesSendEmail: false,
  };
  try {
    const db = (await client.query('SELECT current_database() AS d, current_user AS u')).rows[0];
    if (db.d !== 'checksops') throw new Error(`connected to ${db.d}, expected checksops`);
    if (!/checksops_admin/i.test(db.u)) throw new Error(`connected as ${db.u}, expected checksops_admin`);
    out.connectedAs = db.u;

    const before = await financialAggregates(client);
    if (step === 'apply' || step === 'all') {
      await client.query(fs.readFileSync(RLS_SQL, 'utf8'));
      await client.query(fs.readFileSync(GRANT_SQL, 'utf8'));
      out.applied = true;
    }
    const after = await financialAggregates(client);
    out.financialUnchanged = JSON.stringify(before) === JSON.stringify(after);
    out.financial = after;

    const updateCols = (await client.query(`
      SELECT column_name
      FROM information_schema.column_privileges
      WHERE table_schema = 'public'
        AND table_name = 'mortgage_handling_requests'
        AND grantee = 'checksops'
        AND privilege_type = 'UPDATE'
      ORDER BY 1
    `)).rows.map((row) => row.column_name);
    out.staffColumnsGranted = ['assigned_employee_id', 'accepted_at', 'completed_at', 'cancelled_at', 'status']
      .every((column) => updateCols.includes(column));
    out.updateColumns = updateCols;

    const policies = (await client.query(`
      SELECT policyname, cmd
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'mortgage_handling_requests'
        AND policyname LIKE 'aws_%'
      ORDER BY 1
    `)).rows;
    out.policies = policies;

    await client.query('BEGIN');
    const selectSql = `
      SELECT tenant_id::text AS tenant_id, count(*)::int AS n
      FROM public.mortgage_handling_requests
      GROUP BY 1
    `;
    const summarize = (rows) => {
      const by = {};
      for (const row of rows) by[row.tenant_id] = Number(row.n);
      return {
        freedom: by[FREEDOM_TENANT] || 0,
        c1c: by[C1C_TENANT] || 0,
        other: Object.entries(by)
          .filter(([id]) => id !== FREEDOM_TENANT && id !== C1C_TENANT)
          .reduce((sum, [, n]) => sum + n, 0),
      };
    };
    const agentSelect = summarize((await asChecksops(client, AGENT_ID, selectSql)).rows);
    const c1cSelect = summarize((await asChecksops(client, C1C_ADMIN_ID, selectSql)).rows);
    const freedomSelect = summarize((await asChecksops(client, FREEDOM_STAFF_ID, selectSql)).rows);
    const ownerSelect = summarize((await asChecksops(client, OWNER_ID, selectSql)).rows);
    const ninthSelect = summarize((await asChecksops(client, NINTH_ID, selectSql)).rows);
    const unauthSelect = summarize((await asChecksops(client, null, selectSql)).rows);

    const tenantStatus = await tryAsChecksops(
      client,
      C1C_ADMIN_ID,
      `UPDATE public.mortgage_handling_requests
       SET status = 'in_progress'
       WHERE tenant_id = $1::uuid AND status = 'requested'
       RETURNING id`,
      [C1C_TENANT],
    );
    const agentAccept = await tryAsChecksops(
      client,
      AGENT_ID,
      `UPDATE public.mortgage_handling_requests
       SET assigned_employee_id = $1::uuid, status = 'in_progress', accepted_at = now()
       WHERE tenant_id = $2::uuid
         AND status = 'requested'
         AND assigned_employee_id IS NULL
       RETURNING id, status, assigned_employee_id`,
      [AGENT_ID, C1C_TENANT],
    );
    const tenantTenants = (await asChecksops(
      client,
      C1C_ADMIN_ID,
      'SELECT id::text AS id FROM public.tenants',
    )).rows.map((row) => row.id);
    const agentTenants = (await asChecksops(
      client,
      AGENT_ID,
      'SELECT id::text AS id FROM public.tenants',
    )).rows.map((row) => row.id);
    const freedomTenants = (await asChecksops(
      client,
      FREEDOM_STAFF_ID,
      'SELECT id::text AS id FROM public.tenants',
    )).rows.map((row) => row.id);
    await client.query('ROLLBACK');

    out.probes = {
      agentSelect,
      c1cSelect,
      freedomSelect,
      ownerSelect,
      ninthSelect,
      unauthSelect,
      tenantStatusDenied: tenantStatus.ok === false || tenantStatus.rowCount === 0,
      tenantStatus,
      agentAcceptOk: agentAccept.ok === true && (agentAccept.rowCount || 0) > 0,
      agentAccept,
      tenantSeesOnlyOwnTenant: tenantTenants.length === 1 && tenantTenants[0] === C1C_TENANT,
      freedomSeesOnlyOwnTenant: freedomTenants.length === 1 && freedomTenants[0] === FREEDOM_TENANT,
      agentSeesOperationalTenantsOnly: agentTenants.every((id) => id === C1C_TENANT || id === FREEDOM_TENANT)
        && (agentSelect.c1c > 0 || agentSelect.freedom > 0),
      ownerSeesBoth: ownerSelect.c1c > 0 && ownerSelect.freedom > 0,
      c1cDeniedFreedom: c1cSelect.freedom === 0,
      freedomDeniedC1c: freedomSelect.c1c === 0,
      ninthDenied: ninthSelect.c1c === 0 && ninthSelect.freedom === 0,
      unauthDenied: unauthSelect.c1c === 0 && unauthSelect.freedom === 0,
    };
    out.ok = Boolean(
      out.financialUnchanged
      && out.staffColumnsGranted
      && out.probes.tenantStatusDenied
      && out.probes.agentAcceptOk
      && out.probes.c1cDeniedFreedom
      && out.probes.freedomDeniedC1c
      && out.probes.ownerSeesBoth
      && out.probes.ninthDenied
      && out.probes.unauthDenied
      && out.probes.tenantSeesOnlyOwnTenant
      && out.probes.freedomSeesOnlyOwnTenant
      && (out.probes.agentSelect.c1c > 0 || out.probes.agentSelect.freedom > 0),
    );
    return out;
  } catch (error) {
    out.error = String(error?.message || error).replace(/password\s*=\s*\S+/gi, 'password=redacted');
    return out;
  } finally {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    await client.end();
  }
};
