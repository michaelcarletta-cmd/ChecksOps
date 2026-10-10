import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

register('./helpers/pg-ci-stub-hooks.mjs', import.meta.url);

const {
  FUNCTION_DEF_INSPECT_SQL,
  LEDGER_TRIGGER_INSPECT_SQL,
  PINNED_FUNCTION_LOOKUPS,
  REQUIRED_LEDGER_TRIGGERS,
  REQUIRED_SETTLEMENT_COLUMNS,
  SETTLEMENT_COLUMN_INSPECT_SQL,
  hashFunctionDefinition,
} = await import('../functions/api/db-readonly-validate.mjs');
const {
  SQL53_FUNCTION_DEF_INSPECT_SQL,
  SQL53_LEDGER_TRIGGER_INSPECT_SQL,
  SQL53_PINNED_FUNCTION_LOOKUPS,
  SQL53_REQUIRED_LEDGER_TRIGGERS,
  SQL53_REQUIRED_SETTLEMENT_COLUMNS,
  SQL53_READONLY_INSPECT_AUTHORIZATION,
  SQL53_READONLY_INSPECT_AUTHORIZATION_ENV,
  SQL53_READONLY_INSPECT_AUTHORIZATION_MIN_LENGTH,
  SQL53_READONLY_INSPECT_DIAGNOSTIC,
  SQL53_READONLY_INSPECT_EXPECTED_FUNCTION,
  SQL53_READONLY_INSPECT_EXPECTED_RDS_IDENTIFIER,
  SQL53_READONLY_INSPECT_EXPIRES_AT_ENV,
  SQL53_READONLY_INSPECT_MAX_WINDOW_MS,
  SQL53_READONLY_INSPECT_SECRETS_SHA256,
  SQL53_SETTLEMENT_COLUMN_INSPECT_SQL,
  assertSql53InspectQueryAllowlisted,
  handleSql53ProductionReadonlyInspect,
  hashSql53Definition,
  hashSql53PackageMember,
  isHttpApiGatewayEvent,
  isSql53ProductionReadonlyInspectEvent,
  proveSql53ReadonlyInspectProvenance,
  redactSql53InspectResponse,
  secretHostBindsProvenRds,
  sql53ReadonlyInspectAuthorizationState,
  sql53ReadonlyInspectExpiryState,
} = await import('../functions/api/sql53-production-readonly-inspect.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'aws/functions/api');
const SECRET_BODY = 'CREATE FUNCTION public.save_claim_settlement_breakdown(uuid,uuid,jsonb) RETURNS jsonb AS $$ SELECT 1 $$';
const SECRET_PASSWORD = 'unit-test-only-not-a-real-secret';
const OWNER_TOKEN = 'unit-test-sql53-inspect-token-32ch';
const HASH = hashSql53Definition(SECRET_BODY);
const PROVEN_HOST = 'checksops-production.c0fakehash.us-east-1.rds.amazonaws.com';
const STAGING_HOST = 'checksops-staging.c0fakehash.us-east-1.rds.amazonaws.com';

const authorizedEnv = () => ({
  CHECKSOPS_ENV: 'production',
  AWS_LAMBDA_FUNCTION_NAME: SQL53_READONLY_INSPECT_EXPECTED_FUNCTION,
  [SQL53_READONLY_INSPECT_AUTHORIZATION_ENV]: OWNER_TOKEN,
  [SQL53_READONLY_INSPECT_EXPIRES_AT_ENV]: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
});

const authorizedEvent = () => ({
  diagnostic: SQL53_READONLY_INSPECT_DIAGNOSTIC,
  authorization: OWNER_TOKEN,
});

const provenCredentials = (overrides = {}) => ({
  username: 'checksops',
  host: PROVEN_HOST,
  password: SECRET_PASSWORD,
  ...overrides,
});

function inspectClient({
  database = 'checksops',
  user = 'checksops',
  readOnly = 'on',
  functions = {
    save_claim_settlement_breakdown: [{ def: SECRET_BODY }],
    sync_homeowner_ledger_from_check: [{ def: 'CREATE FUNCTION public.sync_homeowner_ledger_from_check() AS $$ SELECT 1 $$' }],
    aws_can_write_claim: [{ def: 'CREATE FUNCTION public.aws_can_write_claim(uuid) AS $$ SELECT true $$' }],
    hle_on_check_intake_insert: [{ def: 'CREATE FUNCTION public.hle_on_check_intake_insert() AS $$ SELECT 1 $$' }],
  },
  columns = [...REQUIRED_SETTLEMENT_COLUMNS],
  triggers = REQUIRED_LEDGER_TRIGGERS.map((row) => ({ table_name: row.table, trigger_name: row.trigger })),
  throwOn,
} = {}) {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (throwOn && sql === throwOn) throw new Error(SECRET_PASSWORD);
      if (sql === 'BEGIN READ ONLY' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('current_database()')) {
        return { rows: [{
          current_database: database,
          current_user: user,
          transaction_read_only: readOnly,
          default_transaction_read_only: readOnly,
        }] };
      }
      if (sql === SQL53_FUNCTION_DEF_INSPECT_SQL) {
        return { rows: functions[params[1]] || [] };
      }
      if (sql === SQL53_SETTLEMENT_COLUMN_INSPECT_SQL) {
        return { rows: columns.map((column_name) => ({ column_name })) };
      }
      if (sql === SQL53_LEDGER_TRIGGER_INSPECT_SQL) {
        return { rows: triggers };
      }
      throw new Error(`unexpected inspect query: ${sql}`);
    },
  };
}

function closedDeps() {
  const calls = [];
  return {
    calls,
    loadCredentials: async () => {
      calls.push('credentials');
      throw new Error('must not load credentials');
    },
    createClient: () => {
      calls.push('client');
      throw new Error('must not connect');
    },
  };
}

test('sql53 inspect reuses official catalog SQL and pins', () => {
  assert.equal(SQL53_FUNCTION_DEF_INSPECT_SQL, FUNCTION_DEF_INSPECT_SQL);
  assert.equal(SQL53_SETTLEMENT_COLUMN_INSPECT_SQL, SETTLEMENT_COLUMN_INSPECT_SQL);
  assert.equal(SQL53_LEDGER_TRIGGER_INSPECT_SQL, LEDGER_TRIGGER_INSPECT_SQL);
  assert.deepEqual(SQL53_PINNED_FUNCTION_LOOKUPS, PINNED_FUNCTION_LOOKUPS);
  assert.deepEqual(SQL53_REQUIRED_SETTLEMENT_COLUMNS, REQUIRED_SETTLEMENT_COLUMNS);
  assert.deepEqual(SQL53_REQUIRED_LEDGER_TRIGGERS, REQUIRED_LEDGER_TRIGGERS);
  assert.equal(SQL53_REQUIRED_SETTLEMENT_COLUMNS.length, 17);
  assert.equal(SQL53_REQUIRED_LEDGER_TRIGGERS.length, 3);
  assert.equal(hashSql53Definition(SECRET_BODY), hashFunctionDefinition(SECRET_BODY));
  assert.equal(
    hashSql53PackageMember('secrets.mjs', API),
    SQL53_READONLY_INSPECT_SECRETS_SHA256,
  );
  const pin = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/production-sql53-readonly-diagnostic.json'), 'utf8'));
  assert.equal(pin.http_route, null);
  assert.equal(pin.transport, 'direct_lambda_invoke_only');
  assert.equal(
    pin.owned_overlay_member_sha256['sql53-production-readonly-inspect.mjs'],
    hashSql53PackageMember('sql53-production-readonly-inspect.mjs', API),
  );
});

test('sql53 inspect refuses API Gateway and any extra invoke keys', () => {
  assert.equal(isHttpApiGatewayEvent({
    rawPath: '/sql53-production-readonly-inspect',
    requestContext: { http: { method: 'GET' }, apiId: 'kiqojucc02', stage: 'prep' },
    headers: { authorization: OWNER_TOKEN },
  }), true);
  assert.equal(isSql53ProductionReadonlyInspectEvent({
    diagnostic: SQL53_READONLY_INSPECT_DIAGNOSTIC,
    authorization: OWNER_TOKEN,
    rawPath: '/sql53-production-readonly-inspect',
    headers: { authorization: SQL53_READONLY_INSPECT_AUTHORIZATION },
    requestContext: { http: { method: 'GET' }, apiId: 'kiqojucc02', stage: 'prep' },
  }), false);
  assert.equal(isSql53ProductionReadonlyInspectEvent({
    ...authorizedEvent(),
    extra: 'nope',
  }), false);
  assert.equal(isSql53ProductionReadonlyInspectEvent(authorizedEvent()), true);
  assert.equal(secretHostBindsProvenRds(PROVEN_HOST), true);
  assert.equal(secretHostBindsProvenRds(STAGING_HOST), false);
  assert.equal(secretHostBindsProvenRds('example'), false);
  assert.equal(secretHostBindsProvenRds('checksops-production.example.com'), false);
});

test('sql53 inspect authorization fails closed without contacting the database', async () => {
  const deps = closedDeps();
  const expired = {
    ...authorizedEnv(),
    [SQL53_READONLY_INSPECT_EXPIRES_AT_ENV]: new Date(Date.now() - 60_000).toISOString(),
  };
  const tooLong = {
    ...authorizedEnv(),
    [SQL53_READONLY_INSPECT_EXPIRES_AT_ENV]: new Date(Date.now() + SQL53_READONLY_INSPECT_MAX_WINDOW_MS + 60_000).toISOString(),
  };
  const missingExpiry = { ...authorizedEnv() };
  delete missingExpiry[SQL53_READONLY_INSPECT_EXPIRES_AT_ENV];
  for (const [env, event] of [
    [{}, {}],
    [authorizedEnv(), {}],
    [{ ...authorizedEnv(), [SQL53_READONLY_INSPECT_AUTHORIZATION_ENV]: 'nope' }, authorizedEvent()],
    [{ ...authorizedEnv(), CHECKSOPS_ENV: 'staging' }, authorizedEvent()],
    [{ ...authorizedEnv(), CHECKSOPS_ENV: 'development' }, authorizedEvent()],
    [authorizedEnv(), { diagnostic: SQL53_READONLY_INSPECT_DIAGNOSTIC, authorization: 'nope' }],
    [{ ...authorizedEnv(), [SQL53_READONLY_INSPECT_AUTHORIZATION_ENV]: SQL53_READONLY_INSPECT_AUTHORIZATION }, { diagnostic: SQL53_READONLY_INSPECT_DIAGNOSTIC, authorization: SQL53_READONLY_INSPECT_AUTHORIZATION }],
    [{ ...authorizedEnv(), [SQL53_READONLY_INSPECT_AUTHORIZATION_ENV]: 'short-token' }, { diagnostic: SQL53_READONLY_INSPECT_DIAGNOSTIC, authorization: 'short-token' }],
    [authorizedEnv(), { ...authorizedEvent(), rawPath: '/sql53-production-readonly-inspect', requestContext: { apiId: 'kiqojucc02' } }],
    [authorizedEnv(), { ...authorizedEvent(), extra: true }],
    [expired, authorizedEvent()],
    [tooLong, authorizedEvent()],
    [missingExpiry, authorizedEvent()],
  ]) {
    assert.notEqual(sql53ReadonlyInspectAuthorizationState(env, event), 'authorized');
    const result = await handleSql53ProductionReadonlyInspect(event, { env, ...deps });
    assert.equal(result.statusCode, 403);
    assert.equal(result.body.inspect, null);
    assert.equal(result.body.rdsIdentifier, null);
    assert.match(result.body.reason, /authorization is missing or invalid/);
    assert.equal(JSON.stringify(result).includes(SECRET_PASSWORD), false);
  }
  assert.equal(sql53ReadonlyInspectExpiryState(missingExpiry), 'absent');
  assert.equal(sql53ReadonlyInspectExpiryState(expired), 'expired');
  assert.equal(sql53ReadonlyInspectExpiryState(tooLong), 'invalid');
  assert.ok(OWNER_TOKEN.length >= SQL53_READONLY_INSPECT_AUTHORIZATION_MIN_LENGTH);
  assert.deepEqual(deps.calls, []);
});

test('sql53 inspect accepts the live production-prep environment and fails closed otherwise', () => {
  assert.equal(sql53ReadonlyInspectAuthorizationState({
    ...authorizedEnv(),
    CHECKSOPS_ENV: 'production-prep',
  }, authorizedEvent()), 'authorized');
  assert.equal(proveSql53ReadonlyInspectProvenance({
    ...authorizedEnv(),
    CHECKSOPS_ENV: 'production-prep',
  }, {
    hashMember: (name) => hashSql53PackageMember(name, API),
  }).ok, true);
});

test('sql53 inspect fails closed on package provenance mismatch', () => {
  assert.equal(proveSql53ReadonlyInspectProvenance({
    CHECKSOPS_ENV: 'production',
    AWS_LAMBDA_FUNCTION_NAME: 'checksops-staging-api',
  }).ok, false);
  assert.equal(proveSql53ReadonlyInspectProvenance(authorizedEnv(), {
    hashMember: (name) => (name === 'secrets.mjs' ? '0'.repeat(64) : hashSql53PackageMember(name, API)),
  }).ok, false);
  assert.equal(proveSql53ReadonlyInspectProvenance(authorizedEnv(), {
    hashMember: (name) => hashSql53PackageMember(name, API),
  }).ok, true);
});

test('sql53 inspect refuses a secret host that is not the proven production RDS', async () => {
  const calls = [];
  for (const host of ['example', STAGING_HOST, 'checksops.cluster-example.us-east-1.rds.amazonaws.com', PROVEN_HOST.replace('rds.amazonaws.com', 'example.com')]) {
    const result = await handleSql53ProductionReadonlyInspect(authorizedEvent(), {
      env: authorizedEnv(),
      loadCredentials: async () => provenCredentials({ host }),
      createClient: () => {
        calls.push(host);
        throw new Error('must not connect');
      },
      hashMember: (name) => hashSql53PackageMember(name, API),
    });
    assert.equal(result.statusCode, 403);
    assert.match(result.body.reason, /not the proven production RDS/);
    assert.equal(result.body.rdsIdentifier, null);
    assert.equal(JSON.stringify(result).includes(host), false);
    assert.equal(JSON.stringify(result).includes(SECRET_PASSWORD), false);
  }
  assert.deepEqual(calls, []);
});

test('sql53 inspect refuses database identity mismatch before catalog queries', async () => {
  const client = inspectClient({ database: 'postgres' });
  const result = await handleSql53ProductionReadonlyInspect(authorizedEvent(), {
    env: authorizedEnv(),
    loadCredentials: async () => provenCredentials(),
    createClient: () => client,
    hashMember: (name) => hashSql53PackageMember(name, API),
  });
  assert.equal(result.statusCode, 403);
  assert.match(result.body.reason, /database identity mismatch/);
  assert.equal(result.body.inspect, null);
  assert.equal(result.body.rdsIdentifier, null);
  assert.equal(client.queries.some((item) => item.sql === SQL53_FUNCTION_DEF_INSPECT_SQL), false);
  assert.equal(JSON.stringify(result).includes(SECRET_PASSWORD), false);
  assert.equal(JSON.stringify(result).includes(PROVEN_HOST), false);
});

test('sql53 inspect refuses a writable transaction and privileged user', async () => {
  const writable = inspectClient({ readOnly: 'off' });
  const writableResult = await handleSql53ProductionReadonlyInspect(authorizedEvent(), {
    env: authorizedEnv(),
    loadCredentials: async () => provenCredentials(),
    createClient: () => writable,
    hashMember: (name) => hashSql53PackageMember(name, API),
  });
  assert.match(writableResult.body.reason, /writable transaction/);
  assert.equal(writable.queries.some((item) => item.sql === SQL53_FUNCTION_DEF_INSPECT_SQL), false);

  const privilegedCalls = [];
  const privileged = await handleSql53ProductionReadonlyInspect(authorizedEvent(), {
    env: authorizedEnv(),
    loadCredentials: async () => provenCredentials({ username: 'checksops_admin' }),
    createClient: () => {
      privilegedCalls.push('client');
      return inspectClient();
    },
    hashMember: (name) => hashSql53PackageMember(name, API),
  });
  assert.match(privileged.body.reason, /privileged database user/);
  assert.deepEqual(privilegedCalls, []);
});

test('sql53 inspect refuses mutation SQL and incomplete catalog evidence', async () => {
  assert.throws(() => assertSql53InspectQueryAllowlisted('INSERT INTO claim_settlements VALUES (1)'), /not allowlisted/);
  assert.throws(() => assertSql53InspectQueryAllowlisted('CREATE OR REPLACE FUNCTION public.save_claim_settlement_breakdown()'), /not allowlisted/);
  assert.equal(assertSql53InspectQueryAllowlisted(SQL53_FUNCTION_DEF_INSPECT_SQL), SQL53_FUNCTION_DEF_INSPECT_SQL);

  const client = inspectClient({ throwOn: SQL53_FUNCTION_DEF_INSPECT_SQL });
  const result = await handleSql53ProductionReadonlyInspect(authorizedEvent(), {
    env: authorizedEnv(),
    loadCredentials: async () => provenCredentials(),
    createClient: () => client,
    hashMember: (name) => hashSql53PackageMember(name, API),
  });
  assert.equal(result.statusCode, 403);
  assert.match(result.body.reason, /failed closed before complete catalog evidence/);
  assert.equal(result.body.inspect, null);
  assert.equal(JSON.stringify(result).includes(SECRET_PASSWORD), false);
});

test('sql53 inspect reports catalog absence as exists false, not as a missing-object assumption', async () => {
  const client = inspectClient({
    functions: {
      save_claim_settlement_breakdown: [],
      sync_homeowner_ledger_from_check: [{ def: 'CREATE FUNCTION public.sync_homeowner_ledger_from_check() AS $$ SELECT 1 $$' }],
      aws_can_write_claim: [{ def: 'CREATE FUNCTION public.aws_can_write_claim(uuid) AS $$ SELECT true $$' }],
      hle_on_check_intake_insert: [{ def: 'CREATE FUNCTION public.hle_on_check_intake_insert() AS $$ SELECT 1 $$' }],
    },
    columns: REQUIRED_SETTLEMENT_COLUMNS.slice(1),
  });
  const result = await handleSql53ProductionReadonlyInspect(authorizedEvent(), {
    env: authorizedEnv(),
    loadCredentials: async () => provenCredentials(),
    createClient: () => client,
    hashMember: (name) => hashSql53PackageMember(name, API),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.inspect.functions[0].exists, false);
  assert.equal(result.body.inspect.functions[0].definitionSha256, null);
  assert.equal(result.body.inspect.settlementColumns[0].exists, false);
  assert.equal(result.body.inspect.settlementColumns[1].exists, true);
  assert.equal(result.body.rdsIdentifier, SQL53_READONLY_INSPECT_EXPECTED_RDS_IDENTIFIER);
});

test('authorized sql53 inspect returns existence and hashes only', async () => {
  const client = inspectClient();
  const result = await handleSql53ProductionReadonlyInspect(authorizedEvent(), {
    env: authorizedEnv(),
    loadCredentials: async () => provenCredentials(),
    createClient: () => client,
    hashMember: (name) => hashSql53PackageMember(name, API),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, 'complete');
  assert.equal(result.body.rdsIdentifier, SQL53_READONLY_INSPECT_EXPECTED_RDS_IDENTIFIER);
  assert.equal(result.body.inspect.functions.length, 4);
  assert.equal(result.body.inspect.functions[0].exists, true);
  assert.equal(result.body.inspect.functions[0].definitionSha256, HASH);
  assert.equal(result.body.inspect.settlementColumns.length, 17);
  assert.equal(result.body.inspect.settlementColumns.every((row) => row.exists === true), true);
  assert.equal(result.body.inspect.ledgerTriggers.length, 3);
  const json = JSON.stringify(result);
  assert.equal(json.includes(SECRET_BODY), false);
  assert.equal(json.includes(SECRET_PASSWORD), false);
  assert.equal(json.includes(PROVEN_HOST), false);
  assert.equal(client.queries[0].sql, 'BEGIN READ ONLY');
  assert.equal(client.queries.at(-1).sql, 'ROLLBACK');
});

test('sql53 inspect redactor drops secret-like fields and unknown objects', () => {
  const redacted = redactSql53InspectResponse({
    status: 'complete',
    reason: 'ok',
    rdsIdentifier: SQL53_READONLY_INSPECT_EXPECTED_RDS_IDENTIFIER,
    inspect: {
      functions: [{
        identity: 'public.save_claim_settlement_breakdown(uuid,uuid,jsonb)',
        exists: true,
        definitionSha256: HASH,
        definition: SECRET_BODY,
        password: SECRET_PASSWORD,
        host: PROVEN_HOST,
      }],
      settlementColumns: REQUIRED_SETTLEMENT_COLUMNS.map((column) => ({
        table: 'claim_settlements',
        column,
        exists: true,
        definition: SECRET_BODY,
      })),
      ledgerTriggers: REQUIRED_LEDGER_TRIGGERS.map((row) => ({ ...row, exists: true, definition: SECRET_BODY })),
    },
  });
  const json = JSON.stringify(redacted);
  assert.equal(json.includes(SECRET_BODY), false);
  assert.equal(json.includes(SECRET_PASSWORD), false);
  assert.equal(json.includes(PROVEN_HOST), false);
  assert.equal(redacted.inspect.functions[0].definitionSha256, HASH);
  assert.equal(redacted.rdsIdentifier, SQL53_READONLY_INSPECT_EXPECTED_RDS_IDENTIFIER);
});

test('index has no public SQL53 HTTP route and leaves staging validator inspect unchanged', async () => {
  const index = fs.readFileSync(path.join(API, 'index.mjs'), 'utf8');
  const validator = fs.readFileSync(path.join(API, 'db-readonly-validate.mjs'), 'utf8');
  assert.match(index, /isSql53ProductionReadonlyInspectEvent\(event\)/);
  assert.match(index, /sql53-production-readonly-inspect\.mjs/);
  assert.match(index, /access\.reason === 'staging_admin'/);
  assert.match(validator, /CHECKSOPS_ENV \|\| ''\)\.toLowerCase\(\) !== 'production'/);
  assert.match(index, /if \(isSql53ProductionReadonlyInspectEvent\(event\)\) \{\n    const result = await handleSql53ProductionReadonlyInspect\(event\);/);
  assert.doesNotMatch(index, /handleSql53ProductionReadonlyInspect\(event, \{\s*authorize/);
  assert.doesNotMatch(index, /SQL53_READONLY_INSPECT_PATH/);
  assert.doesNotMatch(index, /SQL53_READONLY_INSPECT_HEADER/);
  assert.doesNotMatch(index, /GET \/sql53-production-readonly-inspect/);
  assert.doesNotMatch(index, /READ_ONLY_PATHS[\s\S]*sql53/);

  const httpEvent = {
    httpMethod: 'GET',
    rawPath: '/sql53-production-readonly-inspect',
    headers: { 'x-checksops-sql53-inspect-authorization': OWNER_TOKEN },
    requestContext: { apiId: 'kiqojucc02', stage: 'prep', http: { method: 'GET', path: '/sql53-production-readonly-inspect' } },
  };
  assert.equal(isHttpApiGatewayEvent(httpEvent), true);
  assert.equal(isSql53ProductionReadonlyInspectEvent(httpEvent), false);
  const httpDenied = await handleSql53ProductionReadonlyInspect(httpEvent, {
    env: authorizedEnv(),
    loadCredentials: async () => {
      throw new Error('must not load credentials');
    },
    createClient: () => {
      throw new Error('must not connect');
    },
  });
  assert.equal(httpDenied.statusCode, 403);
  assert.match(httpDenied.body.reason, /authorization is missing or invalid/);
  assert.equal(httpDenied.body.inspect, null);

  const invokeDenied = await handleSql53ProductionReadonlyInspect(authorizedEvent(), {
    env: {},
    loadCredentials: async () => {
      throw new Error('must not load credentials');
    },
    createClient: () => {
      throw new Error('must not connect');
    },
  });
  assert.equal(invokeDenied.statusCode, 403);
  assert.match(invokeDenied.body.reason, /authorization is missing or invalid/);
  assert.equal(invokeDenied.body.inspect, null);
});
