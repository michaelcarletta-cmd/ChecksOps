/**
 * SQL 164 (aws/workflows/sql/164_wallet_withdrawal_leg_and_limits.sql) in the staging guarded executor, on the release
 * engine shared with SQL 90-163 (scripts/deployment-guard/lib/release-sql-state.mjs). Owner 2026-11-13: "Build the
 * transfer to bank" (design docs/WALLET_TO_BANK_TRANSFER_DESIGN.md, #1849). release-sql90-97-executor.test.mjs runs what
 * every release key shares (SQL 164 included); this file covers what is new:
 *
 *   - the pin: pending (execute false, no pre-state), code-derived, selectable, packed, in step with the pending
 *     production pin; the pinned commit authored the bytes; predecessor and supersedes SQL 109 (as SQL 150 for SQL 147:
 *     SQL 109's only object is the function SQL 164 replaces, so no superseded_intended_sha256);
 *   - the file and spec: SQL 109's aws_moov_webhook_apply_transfer_status with the same attributes, result and ACL and
 *     SQL 109's body with exactly one change, wallet_withdrawal added to the owned legs; the two nullable bigint limit
 *     columns on tenant_wallet_funding_settings with their NULL-or-positive CHECKs and column INSERT / UPDATE for
 *     checksops; nothing else; the expected pre-state (SQL 109's function, the columns and checks absent) derived from
 *     SQL 109's bytes;
 *   - on PostgreSQL 16 (SQL 109's payment schema and a funding-settings table on the release fixture): refused before
 *     SQL 109 (predecessors_applied); with SQL 91 and SQL 109 applied as the owner the inspect reads the derived
 *     pre-state; a pending pin cannot apply; one apply through the executor reaches the intended fingerprint, then a
 *     second apply is refused (already in place); SQL 109 still reads applied through SQL 164 (supersedes).
 * The behavior (the withdrawal leg's status written back; the limits' CHECKs and grants) is
 * aws/tests/sql164-wallet-withdrawal-leg-and-limits-pg.test.mjs.
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
  AUTHORIZED_SQL164_WALLET_WITHDRAWAL_LEG_AND_LIMITS,
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
const NOW = '2026-11-13T12:00:00.000Z';
const KEY = 'sql164';
const FN = 'aws_moov_webhook_apply_transfer_status';
const WRITER = `public.${FN}(text, text, text, text, text, text, text, text, text, text, timestamp with time zone)`;
const TABLE = 'public.tenant_wallet_funding_settings';
const COLUMNS = Object.freeze(['wallet_withdraw_max_per_transfer_cents', 'wallet_withdraw_max_per_day_cents']);
const CHECKS = Object.freeze({
  tenant_wallet_funding_settings_withdraw_per_transfer_check:
    'CHECK (((wallet_withdraw_max_per_transfer_cents IS NULL) OR (wallet_withdraw_max_per_transfer_cents > 0)))',
  tenant_wallet_funding_settings_withdraw_per_day_check:
    'CHECK (((wallet_withdraw_max_per_day_cents IS NULL) OR (wallet_withdraw_max_per_day_cents > 0)))',
});
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const SQL109 = fs.readFileSync(path.join(ROOT, PINS.sql109.filename), 'utf8');
const SQL91_TEXT = fs.readFileSync(path.join(ROOT, PINS.sql91.filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/** The pre-state both databases are expected to have (SQL 109 applied): its function; the columns and checks absent. */
const SQL109_FN = releaseIntendedState('sql109', SQL109).functions[WRITER];
const PRE = releaseStateHash(KEY, { functions: { [WRITER]: SQL109_FN } });
const LEGS_109 = "NOT IN ('wallet_funding', 'send_wallet', 'send_bank')";
const LEGS_164 = "NOT IN ('wallet_funding', 'send_wallet', 'send_bank', 'wallet_withdrawal')";

/** The funding-settings table on top of SQL 109's payment schema (run as the superuser, then handed to the owner). */
const FUNDING_SETTINGS_SCHEMA = `
CREATE TABLE public.tenant_wallet_funding_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL UNIQUE,
  maximum_single_pull_cents bigint, updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.tenant_wallet_funding_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.tenant_wallet_funding_settings TO checksops, authenticated;`;

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
    expiry: '2026-11-13T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql164-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 164 staging-authorized from its read-live, code-derived, selectable, packed, in step with the pending production pin; predecessor and supersedes SQL 109; the derived pre-state', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL164_WALLET_WITHDRAWAL_LEG_AND_LIMITS, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/164_wallet_withdrawal_leg_and_limits.sql');
  assert.equal(pin.migration_id, '164_wallet_withdrawal_leg_and_limits');
  assert.equal(spec.choice, 'sql164-wallet-withdrawal-leg-and-limits');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Pending until a reviewed pin change records a staging read-live.
  assertStagingPinState(assert, KEY, pin);
  // Staging apply authorized (owner approved 2026-11-13) from staging read-live run 43439497274: already_applied false,
  // precondition_failures []. It read the derived pre-state.
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-13: staging apply (wave 55) from staging read-live run 43439497274');
  assert.equal(pin.expected_live_definition_sha256, PRE);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-164-apply.md'), 'utf8'), /\*\*Status:\*\* applied to staging \(wave 55, 2026-11-13\); production pin execute-authorized/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-164-apply.md'), 'utf8'), /read-live \(2026-11-13\)\.\*\* Run 43439497274/);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  // The expected pre-state: SQL 109's function, derived from SQL 109's bytes; the columns and checks absent.
  assert.equal(PRE, '51e721c14833afe91c1236bd618735b2adb75e7acc2f01b03c109c98ab9c19d7');
  assert.notEqual(PRE, pin.intended_replacement_sha256);
  assert.notEqual(PRE, releaseStateHash(KEY, {}));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql164-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [WRITER]);
  assert.deepEqual(spec.predecessors, ['sql109']);
  assert.deepEqual(spec.supersedes, ['sql109']);
  assert.equal(spec.refuse_after, undefined);
  // Nothing else supersedes or follows SQL 164; SQL 109 is superseded by SQL 164 only.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes('sql109')), [KEY]);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  const prod = productionPin();
  assert.equal(prod.execute, true);
  assert.match(prod.authorization, /^Owner approved 2026-11-13 /);
  assert.equal(prod.expected_live_definition_sha256, PRE);
  assert.equal(prod.production_inspect.status, 'recorded');
  assert.equal(prod.staging_acceptance.ok, true);
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, ['sql109']);
  assert.ok(prod.order_note.includes(PRE));
  assert.ok(prod.production_inspect.note.includes(PRE));
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-164-apply.md'), 'utf8');
  for (const value of [PRE, pin.intended_replacement_sha256, pin.source_sha256]) assert.ok(runbook.includes(value), value);
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

test('reviewed file and spec: SQL 109\'s writer with only wallet_withdrawal added; the two limit columns, their CHECKs and column grants to checksops; nothing else', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), [FN]);
  const fn = defs[FN];
  const base = releaseFunctionDefinitions(SQL109)[FN];
  // Same attributes; SQL 109's body with exactly the one leg-list change.
  for (const attr of ['security_definer', 'language', 'result', 'config', 'volatility']) {
    assert.deepEqual(fn[attr], base[attr], attr);
  }
  assert.equal(base.prosrc.split(LEGS_109).length, 2);
  assert.equal(fn.prosrc, base.prosrc.replace(LEGS_109, LEGS_164));
  const code = TEXT.replace(/--[^\n]*/g, '');
  const outside = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$').replace(/'(?:[^']|'')*'/g, "''");
  const statements = outside.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.deepEqual(statements.map((s) => s.split(' ').slice(0, 3).join(' ')), [
    'DO $body$',
    'CREATE OR REPLACE',
    'REVOKE ALL ON',
    'GRANT EXECUTE ON',
    'COMMENT ON FUNCTION',
    'ALTER TABLE public.tenant_wallet_funding_settings',
    'DO $body$',
    'GRANT INSERT (wallet_withdraw_max_per_transfer_cents,',
    'GRANT UPDATE (wallet_withdraw_max_per_transfer_cents,',
  ]);
  assert.match(statements[2], /FROM PUBLIC$/);
  assert.match(statements[3], /TO checksops$/);
  assert.equal(statements[5], `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS wallet_withdraw_max_per_transfer_cents bigint, ADD COLUMN IF NOT EXISTS wallet_withdraw_max_per_day_cents bigint`);
  assert.equal(statements[7], `GRANT INSERT (wallet_withdraw_max_per_transfer_cents, wallet_withdraw_max_per_day_cents) ON TABLE ${TABLE} TO checksops`);
  assert.equal(statements[8], `GRANT UPDATE (wallet_withdraw_max_per_transfer_cents, wallet_withdraw_max_per_day_cents) ON TABLE ${TABLE} TO checksops`);
  for (const forbidden of [/\bCREATE\s+(TABLE|POLICY|TRIGGER|INDEX|VIEW)\b/i, /\bDROP\b/i, /\bTRUNCATE\b/i, /ROW LEVEL SECURITY/i, /\bTO\s+authenticated\b/i, /\banon\b/, /\bservice_role\b/]) {
    assert.doesNotMatch(outside, forbidden, String(forbidden));
  }
  assert.match(TEXT, /Not applied\s+-- by this change/);
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, [{ identity: WRITER, acl: ['checksops EXECUTE', 'owner EXECUTE'] }]);
  assert.deepEqual(spec.definer_writes, ['public.payment_transfers', 'public.payment_event_log']);
  assert.deepEqual(spec.added_columns.map((c) => [c.table, c.column, c.type, c.notnull, c.default, c.acl]),
    COLUMNS.map((column) => [TABLE, column, 'bigint', false, null, ['checksops INSERT', 'checksops UPDATE']]));
  assert.deepEqual(Object.fromEntries(spec.constraints.map((c) => [c.name, c.def])), CHECKS);
  assert.ok(spec.constraints.every((c) => c.table === TABLE));
  assert.deepEqual(spec.altered_relations, [TABLE]);
  assert.equal(spec.policies, undefined);
  assert.equal(spec.table_privileges, undefined);
  // The intended and pre-state renderings, as the runbook prints them.
  const intended = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.match(intended, /^release sql164 v1\nfunction public\.aws_moov_webhook_apply_transfer_status\(.*\): lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public prosrc=[0-9a-f]{64} acl=checksops EXECUTE;owner EXECUTE\n/);
  assert.match(intended, /column public\.tenant_wallet_funding_settings\.wallet_withdraw_max_per_transfer_cents: bigint notnull=false default=- acl=checksops INSERT;checksops UPDATE/);
  const pre = releaseStateText(KEY, { functions: { [WRITER]: SQL109_FN } });
  assert.match(pre, /wallet_withdraw_max_per_day_cents: absent/);
  assert.equal(sha(intended), PINS[KEY].intended_replacement_sha256);
  assert.equal(sha(pre), PRE);
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-164-apply.md'), 'utf8');
  assert.ok(runbook.includes(intended), 'the runbook prints the intended fingerprint text');
  assert.ok(runbook.includes(pre), 'the runbook prints the pre-state text');
  // Pre-conditions: the predecessor and the definer writes.
  const state = {
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [],
    definer: { 'public.payment_transfers': true, 'public.payment_event_log': true },
  };
  const failures = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...state, ...over }, TEXT);
  assert.ok(!failures().includes('definer_can_write_relations'));
  assert.ok(failures({ definer: { ...state.definer, 'public.payment_event_log': false } }).includes('definer_can_write_relations'));
  assert.ok(failures({ predecessors_applied: false }).includes('predecessors_applied'));
});

test('PostgreSQL 16: SQL 164 through the executor: refused before SQL 109, the pre-state as derived, a pending pin cannot apply, one apply on the intended fingerprint, then already in place; SQL 109 still applied through SQL 164', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql164-exec-', 59364, { extra: [PAYMENT_SCHEMA, FUNDING_SETTINGS_SCHEMA] });
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
    const runAsOwner = async (sql) => {
      const owner = await connectAs('checksops_admin');
      try {
        await owner.query(sql);
      } finally {
        await owner.end();
      }
    };

    // Before SQL 109: refused.
    await runAsOwner(SQL91_TEXT);
    const early = await inspect();
    assert.deepEqual(early.release_sql_inspect.predecessors, { sql109: false });
    assert.ok(early.precondition_failures.includes('predecessors_applied'));
    assert.equal((await apply(early.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);

    await runAsOwner(SQL109);
    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.deepEqual(r.release_sql_inspect.predecessors, { sql109: true });
    assert.equal(r.already_applied, false);
    // SQL 109's function, the columns and checks absent: the derived pre-state.
    assert.equal(r.live_definition_sha256, PRE);

    // The committed pin is pending: it cannot apply.
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingPin(PINS[KEY]) } })(releaseEvent({ pin: pendingPin(PINS[KEY]), expected_live_definition_sha256: PRE }));
    assert.equal(pending.ok, false);

    const applied = await apply(PRE);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, PRE);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.deepEqual(after.precondition_failures, []);
    assert.equal((await apply(PRE)).code, CODES.UNRELATED_MUTATION);

    // SQL 109 still reads applied through SQL 164 (supersedes): a release key with SQL 109 as predecessor is not
    // needed for that, the engine's own predecessor read is.
    assert.deepEqual(after.release_sql_inspect.predecessors, { sql109: true });
  } finally {
    await fx.close();
  }
});
