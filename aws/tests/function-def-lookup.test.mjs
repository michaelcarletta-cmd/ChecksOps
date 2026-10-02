import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  FUNCTION_DEF_LOOKUP_SQL,
  catalogInputTypesMatch,
  classifyFunctionDefRows,
  functionDefLookupParams,
  matchFunctionCatalog,
  parseFunctionIdentity,
  readFunctionDef,
} from '../../scripts/deployment-guard/lib/function-def-lookup.mjs';

const MOVE_NAMED = '_user_id uuid, _tenant_id uuid';
const OVERRIDE_NAMED = 'p_check_id uuid, p_new_status text, p_actor_user_id uuid';
const MOVE_DEF = 'CREATE OR REPLACE FUNCTION public.user_can_move_tenant_checks(_user_id uuid, _tenant_id uuid)\n RAW_PG_GET_FUNCTIONDEF_MOVE';
const OVERRIDE_DEF = 'CREATE OR REPLACE FUNCTION public.admin_override_check_status(p_check_id uuid, p_new_status text, p_actor_user_id uuid)\n RAW_PG_GET_FUNCTIONDEF_OVERRIDE';

const NAMED_ARG_CATALOG = Object.freeze([
  {
    schema: 'public',
    name: 'user_can_move_tenant_checks',
    identity_args: MOVE_NAMED,
    input_types: ['uuid', 'uuid'],
    def: MOVE_DEF,
  },
  {
    schema: 'public',
    name: 'admin_override_check_status',
    identity_args: OVERRIDE_NAMED,
    input_types: ['uuid', 'text', 'uuid'],
    def: OVERRIDE_DEF,
  },
  {
    schema: 'public',
    name: 'admin_override_check_status',
    identity_args: 'p_check_id uuid',
    input_types: ['uuid'],
    def: 'OVERLOAD_UUID',
  },
  {
    schema: 'public',
    name: 'admin_override_check_status',
    identity_args: 'a uuid, b uuid',
    input_types: ['uuid', 'uuid'],
    def: 'OVERLOAD_UUID_UUID',
  },
  {
    schema: 'public',
    name: 'admin_override_check_status',
    identity_args: 'a uuid, b text',
    input_types: ['uuid', 'text'],
    def: 'OVERLOAD_UUID_TEXT',
  },
  {
    schema: 'other',
    name: 'user_can_move_tenant_checks',
    identity_args: MOVE_NAMED,
    input_types: ['uuid', 'uuid'],
    def: 'OTHER_SCHEMA_MOVE',
  },
  {
    schema: 'public',
    name: 'user_can_move_tenant_check',
    identity_args: MOVE_NAMED,
    input_types: ['uuid', 'uuid'],
    def: 'WRONG_NAME',
  },
  {
    schema: 'public',
    name: 'admin_override_check_status',
    identity_args: 'OUT p_status text',
    input_types: [],
    def: 'OUT_ONLY',
  },
  {
    schema: 'public',
    name: 'admin_override_check_status',
    identity_args: 'VARIADIC p_ids uuid[]',
    input_types: ['uuid[]'],
    variadic: true,
    def: 'VARIADIC_UUID_ARRAY',
  },
  {
    schema: 'public',
    name: 'status_override_with_default',
    identity_args: 'p_check_id uuid, p_new_status text DEFAULT $1',
    input_types: ['uuid', 'text'],
    has_defaults: true,
    def: 'DEFAULTS_STILL_TWO_INPUTS',
  },
  {
    schema: 'public',
    name: 'user_can_move_tenant_checks',
    identity_args: 'p_id check_id',
    input_types: ['check_id'],
    def: 'DOMAIN_NOT_UUID',
  },
]);

function oldNamedArgStringCompare(identityArgs, requestedArgs) {
  return String(identityArgs || '').replace(/\s+/g, '').toLowerCase()
    === String(requestedArgs || '').replace(/\s+/g, '').toLowerCase();
}

function mockLookupClient(catalog) {
  return {
    async query(sql, params) {
      assert.equal(sql, FUNCTION_DEF_LOOKUP_SQL);
      assert.equal(params.length, 3);
      const [schema, name, argTypes] = params;
      const matches = catalog.filter((row) => (
        row.schema === schema
        && row.name === name
        && catalogInputTypesMatch(argTypes, row.input_types)
      ));
      return { rows: matches.map((row) => ({ def: row.def })) };
    },
  };
}

test('lookup SQL binds schema, name, and catalog type OIDs; it does not compare named identity text', () => {
  assert.equal(FUNCTION_DEF_LOOKUP_SQL.includes('::regprocedure'), false);
  assert.equal(FUNCTION_DEF_LOOKUP_SQL.includes('to_regprocedure'), false);
  assert.match(FUNCTION_DEF_LOOKUP_SQL, /pg_proc/);
  assert.match(FUNCTION_DEF_LOOKUP_SQL, /p\.proargtypes::oid\[\]/);
  assert.match(FUNCTION_DEF_LOOKUP_SQL, /p\.pronargs/);
  assert.match(FUNCTION_DEF_LOOKUP_SQL, /::regtype::oid/);
  assert.match(FUNCTION_DEF_LOOKUP_SQL, /\$1::text/);
  assert.match(FUNCTION_DEF_LOOKUP_SQL, /\$2::text/);
  assert.match(FUNCTION_DEF_LOOKUP_SQL, /\$3::text\[\]/);
  assert.match(FUNCTION_DEF_LOOKUP_SQL, /pg_get_functiondef\(p\.oid\)/);
  const where = FUNCTION_DEF_LOOKUP_SQL.slice(FUNCTION_DEF_LOOKUP_SQL.indexOf('WHERE'));
  assert.equal(where.includes('pg_get_function_identity_arguments'), false);
  assert.equal(where.includes('regexp_replace'), false);
});

test('lookup SQL never casts oid[] to oidvector; live PG error stays fail-closed', async () => {
  const livePgError = 'cannot cast type oid[] to oidvector';
  const invalid610Cast = [
    'CAST(',
    'COALESCE(ARRAY_AGG(u.typ::regtype::oid ORDER BY u.ord), ARRAY[]::oid[])',
    'AS oidvector',
  ].join('');
  const compactSql = FUNCTION_DEF_LOOKUP_SQL.replace(/\s+/g, '');
  assert.equal(/AS\s+oidvector/i.test(FUNCTION_DEF_LOOKUP_SQL), false);
  assert.equal(compactSql.includes(invalid610Cast.replace(/\s+/g, '')), false);
  assert.match(FUNCTION_DEF_LOOKUP_SQL, /ARRAY\(SELECT unnest\(p\.proargtypes::oid\[\]\)\)\s*=/);
  assert.match(FUNCTION_DEF_LOOKUP_SQL, /ARRAY_AGG\(u\.typ::regtype::oid ORDER BY u\.ord\)/);
  assert.match(FUNCTION_DEF_LOOKUP_SQL, /ARRAY\[\]::oid\[\]/);
  assert.equal(/p\.proargtypes\s*=/.test(FUNCTION_DEF_LOOKUP_SQL), false);

  const result = await readFunctionDef({
    async query() {
      throw new Error(livePgError);
    },
  }, 'public.user_can_move_tenant_checks(uuid,uuid)');
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.UNRELATED_MUTATION);
  assert.match(String(result.details.error || result.message), /cannot cast type oid\[\] to oidvector/);
  assert.equal(result.details.exists, undefined);
  assert.notEqual(result.details.exists, false);
});

test('named #601 catalog arguments match unnamed requested type identities', () => {
  assert.equal(oldNamedArgStringCompare(MOVE_NAMED, 'uuid,uuid'), false);
  assert.equal(oldNamedArgStringCompare(OVERRIDE_NAMED, 'uuid,text,uuid'), false);

  const move = matchFunctionCatalog(NAMED_ARG_CATALOG, 'public.user_can_move_tenant_checks(uuid,uuid)');
  assert.equal(move.ok, true);
  assert.deepEqual(move.details, { exists: true, definition: MOVE_DEF });

  const override = matchFunctionCatalog(
    NAMED_ARG_CATALOG,
    'public.admin_override_check_status(uuid,text,uuid)',
  );
  assert.equal(override.ok, true);
  assert.deepEqual(override.details, { exists: true, definition: OVERRIDE_DEF });
});

test('readFunctionDef sends type-name array params and returns raw pg_get_functiondef for named-arg catalog rows', async () => {
  const params = functionDefLookupParams('public.user_can_move_tenant_checks(uuid,uuid)');
  assert.equal(params.ok, true);
  assert.deepEqual(params.details.query_params, ['public', 'user_can_move_tenant_checks', ['uuid', 'uuid']]);

  const client = mockLookupClient(NAMED_ARG_CATALOG);
  const move = await readFunctionDef(client, 'public.user_can_move_tenant_checks(uuid,uuid)');
  assert.equal(move.ok, true);
  assert.equal(move.details.exists, true);
  assert.equal(move.details.definition, MOVE_DEF);

  const override = await readFunctionDef(client, 'public.admin_override_check_status(uuid,text,uuid)');
  assert.equal(override.ok, true);
  assert.equal(override.details.definition, OVERRIDE_DEF);
});

test('overloads resolve only the exact requested type vector', () => {
  assert.equal(
    matchFunctionCatalog(NAMED_ARG_CATALOG, 'public.admin_override_check_status(uuid)').details.definition,
    'OVERLOAD_UUID',
  );
  assert.equal(
    matchFunctionCatalog(NAMED_ARG_CATALOG, 'public.admin_override_check_status(uuid,uuid)').details.definition,
    'OVERLOAD_UUID_UUID',
  );
  assert.equal(
    matchFunctionCatalog(NAMED_ARG_CATALOG, 'public.admin_override_check_status(uuid,text)').details.definition,
    'OVERLOAD_UUID_TEXT',
  );
  assert.equal(
    matchFunctionCatalog(NAMED_ARG_CATALOG, 'public.admin_override_check_status(uuid,text,uuid)').details.definition,
    OVERRIDE_DEF,
  );
});

test('argument order, count, and types matter', () => {
  assert.equal(catalogInputTypesMatch(['uuid', 'text'], ['text', 'uuid']), false);
  assert.equal(catalogInputTypesMatch(['uuid', 'uuid'], ['uuid', 'text']), false);
  assert.equal(catalogInputTypesMatch(['uuid', 'text', 'uuid'], ['uuid', 'text']), false);
  assert.equal(
    matchFunctionCatalog(NAMED_ARG_CATALOG, 'public.admin_override_check_status(text,uuid,uuid)').details.exists,
    false,
  );
  assert.equal(
    matchFunctionCatalog(NAMED_ARG_CATALOG, 'public.user_can_move_tenant_checks(uuid)').details.exists,
    false,
  );
  assert.equal(
    matchFunctionCatalog(NAMED_ARG_CATALOG, 'public.user_can_move_tenant_checks(uuid,uuid,uuid)').details.exists,
    false,
  );
  assert.equal(
    matchFunctionCatalog(NAMED_ARG_CATALOG, 'public.user_can_move_tenant_checks(uuid,text)').details.exists,
    false,
  );
});

test('schema and function name are independent exact binds', () => {
  assert.equal(
    matchFunctionCatalog(NAMED_ARG_CATALOG, 'other.user_can_move_tenant_checks(uuid,uuid)').details.definition,
    'OTHER_SCHEMA_MOVE',
  );
  assert.equal(
    matchFunctionCatalog(NAMED_ARG_CATALOG, 'public.user_can_move_tenant_check(uuid,uuid)').details.definition,
    'WRONG_NAME',
  );
  assert.equal(
    matchFunctionCatalog(NAMED_ARG_CATALOG, 'private.user_can_move_tenant_checks(uuid,uuid)').details.exists,
    false,
  );
});

test('OUT-only arguments cannot create a false match for an input type vector', () => {
  const outOnly = [{
    schema: 'public',
    name: 'admin_override_check_status',
    identity_args: 'OUT p_status text',
    input_types: [],
    def: 'OUT_ONLY',
  }];
  assert.equal(
    matchFunctionCatalog(outOnly, 'public.admin_override_check_status(text)').details.exists,
    false,
  );
  assert.equal(
    matchFunctionCatalog(outOnly, 'public.admin_override_check_status()').details.definition,
    'OUT_ONLY',
  );
});

test('variadic and default argument catalogs cannot broaden a shorter identity', () => {
  assert.equal(
    matchFunctionCatalog(NAMED_ARG_CATALOG, 'public.admin_override_check_status(uuid,uuid)').details.definition,
    'OVERLOAD_UUID_UUID',
  );
  assert.notEqual(
    matchFunctionCatalog(NAMED_ARG_CATALOG, 'public.admin_override_check_status(uuid,uuid)').details.definition,
    'VARIADIC_UUID_ARRAY',
  );
  assert.equal(
    matchFunctionCatalog(NAMED_ARG_CATALOG, 'public.status_override_with_default(uuid)').details.exists,
    false,
  );
  assert.equal(
    matchFunctionCatalog(NAMED_ARG_CATALOG, 'public.status_override_with_default(uuid,text)').details.definition,
    'DEFAULTS_STILL_TWO_INPUTS',
  );
  assert.equal(
    matchFunctionCatalog(NAMED_ARG_CATALOG, 'public.admin_override_check_status(uuid[])').details.definition,
    'VARIADIC_UUID_ARRAY',
  );
});

test('domains are not silently treated as their base type', () => {
  assert.equal(
    matchFunctionCatalog(NAMED_ARG_CATALOG, 'public.user_can_move_tenant_checks(check_id)').details.definition,
    'DOMAIN_NOT_UUID',
  );
  const domainOnly = NAMED_ARG_CATALOG.filter((row) => row.def === 'DOMAIN_NOT_UUID');
  assert.equal(
    matchFunctionCatalog(domainOnly, 'public.user_can_move_tenant_checks(uuid)').details.exists,
    false,
  );
});

test('zero, one, and multiple exact catalog matches classify as specified', () => {
  assert.deepEqual(
    classifyFunctionDefRows([], 'public.missing(uuid)').details,
    { exists: false },
  );
  assert.deepEqual(
    classifyFunctionDefRows([{ def: MOVE_DEF }], 'public.user_can_move_tenant_checks(uuid,uuid)').details,
    { exists: true, definition: MOVE_DEF },
  );
  const dup = classifyFunctionDefRows(
    [{ def: MOVE_DEF }, { def: MOVE_DEF }],
    'public.user_can_move_tenant_checks(uuid,uuid)',
  );
  assert.equal(dup.ok, false);
  assert.equal(dup.code, CODES.SQL_COLLISION);
  const emptyDef = classifyFunctionDefRows([{ def: '' }], 'public.user_can_move_tenant_checks(uuid,uuid)');
  assert.equal(emptyDef.ok, false);
  assert.equal(emptyDef.code, CODES.SQL_COLLISION);
});

test('malformed identities fail closed and never become exists:false', () => {
  const cases = [
    '',
    'user_can_move_tenant_checks(uuid,uuid)',
    'public.user_can_move_tenant_checks',
    'public.user_can_move_tenant_checks(uuid,)',
    'public.user_can_move_tenant_checks(_user_id uuid, _tenant_id uuid)',
    'public.admin_override_check_status(p_check_id uuid, p_new_status text, p_actor_user_id uuid)',
    'public.foo(uuid;text)',
    'public.foo(uuid--comment)',
    'public.foo(bar(uuid))',
  ];
  for (const identity of cases) {
    const parsed = parseFunctionIdentity(identity);
    assert.equal(parsed.ok, false, identity);
    assert.notEqual(parsed.details?.exists, false, identity);
    const matched = matchFunctionCatalog(NAMED_ARG_CATALOG, identity);
    assert.equal(matched.ok, false, identity);
    assert.notEqual(matched.details?.exists, false, identity);
  }
});

test('query, permission, and connectivity errors remain errors and never become exists:false', async () => {
  const errors = [
    'permission denied for table pg_proc',
    'connection refused',
    'timeout expired',
  ];
  for (const message of errors) {
    const result = await readFunctionDef({
      async query() {
        throw new Error(message);
      },
    }, 'public.user_can_move_tenant_checks(uuid,uuid)');
    assert.equal(result.ok, false, message);
    assert.equal(result.code, CODES.UNRELATED_MUTATION, message);
    assert.equal(result.details.exists, undefined, message);
  }
  const unexpected = classifyFunctionDefRows(undefined, 'public.user_can_move_tenant_checks(uuid,uuid)');
  assert.equal(unexpected.ok, false);
  assert.equal(unexpected.details.exists, undefined);
});

test('parseFunctionIdentity keeps requested identities as ordered type names', () => {
  const parsed = parseFunctionIdentity('public.admin_override_check_status(uuid, text, uuid)');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.details, {
    schema: 'public',
    name: 'admin_override_check_status',
    arg_types: ['uuid', 'text', 'uuid'],
    identity_args: 'uuid, text, uuid',
    args: ['uuid', 'text', 'uuid'],
  });
});
