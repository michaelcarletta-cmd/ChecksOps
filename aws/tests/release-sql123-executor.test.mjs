/**
 * SQL 123 (aws/workflows/sql/123_checkalt_deposit_check_status.sql) in the staging guarded executor,
 * on the release engine shared with SQL 90-122 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 123 included); this
 * file covers what is new:
 *
 *   - the pin: staging-authorized from its read-live (wave 22), code-derived, selectable, packed, in step with the production pin; the
 *     pinned commit authored the bytes; no predecessor;
 *   - the file and spec: two owner-only definer functions and one trigger on checkalt_deposits whose
 *     name sorts before SQL 120's and SQL 121's; the check_stage label guard; no table, column,
 *     policy or grant; the two inspect counts; the ownership and definer-write pre-conditions refuse;
 *   - on PostgreSQL 16: refused while checkalt_deposits is missing; the file refuses (and rolls back)
 *     while check_stage has no 'returned' label; a pending pin cannot apply; one apply through the
 *     executor reaches the intended fingerprint, then is refused as already in place.
 * The behavior (Deposited on approval, Returned on a later rejection, with SQL 98, 120 and 121) is
 * aws/tests/sql123-checkalt-check-status-pg.test.mjs.
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
  AUTHORIZED_SQL123_CHECKALT_DEPOSIT_CHECK_STATUS,
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
import { CHECK_A, TENANT_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-10-28T12:00:00.000Z';
const KEY = 'sql123';
const MARK_FN = 'public.aws_checkalt_mark_check_deposited(uuid, timestamp with time zone)';
const TRIGGER_FN = 'public.aws_apply_checkalt_check_status()';
const FNS = [MARK_FN, TRIGGER_FN];
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
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
    expiry: '2026-10-28T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql123-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

// The check columns SQL 123 writes, the check_stage type (first without 'returned', for the file's
// own label guard), the audit log and the usage events it reads. checkalt_deposits is added only after
// the first inspect (the prerequisite refusal).
const CHECK_SCHEMA = `
CREATE TYPE public.check_stage AS ENUM ('review', 'loss_draft', 'endorsing', 'ready_for_deposit', 'deposited', 'funds_released');
ALTER TABLE public.check_intake_items
  ADD COLUMN check_stage public.check_stage DEFAULT 'ready_for_deposit', ADD COLUMN pre_return_stage public.check_stage,
  ADD COLUMN returned_at timestamptz, ADD COLUMN return_code text, ADD COLUMN return_reason text, ADD COLUMN return_notes text,
  ADD COLUMN return_recorded_by uuid, ADD COLUMN return_source text, ADD COLUMN return_resolved_at timestamptz,
  ADD COLUMN return_resolution text, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE public.check_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_id uuid, tenant_id uuid, actor_id uuid, event_type text NOT NULL,
  event_description text, event_data jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.check_billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, check_intake_item_id uuid,
  event_type text NOT NULL DEFAULT 'check_processing', unit_price_cents integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'recorded');
ALTER TABLE public.check_audit_log ENABLE ROW LEVEL SECURITY;
INSERT INTO public.check_billing_events (tenant_id, check_intake_item_id) VALUES ('${TENANT_A}', '${CHECK_A}');`;
const CHECKALT_SCHEMA = `
CREATE TABLE public.checkalt_deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_intake_item_id uuid, tenant_id uuid,
  status text NOT NULL DEFAULT 'pending', return_reason text, submitted_at timestamptz, returned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.checkalt_deposits ENABLE ROW LEVEL SECURITY;
INSERT INTO public.checkalt_deposits (check_intake_item_id, tenant_id, status, submitted_at)
  VALUES ('${CHECK_A}', '${TENANT_A}', 'cleared', '2026-10-20T15:00:00Z');`;

test('pin: SQL 123 staging-authorized from its read-live, code-derived, selectable, packed, in step with the production pin; no predecessor', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL123_CHECKALT_DEPOSIT_CHECK_STATUS, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/123_checkalt_deposit_check_status.sql');
  assert.equal(pin.migration_id, '123_checkalt_deposit_check_status');
  assert.equal(spec.choice, 'sql123-checkalt-deposit-check-status');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-10-28) from staging read-live run 40717225525: the
  // two functions and the trigger absent, so SQL 123 was not yet applied there.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-10-28: staging apply (wave 22) from staging read-live run 40717225525');
  assert.equal(pin.expected_live_definition_sha256, 'b584e1cd4352837eb5515cd07e76900e055637d11c29214db036f912e6b6f6b9');
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  // Everything absent (a database without SQL 123) has a fingerprint of its own.
  assert.notEqual(releaseStateHash(KEY, {}), pin.intended_replacement_sha256);
  assert.equal(pin.superseded_intended_sha256, undefined);
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql123-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], FNS);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.runs_before, undefined);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.refuse_after, undefined);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)
    || (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)
    || (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), []);
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.predecessors, []);
  assert.deepEqual(prod.function_identities, FNS);
  // Production pin execute-authorized (owner-approved pin change of 2026-10-28) on the staging apply. Its
  // pre-state is production's own (read-only inspect SSM e8a92ced), the same as staging's.
  assert.equal(prod.execute, true);
  assert.match(prod.authorization, /^Owner approved 2026-10-28 /);
  assert.equal(prod.expected_live_definition_sha256, 'b584e1cd4352837eb5515cd07e76900e055637d11c29214db036f912e6b6f6b9');
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

test('reviewed file and spec: two owner-only definer functions and one trigger that fires first; the label guard; no table, column, policy or grant; the counts; pre-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), ['aws_checkalt_mark_check_deposited', 'aws_apply_checkalt_check_status']);
  for (const [name, fn] of Object.entries(defs)) {
    assert.equal(fn.security_definer, true, name);
    assert.equal(fn.language, 'plpgsql', name);
    assert.deepEqual(fn.config, ['row_security=off', 'search_path=public, pg_temp'], name);
  }
  assert.equal(defs.aws_checkalt_mark_check_deposited.result, 'boolean');
  assert.equal(defs.aws_apply_checkalt_check_status.result, 'trigger');
  const mark = defs.aws_checkalt_mark_check_deposited.prosrc;
  const apply = defs.aws_apply_checkalt_check_status.prosrc;
  // The helper writes only check_intake_items, only forward (never from deposited, funds released,
  // disbursed externally or a bank or hand return).
  assert.deepEqual([...new Set([...mark.matchAll(/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+(public\.[a-z_]+)/g)].map((m) => m[1]))],
    ['public.check_intake_items']);
  assert.match(mark, /c\.check_stage IS NULL\s+OR c\.check_stage::text IN \('review', 'loss_draft', 'endorsing', 'ready_for_deposit'\)/);
  assert.match(mark, /c\.return_source = 'checkalt'\s+AND c\.return_resolved_at IS NULL/);
  assert.match(mark, /deposited_at = COALESCE\(c\.deposited_at, p_deposited_at, now\(\)\)/);
  // The trigger: approval moves the check through the helper; a failure after approval returns it,
  // unless another deposit of the check is approved; it writes the check and one audit row only.
  assert.deepEqual([...new Set([...apply.matchAll(/\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+(public\.[a-z_]+)/g)].map((m) => m[1]))],
    ['public.check_intake_items', 'public.check_audit_log']);
  assert.match(apply, /v_new IN \('submitted', 'cleared'\) AND v_old NOT IN \('submitted', 'cleared'\)/);
  assert.match(apply, /PERFORM public\.aws_checkalt_mark_check_deposited\(NEW\.check_intake_item_id, COALESCE\(NEW\.submitted_at, now\(\)\)\);/);
  assert.match(apply, /v_new IN \('rejected', 'error', 'duplicate', 'returned'\) AND v_old IN \('submitted', 'cleared'\)/);
  assert.match(apply, /d\.id <> NEW\.id\s+AND lower\(COALESCE\(d\.status, ''\)\) IN \('submitted', 'cleared'\)\)/);
  assert.match(apply, /v_check\.check_stage = 'returned'::public\.check_stage THEN\s+RETURN NULL;/);
  // The same columns the AWS record_check_return RPC writes (workflow-rpc.mjs executeRecordCheckReturn).
  const rpc = fs.readFileSync(path.join(ROOT, 'aws/functions/api/workflow-rpc.mjs'), 'utf8');
  const rpcSet = /const executeRecordCheckReturn[\s\S]*?UPDATE public\.check_intake_items\s+SET ([\s\S]*?)\s+WHERE id/.exec(rpc)[1];
  const fileSet = /UPDATE public\.check_intake_items c\s+SET (check_stage = 'returned'[\s\S]*?)\s+WHERE c\.id = v_check\.id/.exec(apply)[1];
  const columns = (set) => [...set.matchAll(/(?:^|,)\s*([a-z_]+)\s*=/g)].map((m) => m[1]).sort();
  assert.deepEqual(columns(fileSet), columns(rpcSet));
  // The label guard runs before anything is created.
  assert.ok(TEXT.indexOf('sql123_check_stage_label_missing') < TEXT.indexOf('CREATE OR REPLACE FUNCTION'));
  assert.match(TEXT, /FOREACH v_label IN ARRAY ARRAY\['deposited', 'returned'\] LOOP/);
  // Only the two functions and the trigger: no table, column, policy, grant or other drop.
  const code = TEXT.replace(/--[^\n]*/g, '');
  for (const forbidden of [/\bCREATE\s+(TABLE|POLICY|VIEW|INDEX|TYPE)\b/i, /\bALTER\s+(TABLE|TYPE)\b/i, /\bGRANT\b/i, /\bTRUNCATE\b/i,
    /ROW LEVEL SECURITY/i, /\bDELETE\s+FROM\b/i, /\bDROP\s+(?!TRIGGER IF EXISTS aws_checkalt_deposit_apply_check_status ON public\.checkalt_deposits;)/i]) {
    assert.doesNotMatch(code, forbidden, String(forbidden));
  }
  assert.equal([...TEXT.matchAll(/REVOKE ALL ON FUNCTION public\.aws_checkalt_mark_check_deposited\(uuid, timestamptz\) FROM/g)].length, 2);
  assert.equal([...TEXT.matchAll(/REVOKE ALL ON FUNCTION public\.aws_apply_checkalt_check_status\(\) FROM/g)].length, 2);
  // The one-time move takes only checks that already carry their usage event.
  assert.match(code, /AND EXISTS \(\s+SELECT 1 FROM public\.check_billing_events e\s+WHERE e\.check_intake_item_id = d\.check_intake_item_id\s+AND e\.event_type = 'check_processing'\s+AND e\.status <> 'voided'\)/);

  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, FNS.map((identity) => ({ identity, acl: ['owner EXECUTE'] })));
  assert.deepEqual(spec.triggers, [{
    table: 'public.checkalt_deposits',
    name: 'aws_checkalt_deposit_apply_check_status',
    def: 'CREATE TRIGGER aws_checkalt_deposit_apply_check_status AFTER INSERT OR UPDATE OF status ON public.checkalt_deposits FOR EACH ROW EXECUTE FUNCTION public.aws_apply_checkalt_check_status()',
  }]);
  // Fires first: its name sorts before every other trigger the release engine pins on checkalt_deposits.
  const others = RELEASE_SQL_KEYS.filter((key) => key !== KEY)
    .flatMap((key) => (RELEASE_SQL_SPECS[key].triggers || []).filter((t) => t.table === 'public.checkalt_deposits').map((t) => t.name));
  assert.deepEqual(others, ['aws_checkalt_deposit_billing_event', 'aws_checkalt_deposit_cash_job_payment']);
  assert.ok(others.every((name) => spec.triggers[0].name < name));
  assert.deepEqual(spec.definer_writes, ['public.check_intake_items', 'public.check_audit_log']);
  assert.deepEqual(spec.altered_relations, ['public.checkalt_deposits']);
  assert.deepEqual(Object.keys(spec.counts), ['checkalt_approved_checks_to_move', 'checkalt_approved_checks_left_unbilled']);
  for (const count of Object.values(spec.counts)) assert.match(count.sql, /^SELECT count\(DISTINCT c\.id\)::int AS n FROM/);
  for (const absent of ['tables', 'added_columns', 'policies', 'column_acl', 'indexes', 'unique_covers', 'dropped_functions', 'whole_tables', 'acl_functions', 'table_privileges', 'render']) {
    assert.equal(spec[absent], undefined, absent);
  }

  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.match(text, /^release sql123 v1\n/);
  assert.match(text, /\ntrigger public\.checkalt_deposits aws_checkalt_deposit_apply_check_status: enabled=O def=[0-9a-f]{64}$/);

  // Pre-conditions: the definer writes and the ownership of checkalt_deposits.
  const base = {
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [],
    altered: { 'public.checkalt_deposits': { exists: true, owner_is_login: true } },
    definer: { 'public.check_intake_items': true, 'public.check_audit_log': true },
  };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ definer: { 'public.check_intake_items': true, 'public.check_audit_log': false } }), ['definer_can_write_relations']);
  assert.deepEqual(pre({ altered: { 'public.checkalt_deposits': { exists: true, owner_is_login: false } } }), ['altered_relations_owned_by_login']);
});

test('PostgreSQL 16: SQL 123 through the executor: refused without checkalt_deposits and without the returned label, a pending pin cannot apply, one apply on the intended fingerprint, then already in place', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql123-exec-', 59520, { extra: [CHECK_SCHEMA] });
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
    const created = async () => (await fx.admin.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_proc
      WHERE proname IN ('aws_checkalt_mark_check_deposited', 'aws_apply_checkalt_check_status')`)).rows[0].n;
    const stage = async () => (await fx.admin.query(`SELECT status, check_stage::text AS stage FROM public.check_intake_items WHERE id = '${CHECK_A}'`)).rows[0];

    const early = await inspect();
    assert.deepEqual(early.release_sql_inspect.prerequisites_missing, [
      'public.checkalt_deposits', 'column public.checkalt_deposits.id', 'column public.checkalt_deposits.check_intake_item_id',
      'column public.checkalt_deposits.status', 'column public.checkalt_deposits.submitted_at', 'column public.checkalt_deposits.returned_at',
      'column public.checkalt_deposits.return_reason',
    ]);
    assert.ok(early.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(early.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query(CHECKALT_SCHEMA);
    await fx.admin.query('ALTER TABLE public.checkalt_deposits OWNER TO checksops_admin');

    // check_stage has no 'returned' label: the file refuses and nothing is created or moved.
    const unlabeled = await inspect();
    assert.deepEqual(unlabeled.precondition_failures, [], JSON.stringify(unlabeled.release_sql_inspect));
    assert.deepEqual(unlabeled.release_sql_inspect.counts, { checkalt_approved_checks_to_move: 1, checkalt_approved_checks_left_unbilled: 0 });
    const refused = await apply(unlabeled.live_definition_sha256);
    assert.equal(refused.ok, false);
    assert.match(JSON.stringify(refused), /sql123_check_stage_label_missing/);
    assert.equal(await created(), 0);
    assert.equal((await stage()).stage, 'ready_for_deposit');
    await fx.admin.query("ALTER TYPE public.check_stage ADD VALUE 'returned'");

    const r = await inspect();
    assert.deepEqual(r.precondition_failures, [], JSON.stringify(r.release_sql_inspect));
    assert.equal(r.already_applied, false);
    // Before SQL 123 none of its objects exist: the pre-state is the all-absent fingerprint.
    assert.equal(r.live_definition_sha256, releaseStateHash(KEY, {}));
    assert.deepEqual(r.release_sql_inspect.definer_writes, [{ name: 'check_intake_items', ok: true }, { name: 'check_audit_log', ok: true }]);
    // A pending pin cannot apply (the committed pin is staging-authorized, so pend a copy).
    const pendingCopy = pendingPin(PINS[KEY]);
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy, expected_live_definition_sha256: r.live_definition_sha256 }));
    assert.equal(pending.ok, false);
    assert.equal(await created(), 0);

    const applied = await apply(r.live_definition_sha256);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, r.live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    // The one-time move: the approved, billed check is Deposited.
    assert.deepEqual(await stage(), { status: 'deposited', stage: 'deposited' });
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    assert.deepEqual(after.release_sql_inspect.counts, { checkalt_approved_checks_to_move: 0, checkalt_approved_checks_left_unbilled: 0 });
    assert.equal((await apply(r.live_definition_sha256)).code, CODES.UNRELATED_MUTATION);
  } finally {
    await fx.close();
  }
});
