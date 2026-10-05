/**
 * Temporary staging-only TMP RLS catalog inspector.
 * Fixtures only. No AWS mutation, SQL apply, or live catalog inspect.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { USER_ROLES_SQL } from '../functions/api/identity.mjs';
import {
  FIXED_SQLS,
  FUNCTION_NAMESPACES,
  FUNCTION_OVERLOADS_SQL,
  GRANTS_SQL,
  INSPECT_PATH,
  INSPECTOR_ID,
  OWNER_FLAGS_SQL,
  PINNED_FUNCTION_LOOKUPS,
  PINNED_FUNCTION_NAMES,
  POLICIES_SQL,
  PRIVILEGE_SQL,
  REFUSED_CALLER_KEYS,
  ROLE_MEMBERSHIP_SQL,
  SESSION_SQL,
  SET_READ_ONLY_SQL,
  TABLE_SQL,
  TMP_TABLE,
  TRIGGER_SQL,
  assertNoCallerCatalogOverride,
  assertStagingOnly,
  extractReferencedFunctionNames,
  handleTmpRlsCatalogInspect,
  handleTmpRlsCatalogInspectRequest,
  runTmpRlsCatalogInspect,
  sha256Text,
} from '../functions/api/tenant-maintenance-payments-catalog-inspect.mjs';

const ADMIN = '75d3da03-326c-4ea0-8cd1-684d695495a3';
const MEMBER = '11111111-1111-4111-8111-111111111111';

const inspectSource = () => readFileSync(
  new URL('../functions/api/tenant-maintenance-payments-catalog-inspect.mjs', import.meta.url),
  'utf8',
);
const indexSource = () => readFileSync(
  new URL('../functions/api/index.mjs', import.meta.url),
  'utf8',
);

const jwtEvent = (extra = {}) => ({
  rawPath: INSPECT_PATH,
  rawQueryString: extra.rawQueryString || '',
  queryStringParameters: extra.query || {},
  headers: { authorization: extra.auth === null ? undefined : 'Bearer test-id-token' },
  body: extra.body === undefined ? undefined : JSON.stringify(extra.body),
  requestContext: {
    stage: extra.stage || 'staging',
    http: { method: extra.method || 'GET', path: INSPECT_PATH },
  },
});

const WRITE_HELPER_DEF = `CREATE OR REPLACE FUNCTION public.aws_can_write_tenant(_tenant_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET row_security TO 'off'
AS $function$
  SELECT true;
$function$`;

function createInspectStore({
  roles = ['admin'],
  master = false,
  platform = false,
} = {}) {
  const queries = [];
  const client = {
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql === SET_READ_ONLY_SQL) return { rows: [] };
      if (sql === USER_ROLES_SQL) return { rows: roles.map((role) => ({ role })) };
      if (sql === OWNER_FLAGS_SQL) {
        return { rows: [{ is_master: master === true, is_platform: platform === true }] };
      }
      if (sql === SESSION_SQL) {
        return {
          rows: [{
            current_user: 'checksops',
            session_user: 'checksops',
            current_role: 'checksops',
            current_database: 'checksops',
            transaction_read_only: 'on',
            default_transaction_read_only: 'on',
            row_security: 'on',
          }],
        };
      }
      if (sql === TABLE_SQL) {
        return {
          rows: [{
            table: TMP_TABLE,
            owner: 'checksops_admin',
            relrowsecurity: true,
            relforcerowsecurity: false,
          }],
        };
      }
      if (sql === GRANTS_SQL) {
        return {
          rows: [
            { grantee: 'authenticated', privilege_type: 'INSERT', is_grantable: 'NO' },
            { grantee: 'checksops', privilege_type: 'INSERT', is_grantable: 'NO' },
          ],
        };
      }
      if (sql === PRIVILEGE_SQL) {
        return {
          rows: [{
            checksops_select: true,
            checksops_insert: true,
            checksops_update: true,
            checksops_delete: true,
          }],
        };
      }
      if (sql === ROLE_MEMBERSHIP_SQL) return { rows: [{ member_of: 'authenticated' }] };
      if (sql === POLICIES_SQL) {
        return {
          rows: [{
            policy_name: 'aws_write_tenant_maintenance_payments',
            permissive: 'PERMISSIVE',
            command: 'ALL',
            roles: ['authenticated'],
            using_expression: 'aws_can_write_tenant(tenant_id)',
            with_check: 'aws_can_write_tenant(tenant_id)',
          }],
        };
      }
      if (sql === FUNCTION_OVERLOADS_SQL) {
        assert.deepEqual(params[0], FUNCTION_NAMESPACES);
        assert.equal(params[1].includes('aws_can_write_tenant'), true);
        return {
          rows: [{
            schema_name: 'public',
            function_name: 'aws_can_write_tenant',
            function_oid: 4242,
            identity_arguments: 'uuid',
            arguments: '_tenant_id uuid',
            security_definer: true,
            security: 'DEFINER',
            owner: 'checksops_admin',
            proconfig: ['search_path=public', 'row_security=off'],
            prokind: 'f',
            definition: WRITE_HELPER_DEF,
          }],
        };
      }
      if (sql === TRIGGER_SQL) {
        return {
          rows: [{
            trigger_name: 'tenant_maintenance_payments_set_updated_at',
            timing: 'BEFORE',
            on_insert: false,
            on_update: true,
            on_delete: false,
            on_truncate: false,
            enabled: 'O',
            definition: 'CREATE TRIGGER tenant_maintenance_payments_set_updated_at BEFORE UPDATE ON public.tenant_maintenance_payments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
            function_oid: 99,
            function_schema: 'public',
            function_name: 'set_updated_at',
            function_identity_arguments: '',
            function_security_definer: false,
            function_security: 'INVOKER',
            function_owner: 'checksops_admin',
            function_proconfig: null,
            function_definition: 'CREATE FUNCTION public.set_updated_at() ...',
          }],
        };
      }
      throw new Error(`unexpected inspect SQL: ${sql}`);
    },
  };
  return { client, queries };
}

const handle = (store, extra = {}) => handleTmpRlsCatalogInspect(jwtEvent(extra), {
  env: Object.hasOwn(extra, 'env') ? extra.env : 'staging',
  body: extra.body,
  withIdentity: extra.withIdentity || (async (_event, fn) => fn({
    client: store.client,
    mapping: { application_user_id: extra.userId || ADMIN },
    spoof: { ignored: true },
  })),
});

test('source is a fixed-query read-only inspector with no DML/DDL or executor widening', () => {
  const source = inspectSource();
  assert.match(source, /TEMPORARY staging-only read-only catalog inspector/);
  assert.match(source, /withIdentity/);
  assert.equal(source.includes('withIdentityWrite'), false);
  assert.equal(source.includes('buildWriteClientConfig'), false);
  assert.equal(source.includes('guarded-sql-executor'), false);
  assert.equal(source.includes('SET ROLE'), false);
  assert.equal(source.includes('row_security = off') || source.includes("row_security=off'"), false);
  assert.equal(/INSERT\s+INTO/i.test(source), false);
  assert.equal(/UPDATE\s+public\./i.test(source), false);
  assert.equal(/DELETE\s+FROM/i.test(source), false);
  assert.equal(/DROP\s+POLICY/i.test(source), false);
  assert.equal(/CREATE\s+POLICY/i.test(source), false);
  assert.equal(/ALTER\s+TABLE/i.test(source), false);
  assert.equal(/GRANT\s+/i.test(source), false);
  assert.equal(/REVOKE\s+/i.test(source), false);
  assert.equal(source.includes('event.sql'), false);
  assert.equal(source.includes('body.sql'), false);
  assert.match(source, /tenant_maintenance_payments/);
  assert.equal((source.match(/relname = 'tenant_maintenance_payments'/g) || []).length >= 3, true);
});

test('index exposes only GET /inspect/tmp-rls-catalog and marks it temporary', () => {
  const source = indexSource();
  assert.match(source, /handleTmpRlsCatalogInspectRequest/);
  assert.match(source, /TEMPORARY staging-only TMP RLS catalog inspect/);
  assert.equal((source.match(/handleTmpRlsCatalogInspectRequest/g) || []).length, 2);
  assert.match(source, /'\/inspect\/tmp-rls-catalog'/);
});

test('production invocation is rejected before any query', async () => {
  const store = createInspectStore();
  const result = await handle(store, { env: 'production' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'production_inspect_forbidden');
  assert.equal(store.queries.length, 0);
});

test('unset and unknown environments are refused like production', async () => {
  const store = createInspectStore();
  for (const env of ['', 'unknown', 'prod', undefined]) {
    const result = await handle(store, { env });
    assert.equal(result.error, 'production_inspect_forbidden', String(env));
    assert.equal(store.queries.length, 0);
  }
});

test('unauthenticated invocation is rejected', async () => {
  const store = createInspectStore();
  const result = await handle(store, {
    withIdentity: async () => ({ ok: false, statusCode: 401, error: 'missing_cognito_token' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 401);
  assert.equal(result.error, 'missing_cognito_token');
  assert.equal(store.queries.length, 0);
});

test('non-admin invocation is denied before catalog queries', async () => {
  const store = createInspectStore({ roles: ['member'], master: false, platform: false });
  const result = await runTmpRlsCatalogInspect({
    client: store.client,
    mapping: { application_user_id: MEMBER },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'admin_required');
  assert.equal(store.queries.some((row) => row.sql === POLICIES_SQL), false);
  assert.equal(store.queries.some((row) => row.sql === FUNCTION_OVERLOADS_SQL), false);
  assert.equal(store.queries.some((row) => row.sql === TRIGGER_SQL), false);
});

test('platform and master owners are authorized without tenant admin role', async () => {
  const store = createInspectStore({ roles: ['member'], master: true, platform: false });
  const result = await runTmpRlsCatalogInspect({
    client: store.client,
    mapping: { application_user_id: ADMIN },
  });
  assert.equal(result.ok, true);
  assert.equal(result.policies[0].name, 'aws_write_tenant_maintenance_payments');
});

test('caller cannot submit SQL or change the inspected table', () => {
  for (const key of ['sql', 'table', 'function', 'oid', 'schema']) {
    const refused = assertNoCallerCatalogOverride(
      { queryStringParameters: { [key]: 'evil' }, rawQueryString: `${key}=evil` },
      {},
    );
    assert.equal(refused.error, 'caller_catalog_override_forbidden', key);
    assert.equal(refused.refused_keys.includes(key), true, key);
  }
  const bodyRefused = assertNoCallerCatalogOverride({}, { sql: 'DROP TABLE tenants', table: 'tenants' });
  assert.equal(bodyRefused.error, 'caller_catalog_override_forbidden');
  assert.equal(assertNoCallerCatalogOverride({ queryStringParameters: {} }, {}), null);
});

test('handler rejects caller catalog overrides without querying', async () => {
  const store = createInspectStore();
  const result = await handle(store, {
    body: { sql: 'SELECT 1', table: 'tenants' },
  });
  assert.equal(result.error, 'caller_catalog_override_forbidden');
  assert.equal(store.queries.length, 0);
});

test('non-GET methods are rejected by the request wrapper', async () => {
  const store = createInspectStore();
  const result = await handleTmpRlsCatalogInspectRequest(
    jwtEvent({ method: 'POST' }),
    INSPECT_PATH,
    'POST',
    { env: 'staging', withIdentity: async () => ({ ok: true }) },
  );
  assert.equal(result.error, 'method_not_allowed');
  assert.equal(result.statusCode, 405);
  assert.equal(store.queries.length, 0);
  assert.equal(await handleTmpRlsCatalogInspectRequest({}, '/db-health', 'GET'), null);
});

test('authorized inspect returns only predetermined catalog fields', async () => {
  const store = createInspectStore();
  const result = await handle(store);
  assert.equal(result.ok, true);
  assert.equal(result.inspector, INSPECTOR_ID);
  assert.equal(result.temporary, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.writesAttempted, false);
  assert.equal(result.table, TMP_TABLE);
  assert.equal(result.table_catalog.owner, 'checksops_admin');
  assert.equal(result.table_catalog.relrowsecurity, true);
  assert.equal(result.table_catalog.relforcerowsecurity, false);
  assert.equal(result.policies[0].using, 'aws_can_write_tenant(tenant_id)');
  assert.equal(result.policies[0].with_check, 'aws_can_write_tenant(tenant_id)');
  assert.equal(result.policies[0].permissive, 'PERMISSIVE');
  assert.equal(result.functions[0].function_oid, 4242);
  assert.equal(result.functions[0].identity, 'public.aws_can_write_tenant(uuid)');
  assert.equal(result.functions[0].security, 'DEFINER');
  assert.equal(result.functions[0].definition_sha256, sha256Text(WRITE_HELPER_DEF));
  assert.equal(result.functions[0].pinned, true);
  assert.equal(result.triggers[0].timing, 'BEFORE');
  assert.equal(result.triggers[0].on_update, true);
  assert.equal(result.triggers[0].on_insert, false);
  assert.equal(result.session.current_user, 'checksops');
  assert.equal(result.lambda_role_membership.includes('authenticated'), true);
  assert.equal(Object.hasOwn(result, 'password'), false);
  assert.equal(JSON.stringify(result).includes('Bearer'), false);
});

test('every executed statement is one of the fixed SQL constants', async () => {
  const store = createInspectStore();
  await handle(store);
  assert.equal(store.queries.length > 0, true);
  for (const row of store.queries) {
    assert.equal(FIXED_SQLS.includes(row.sql), true, row.sql);
    assert.equal(
      /\b(INSERT\s+INTO|UPDATE\s+\w+|DELETE\s+FROM|DROP\s+|ALTER\s+|CREATE\s+|GRANT\s+|REVOKE\s+|SET\s+ROLE)\b/i.test(row.sql),
      false,
      row.sql,
    );
  }
  assert.deepEqual(store.queries.find((row) => row.sql === FUNCTION_OVERLOADS_SQL).params[0], ['public', 'auth']);
  const names = store.queries.find((row) => row.sql === FUNCTION_OVERLOADS_SQL).params[1];
  for (const name of PINNED_FUNCTION_NAMES) {
    assert.equal(names.includes(name), true, name);
  }
});

test('policy-referenced functions are discovered from catalog text, not the caller', () => {
  const names = extractReferencedFunctionNames([
    "aws_is_cross_tenant_reader() OR aws_can_access_tenant(tenant_id)",
    "public.aws_can_write_tenant(tenant_id) AND auth.uid() IS NOT NULL",
  ]);
  assert.deepEqual(names, [
    'aws_can_access_tenant',
    'aws_can_write_tenant',
    'aws_is_cross_tenant_reader',
    'uid',
  ]);
  assert.equal(PINNED_FUNCTION_LOOKUPS.length, 5);
  assert.deepEqual(PINNED_FUNCTION_LOOKUPS[0], {
    schema: 'public',
    name: 'aws_can_write_tenant',
    args: ['uuid'],
  });
});

test('index POST /inspect/tmp-rls-catalog is method_not_allowed', async () => {
  const source = indexSource();
  assert.match(source, /const READ_ONLY_PATHS = new Set\(\[[\s\S]*'\/inspect\/tmp-rls-catalog'/);
  assert.match(source, /\(READ_ONLY_PATHS\.has\(path\) \|\| complianceRoute\) && method !== 'GET'/);
  const previous = process.env.CHECKSOPS_ENV;
  process.env.CHECKSOPS_ENV = 'staging';
  try {
    const loaded = await import('../functions/api/index.mjs').catch((error) => error);
    if (loaded instanceof Error) {
      assert.match(String(loaded.message || loaded), /tenant-collection-v2-uat|public-invoice/);
      return;
    }
    const response = await loaded.handler({
      rawPath: INSPECT_PATH,
      requestContext: {
        stage: 'staging',
        http: { method: 'POST', path: INSPECT_PATH },
      },
    });
    assert.equal(response.statusCode, 405);
    assert.equal(JSON.parse(response.body).error, 'method_not_allowed');
  } finally {
    if (previous === undefined) delete process.env.CHECKSOPS_ENV;
    else process.env.CHECKSOPS_ENV = previous;
  }
});

test('assertStagingOnly and sha256 helpers are deterministic', () => {
  assert.equal(assertStagingOnly('staging'), null);
  assert.equal(assertStagingOnly('production').error, 'production_inspect_forbidden');
  assert.equal(
    sha256Text('abc'),
    createHash('sha256').update('abc', 'utf8').digest('hex'),
  );
  assert.equal(REFUSED_CALLER_KEYS.includes('sql'), true);
});
