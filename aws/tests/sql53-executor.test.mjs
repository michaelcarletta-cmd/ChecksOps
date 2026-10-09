import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { hashSqlDefinition } from '../../scripts/deployment-guard/lib/sql-apply.mjs';
import {
  AUTHORIZED_SQL44,
  AUTHORIZED_SQL53,
  authorizationFingerprint,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  evaluateSql53PostApplyInspect,
  evaluateSql53StagingApply,
} from '../../scripts/deployment-guard/lib/sql53-staging-apply.mjs';

const EXECUTOR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../write-path/guarded-sql-executor');
const GUARD_LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/deployment-guard/lib');
fs.mkdirSync(path.join(EXECUTOR_DIR, 'lib'), { recursive: true });
for (const name of ['errors.mjs', 'identity.mjs', 'sql-apply.mjs', 'sql-executor-auth.mjs', 'function-def-lookup.mjs']) {
  fs.copyFileSync(path.join(GUARD_LIB, name), path.join(EXECUTOR_DIR, 'lib', name));
}
const { createHandler } = await import('../write-path/guarded-sql-executor/index.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SQL53_FILE = path.join(ROOT, AUTHORIZED_SQL53.filename);
const EXECUTION_PIN = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'ops/deployment-guard/sql53-staging-execution.json'),
  'utf8',
));
const NOW = '2026-10-09T15:00:00.000Z';
const AFTER_DEF = 'CREATE FUNCTION public.save_claim_settlement_breakdown(uuid, uuid, jsonb) AFTER';
const PRESERVED = {
  'sync_homeowner_ledger_from_check': 'CREATE FUNCTION public.sync_homeowner_ledger_from_check() KEEP',
  'aws_can_write_claim': 'CREATE FUNCTION public.aws_can_write_claim(uuid) KEEP',
  'hle_on_check_intake_insert': 'CREATE FUNCTION public.hle_on_check_intake_insert() KEEP',
};

function sql53Event(overrides = {}) {
  const oneUse = overrides.one_use_id || `sql53-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const expectedLive = overrides.expected_live_definition_sha256 || AUTHORIZED_SQL53.absent_live_definition_sha256;
  const base = {
    action: 'apply',
    workstream_id: 'staging-sql53-3bc9',
    branch: 'cursor/staging-sql53-execute-3bc9',
    commit: AUTHORIZED_SQL53.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [AUTHORIZED_SQL53.filename],
    filename: AUTHORIZED_SQL53.filename,
    migration_id: AUTHORIZED_SQL53.migration_id,
    source_sha256: AUTHORIZED_SQL53.source_sha256,
    intended_replacement_sha256: AUTHORIZED_SQL53.intended_replacement_sha256,
    expected_live_definition_sha256: expectedLive,
    one_use_id: oneUse,
    expiry: '2026-10-09T16:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    preflight_live_fingerprint: authorizationFingerprint({
      ...AUTHORIZED_SQL53,
      expected_live_definition_sha256: expectedLive,
      one_use_id: oneUse,
    }),
  };
  return { ...base, ...overrides, one_use_id: oneUse };
}

function mockSql53Connect({
  settlementDef = null,
  afterDef = AFTER_DEF,
  preserved = PRESERVED,
  dropPreservedAfterApply = false,
} = {}) {
  let applied = false;
  let invoked = false;
  let appliedSql44 = false;
  const lookups = [];
  const client = {
    applied() { return applied; },
    invoked() { return invoked; },
    appliedSql44() { return appliedSql44; },
    lookups() { return lookups; },
    async query(sql, params = []) {
      const text = String(sql);
      if (text.includes('CREATE OR REPLACE FUNCTION public.claim_ledger_link_or_create')) {
        appliedSql44 = true;
        return { rows: [] };
      }
      if (text.includes('CREATE OR REPLACE FUNCTION public.save_claim_settlement_breakdown')) {
        applied = true;
        return { rows: [] };
      }
      if (text.includes('save_claim_settlement_breakdown($1')) {
        invoked = true;
        return { rows: [{ result: { ok: true } }] };
      }
      if (text.includes('current_database')) return { rows: [{ d: 'checksops' }] };
      if (text.includes('FROM pg_proc') || text.includes('pg_get_functiondef')) {
        if (text.includes('::regprocedure')) {
          throw new Error('function definition lookup must not cast through regprocedure');
        }
        const name = String(params?.[1] || '');
        lookups.push({ schema: params?.[0], name, args: params?.[2] });
        if (name.includes('save_claim_settlement_breakdown')) {
          const def = applied ? afterDef : settlementDef;
          return { rows: def ? [{ def }] : [] };
        }
        if (name.includes('sync_homeowner_ledger_from_check')) {
          const def = dropPreservedAfterApply && applied ? null : preserved.sync_homeowner_ledger_from_check;
          return { rows: def ? [{ def }] : [] };
        }
        if (name.includes('aws_can_write_claim')) {
          return { rows: preserved.aws_can_write_claim ? [{ def: preserved.aws_can_write_claim }] : [] };
        }
        if (name.includes('hle_on_check_intake_insert')) {
          return { rows: preserved.hle_on_check_intake_insert ? [{ def: preserved.hle_on_check_intake_insert }] : [] };
        }
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text.slice(0, 120)}`);
    },
    async end() {},
  };
  return async () => client;
}

function handlerFor(connect, extra = {}) {
  const consumed = path.join(os.tmpdir(), `sql53-exec-${process.pid}-${Date.now()}.json`);
  process.env.SQL_EXECUTOR_CONSUMED_PATH = consumed;
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({
    connect,
    now: () => Date.parse(NOW),
    sqlFile53: SQL53_FILE,
    expectedSql53AfterHash: hashSqlDefinition(AFTER_DEF),
    ...extra,
  });
}

test('execution pin is source-only and matches the official SQL 53 hashes', () => {
  assert.equal(EXECUTION_PIN.apply_authorized, false);
  assert.equal(EXECUTION_PIN.execute, false);
  assert.equal(EXECUTION_PIN.ensure_authorized, false);
  assert.equal(EXECUTION_PIN.invoke_authorized, false);
  assert.equal(EXECUTION_PIN.phase2_authorized, false);
  assert.equal(EXECUTION_PIN.deployment_type, 'sql-executor-invoke');
  assert.equal(EXECUTION_PIN.function_name, 'checksops-staging-guarded-sql-executor');
  assert.equal(EXECUTION_PIN.commit, AUTHORIZED_SQL53.commit);
  assert.equal(EXECUTION_PIN.source_sha256, AUTHORIZED_SQL53.source_sha256);
  assert.equal(EXECUTION_PIN.intended_replacement_sha256, AUTHORIZED_SQL53.intended_replacement_sha256);
  assert.equal(EXECUTION_PIN.latest_absent_inspect.workflow_run, 37947042060);
  assert.equal(EXECUTION_PIN.latest_absent_inspect.exists, false);
  assert.equal(
    EXECUTION_PIN.post_apply_verification.workflow,
    '.github/workflows/staging-db-readonly-diagnostic.yml',
  );
});

test('sql-apply evaluate path still refuses apply flags after the executor pin', () => {
  const result = evaluateSql53StagingApply({
    workstream_id: 'staging-sql53-3bc9',
    branch: 'cursor/staging-sql53-execute-3bc9',
    commit: AUTHORIZED_SQL53.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-apply',
    owned_components: [AUTHORIZED_SQL53.filename],
    filename: AUTHORIZED_SQL53.filename,
    migration_id: AUTHORIZED_SQL53.migration_id,
    source_sha256: AUTHORIZED_SQL53.source_sha256,
    expected_live_definition_sha256: AUTHORIZED_SQL53.absent_live_definition_sha256,
    live_definition_sha256: AUTHORIZED_SQL53.absent_live_definition_sha256,
    exists: false,
    apply: true,
    action: 'authorize',
    build_timestamp: NOW,
    preflight_live_fingerprint: { sql: AUTHORIZED_SQL53.absent_live_definition_sha256 },
  }, { root: ROOT });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.GUARD_APPLY_FORBIDDEN);
});

test('inspect of an absent settlement function is read-only and does not apply SQL 44', async () => {
  const connect = mockSql53Connect();
  const handler = handlerFor(connect);
  const result = await handler(sql53Event({ action: 'inspect' }));
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.receipt.exists, false);
  assert.equal(result.details.receipt.live_definition_sha256, AUTHORIZED_SQL53.absent_live_definition_sha256);
  assert.equal(result.details.receipt.preserved_functions.length, 3);
  const client = await connect();
  assert.equal(client.applied(), false);
  assert.equal(client.appliedSql44(), false);
  assert.equal(client.invoked(), false);
});

test('apply creates only the settlement function when immediately-before evidence is absent', async () => {
  const connect = mockSql53Connect();
  const handler = handlerFor(connect);
  const result = await handler(sql53Event());
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.receipt.result, 'applied');
  assert.equal(result.details.receipt.before_hash, AUTHORIZED_SQL53.absent_live_definition_sha256);
  assert.equal(result.details.receipt.after_hash, hashSqlDefinition(AFTER_DEF));
  assert.equal(result.details.receipt.function_identity, AUTHORIZED_SQL53.function_identity);
  const client = await connect();
  assert.equal(client.applied(), true);
  assert.equal(client.appliedSql44(), false);
  assert.equal(client.invoked(), false);
});

test('apply refuses when the settlement function already exists', async () => {
  const connect = mockSql53Connect({
    settlementDef: 'CREATE FUNCTION public.save_claim_settlement_breakdown() UNEXPECTED',
  });
  const handler = handlerFor(connect);
  const unexpected = await handler(sql53Event({
    expected_live_definition_sha256: hashSqlDefinition('CREATE FUNCTION public.save_claim_settlement_breakdown() UNEXPECTED'),
  }));
  assert.equal(unexpected.ok, false);
  assert.equal(unexpected.code, CODES.SQL_COLLISION);
  assert.equal((await connect()).applied(), false);

  const existingConnect = mockSql53Connect({
    settlementDef: AFTER_DEF,
  });
  const existing = await handlerFor(existingConnect)(sql53Event({
    expected_live_definition_sha256: hashSqlDefinition(AFTER_DEF),
  }));
  assert.equal(existing.ok, false);
  assert.ok([CODES.SQL_COLLISION, CODES.UNRELATED_MUTATION].includes(existing.code));
  assert.equal((await existingConnect()).applied(), false);
});

test('apply refuses when the expected live fingerprint changed', async () => {
  const connect = mockSql53Connect();
  const handler = handlerFor(connect);
  const result = await handler(sql53Event({
    expected_live_definition_sha256: 'a'.repeat(64),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
  assert.equal((await connect()).applied(), false);
});

test('apply refuses when a preserved function is missing', async () => {
  const connect = mockSql53Connect({
    preserved: {
      ...PRESERVED,
      aws_can_write_claim: null,
    },
  });
  const handler = handlerFor(connect);
  const result = await handler(sql53Event());
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SQL_COLLISION);
  assert.match(result.message, /preserved function is missing/);
  assert.equal((await connect()).applied(), false);
});

test('replay of the same SQL 53 one_use_id is refused', async () => {
  const connect = mockSql53Connect();
  const handler = handlerFor(connect);
  const event = sql53Event({ one_use_id: 'sql53-replay-1' });
  const first = await handler(event);
  assert.equal(first.ok, true, first.message);
  const second = await handler(event);
  assert.equal(second.ok, false);
  assert.equal(second.code, CODES.SQL_COLLISION);
});

test('an unmatched migration does not fall through to the SQL 44 apply path', async () => {
  const connect = mockSql53Connect();
  const handler = handlerFor(connect);
  const result = await handler({
    ...sql53Event(),
    filename: 'aws/write-path/sql/other.sql',
    migration_id: 'other_sql',
    owned_components: ['aws/write-path/sql/other.sql'],
    source_sha256: AUTHORIZED_SQL44.source_sha256,
    intended_replacement_sha256: AUTHORIZED_SQL44.intended_replacement_sha256,
    commit: AUTHORIZED_SQL44.commit,
  });
  assert.equal(result.ok, false);
  assert.equal((await connect()).appliedSql44(), false);
  assert.equal((await connect()).applied(), false);
});

test('post-apply inspect helper still requires the intended hash and preserved functions', () => {
  const okInspect = evaluateSql53PostApplyInspect({
    functions: [
      {
        identity: AUTHORIZED_SQL53.function_identity,
        exists: true,
        definitionSha256: AUTHORIZED_SQL53.intended_replacement_sha256,
      },
      { identity: 'public.sync_homeowner_ledger_from_check()', exists: true, definitionSha256: '9'.repeat(64) },
      { identity: 'public.aws_can_write_claim(uuid)', exists: true, definitionSha256: 'a'.repeat(64) },
      { identity: 'public.hle_on_check_intake_insert()', exists: true, definitionSha256: 'b'.repeat(64) },
    ],
  });
  assert.equal(okInspect.ok, true, okInspect.message);
});
