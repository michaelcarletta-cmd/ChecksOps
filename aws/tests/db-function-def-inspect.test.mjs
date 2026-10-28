import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CORE_TABLES,
  EXPECTED_ROW_COUNTS,
  FUNCTION_DEF_INSPECT_SQL,
  LEDGER_TRIGGER_INSPECT_SQL,
  PINNED_FUNCTION_LOOKUPS,
  REQUIRED_LEDGER_TRIGGERS,
  REQUIRED_SETTLEMENT_COLUMNS,
  SETTLEMENT_COLUMN_INSPECT_SQL,
  emptyFunctionDefInspect,
  hashFunctionDefinition,
  inspectPinnedSqlObjects,
  redactFunctionDefInspect,
  validateReadonlyCoreTables,
} from '../functions/api/db-readonly-validate.mjs';
import { handleDbReadonlyValidateRequest, publicDbValidationResponse } from '../functions/api/index.mjs';
import { FUNCTION_DEF_LOOKUP_SQL } from '../../scripts/deployment-guard/lib/function-def-lookup.mjs';
import { hashSqlDefinition } from '../../scripts/deployment-guard/lib/sql-apply.mjs';
import { IDENTITY_PROBE } from '../functions/api/db-health.mjs';

const SECRET_BODY = 'CREATE FUNCTION public.aws_can_write_claim(uuid) RETURNS boolean AS $$ SELECT true $$';
const SECRET_PASSWORD = 'unit-test-only-not-a-real-secret';
const HASH = hashFunctionDefinition(SECRET_BODY);

const identityRow = {
  current_database: 'checksops',
  current_user: 'checksops',
  transaction_read_only: 'on',
  default_transaction_read_only: 'on',
};

const inspectClient = ({
  functionRows = {},
  columns = REQUIRED_SETTLEMENT_COLUMNS,
  triggers = REQUIRED_LEDGER_TRIGGERS,
  throwOn,
} = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.startsWith('SAVEPOINT ') || sql.startsWith('RELEASE SAVEPOINT ') || sql.startsWith('ROLLBACK TO SAVEPOINT ')) {
        return { rows: [] };
      }
      if (sql === FUNCTION_DEF_INSPECT_SQL) {
        if (throwOn === 'function') throw Object.assign(new Error(SECRET_PASSWORD), { code: '42501' });
        const name = params[1];
        return { rows: functionRows[name] || [] };
      }
      if (sql === SETTLEMENT_COLUMN_INSPECT_SQL) {
        if (throwOn === 'columns') throw Object.assign(new Error(SECRET_PASSWORD), { code: '42501' });
        return { rows: columns.map((column_name) => ({ column_name })) };
      }
      if (sql === LEDGER_TRIGGER_INSPECT_SQL) {
        if (throwOn === 'triggers') throw Object.assign(new Error(SECRET_PASSWORD), { code: '42501' });
        return { rows: triggers.map((row) => ({ table_name: row.table, trigger_name: row.trigger })) };
      }
      throw new Error(`unexpected inspect query: ${sql}`);
    },
  };
};

test('official function-definition lookup SQL is reused and stays a parameterized SELECT', () => {
  assert.equal(FUNCTION_DEF_INSPECT_SQL, FUNCTION_DEF_LOOKUP_SQL);
  assert.match(FUNCTION_DEF_INSPECT_SQL, /pg_get_functiondef/);
  assert.match(FUNCTION_DEF_INSPECT_SQL, /\$1::text/);
  assert.match(FUNCTION_DEF_INSPECT_SQL, /\$2::text/);
  assert.match(FUNCTION_DEF_INSPECT_SQL, /\$3::text\[\]/);
  assert.doesNotMatch(FUNCTION_DEF_INSPECT_SQL, /^\s*(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/im);
  assert.doesNotMatch(SETTLEMENT_COLUMN_INSPECT_SQL, /^\s*(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/im);
  assert.doesNotMatch(LEDGER_TRIGGER_INSPECT_SQL, /^\s*(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/im);
  assert.equal(PINNED_FUNCTION_LOOKUPS.length, 4);
  assert.deepEqual(PINNED_FUNCTION_LOOKUPS.map((row) => row.identity), [
    'public.save_claim_settlement_breakdown(uuid,uuid,jsonb)',
    'public.sync_homeowner_ledger_from_check()',
    'public.aws_can_write_claim(uuid)',
    'public.hle_on_check_intake_insert()',
  ]);
  assert.equal(REQUIRED_SETTLEMENT_COLUMNS.includes('other_structures_rcv'), true);
  assert.equal(REQUIRED_SETTLEMENT_COLUMNS.includes('pwi_rcv'), true);
  assert.equal(REQUIRED_SETTLEMENT_COLUMNS.includes('personal_property_rcv'), true);
  assert.equal(REQUIRED_SETTLEMENT_COLUMNS.includes('ale_rcv'), true);
  assert.equal(REQUIRED_LEDGER_TRIGGERS.length, 3);
});

test('definition hashes match the official SQL pin helper and never keep the body', () => {
  assert.equal(hashFunctionDefinition(SECRET_BODY), hashSqlDefinition(SECRET_BODY));
  assert.match(HASH, /^[0-9a-f]{64}$/);
  const leaked = redactFunctionDefInspect({
    readOnly: false,
    functions: [{
      identity: 'public.aws_can_write_claim(uuid)',
      exists: true,
      definitionSha256: HASH,
      definition: SECRET_BODY,
      def: SECRET_BODY,
      prosrc: SECRET_BODY,
      password: SECRET_PASSWORD,
    }],
    settlementColumns: [{
      table: 'claim_settlements',
      column: 'other_structures_rcv',
      exists: true,
      definition: SECRET_BODY,
    }],
    ledgerTriggers: [{
      table: 'check_intake_items',
      trigger: 'trg_hle_check_intake_insert',
      exists: true,
      definition: SECRET_BODY,
    }],
    password: SECRET_PASSWORD,
  });
  assert.equal(leaked.readOnly, true);
  assert.deepEqual(leaked.functions.find((row) => row.identity === 'public.aws_can_write_claim(uuid)'), {
    identity: 'public.aws_can_write_claim(uuid)',
    exists: true,
    definitionSha256: HASH,
  });
  assert.equal(JSON.stringify(leaked).includes(SECRET_BODY), false);
  assert.equal(JSON.stringify(leaked).includes(SECRET_PASSWORD), false);
  assert.equal(Object.hasOwn(leaked.functions.find((row) => row.identity === 'public.aws_can_write_claim(uuid)'), 'definition'), false);
  assert.doesNotMatch(JSON.stringify(leaked), /"definition":|"def":|"prosrc":|"password":/);
  assert.equal(Object.keys(leaked).sort().join(','), 'functions,ledgerTriggers,readOnly,settlementColumns');
});

test('pinned inspect returns existence and hashes from read-only catalog queries', async () => {
  const client = inspectClient({
    functionRows: {
      aws_can_write_claim: [{ schema_name: 'public', function_name: 'aws_can_write_claim', def: SECRET_BODY }],
      hle_on_check_intake_insert: [],
    },
    columns: ['other_structures_rcv', 'ale_rcv'],
    triggers: [{ table: 'check_intake_items', trigger: 'trg_hle_check_intake_insert' }],
  });
  const inspect = await inspectPinnedSqlObjects(client);
  assert.equal(inspect.readOnly, true);
  assert.deepEqual(inspect.functions.find((row) => row.identity === 'public.aws_can_write_claim(uuid)'), {
    identity: 'public.aws_can_write_claim(uuid)',
    exists: true,
    definitionSha256: HASH,
  });
  assert.deepEqual(inspect.functions.find((row) => row.identity === 'public.hle_on_check_intake_insert()'), {
    identity: 'public.hle_on_check_intake_insert()',
    exists: false,
    definitionSha256: null,
  });
  assert.equal(inspect.settlementColumns.find((row) => row.column === 'other_structures_rcv').exists, true);
  assert.equal(inspect.settlementColumns.find((row) => row.column === 'pwi_rcv').exists, false);
  assert.equal(inspect.ledgerTriggers.find((row) => row.trigger === 'trg_hle_check_intake_insert').exists, true);
  assert.equal(inspect.ledgerTriggers.find((row) => row.trigger === 'trg_sync_homeowner_ledger_ins').exists, false);
  assert.equal(JSON.stringify(inspect).includes(SECRET_BODY), false);
  assert.equal(client.queries.some((item) => item.sql === FUNCTION_DEF_INSPECT_SQL), true);
  assert.equal(client.queries.some((item) => /^\s*(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/i.test(item.sql)), false);
});

test('inspect query failures stay absent and never copy error text or credentials', async () => {
  const inspect = await inspectPinnedSqlObjects(inspectClient({ throwOn: 'function' }));
  assert.deepEqual(inspect.functions, emptyFunctionDefInspect().functions);
  assert.equal(JSON.stringify(inspect).includes(SECRET_PASSWORD), false);
});

test('public HTTP mapping still ignores inspect and health stays unchanged when objects are absent', async () => {
  const saved = process.env.CHECKSOPS_ENV;
  process.env.CHECKSOPS_ENV = 'staging';
  const queries = [];
  const validation = await validateReadonlyCoreTables({
    loadCredentials: async () => ({
      username: 'checksops',
      password: SECRET_PASSWORD,
      host: 'db.example.internal',
      database: 'checksops',
      secretDatabase: 'postgres',
    }),
    createClient: () => ({
      connect: async () => {},
      query: async (sql, params) => {
        queries.push(sql);
        if (sql === 'BEGIN READ ONLY' || sql === 'ROLLBACK'
            || sql.startsWith('SAVEPOINT ') || sql.startsWith('RELEASE SAVEPOINT ')
            || sql.startsWith('ROLLBACK TO SAVEPOINT ')) return { rows: [] };
        if (sql === IDENTITY_PROBE) return { rows: [identityRow] };
        if (sql.startsWith('SELECT to_regclass($1)')) return { rows: [{ regclass: params[0] }] };
        if (sql.startsWith('SELECT count(*)::bigint AS row_count')) {
          const table = sql.match(/public\."([^"]+)"/)[1];
          return { rows: [{ row_count: EXPECTED_ROW_COUNTS[table] }] };
        }
        if (sql.includes('has_table_privilege')) return { rows: CORE_TABLES.map((table) => ({
          table_name: table, can_select: true, can_insert: false, can_update: false,
          can_delete: false, rls_enabled: false, rls_forced: false,
        })) };
        if (sql.includes('_checksops_restore_complete')) return { rows: [{ present: true }] };
        if (sql.includes('has_schema_privilege')) return { rows: [{ schema_name: 'public', can_usage: true }] };
        if (sql.includes("c.relname = 'users'")) return { rows: [{ present: false }] };
        if (sql.includes('pg_constraint')) return { rows: [{ fk_count: 0 }] };
        if (sql === FUNCTION_DEF_INSPECT_SQL) return { rows: [] };
        if (sql === SETTLEMENT_COLUMN_INSPECT_SQL) return { rows: [] };
        if (sql === LEDGER_TRIGGER_INSPECT_SQL) return { rows: [] };
        if (sql.includes('pg_get_triggerdef')) return { rows: [] };
        if (sql.includes('pg_trigger')) return { rows: [{ trigger_count: 184 }] };
        if (sql.includes('prokind')) return { rows: [{
          function_count: 0, auth_uid_functions: 0, net_functions: 0, cron_functions: 0,
          vault_functions: 0, pgmq_functions: 0,
        }] };
        if (sql.includes('has_function_privilege')) return { rows: [{ can_execute: false }] };
        if (sql.includes('SELECT auth.uid()')) throw Object.assign(new Error('permission denied'), { code: '42501' });
        if (sql.includes('FROM pg_roles') || sql.includes('relrowsecurity') || sql.includes('FROM pg_policies')) {
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
      end: async () => {},
    }),
  });
  if (saved === undefined) delete process.env.CHECKSOPS_ENV;
  else process.env.CHECKSOPS_ENV = saved;

  assert.equal(validation.ok, true);
  assert.equal(validation.issues.some((item) => item.severity === 'error'), false);
  assert.equal(validation.inspect.functions.every((row) => row.exists === false), true);
  assert.equal(queries.includes('BEGIN READ ONLY'), true);
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.equal(queries.some((sql) => /^\s*(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|GRANT|REVOKE)\b/i.test(sql)), false);
  assert.equal(JSON.stringify(validation).includes(SECRET_PASSWORD), false);

  const publicResult = publicDbValidationResponse(validation);
  assert.deepEqual(publicResult, {
    statusCode: 200,
    body: { service: 'checksops-api', status: 'ok', readOnly: true },
  });
});

const validationWithInspect = {
  ok: true,
  readOnly: true,
  writesAttempted: false,
  issues: [],
  tables: [],
  inspect: {
    readOnly: true,
    functions: [{
      identity: 'public.aws_can_write_claim(uuid)',
      exists: true,
      definitionSha256: HASH,
      definition: SECRET_BODY,
      password: SECRET_PASSWORD,
    }],
    settlementColumns: [],
    ledgerTriggers: [],
  },
};

test('unauthenticated and forbidden callers never receive inspect details', async () => {
  const publicResult = await handleDbReadonlyValidateRequest({}, {
    validate: async () => validationWithInspect,
    resolveAuth: async () => ({ ok: false }),
    authorizeDetails: async () => ({ ok: false, reason: 'unauthenticated' }),
  });
  assert.deepEqual(publicResult.body, { service: 'checksops-api', status: 'ok', readOnly: true });
  assert.equal(Object.hasOwn(publicResult.body, 'inspect'), false);
  assert.equal(JSON.stringify(publicResult).includes(SECRET_BODY), false);

  const forbidden = await handleDbReadonlyValidateRequest({}, {
    validate: async () => validationWithInspect,
    resolveAuth: async () => ({ ok: true, claims: { sub: 'cognito-sub' } }),
    authorizeDetails: async () => ({ ok: false, reason: 'not_admin', statusCode: 403 }),
  });
  assert.deepEqual(forbidden, { statusCode: 403, body: { error: 'not_authorized' } });
  assert.equal(JSON.stringify(forbidden).includes(SECRET_BODY), false);
  assert.equal(JSON.stringify(forbidden).includes(HASH), false);
});

test('production validation does not attach inspect and keeps the existing result shape', async () => {
  const saved = process.env.CHECKSOPS_ENV;
  process.env.CHECKSOPS_ENV = 'production';
  const validation = await validateReadonlyCoreTables({
    loadCredentials: async () => ({
      username: 'checksops',
      password: SECRET_PASSWORD,
      host: 'db.example.internal',
      database: 'checksops',
      secretDatabase: 'postgres',
    }),
    createClient: () => ({
      connect: async () => {},
      query: async (sql, params) => {
        if (sql === FUNCTION_DEF_INSPECT_SQL || sql === SETTLEMENT_COLUMN_INSPECT_SQL || sql === LEDGER_TRIGGER_INSPECT_SQL) {
          throw new Error('production must not inspect function definitions');
        }
        if (sql === 'BEGIN READ ONLY' || sql === 'ROLLBACK'
            || sql.startsWith('SAVEPOINT ') || sql.startsWith('RELEASE SAVEPOINT ')
            || sql.startsWith('ROLLBACK TO SAVEPOINT ')) return { rows: [] };
        if (sql === IDENTITY_PROBE) return { rows: [identityRow] };
        if (sql.startsWith('SELECT to_regclass($1)')) return { rows: [{ regclass: params[0] }] };
        if (sql.startsWith('SELECT count(*)::bigint AS row_count')) {
          const table = sql.match(/public\."([^"]+)"/)[1];
          return { rows: [{ row_count: EXPECTED_ROW_COUNTS[table] }] };
        }
        if (sql.includes('has_table_privilege')) return { rows: CORE_TABLES.map((table) => ({
          table_name: table, can_select: true, can_insert: false, can_update: false,
          can_delete: false, rls_enabled: false, rls_forced: false,
        })) };
        if (sql.includes('_checksops_restore_complete')) return { rows: [{ present: true }] };
        if (sql.includes('has_schema_privilege')) return { rows: [{ schema_name: 'public', can_usage: true }] };
        if (sql.includes("c.relname = 'users'")) return { rows: [{ present: false }] };
        if (sql.includes('pg_constraint')) return { rows: [{ fk_count: 0 }] };
        if (sql.includes('pg_get_triggerdef')) return { rows: [] };
        if (sql.includes('pg_trigger')) return { rows: [{ trigger_count: 184 }] };
        if (sql.includes('prokind')) return { rows: [{
          function_count: 0, auth_uid_functions: 0, net_functions: 0, cron_functions: 0,
          vault_functions: 0, pgmq_functions: 0,
        }] };
        if (sql.includes('has_function_privilege')) return { rows: [{ can_execute: false }] };
        if (sql.includes('SELECT auth.uid()')) throw Object.assign(new Error('permission denied'), { code: '42501' });
        if (sql.includes('FROM pg_roles') || sql.includes('relrowsecurity') || sql.includes('FROM pg_policies')) {
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
      end: async () => {},
    }),
  });
  if (saved === undefined) delete process.env.CHECKSOPS_ENV;
  else process.env.CHECKSOPS_ENV = saved;
  assert.equal(validation.ok, true);
  assert.equal(Object.hasOwn(validation, 'inspect'), false);
});

test('only staging-admin details include redacted inspect hashes', async () => {
  const allowed = await handleDbReadonlyValidateRequest({}, {
    validate: async () => validationWithInspect,
    resolveAuth: async () => ({ ok: true, claims: { sub: 'cognito-sub' } }),
    authorizeDetails: async () => ({ ok: true, reason: 'staging_admin' }),
  });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.body.inspect.readOnly, true);
  assert.deepEqual(allowed.body.inspect.functions.find((row) => row.identity === 'public.aws_can_write_claim(uuid)'), {
    identity: 'public.aws_can_write_claim(uuid)',
    exists: true,
    definitionSha256: HASH,
  });
  assert.equal(JSON.stringify(allowed).includes(SECRET_BODY), false);
  assert.equal(JSON.stringify(allowed).includes(SECRET_PASSWORD), false);

  const production = await handleDbReadonlyValidateRequest({}, {
    validate: async () => validationWithInspect,
    resolveAuth: async () => ({ ok: true, claims: { sub: 'cognito-sub' } }),
    authorizeDetails: async () => ({ ok: true, reason: 'production_authenticated' }),
  });
  assert.equal(Object.hasOwn(production.body, 'inspect'), false);
  assert.equal(production.body.ok, true);
  assert.equal(JSON.stringify(production).includes(SECRET_BODY), false);
});
