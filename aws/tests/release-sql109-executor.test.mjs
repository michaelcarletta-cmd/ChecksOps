/**
 * SQL 109 (aws/workflows/sql/109_moov_transfer_webhook_status.sql) in the staging guarded
 * executor, on the release engine shared with SQL 90-105 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 109 included); this
 * file covers what is new:
 *
 *   - the pin: staging-authorized from its read-live (wave 10), code-derived, selectable, packed,
 *     in step with the production pin (execute-authorized on the staging apply); the pinned
 *     commit authored the bytes; after SQL 91;
 *   - the file and spec: one guarded prerequisite block and one SECURITY DEFINER function, EXECUTE
 *     checksops only, writing payment_transfers and payment_event_log (definer_writes); no table,
 *     policy or grant DDL; the definer-write pre-condition refuses a login that cannot write them;
 *   - on PostgreSQL 16: refused before SQL 91; a pending pin cannot apply; one apply through the
 *     executor reaches the intended fingerprint, then is refused as already in place.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  AUTHORIZED_SQL109_MOOV_TRANSFER_WEBHOOK_STATUS,
  AUTHORIZED_STAGING_SQL,
  RELEASE_2026_10_17_PENDING_SQL_PINS as PINS,
  authorizationFingerprint,
  resolveAuthorizedMigration,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  RELEASE_SQL_KEYS,
  RELEASE_SQL_SPECS,
  releaseFunctionDefinitions,
  releaseIntendedHash,
  releaseIntendedState,
  releaseSharedPreconditionFailures,
  releaseSqlExecutableText,
  releaseStateHash,
  releaseStateText,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { PAYMENT_SCHEMA } from './helpers/sql109-payment-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-21T12:00:00.000Z';
const KEY = 'sql109';
const WRITER = 'public.aws_moov_webhook_apply_transfer_status(text, text, text, text, text, text, text, text, text, text, timestamp with time zone)';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const SQL91_TEXT = fs.readFileSync(path.join(ROOT, PINS.sql91.filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

const { module: executorModule } = await importGuardedSqlExecutor();
const { createHandler } = executorModule;

function releaseEvent(overrides = {}) {
  const pin = overrides.pin || PINS[KEY];
  const rest = { ...overrides };
  delete rest.pin;
  const event = {
    action: 'apply',
    workstream_id: `staging-${RELEASE_SQL_SPECS[KEY].choice}`,
    branch: 'main',
    commit: pin.commit,
    operator: 'test-agent',
    target_environment: 'staging',
    target_component: 'staging-sql',
    deployment_type: 'sql-executor-invoke',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    expected_live_definition_sha256: pin.expected_live_definition_sha256 || READ_LIVE_EXPECTED_SENTINEL,
    one_use_id: `${KEY}-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    expiry: '2026-10-21T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql109-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 109 staging-authorized from its read-live, code-derived, selectable, packed, in step with the production pin; after SQL 91', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL109_MOOV_TRANSFER_WEBHOOK_STATUS, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/109_moov_transfer_webhook_status.sql');
  assert.equal(pin.migration_id, '109_moov_transfer_webhook_status');
  assert.equal(spec.choice, 'sql109-moov-transfer-webhook-status');
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-10-21) from staging read-live run 39663914111:
  // the function was absent, so SQL 109 was not yet applied.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-10-21: staging apply (wave 10) from staging read-live run 39663914111');
  assert.equal(pin.expected_live_definition_sha256, 'e0f02501f167f4bee2bbb8bc32c1e19b23deb5425a650c63102030531aa9a077');
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  // The recorded pre-state is the engine's fingerprint of exactly the absent function.
  assert.equal(releaseStateText(KEY, {}), `release sql109 v1\nfunction ${WRITER}: absent`);
  assert.equal(releaseStateHash(KEY, {}), pin.expected_live_definition_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql109-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [WRITER]);
  assert.deepEqual(spec.predecessors, ['sql91']);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  // SQL 91 stays as applied.
  assert.equal(PINS.sql91.source_sha256, '199bfa1a528d219a8683b61ae6264d84dd5b08caa74564691374c8c6c42b71e3');
  assert.equal(releaseIntendedHash('sql91', SQL91_TEXT), PINS.sql91.intended_replacement_sha256);
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, ['sql91']);
  // Production pin execute-authorized (owner-approved pin change of 2026-10-21) on the staging apply
  // from the same pre-state: production's recorded pre-state is this pin's.
  assert.equal(prod.execute, true);
  assert.match(prod.authorization, /^Owner approved 2026-10-21 /);
  assert.equal(prod.expected_live_definition_sha256, pin.expected_live_definition_sha256);
  assert.notEqual(prod.expected_live_definition_sha256, prod.intended_replacement_sha256);
  let bytes = null;
  if (/^[0-9a-f]{40}$/.test(pin.commit)) {
    try {
      bytes = execFileSync('git', ['-C', ROOT, 'show', `${pin.commit}:${pin.filename}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      bytes = null;
    }
  }
  if (bytes !== null) assert.equal(sha(bytes), pin.source_sha256, 'the pinned commit carries the pinned bytes');
});

test('reviewed file and spec: one guarded block and one SECURITY DEFINER writer, EXECUTE checksops only; no table, policy or grant DDL; the definer must be able to write both tables', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), ['aws_moov_webhook_apply_transfer_status']);
  const fn = defs.aws_moov_webhook_apply_transfer_status;
  assert.equal(fn.security_definer, true);
  assert.equal(fn.language, 'plpgsql');
  assert.equal(fn.result, 'jsonb');
  assert.deepEqual(fn.config, ['search_path=public']);
  // The guard comes first; only the two tables are written; three leg roles are owned.
  assert.match(fn.prosrc, /^\s*DECLARE[\s\S]*?BEGIN\s+IF NOT COALESCE\(public\.aws_moov_webhook_apply_active\(\), false\) THEN/);
  assert.deepEqual([...fn.prosrc.matchAll(/\b(UPDATE|INSERT INTO|DELETE FROM)\s+(public\.[a-z_]+)/g)].map((m) => `${m[1]} ${m[2]}`), [
    'UPDATE public.payment_transfers',
    'INSERT INTO public.payment_event_log',
  ]);
  assert.match(fn.prosrc, /NOT IN \('wallet_funding', 'send_wallet', 'send_bank'\)/);
  assert.match(fn.prosrc, /FOR UPDATE;/);
  const code = TEXT.replace(/--[^\n]*/g, '');
  const outside = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').replace(/'(?:[^']|'')*'/g, "''");
  const statements = outside.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.equal(statements.length, 5);
  assert.equal(statements[0], 'DO $body$');
  assert.match(statements[1], /^CREATE OR REPLACE FUNCTION public\.aws_moov_webhook_apply_transfer_status\(/);
  assert.match(statements[2], /^REVOKE ALL ON FUNCTION public\.aws_moov_webhook_apply_transfer_status\(.*\) FROM PUBLIC$/);
  assert.match(statements[3], /^GRANT EXECUTE ON FUNCTION public\.aws_moov_webhook_apply_transfer_status\(.*\) TO checksops$/);
  assert.match(statements[4], /^COMMENT ON FUNCTION public\.aws_moov_webhook_apply_transfer_status\(/);
  for (const forbidden of [/\bCREATE\s+(TABLE|POLICY|TRIGGER|INDEX|VIEW)\b/i, /\bDROP\b/i, /\bALTER\b/i, /\bTRUNCATE\b/i, /ROW LEVEL SECURITY/i, /\bTO\s+authenticated\b/i, /\banon\b/]) {
    assert.doesNotMatch(outside, forbidden, String(forbidden));
  }
  assert.match(TEXT, /Not applied by this change\./);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, [{ identity: WRITER, acl: ['checksops EXECUTE', 'owner EXECUTE'] }]);
  assert.deepEqual(spec.definer_writes, ['public.payment_transfers', 'public.payment_event_log']);
  assert.equal(spec.table_privileges, undefined);
  assert.equal(spec.policies, undefined);
  assert.equal(spec.altered_relations, undefined);
  const intended = releaseIntendedState(KEY, TEXT);
  assert.match(releaseStateText(KEY, intended), /^release sql109 v1\nfunction public\.aws_moov_webhook_apply_transfer_status\(.*\): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=[0-9a-f]{64} acl=checksops EXECUTE;owner EXECUTE$/);
  // The definer-write pre-condition: a login that cannot write a table refuses.
  const base = {
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [],
    definer: { 'public.payment_transfers': true, 'public.payment_event_log': true },
  };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  assert.ok(!pre().includes('definer_can_write_relations'));
  assert.ok(pre({ definer: { ...base.definer, 'public.payment_event_log': false } }).includes('definer_can_write_relations'));
  assert.ok(pre({ predecessors_applied: false }).includes('predecessors_applied'));
});

test('PostgreSQL 16: SQL 109 through the executor: refused before SQL 91, a pending pin cannot apply, one apply on the intended fingerprint, then already in place', { timeout: 600000 }, async (t) => {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const fx = await releaseFixture(pg, 'pg-sql109-exec-', 59310, { extra: [PAYMENT_SCHEMA] });
  const { connectAs } = fx;
  try {
    const seen = [];
    const connect = async () => {
      const client = await connectAs('checksops_admin');
      const query = client.query.bind(client);
      client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
      return client;
    };
    const inspect = async () => {
      seen.length = 0;
      const result = await handlerFor(connect)(inspectEvent());
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(seen[0], 'BEGIN READ ONLY');
      assert.ok(seen.every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
      return result.details.receipt;
    };
    const apply = async (live) => {
      const pin = Object.freeze({ ...PINS[KEY], expected_live_definition_sha256: live, execute: true, authorization: 'Owner approved test fixture' });
      return handlerFor(connect, { pins: { [KEY]: pin } })(releaseEvent({ pin }));
    };

    const early = await inspect();
    assert.deepEqual(early.release_sql_inspect.predecessors, { sql91: false });
    assert.ok(early.precondition_failures.includes('predecessors_applied'));
    assert.equal((await apply(early.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    const owner = await connectAs('checksops_admin');
    try {
      await owner.query(SQL91_TEXT);
    } finally {
      await owner.end();
    }

    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.deepEqual(r.release_sql_inspect.predecessors, { sql91: true });
    assert.equal(r.already_applied, false);
    // The local absent function has the recorded staging pre-state's fingerprint.
    assert.equal(r.live_definition_sha256, PINS[KEY].expected_live_definition_sha256);
    // A pending pin cannot apply (the committed pin is staging-authorized, so pend a copy).
    const pendingCopy = pendingPin(PINS[KEY]);
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
    assert.equal(pending.ok, false);

    const applied = await apply(r.live_definition_sha256);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.deepEqual(after.precondition_failures, []);
    assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
    assert.deepEqual(after.release_sql_inspect.predecessors, { sql91: true });
  } finally {
    await fx.close();
  }
});
