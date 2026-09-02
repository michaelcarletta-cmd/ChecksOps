import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(ROOT, '..', 'sql');
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');

const TESTER_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const NINTH_ID = 'dd24eea5-5d12-47d1-999e-d5930c278b7d';
const C1C_ADMIN_ID = 'fd857564-9534-4b0f-95ac-624ed1273725';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const COGNITO_SUB = '2418c458-c011-70b7-07ac-6b9da2d9415d';

const HELPER_NAMES = [
  'has_role',
  'has_any_role',
  'is_master_owner',
  'is_platform_owner',
  'is_org_member',
  'is_tenant_staff',
  'is_tenant_member',
  'user_belongs_to_tenant',
  'get_user_tenant_ids',
  'current_tenant_is_claim_funds_recipient',
  'current_tenant_is_check_funds_recipient',
  'mortgage_agent_can_view_check',
  'mortgage_agent_can_view_claim',
  'can_access_shared_intake',
  'user_can_access_batch',
  'tenant_is_funds_recipient',
  'is_batch_sender_tenant',
  'user_has_role',
  'aws_user_tenant_ids',
  'aws_is_cross_tenant_reader',
];

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
    query_timeout: 25000,
  });
  await client.connect();
  return client;
};

const rlsEnabledPublicTables = async (client) => {
  const { rows } = await client.query(`
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity
    ORDER BY 1
  `);
  return rows.map((row) => row.table_name);
};

const grantHelperExecute = async (client) => {
  const { rows } = await client.query(
    `SELECT p.proname,
            pg_get_function_identity_arguments(p.oid) AS args
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = ANY($1::text[])
     ORDER BY 1, 2`,
    [HELPER_NAMES],
  );
  const granted = [];
  for (const row of rows) {
    const ident = `public.${row.proname}(${row.args})`;
    await client.query(`GRANT EXECUTE ON FUNCTION ${ident} TO checksops`);
    granted.push(ident);
  }
  return granted;
};

const countsByTenant = (rows) => {
  const out = {};
  for (const row of rows) {
    out[row.tenant_id] = Number(row.n);
  }
  return {
    freedom: out[FREEDOM_TENANT] || 0,
    c1c: out[C1C_TENANT] || 0,
    other: Object.entries(out)
      .filter(([id]) => id !== FREEDOM_TENANT && id !== C1C_TENANT)
      .reduce((sum, [, n]) => sum + n, 0),
  };
};

const asChecksops = async (client, appUserId, sql) => {
  await client.query('SAVEPOINT rls_probe');
  try {
    await client.query('SET LOCAL ROLE checksops');
    if (appUserId) {
      await client.query("SELECT set_config('request.app_user_id', $1, true)", [appUserId]);
    } else {
      await client.query("SELECT set_config('request.app_user_id', '', true)");
    }
    const result = await client.query(sql);
    await client.query('ROLLBACK TO SAVEPOINT rls_probe');
    return result.rows;
  } catch (error) {
    try { await client.query('ROLLBACK TO SAVEPOINT rls_probe'); } catch { /* ignore */ }
    throw error;
  }
};

const withTxn = async (client, fn) => {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  }
};

const investigateNinth = async (client) => {
  const id = NINTH_ID;
  const out = { applicationUserId: id, emailGuessed: false };

  out.identityAccount = (await client.query(
    `SELECT application_user_id::text AS application_user_id, cognito_sub, email, status
     FROM public.identity_accounts WHERE application_user_id = $1::uuid`,
    [id],
  )).rows[0] || null;

  out.profile = (await client.query(
    `SELECT id::text AS id, email, full_name FROM public.profiles WHERE id = $1::uuid`,
    [id],
  )).rows[0] || null;

  out.userRoles = (await client.query(
    `SELECT role::text AS role FROM public.user_roles WHERE user_id = $1::uuid ORDER BY 1`,
    [id],
  )).rows.map((row) => row.role);

  out.tenantUsers = (await client.query(
    `SELECT tu.tenant_id::text AS tenant_id, tu.role, t.name, t.slug
     FROM public.tenant_users tu
     LEFT JOIN public.tenants t ON t.id = tu.tenant_id
     WHERE tu.user_id = $1::uuid`,
    [id],
  )).rows;

  out.roleVersion = (await client.query(
    `SELECT version, updated_at
     FROM public.role_version_tracker WHERE user_id = $1::uuid`,
    [id],
  )).rows[0] || null;

  out.vettingUploads = (await client.query(
    `SELECT id::text AS id, tenant_id::text AS tenant_id, t.name AS tenant_name,
            doc_type, file_name, review_status, created_at
     FROM public.tenant_vetting_documents d
     LEFT JOIN public.tenants t ON t.id = d.tenant_id
     WHERE uploaded_by = $1::uuid`,
    [id],
  )).rows;

  out.contractorProfiles = Number((await client.query(
    `SELECT count(*)::int AS n FROM public.contractor_profiles WHERE user_id = $1::uuid`,
    [id],
  )).rows[0].n);

  const uuidColumns = (await client.query(`
    SELECT c.table_schema, c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE t.table_type = 'BASE TABLE'
      AND c.data_type = 'uuid'
      AND c.table_schema IN ('public', 'auth')
      AND c.table_name NOT IN ('_aws_rls_probe_items')
    ORDER BY 1, 2, 3
  `)).rows;

  const hits = [];
  for (const col of uuidColumns) {
    const fq = `"${col.table_schema}"."${col.table_name}"`;
    const ident = `"${col.column_name}"`;
    try {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM ${fq} WHERE ${ident} = $1::uuid`,
        [id],
      );
      const n = Number(rows[0].n);
      if (n > 0) {
        hits.push({
          schema: col.table_schema,
          table: col.table_name,
          column: col.column_name,
          rows: n,
        });
      }
    } catch {
      // skip views/permissions
    }
  }
  out.uuidColumnHits = hits;

  out.authUsersRestored = false;
  out.authUsersRow = null;
  const usersReg = (await client.query(`SELECT to_regclass('auth.users') AS r`)).rows[0].r;
  if (usersReg) {
    out.authUsersRestored = true;
    const { rows } = await client.query(
      `SELECT id::text AS id,
              email,
              created_at,
              last_sign_in_at,
              email_confirmed_at,
              banned_until,
              deleted_at,
              raw_user_meta_data->>'full_name' AS full_name,
              raw_user_meta_data->>'name' AS name,
              raw_app_meta_data->>'provider' AS provider
       FROM auth.users
       WHERE id = $1::uuid`,
      [id],
    );
    out.authUsersRow = rows[0] || null;
  }

  const identitiesReg = (await client.query(`SELECT to_regclass('auth.identities') AS r`)).rows[0].r;
  if (identitiesReg) {
    out.authIdentities = (await client.query(
      `SELECT provider, email, created_at
       FROM auth.identities
       WHERE user_id = $1::uuid`,
      [id],
    )).rows;
  } else {
    out.authIdentities = [];
  }

  return out;
};

const transactionalIntakeIsolation = async (client) => {
  const enabled = (await client.query(
    `SELECT c.relrowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'check_intake_items'`,
  )).rows[0];
  if (enabled?.relrowsecurity) {
    return { skipped: true, reason: 'check_intake_items already has RLS; refusing to alter' };
  }

  await client.query('BEGIN');
  try {
    await client.query('ALTER TABLE public.check_intake_items ENABLE ROW LEVEL SECURITY');
    await client.query(`
      CREATE POLICY aws_tx_isolation_select ON public.check_intake_items
        FOR SELECT TO authenticated
        USING (tenant_id IN (SELECT public.aws_user_tenant_ids()))
    `);
    const sql = `
      SELECT tenant_id::text AS tenant_id, count(*)::int AS n
      FROM public.check_intake_items
      GROUP BY tenant_id
    `;
    const tester = countsByTenant(await asChecksops(client, TESTER_ID, sql));
    const c1cAdmin = countsByTenant(await asChecksops(client, C1C_ADMIN_ID, sql));
    const ninth = countsByTenant(await asChecksops(client, NINTH_ID, sql));
    const cognitoSub = countsByTenant(await asChecksops(client, COGNITO_SUB, sql));
    const unauthenticated = countsByTenant(await asChecksops(client, null, sql));
    await client.query('ROLLBACK');
    const after = (await client.query(
      `SELECT c.relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'check_intake_items'`,
    )).rows[0]?.relrowsecurity;
    return {
      skipped: false,
      rolledBack: true,
      checkIntakeItemsRlsAfterRollback: Boolean(after),
      tester,
      c1cAdmin,
      ninthNoTenant: ninth,
      cognitoSubAsAppId: cognitoSub,
      unauthenticated,
      pass: tester.freedom > 0
        && tester.c1c === 0
        && c1cAdmin.c1c > 0
        && c1cAdmin.freedom === 0
        && ninth.freedom === 0
        && ninth.c1c === 0
        && cognitoSub.freedom === 0
        && cognitoSub.c1c === 0
        && unauthenticated.freedom === 0
        && unauthenticated.c1c === 0
        && after === false,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return { skipped: false, rolledBack: true, error: String(error?.message || error).slice(0, 400) };
  }
};

const probeIsolation = async (client) => withTxn(client, async () => {
  const sql = `
    SELECT label, tenant_id::text AS tenant_id
    FROM public._aws_rls_probe_items
    ORDER BY label
  `;
  const asAdmin = (await client.query(sql)).rows.map((row) => row.label);
  const tester = (await asChecksops(client, TESTER_ID, sql)).map((row) => row.label);
  const c1cAdmin = (await asChecksops(client, C1C_ADMIN_ID, sql)).map((row) => row.label);
  const ninth = (await asChecksops(client, NINTH_ID, sql)).map((row) => row.label);
  const cognitoSub = (await asChecksops(client, COGNITO_SUB, sql)).map((row) => row.label);
  const unauthenticated = (await asChecksops(client, null, sql)).map((row) => row.label);
  const testerRoles = await asChecksops(
    client,
    TESTER_ID,
    `SELECT role::text AS role FROM public.user_roles WHERE user_id = auth.uid() ORDER BY 1`,
  );
  return {
    adminSeesAllLabels: asAdmin,
    tester,
    c1cAdmin,
    ninth,
    cognitoSubAsAppId: cognitoSub,
    unauthenticated,
    testerRolesFromUserRoles: testerRoles.map((row) => row.role),
    pass: tester.includes('freedom-probe-visible')
      && !tester.includes('c1c-probe-hidden')
      && !tester.includes('barzzini-probe-hidden')
      && c1cAdmin.includes('c1c-probe-hidden')
      && !c1cAdmin.includes('freedom-probe-visible')
      && ninth.length === 0
      && cognitoSub.length === 0
      && unauthenticated.length === 0
      && testerRoles.map((row) => row.role).includes('staff'),
  };
});

export const handler = async (event = {}) => {
  const step = event.step || 'all';
  const out = {
    ok: false,
    step,
    productionSupabaseChanged: false,
    database: 'checksops',
    rlsEnabledGlobally: false,
    realUsersInvited: false,
  };
  let client;
  try {
    client = await adminClient('checksops');
    const db = (await client.query('SELECT current_database() AS d, current_user AS u')).rows[0];
    if (db.d !== 'checksops') throw new Error(`connected to ${db.d}, expected checksops`);
    out.connectedAs = db.u;

    if (step === 'ddl' || step === 'all') {
      await client.query(readSql('01_role_shim.sql'));
      await client.query(readSql('02_helpers.sql'));
      await client.query(readSql('03_grants.sql'));
      out.helpersGranted = await grantHelperExecute(client);
      await client.query(readSql('04_probe_table.sql'));
      out.ddlApplied = true;
    }
    if (step === 'ninth' || step === 'all') {
      out.ninthUuid = await investigateNinth(client);
    }
    if (step === 'probe' || step === 'all') {
      out.probeIsolation = await probeIsolation(client);
    }
    if (step === 'transactional' || step === 'all') {
      out.transactionalIntakeIsolation = await transactionalIntakeIsolation(client);
    }
    out.publicTablesWithRls = await rlsEnabledPublicTables(client);
    out.rlsEnabledGlobally = out.publicTablesWithRls.some((name) => name !== '_aws_rls_probe_items');
    out.ok = true
      && out.ddlApplied !== false
      && out.publicTablesWithRls.length === 1
      && out.publicTablesWithRls[0] === '_aws_rls_probe_items'
      && (step === 'ddl' || (out.probeIsolation?.pass && out.transactionalIntakeIsolation?.pass));
    if (step === 'ddl') {
      out.ok = out.ddlApplied === true && !out.rlsEnabledGlobally;
    }
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
