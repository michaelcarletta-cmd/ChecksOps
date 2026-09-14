import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  applyWriteDdl,
  inspectApplicationRole,
  investigateClaimsOwnership,
  investigateNinthLive,
  transactionalWriteTests,
} from './writePlan.mjs';
import { runCompleteAuth } from './completeAuth.mjs';
import { runEnableRls } from './enableRls.mjs';

const { Client } = pg;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(ROOT, '..', 'sql');
const CA_PATH = path.join(ROOT, 'rds-global-bundle.pem');

const TESTER_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const NINTH_ID = 'dd24eea5-5d12-47d1-999e-d5930c278b7d';
const C1C_ADMIN_ID = 'fd857564-9534-4b0f-95ac-624ed1273725';
const MASTER_OWNER_ID = '7dbb3009-f059-4767-b5dc-1c5c72379330';
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
  'aws_can_access_tenant',
  'aws_can_access_claim',
  'aws_can_access_check',
  'aws_can_access_same_tenant_user',
  'aws_can_access_deposit_item',
  'aws_can_access_loss_draft',
  'aws_can_access_signature_request',
  'aws_mortgage_agent_can_read_library_document',
  'aws_mortgage_agent_can_read_library_path',
  'aws_can_manage_mortgage_library',
  'aws_can_insert_mortgage_library_document',
  'aws_is_authenticated',
  'aws_can_write_tenant',
  'aws_can_write_check',
  'aws_can_write_claim',
  'aws_can_write_same_tenant_user',
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
    query_timeout: 120000,
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
    `SELECT d.id::text AS id, d.tenant_id::text AS tenant_id, t.name AS tenant_name,
            d.doc_type, d.file_name, d.review_status, d.created_at
     FROM public.tenant_vetting_documents d
     LEFT JOIN public.tenants t ON t.id = d.tenant_id
     WHERE d.uploaded_by = $1::uuid`,
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
    out.authUsersCount = Number((await client.query('SELECT count(*)::int AS n FROM auth.users')).rows[0].n);
    const cols = (await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'auth' AND table_name = 'users'`,
    )).rows.map((row) => row.column_name);
    out.authUsersColumns = cols;
    const select = [
      'id::text AS id',
      cols.includes('email') ? 'email' : 'NULL::text AS email',
      cols.includes('created_at') ? 'created_at' : 'NULL::timestamptz AS created_at',
      cols.includes('last_sign_in_at') ? 'last_sign_in_at' : 'NULL::timestamptz AS last_sign_in_at',
      cols.includes('email_confirmed_at') ? 'email_confirmed_at' : 'NULL::timestamptz AS email_confirmed_at',
      cols.includes('banned_until') ? 'banned_until' : 'NULL::timestamptz AS banned_until',
      cols.includes('deleted_at') ? 'deleted_at' : 'NULL::timestamptz AS deleted_at',
      cols.includes('raw_user_meta_data')
        ? "raw_user_meta_data->>'full_name' AS full_name, raw_user_meta_data->>'name' AS name"
        : 'NULL::text AS full_name, NULL::text AS name',
      cols.includes('raw_app_meta_data')
        ? "raw_app_meta_data->>'provider' AS provider"
        : 'NULL::text AS provider',
    ].join(', ');
    const { rows } = await client.query(
      `SELECT ${select} FROM auth.users WHERE id = $1::uuid`,
      [id],
    );
    out.authUsersRow = rows[0] || null;
  }

  const identitiesReg = (await client.query(`SELECT to_regclass('auth.identities') AS r`)).rows[0].r;
  if (identitiesReg) {
    const icols = (await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'auth' AND table_name = 'identities'`,
    )).rows.map((row) => row.column_name);
    const identitySelect = [
      icols.includes('provider') ? 'provider' : "'unknown'::text AS provider",
      icols.includes('email') ? 'email' : 'NULL::text AS email',
      icols.includes('identity_data') ? "identity_data->>'email' AS identity_email" : 'NULL::text AS identity_email',
      icols.includes('created_at') ? 'created_at' : 'NULL::timestamptz AS created_at',
    ].join(', ');
    out.authIdentities = (await client.query(
      `SELECT ${identitySelect} FROM auth.identities WHERE user_id = $1::uuid`,
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

  const baseline = countsByTenant((await client.query(`
      SELECT tenant_id::text AS tenant_id, count(*)::int AS n
      FROM public.check_intake_items
      GROUP BY tenant_id
    `)).rows);

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
      baselineAdminCounts: baseline,
      tester,
      c1cAdmin,
      ninthNoTenant: ninth,
      cognitoSubAsAppId: cognitoSub,
      unauthenticated,
      pass: tester.freedom > 0
        && tester.c1c === 0
        && tester.other === 0
        && c1cAdmin.freedom === 0
        && c1cAdmin.c1c === baseline.c1c
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
  const masterOwner = (await asChecksops(client, MASTER_OWNER_ID, sql)).map((row) => row.label);
  const testerRoles = await asChecksops(
    client,
    TESTER_ID,
    `SELECT role::text AS role FROM public.user_roles WHERE user_id = auth.uid() ORDER BY 1`,
  );
  const ownerFlags = {};
  for (const [name, id] of [
    ['tester', TESTER_ID],
    ['c1cAdmin', C1C_ADMIN_ID],
    ['masterOwner', MASTER_OWNER_ID],
    ['ninth', NINTH_ID],
  ]) {
    const rows = await asChecksops(
      client,
      id,
      `SELECT public.is_master_owner() AS master, public.is_platform_owner() AS platform`,
    );
    ownerFlags[name] = rows[0];
  }
  return {
    adminSeesAllLabels: asAdmin,
    tester,
    c1cAdmin,
    masterOwner,
    ninth,
    cognitoSubAsAppId: cognitoSub,
    unauthenticated,
    testerRolesFromUserRoles: testerRoles.map((row) => row.role),
    ownerFlags,
    pass: tester.includes('freedom-probe-visible')
      && !tester.includes('c1c-probe-hidden')
      && !tester.includes('barzzini-probe-hidden')
      && c1cAdmin.includes('c1c-probe-hidden')
      && !c1cAdmin.includes('freedom-probe-visible')
      && masterOwner.includes('freedom-probe-visible')
      && masterOwner.includes('c1c-probe-hidden')
      && ninth.length === 0
      && cognitoSub.length === 0
      && unauthenticated.length === 0
      && testerRoles.map((row) => row.role).includes('staff')
      && ownerFlags.masterOwner?.master === true
      && ownerFlags.tester?.master === false
      && ownerFlags.c1cAdmin?.master === false
      && ownerFlags.c1cAdmin?.platform === false,
  };
});

const REPRESENTATIVE_TABLES = [
  { table: 'check_intake_items', kind: 'tenant', tenantCol: 'tenant_id' },
  { table: 'check_endorsements', kind: 'tenant', tenantCol: 'tenant_id' },
  { table: 'disbursement_batches', kind: 'tenant', tenantCol: 'tenant_id' },
  { table: 'payment_provider_accounts', kind: 'tenant', tenantCol: 'tenant_id' },
  { table: 'payment_webhook_events', kind: 'tenant', tenantCol: 'tenant_id' },
  { table: 'homeowner_ledger_events', kind: 'tenant', tenantCol: 'tenant_id' },
  { table: 'claims', kind: 'tenant', tenantCol: 'org_id' },
  { table: 'tenants', kind: 'tenant', tenantCol: 'id' },
  { table: 'tenant_email_settings', kind: 'tenant', tenantCol: 'tenant_id' },
  { table: 'payment_idempotency_keys', kind: 'tenant', tenantCol: 'tenant_id' },
  { table: 'user_roles', kind: 'same_tenant_user', userCol: 'user_id' },
  { table: 'profiles', kind: 'same_tenant_user', userCol: 'id' },
  { table: 'claim_files', kind: 'claim_join' },
  { table: 'check_files', kind: 'check_file_join' },
  { table: 'deposit_items', kind: 'deposit_join' },
  { table: 'plaid_webhook_cursors', kind: 'platform_only' },
];

const countSql = (spec) => {
  if (spec.kind === 'same_tenant_user') {
    return `SELECT CASE
      WHEN EXISTS (
        SELECT 1 FROM public.tenant_users tu
        WHERE tu.user_id = t.${spec.userCol} AND tu.tenant_id = '${FREEDOM_TENANT}'::uuid
      ) THEN '${FREEDOM_TENANT}'
      WHEN EXISTS (
        SELECT 1 FROM public.tenant_users tu
        WHERE tu.user_id = t.${spec.userCol} AND tu.tenant_id = '${C1C_TENANT}'::uuid
      ) THEN '${C1C_TENANT}'
      ELSE 'other'
    END AS tenant_id, count(*)::int AS n
    FROM public.${spec.table} t
    GROUP BY 1`;
  }
  if (spec.kind === 'claim_join') {
    return `SELECT COALESCE(c.org_id::text, 'other') AS tenant_id, count(*)::int AS n
      FROM public.claim_files cf
      LEFT JOIN public.claims c ON c.id = cf.claim_id
      GROUP BY 1`;
  }
  if (spec.kind === 'check_file_join') {
    return `SELECT COALESCE(ci.tenant_id::text, 'other') AS tenant_id, count(*)::int AS n
      FROM public.check_files f
      LEFT JOIN public.check_intake_items ci ON ci.id = f.check_intake_item_id
      GROUP BY 1`;
  }
  if (spec.kind === 'deposit_join') {
    return `SELECT COALESCE(ci.tenant_id::text, 'other') AS tenant_id, count(*)::int AS n
      FROM public.deposit_items di
      LEFT JOIN public.check_intake_items ci ON ci.id = di.check_id
      GROUP BY 1`;
  }
  if (spec.kind === 'platform_only' || !spec.tenantCol) {
    return `SELECT 'all'::text AS tenant_id, count(*)::int AS n FROM public.${spec.table}`;
  }
  return `SELECT ${spec.tenantCol}::text AS tenant_id, count(*)::int AS n FROM public.${spec.table} GROUP BY 1`;
};

const tablePass = (spec, baseline, perActor) => {
  const staff = perActor.testerStaff;
  const admin = perActor.tenantAdminC1c;
  const master = perActor.masterOwner;
  const ninth = perActor.ninth;
  const sub = perActor.cognitoSub;
  const unauth = perActor.unauthenticated;
  if (unauth.all !== 0 || sub.all !== 0) return false;
  if (spec.kind === 'platform_only') {
    return staff.all === 0 && admin.all === 0 && ninth.all === 0 && master.all === baseline.all;
  }
  if (staff.c1c !== 0 || admin.freedom !== 0) return false;
  if (ninth.freedom !== 0 || ninth.c1c !== 0) return false;
  if (baseline.freedom > 0 && staff.freedom === 0) return false;
  if (baseline.c1c > 0 && admin.c1c === 0) return false;
  if (master.all !== baseline.all) return false;
  return true;
};

const summarize = (rows) => {
  const by = {};
  for (const row of rows) by[row.tenant_id] = Number(row.n);
  const freedom = by[FREEDOM_TENANT] || 0;
  const c1c = by[C1C_TENANT] || 0;
  const all = by.all;
  const other = Object.entries(by)
    .filter(([id]) => id !== FREEDOM_TENANT && id !== C1C_TENANT && id !== 'all')
    .reduce((sum, [, n]) => sum + n, 0);
  return { freedom, c1c, other, all: all ?? (freedom + c1c + other), raw: by };
};

const expandedIsolation = async (client) => {
  const alreadyOn = [];
  for (const spec of REPRESENTATIVE_TABLES) {
    const enabled = (await client.query(
      `SELECT c.relrowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1`,
      [spec.table],
    )).rows[0]?.relrowsecurity;
    if (enabled) alreadyOn.push(spec.table);
  }
  if (alreadyOn.length) {
    return { skipped: true, reason: `RLS already enabled: ${alreadyOn.join(',')}` };
  }

  await client.query('BEGIN');
  try {
    for (const spec of REPRESENTATIVE_TABLES) {
      await client.query(`ALTER TABLE public.${spec.table} ENABLE ROW LEVEL SECURITY`);
    }

    const actors = {
      testerStaff: TESTER_ID,
      tenantAdminC1c: C1C_ADMIN_ID,
      masterOwner: MASTER_OWNER_ID,
      ninth: NINTH_ID,
      cognitoSub: COGNITO_SUB,
      unauthenticated: null,
    };
    const tables = {};
    for (const spec of REPRESENTATIVE_TABLES) {
      try {
        const sql = countSql(spec);
        const baseline = summarize((await client.query(sql)).rows);
        const perActor = {};
        for (const [name, id] of Object.entries(actors)) {
          perActor[name] = summarize(await asChecksops(client, id, sql));
        }
        tables[spec.table] = {
          kind: spec.kind,
          baseline,
          ...perActor,
          pass: tablePass(spec, baseline, perActor),
        };
      } catch (error) {
        tables[spec.table] = {
          kind: spec.kind,
          pass: false,
          error: String(error?.message || error).slice(0, 400),
        };
      }
    }

    const uuidOracleFor = async (table, idSql, params) => {
      const row = (await client.query(idSql, params)).rows[0];
      if (!row) return { table, skipped: true };
      const sql = `SELECT count(*)::int AS n FROM public.${table} WHERE id = '${row.id}'::uuid`;
      const asC1c = await asChecksops(client, C1C_ADMIN_ID, sql);
      const asStaff = await asChecksops(client, TESTER_ID, sql);
      const asUnauth = await asChecksops(client, null, sql);
      return {
        table,
        skipped: false,
        recordId: row.id,
        c1cAdminRows: Number(asC1c[0].n),
        sameTenantStaffRows: Number(asStaff[0].n),
        unauthenticatedRows: Number(asUnauth[0].n),
        pass: Number(asC1c[0].n) === 0 && Number(asStaff[0].n) === 1 && Number(asUnauth[0].n) === 0,
      };
    };
    const uuidOracle = {
      checkIntakeItems: await uuidOracleFor(
        'check_intake_items',
        `SELECT id::text AS id FROM public.check_intake_items WHERE tenant_id = $1::uuid LIMIT 1`,
        [FREEDOM_TENANT],
      ),
      depositItems: await uuidOracleFor(
        'deposit_items',
        `SELECT di.id::text AS id
         FROM public.deposit_items di
         JOIN public.check_intake_items ci ON ci.id = di.check_id
         WHERE ci.tenant_id = $1::uuid LIMIT 1`,
        [FREEDOM_TENANT],
      ),
    };
    uuidOracle.pass = Object.values(uuidOracle)
      .filter((row) => row && typeof row === 'object' && row.pass !== undefined)
      .every((row) => row.skipped || row.pass);

    await client.query('ROLLBACK');
    const stillOn = [];
    for (const spec of REPRESENTATIVE_TABLES) {
      const enabled = (await client.query(
        `SELECT c.relrowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = $1`,
        [spec.table],
      )).rows[0]?.relrowsecurity;
      if (enabled) stillOn.push(spec.table);
    }
    const applicationRole = (await client.query(
      `SELECT rolname, rolsuper, rolbypassrls
       FROM pg_roles
       WHERE rolname IN ('checksops', 'authenticated', 'anon')
       ORDER BY 1`,
    )).rows;
    const tableOwner = (await client.query(
      `SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'check_intake_items'`,
    )).rows[0];
    const applicationRoleCannotBypassRls = applicationRole.every(
      (row) => row.rolname !== 'checksops' || (!row.rolsuper && !row.rolbypassrls),
    ) && tableOwner?.owner !== 'checksops';
    const pass = Object.values(tables).every((row) => row.pass)
      && uuidOracle.pass !== false
      && stillOn.length === 0
      && applicationRoleCannotBypassRls;
    return {
      skipped: false,
      rolledBack: true,
      rlsLeftEnabled: stillOn,
      uuidOracle,
      applicationRole,
      tableOwner,
      applicationRoleCannotBypassRls,
      tables,
      pass,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    return { skipped: false, rolledBack: true, error: String(error?.message || error).slice(0, 500) };
  }
};

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

    if (step === 'ddl' || step === 'all' || step === 'remediate') {
      const applySql = async (name) => {
        try {
          await client.query(readSql(name));
        } catch (error) {
          throw new Error(`${name}: ${error?.message || error}`);
        }
      };
      await applySql('01_role_shim.sql');
      await applySql('02_helpers.sql');
      await applySql('03_grants.sql');
      await applySql('10_owner_helpers_from_identity.sql');
      await applySql('11_access_helpers.sql');
      await applySql('15_access_grants.sql');
      out.helpersGranted = await grantHelperExecute(client);
      await applySql('04_probe_table.sql');
      await applySql('16_probe_policy_remediate.sql');
      const policySql = readSql('12_final_select_policies.sql');
      const dropAt = policySql.indexOf('DROP POLICY');
      if (dropAt < 0) throw new Error('12_final_select_policies.sql: missing DROP POLICY');
      await client.query(policySql.slice(0, dropAt));
      const policyStmts = policySql.slice(dropAt).split(/;\n+/).map((s) => s.trim()).filter(Boolean);
      for (const stmt of policyStmts) {
        try {
          await client.query(`${stmt};`);
        } catch (error) {
          throw new Error(`12_final_select_policies.sql near ${stmt.slice(0, 160)}: ${error?.message || error}`);
        }
      }
      out.dumpPoliciesBeforeDrop = Number((await client.query(
        `SELECT count(*)::int AS n FROM pg_policies
         WHERE schemaname = 'public' AND policyname NOT LIKE 'aws_%'`,
      )).rows[0].n);
      await client.query(readSql('13_drop_dump_policies.sql'));
      out.dumpPoliciesAfterDrop = Number((await client.query(
        `SELECT count(*)::int AS n FROM pg_policies
         WHERE schemaname = 'public' AND policyname NOT LIKE 'aws_%'`,
      )).rows[0].n);
      // 29_mortgage_ops_library_parity.sql requires 20_write_helpers.sql and
      // 24_complete_write_policies.sql. completeAuth applies that sequence.
      // Do not apply 29 from ddl; write helpers are not installed here.
      // Do not apply 30_tenant_documents_mortgage_doc_type.sql from ddl or completeAuth.
      // Do not apply 31_mortgage_ops_agent_access.sql from ddl or completeAuth.
      // Do not apply 69/71/72/73 endorsement or ledger SQL from ddl or completeAuth.
      out.ddlApplied = true;
      out.policiesPrepared = Number((await client.query(
        `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'aws_select_%'`,
      )).rows[0].n);
    }
    if (step === 'ninth' || step === 'all') {
      out.ninthUuid = await investigateNinth(client);
    }
    if (step === 'probe' || step === 'all' || step === 'remediate') {
      out.probeIsolation = await probeIsolation(client);
    }
    if (step === 'transactional' || step === 'all') {
      out.transactionalIntakeIsolation = await transactionalIntakeIsolation(client);
    }
    if (step === 'expanded' || step === 'all' || step === 'remediate') {
      out.expandedIsolation = await expandedIsolation(client);
    }
    if (step === 'writePlan' || step === 'all') {
      out.writeDdl = await applyWriteDdl(client);
      out.claimsOwnership = await investigateClaimsOwnership(client);
      out.ninthUuidLive = await investigateNinthLive(client);
      out.applicationRoleInspection = await inspectApplicationRole(client);
      out.writeAuthorization = await transactionalWriteTests(client);
    }
    if (step === 'completeAuth') {
      Object.assign(out, await runCompleteAuth(client));
    }
    if (step === 'snapshotRls') {
      Object.assign(out, await runEnableRls(client, { apply: false }));
    }
    if (step === 'enableRls') {
      Object.assign(out, await runEnableRls(client, { apply: true }));
    }
    if (step === 'rollbackRls') {
      Object.assign(out, await runEnableRls(client, { rollback: true }));
    }
    out.publicTablesWithRls = await rlsEnabledPublicTables(client);
    const restoredRlsEnabled = out.publicTablesWithRls.filter(
      (name) => name !== '_aws_rls_probe_items' && name !== '_aws_rls_write_probe',
    );
    out.rlsEnabledGlobally = restoredRlsEnabled.length >= 165;
    out.rlsEnabledRestoredCount = restoredRlsEnabled.length;
    out.ok = !out.error
      && out.ddlApplied !== false
      && !out.rlsEnabledGlobally
      && (step === 'ddl' || step === 'writePlan' || step === 'completeAuth' || (
        (out.probeIsolation ? out.probeIsolation.pass : true)
        && (out.expandedIsolation ? out.expandedIsolation.pass : true)
        && (out.transactionalIntakeIsolation ? out.transactionalIntakeIsolation.pass !== false : true)
      ));
    if (step === 'writePlan') {
      out.ok = !out.error
        && !out.rlsEnabledGlobally
        && out.writeDdl?.selectPoliciesUnchanged === 165
        && out.claimsOwnership?.pass
        && out.writeAuthorization?.pass
        && out.applicationRoleInspection?.checksopsCannotAlterRls
        && out.applicationRoleInspection?.checksopsCannotCreatePolicy
        && out.applicationRoleInspection?.checksopsCannotBecomeAdmin
        && out.applicationRoleInspection?.checksopsMemberOfAdmin === false
        && out.applicationRoleInspection?.checksopsHasWritePrivilege === false
        && out.applicationRoleInspection?.checkIntakeOwner !== 'checksops';
    }
    if (step === 'completeAuth') {
      out.ok = !out.error
        && !out.rlsEnabledGlobally
        && out.writeDdl?.selectPoliciesUnchanged === true
        && out.writeDdl?.writePolicies === 127
        && out.claimsBackfill?.pass
        && out.fkOrphans?.pass
        && out.fkRetarget?.pass
        && out.authorizationTests?.pass
        && out.applicationRoleInspection?.checksopsCannotAlterRls
        && out.applicationRoleInspection?.checksopsHasWritePrivilege === false
        && out.realUsersInvited === false;
    }
    if (step === 'snapshotRls') {
      out.ok = !out.error && out.snapshot?.pass === true && out.realUsersInvited === false;
    }
    if (step === 'enableRls') {
      out.ok = !out.error
        && out.pass === true
        && out.snapshot?.pass === true
        && out.authorizationTests?.pass === true
        && out.writeTests?.pass === true
        && out.regression?.pass === true
        && out.rlsEnabledGlobally === true
        && out.rolledBackRls !== true
        && out.realUsersInvited === false
        && out.ninthUuidModified === false
        && out.usedForceRowLevelSecurity === false
        && out.calledExternalProviders === false;
    }
    if (step === 'rollbackRls') {
      out.ok = !out.error && out.disable?.pass === true && out.rlsEnabledGlobally === false;
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
