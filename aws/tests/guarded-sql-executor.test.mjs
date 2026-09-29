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
  authorizationFingerprint,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
const EXECUTOR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../write-path/guarded-sql-executor');
const GUARD_LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/deployment-guard/lib');
fs.mkdirSync(path.join(EXECUTOR_DIR, 'lib'), { recursive: true });
for (const name of ['errors.mjs', 'identity.mjs', 'sql-apply.mjs', 'sql-executor-auth.mjs']) {
  fs.copyFileSync(path.join(GUARD_LIB, name), path.join(EXECUTOR_DIR, 'lib', name));
}
const { createHandler } = await import('../write-path/guarded-sql-executor/index.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SQL_FILE = path.join(ROOT, AUTHORIZED_SQL44.filename);
const NOW = '2026-09-29T18:00:00.000Z';
const EXPECTED_LIVE = 'af784b78408b77ed928d1c815309e8da3459e9ebd3f4f6068321b9f33dd2a078';
const BEFORE_DEF = `CREATE FUNCTION public.claim_ledger_link_or_create() BEFORE ${EXPECTED_LIVE}`;
const AFTER_DEF = `CREATE FUNCTION public.claim_ledger_link_or_create()
  same_tenant_detected_count
  same_tenant_unlinked_count
  same_tenant_already_linked_count
  ocr_claim_number_key
  AFTER`;
const SQL43_DEF = 'CREATE FUNCTION public.review_save_detected_claim_number() UNCHANGED';

function authEvent(overrides = {}) {
  const oneUse = overrides.one_use_id || `sql44-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const expectedLive = overrides.expected_live_definition_sha256 || hashSqlDefinition(BEFORE_DEF);
  const base = {
    action: 'apply',
    workstream_id: 'claim-ledger',
    branch: 'cursor/ledger-guarded-main-a2a4',
    commit: AUTHORIZED_SQL44.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [AUTHORIZED_SQL44.filename],
    filename: AUTHORIZED_SQL44.filename,
    migration_id: AUTHORIZED_SQL44.migration_id,
    source_sha256: AUTHORIZED_SQL44.source_sha256,
    intended_replacement_sha256: AUTHORIZED_SQL44.intended_replacement_sha256,
    expected_live_definition_sha256: expectedLive,
    one_use_id: oneUse,
    expiry: '2026-09-29T19:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    preflight_live_fingerprint: authorizationFingerprint({
      ...AUTHORIZED_SQL44,
      expected_live_definition_sha256: expectedLive,
      one_use_id: oneUse,
    }),
  };
  return { ...base, ...overrides, one_use_id: oneUse, preflight_live_fingerprint: overrides.preflight_live_fingerprint || base.preflight_live_fingerprint };
}

function mockConnect({
  beforeDef = BEFORE_DEF,
  afterDef = AFTER_DEF,
  sql43Def = SQL43_DEF,
  mutateDataOnApply = false,
} = {}) {
  const checks = [
    { id: '66174175-ccd3-4d15-a0e2-49aeeb074fc5', tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a', claim_id: null, amount: '6145.73', deposited_at: null, check_stage: 'review', detected_claim_number: '695064-GQ' },
    { id: '00062a57-13b5-493d-a996-cf6e72d5cc89', tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a', claim_id: null, amount: '7040.80', deposited_at: null, check_stage: 'endorsing', detected_claim_number: '695064-GQ' },
    { id: '3ebc2f0f-1cf7-47b5-9b0b-ac9ce6bdace9', tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a', claim_id: null, amount: '7677.39', deposited_at: null, check_stage: 'endorsing', detected_claim_number: '695064-GQ' },
    { id: '6238a632-84f1-4eea-a352-2cf639ebe4b4', tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a', claim_id: null, amount: '1531.66', deposited_at: null, check_stage: 'review', detected_claim_number: '695064-GQ' },
  ];
  let applied = false;
  let invoked = false;
  const client = {
    invoked() { return invoked; },
    applied() { return applied; },
    async query(sql, params = []) {
      const text = String(sql);
      if (text.includes('CREATE OR REPLACE FUNCTION public.claim_ledger_link_or_create')) {
        applied = true;
        return { rows: [] };
      }
      if (text.includes('current_database')) return { rows: [{ d: 'checksops' }] };
      if (text.includes('pg_get_functiondef')) {
        if (String(params?.[0] || '').includes('claim_ledger')) {
          return { rows: [{ def: applied ? afterDef : beforeDef }] };
        }
        return { rows: [{ def: sql43Def }] };
      }
      if (text.includes('routine_privileges')) {
        return { rows: [{ grantee: 'checksops', privilege_type: 'EXECUTE' }] };
      }
      if (text.includes('role_table_grants') || text.includes('column_privileges')) {
        return { rows: [] };
      }
      if (text.includes('FROM public.claims')) return { rows: [] };
      if (text.includes('FROM public.check_intake_items')) {
        const rows = mutateDataOnApply && applied
          ? checks.map((row, idx) => (idx === 0 ? { ...row, claim_id: 'mutated' } : row))
          : checks;
        return { rows };
      }
      if (text.includes('FROM public.claim_payments') || text.includes('FROM public.claim_checks')) {
        return { rows: [] };
      }
      if (text.includes('FROM public.claim_disbursements')) return { rows: [] };
      if (text.includes('claim_ledger_link_or_create($1')) {
        invoked = true;
        return { rows: [{ result: { ok: true, code: 'no_match', same_tenant_detected_count: 4 } }] };
      }
      throw new Error(`unexpected query: ${text.slice(0, 120)}`);
    },
    async end() {},
  };
  return async () => client;
}

function handlerFor(connect, extra = {}) {
  const consumed = path.join(os.tmpdir(), `sql-exec-consumed-${process.pid}-${Date.now()}.json`);
  process.env.SQL_EXECUTOR_CONSUMED_PATH = consumed;
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({
    connect,
    now: () => Date.parse(NOW),
    sqlFile: SQL_FILE,
    expectedSql43Hash: hashSqlDefinition(SQL43_DEF),
    ...extra,
  });
}

test('apply refuses SQL_COLLISION when live hash does not match expected', async () => {
  const handler = handlerFor(mockConnect({
    beforeDef: 'CREATE FUNCTION unexpected live definition',
  }));
  const result = await handler(authEvent());
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SQL_COLLISION);
});

test('apply does not invoke the function and returns a machine-readable receipt', async () => {
  const connect = mockConnect();
  const handler = handlerFor(connect);
  const event = authEvent();
  event.preflight_live_fingerprint.one_use_id = event.one_use_id;
  const result = await handler(event);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.receipt.result, 'applied');
  assert.equal(result.details.receipt.before_hash, hashSqlDefinition(BEFORE_DEF));
  assert.equal(result.details.receipt.after_hash, hashSqlDefinition(AFTER_DEF));
  assert.equal(result.details.receipt.sql43_hash, hashSqlDefinition(SQL43_DEF));
  assert.equal(result.details.receipt.workstream, 'claim-ledger');
  assert.equal(result.details.receipt.commit, AUTHORIZED_SQL44.commit);
  assert.equal(result.details.receipt.executor_identity, 'checksops-staging-guarded-sql-executor');
  assert.equal(result.details.receipt.data_before.claims_rows, 0);
  assert.equal(result.details.receipt.data_before.same_tenant_unlinked_count, 4);
  const client = await connect();
  assert.equal(client.invoked(), false);
  assert.equal(client.applied(), true);
});

test('replay of the same one_use_id is refused', async () => {
  const handler = handlerFor(mockConnect());
  const event = authEvent({ one_use_id: 'sql44-replay-test-1' });
  event.preflight_live_fingerprint.one_use_id = event.one_use_id;
  const first = await handler(event);
  assert.equal(first.ok, true, first.message);
  const second = await handler(event);
  assert.equal(second.ok, false);
  assert.equal(second.code, CODES.SQL_COLLISION);
});

test('inspect is refused until the applied definition hash is verified', async () => {
  const handler = handlerFor(mockConnect());
  const event = authEvent({
    action: 'inspect',
    applied_after_hash: 'not-the-live-hash',
    inspect: {
      check_id: '66174175-ccd3-4d15-a0e2-49aeeb074fc5',
      tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
      claim_number: '695064-GQ',
    },
  });
  event.preflight_live_fingerprint.one_use_id = event.one_use_id;
  const result = await handler(event);
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.SQL_COLLISION);
});

test('inspect after verified apply does not mutate data', async () => {
  const connect = mockConnect({ beforeDef: AFTER_DEF });
  const handler = handlerFor(connect);
  const event = authEvent({
    action: 'inspect',
    applied_after_hash: hashSqlDefinition(AFTER_DEF),
    inspect: {
      check_id: '66174175-ccd3-4d15-a0e2-49aeeb074fc5',
      tenant_id: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a',
      claim_number: '695064-GQ',
    },
  });
  event.preflight_live_fingerprint.one_use_id = event.one_use_id;
  const result = await handler(event);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.details.receipt.result, 'inspect');
  assert.equal(result.details.receipt.inspect.same_tenant_detected_count, 4);
  const client = await connect();
  assert.equal(client.invoked(), true);
});

test('create_new remains forbidden on the executor', async () => {
  const handler = handlerFor(mockConnect());
  const result = await handler(authEvent({ action: 'create_new' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.UNRELATED_MUTATION);
});
