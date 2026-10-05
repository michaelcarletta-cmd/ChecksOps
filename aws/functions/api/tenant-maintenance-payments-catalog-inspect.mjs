/**
 * TEMPORARY staging-only read-only catalog inspector for
 * public.tenant_maintenance_payments.
 *
 * Test/diagnosis infrastructure, not a product feature. Remove after the
 * TMP RLS diagnosis by deleting this file and the GET /inspect/tmp-rls-catalog
 * hook in index.mjs.
 *
 * Fixed queries only. No caller SQL. No arbitrary table/function parameters.
 * Catalog SELECT only. Does not change the database role or disable RLS.
 * Does not widen the guarded SQL executor.
 */
import { createHash } from 'node:crypto';
import { parseBody, withIdentity } from './data.mjs';
import { USER_ROLES_SQL } from './identity.mjs';
import { sanitizePublicError } from './db-health.mjs';

export const INSPECT_PATH = '/inspect/tmp-rls-catalog';
export const INSPECTOR_ID = 'tmp_rls_catalog';
export const TMP_SCHEMA = 'public';
export const TMP_TABLE = 'tenant_maintenance_payments';

export const PINNED_FUNCTION_LOOKUPS = Object.freeze([
  Object.freeze({ schema: 'public', name: 'aws_can_write_tenant', args: Object.freeze(['uuid']) }),
  Object.freeze({ schema: 'public', name: 'aws_can_access_tenant', args: Object.freeze(['uuid']) }),
  Object.freeze({ schema: 'public', name: 'aws_user_tenant_ids', args: Object.freeze([]) }),
  Object.freeze({ schema: 'public', name: 'is_master_owner', args: Object.freeze([]) }),
  Object.freeze({ schema: 'public', name: 'is_platform_owner', args: Object.freeze([]) }),
]);

export const PINNED_FUNCTION_NAMES = Object.freeze(
  PINNED_FUNCTION_LOOKUPS.map((item) => item.name),
);

export const FUNCTION_NAMESPACES = Object.freeze(['public', 'auth']);

export const REFUSED_CALLER_KEYS = Object.freeze([
  'sql',
  'sql_text',
  'statement',
  'query',
  'table',
  'tablename',
  'table_name',
  'function',
  'function_name',
  'functions',
  'identity',
  'oid',
  'schema',
  'schemaname',
  'arbitrary_sql',
  'ddl',
  'dml',
  'apply',
  'mutation',
]);

export const SET_READ_ONLY_SQL = 'SET LOCAL default_transaction_read_only = on';

export const SESSION_SQL = `SELECT current_user AS current_user,
       session_user AS session_user,
       current_role AS current_role,
       current_database() AS current_database,
       current_setting('transaction_read_only') AS transaction_read_only,
       current_setting('default_transaction_read_only') AS default_transaction_read_only,
       current_setting('row_security', true) AS row_security`;

export const TABLE_SQL = `SELECT c.relname AS table,
       pg_get_userbyid(c.relowner) AS owner,
       c.relrowsecurity AS relrowsecurity,
       c.relforcerowsecurity AS relforcerowsecurity
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname = 'tenant_maintenance_payments'
   AND c.relkind = 'r'`;

export const GRANTS_SQL = `SELECT grantee, privilege_type, is_grantable
  FROM information_schema.role_table_grants
 WHERE table_schema = 'public'
   AND table_name = 'tenant_maintenance_payments'
   AND grantee IN ('checksops', 'authenticated', 'PUBLIC', 'anon')
 ORDER BY grantee, privilege_type`;

export const PRIVILEGE_SQL = `SELECT
       has_table_privilege('checksops', 'public.tenant_maintenance_payments', 'SELECT') AS checksops_select,
       has_table_privilege('checksops', 'public.tenant_maintenance_payments', 'INSERT') AS checksops_insert,
       has_table_privilege('checksops', 'public.tenant_maintenance_payments', 'UPDATE') AS checksops_update,
       has_table_privilege('checksops', 'public.tenant_maintenance_payments', 'DELETE') AS checksops_delete`;

export const ROLE_MEMBERSHIP_SQL = `SELECT m.rolname AS member_of
  FROM pg_auth_members am
  JOIN pg_roles r ON r.oid = am.member
  JOIN pg_roles m ON m.oid = am.roleid
 WHERE r.rolname = 'checksops'
 ORDER BY 1`;

export const POLICIES_SQL = `SELECT pol.polname AS policy_name,
       CASE WHEN pol.polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END AS permissive,
       CASE pol.polcmd
         WHEN 'r' THEN 'SELECT'
         WHEN 'a' THEN 'INSERT'
         WHEN 'w' THEN 'UPDATE'
         WHEN 'd' THEN 'DELETE'
         WHEN '*' THEN 'ALL'
       END AS command,
       ARRAY(
         SELECT r.rolname FROM pg_roles r
          WHERE r.oid = ANY(pol.polroles)
          ORDER BY 1
       ) AS roles,
       pg_get_expr(pol.polqual, pol.polrelid) AS using_expression,
       pg_get_expr(pol.polwithcheck, pol.polrelid) AS with_check
  FROM pg_policy pol
  JOIN pg_class c ON c.oid = pol.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname = 'tenant_maintenance_payments'
 ORDER BY command, policy_name`;

export const FUNCTION_OVERLOADS_SQL = `SELECT n.nspname AS schema_name,
       p.proname AS function_name,
       p.oid AS function_oid,
       pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       pg_get_function_arguments(p.oid) AS arguments,
       p.prosecdef AS security_definer,
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END AS security,
       pg_get_userbyid(p.proowner) AS owner,
       p.proconfig,
       p.prokind,
       pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = ANY($1::text[])
   AND p.proname = ANY($2::text[])
   AND p.prokind IN ('f', 'w')
 ORDER BY n.nspname, p.proname, p.oid`;

export const TRIGGER_SQL = `SELECT t.tgname AS trigger_name,
       CASE
         WHEN (t.tgtype & 64) = 64 THEN 'INSTEAD OF'
         WHEN (t.tgtype & 2) = 2 THEN 'BEFORE'
         ELSE 'AFTER'
       END AS timing,
       (t.tgtype & 4) = 4 AS on_insert,
       (t.tgtype & 16) = 16 AS on_update,
       (t.tgtype & 8) = 8 AS on_delete,
       (t.tgtype & 32) = 32 AS on_truncate,
       t.tgenabled AS enabled,
       pg_get_triggerdef(t.oid) AS definition,
       p.oid AS function_oid,
       n2.nspname AS function_schema,
       p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS function_identity_arguments,
       p.prosecdef AS function_security_definer,
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END AS function_security,
       pg_get_userbyid(p.proowner) AS function_owner,
       p.proconfig AS function_proconfig,
       pg_get_functiondef(p.oid) AS function_definition
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_proc p ON p.oid = t.tgfoid
  JOIN pg_namespace n2 ON n2.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND c.relname = 'tenant_maintenance_payments'
   AND NOT t.tgisinternal
 ORDER BY t.tgname`;

export const OWNER_FLAGS_SQL = `SELECT public.is_master_owner() AS is_master,
       public.is_platform_owner() AS is_platform`;

export const FIXED_SQLS = Object.freeze([
  SET_READ_ONLY_SQL,
  SESSION_SQL,
  TABLE_SQL,
  GRANTS_SQL,
  PRIVILEGE_SQL,
  ROLE_MEMBERSHIP_SQL,
  POLICIES_SQL,
  FUNCTION_OVERLOADS_SQL,
  TRIGGER_SQL,
  OWNER_FLAGS_SQL,
  USER_ROLES_SQL,
]);

const denied = (error, extra = {}) => ({
  ok: false,
  statusCode: extra.statusCode || 403,
  error,
  inspector: INSPECTOR_ID,
  temporary: true,
  removable: true,
  readOnly: true,
  writesAttempted: false,
  table: TMP_TABLE,
  ...extra,
});

const ok = (extra = {}) => ({
  ok: true,
  statusCode: 200,
  inspector: INSPECTOR_ID,
  temporary: true,
  removable: true,
  readOnly: true,
  writesAttempted: false,
  schema: TMP_SCHEMA,
  table: TMP_TABLE,
  ...extra,
});

export const sha256Text = (text) => createHash('sha256').update(String(text || ''), 'utf8').digest('hex');

export const assertStagingOnly = (env) => {
  if (String(env || '') !== 'staging') {
    return denied('production_inspect_forbidden', {
      statusCode: 403,
      environment: env || 'unknown',
    });
  }
  return null;
};

const callerKeyList = (event = {}, body = {}) => {
  const query = event.queryStringParameters || {};
  const keys = [
    ...Object.keys(body || {}),
    ...Object.keys(query || {}),
  ].map((key) => String(key).toLowerCase());
  const rawQuery = String(event.rawQueryString || event.queryString || '');
  for (const key of REFUSED_CALLER_KEYS) {
    if (new RegExp(`(?:^|[&?])${key}=`, 'i').test(rawQuery)) keys.push(key);
  }
  return keys;
};

export const assertNoCallerCatalogOverride = (event = {}, body = {}) => {
  const refused = [...new Set(callerKeyList(event, body))]
    .filter((key) => REFUSED_CALLER_KEYS.includes(key));
  if (refused.length) {
    return denied('caller_catalog_override_forbidden', {
      statusCode: 403,
      refused_keys: refused,
    });
  }
  return null;
};

export const assertCatalogAdmin = async (client, mapping) => {
  const roles = (await client.query(USER_ROLES_SQL, [mapping.application_user_id])).rows
    .map((row) => String(row.role || '').toLowerCase());
  const owners = (await client.query(OWNER_FLAGS_SQL)).rows[0] || {};
  const authorized = owners.is_master === true
    || owners.is_platform === true
    || roles.includes('admin');
  if (!authorized) {
    return denied('admin_required', { statusCode: 403 });
  }
  return null;
};

export const extractReferencedFunctionNames = (expressions = []) => {
  const names = new Set();
  const re = /(?:([A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  for (const expr of expressions) {
    const text = String(expr || '');
    re.lastIndex = 0;
    let match = re.exec(text);
    while (match) {
      const schema = match[1] ? String(match[1]).toLowerCase() : null;
      const name = String(match[2] || '').toLowerCase();
      if (name && (!schema || FUNCTION_NAMESPACES.includes(schema))) {
        names.add(name);
      }
      match = re.exec(text);
    }
  }
  return [...names].sort();
};

const identityKey = (schema, name, args) => (
  `${schema}.${name}(${Array.isArray(args) ? args.join(',') : String(args || '')})`
);

const functionMatchesPinned = (row) => PINNED_FUNCTION_LOOKUPS.some((pinned) => {
  if (row.schema_name !== pinned.schema || row.function_name !== pinned.name) return false;
  const liveArgs = String(row.identity_arguments || '').replace(/\s+/g, ' ').trim();
  const wanted = pinned.args.join(', ');
  return liveArgs === wanted;
});

const publicFunction = (row, { pinned = false, referenced = false } = {}) => ({
  schema: row.schema_name,
  name: row.function_name,
  function_oid: Number(row.function_oid),
  identity: `${row.schema_name}.${row.function_name}(${row.identity_arguments || ''})`,
  identity_arguments: row.identity_arguments || '',
  arguments: row.arguments || '',
  security: row.security,
  security_definer: row.security_definer === true,
  owner: row.owner,
  proconfig: row.proconfig || null,
  prokind: row.prokind,
  definition_sha256: sha256Text(row.definition),
  definition: row.definition || null,
  pinned,
  referenced,
});

const runFixedCatalogQueries = async (client) => {
  await client.query(SET_READ_ONLY_SQL);
  const session = (await client.query(SESSION_SQL)).rows[0] || {};
  const table = (await client.query(TABLE_SQL)).rows[0] || null;
  const grants = (await client.query(GRANTS_SQL)).rows;
  const privileges = (await client.query(PRIVILEGE_SQL)).rows[0] || {};
  const roleMembership = (await client.query(ROLE_MEMBERSHIP_SQL)).rows.map((row) => row.member_of);
  const policies = (await client.query(POLICIES_SQL)).rows.map((row) => ({
    name: row.policy_name,
    permissive: row.permissive,
    command: row.command,
    roles: row.roles || [],
    using: row.using_expression,
    with_check: row.with_check,
  }));
  const referenced = extractReferencedFunctionNames(policies.flatMap((row) => [row.using, row.with_check]));
  const names = [...new Set([...PINNED_FUNCTION_NAMES, ...referenced])];
  const overloads = names.length
    ? (await client.query(FUNCTION_OVERLOADS_SQL, [FUNCTION_NAMESPACES, names])).rows
    : [];
  const functions = overloads.map((row) => publicFunction(row, {
    pinned: functionMatchesPinned(row),
    referenced: referenced.includes(row.function_name),
  }));
  const missingPinned = PINNED_FUNCTION_LOOKUPS
    .filter((pinned) => !functions.some((row) => (
      row.pinned && row.schema === pinned.schema && row.name === pinned.name
      && row.identity_arguments === pinned.args.join(', ')
    )))
    .map((pinned) => identityKey(pinned.schema, pinned.name, pinned.args));
  const triggers = (await client.query(TRIGGER_SQL)).rows.map((row) => ({
    name: row.trigger_name,
    timing: row.timing,
    on_insert: row.on_insert === true,
    on_update: row.on_update === true,
    on_delete: row.on_delete === true,
    on_truncate: row.on_truncate === true,
    enabled: row.enabled,
    definition: row.definition,
    function: {
      schema: row.function_schema,
      name: row.function_name,
      function_oid: Number(row.function_oid),
      identity: `${row.function_schema}.${row.function_name}(${row.function_identity_arguments || ''})`,
      identity_arguments: row.function_identity_arguments || '',
      security: row.function_security,
      security_definer: row.function_security_definer === true,
      owner: row.function_owner,
      proconfig: row.function_proconfig || null,
      definition_sha256: sha256Text(row.function_definition),
      definition: row.function_definition || null,
    },
  }));
  return {
    session: {
      current_user: session.current_user || null,
      session_user: session.session_user || null,
      current_role: session.current_role || null,
      current_database: session.current_database || null,
      transaction_read_only: session.transaction_read_only || null,
      default_transaction_read_only: session.default_transaction_read_only || null,
      row_security: session.row_security || null,
    },
    table_catalog: table ? {
      table: table.table,
      owner: table.owner,
      relrowsecurity: table.relrowsecurity === true,
      relforcerowsecurity: table.relforcerowsecurity === true,
    } : null,
    grants,
    lambda_role_privileges: privileges,
    lambda_role_membership: roleMembership,
    policies,
    functions,
    missing_pinned_functions: missingPinned,
    referenced_function_names: referenced,
    pinned_function_identities: PINNED_FUNCTION_LOOKUPS.map((item) => (
      identityKey(item.schema, item.name, item.args)
    )),
    triggers,
  };
};

export const runTmpRlsCatalogInspect = async ({ client, mapping }) => {
  const adminGate = await assertCatalogAdmin(client, mapping);
  if (adminGate) return adminGate;
  const catalog = await runFixedCatalogQueries(client);
  return ok(catalog);
};

export const handleTmpRlsCatalogInspect = async (event, deps = {}) => {
  const env = Object.hasOwn(deps, 'env') ? deps.env : process.env.CHECKSOPS_ENV;
  const envGate = assertStagingOnly(env);
  if (envGate) return envGate;

  const body = deps.body !== undefined ? deps.body : parseBody(event);
  const callerGate = assertNoCallerCatalogOverride(event, body);
  if (callerGate) return callerGate;

  const identity = deps.withIdentity || withIdentity;
  try {
    return await identity(event, async ({ client, mapping, spoof }) => {
      const result = await runTmpRlsCatalogInspect({ client, mapping });
      return { ...result, spoofFieldsIgnored: spoof };
    }, deps);
  } catch (error) {
    return denied('catalog_inspect_failed', {
      statusCode: 503,
      message: sanitizePublicError(error),
    });
  }
};

export const handleTmpRlsCatalogInspectRequest = async (event, path, method, deps = {}) => {
  if (path !== INSPECT_PATH) return null;
  if (method !== 'GET') {
    return denied('method_not_allowed', {
      statusCode: 405,
      message: 'This staging catalog inspect route is GET-only. No writes.',
    });
  }
  return handleTmpRlsCatalogInspect(event, deps);
};
