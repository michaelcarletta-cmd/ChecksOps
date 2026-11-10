/**
 * SQL 147 (aws/workflows/sql/147_external_disbursement_record.sql) in the staging guarded executor, on the release
 * engine shared with SQL 90-146 (scripts/deployment-guard/lib/release-sql-state.mjs).
 * release-sql90-97-executor.test.mjs runs what every release key shares (SQL 147 included); this file covers what is
 * new:
 *
 *   - the pin: staging-authorized (wave 42) from staging read-live run 42833250784, code-derived, selectable, packed,
 *     in step with the production pin (applied 2026-11-10 and retired, from production's own pre-state, the same one staging had); the
 *     pinned commit authored the bytes; no predecessor; only SQL 150 supersedes or names it (its function replaced in
 *     place);
 *   - the file and spec: one new DEFINER function, aws_record_external_disbursement(uuid, uuid, jsonb, text): plpgsql,
 *     VOLATILE, SECURITY DEFINER, search_path public, pg_temp, RETURNS jsonb; the member gate, the input checks, the
 *     check lock (FOR UPDATE), the idempotency key, the amount available and its two INSERTs (the batch and the
 *     splits, nothing else); the prerequisite DO block, the REVOKEs and GRANT EXECUTE TO checksops, nothing else; the
 *     spec's prerequisites and the six definer relations; the pre- and post-conditions;
 *   - on PostgreSQL 16 (the disbursement, check, transfer and stakeholder schema on the release fixture): the inspect
 *     reads the pre-state both databases should have (the function absent) as derived here; refused while a column it
 *     reads or writes is missing or a relation is under FORCE ROW LEVEL SECURITY; a pending pin cannot apply; an
 *     unexpected pre-state is refused (DEPLOYMENT_COLLISION); one apply through the executor reaches the intended
 *     fingerprint (EXECUTE for checksops and the owner), then a second apply is refused (UNRELATED_MUTATION: already
 *     in place).
 * The behavior (who may record what, the amount available, idempotency, the stage move) is
 * aws/tests/sql147-external-disbursement-pg.test.mjs.
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
  AUTHORIZED_SQL147_EXTERNAL_DISBURSEMENT_RECORD,
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
  releaseSharedPostconditionFailures,
  releaseSharedPreconditionFailures,
  releaseSqlExecutableText,
  releaseStateHash,
  releaseStateText,
  releaseUnrelatedScope,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { EXECUTOR_PACK_MEMBERS } from '../../scripts/deployment-guard/sql-executor-ensure.mjs';
import { MIGRATIONS } from '../../scripts/deployment-guard/github-staging-sql-executor.mjs';
import { READ_LIVE_EXPECTED_SENTINEL } from '../../scripts/deployment-guard/lib/sql-executor-read-live.mjs';
import { importGuardedSqlExecutor } from './helpers/import-guarded-sql-executor.mjs';
import { assertStagingPinState, pendingPin } from './helpers/staging-sql-wave1.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-10T12:00:00.000Z';
const KEY = 'sql147';
const FN = 'aws_record_external_disbursement';
const ARGS = 'uuid, uuid, jsonb, text';
const IDENTITY = `public.${FN}(${ARGS})`;
const IDENTITIES = Object.freeze([IDENTITY]);
const RELATIONS = Object.freeze(['public.disbursement_batches', 'public.disbursement_splits', 'public.check_intake_items',
  'public.payment_transfers', 'public.stakeholder_accounts', 'public.check_stakeholders']);
const TABLES = Object.freeze(RELATIONS.map((table) => table.replace(/^public\./, '')));
const ACL = Object.freeze(['checksops EXECUTE', 'owner EXECUTE']);
const REVOKES = Object.freeze(['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'service_role EXECUTE']);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const TEXT = fs.readFileSync(path.join(ROOT, PINS[KEY].filename), 'utf8');
const FILES = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, PINS[key].filename)])));
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const productionPin = () => JSON.parse(fs.readFileSync(path.join(ROOT, RELEASE_SQL_SPECS[KEY].production_pin_rel), 'utf8'));

/** The pre-state both databases should have: the function absent (everything else present). */
const ABSENT_PRE = releaseStateHash(KEY, { functions: { [IDENTITY]: { exists: false } } });

/**
 * The schema SQL 147 reads and writes, on top of the release fixture (run as the superuser before everything is
 * handed to checksops_admin): the columns the fixture's check_intake_items and stakeholder_accounts lack, and
 * disbursement_batches, disbursement_splits and payment_transfers with the columns SQL 147 names (as
 * sql147-external-disbursement-pg.test.mjs builds them), RLS on.
 */
const DISBURSEMENT_SCHEMA = `
ALTER TABLE public.check_intake_items ADD COLUMN amount numeric, ADD COLUMN pa_fee_pct numeric, ADD COLUMN pa_fee_amount numeric;
ALTER TABLE public.stakeholder_accounts ADD COLUMN nickname text;
CREATE TABLE public.disbursement_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, check_intake_item_id uuid,
  created_by uuid NOT NULL, check_amount numeric NOT NULL, available_amount numeric NOT NULL,
  reserve_held numeric NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'pending', notes text, completed_at timestamptz,
  approved_at timestamptz, approved_by uuid, approved_amount_cents bigint, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.disbursement_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid NOT NULL REFERENCES public.disbursement_batches(id),
  tenant_id uuid NOT NULL, stakeholder_account_id uuid, amount numeric NOT NULL, status text NOT NULL DEFAULT 'pending',
  method text NOT NULL DEFAULT 'actum', external_check_number text, recipient_name text, recipient_type text,
  external_notes text, idempotence_key text, settled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.payment_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, check_id uuid, leg_role text,
  status text NOT NULL, amount_cents bigint NOT NULL);
ALTER TABLE public.disbursement_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disbursement_splits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_transfers ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.disbursement_batches, public.disbursement_splits, public.payment_transfers TO checksops, authenticated;`;

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
    expiry: '2026-11-10T13:00:00.000Z',
    function_name: 'checksops-staging-guarded-sql-executor',
    build_timestamp: NOW,
    ...rest,
  };
  event.preflight_live_fingerprint = authorizationFingerprint(event);
  return event;
}
const inspectEvent = () => releaseEvent({ action: 'inspect', expected_live_definition_sha256: READ_LIVE_EXPECTED_SENTINEL });

function handlerFor(connect, { pins = {} } = {}) {
  process.env.SQL_EXECUTOR_CONSUMED_PATH = path.join(os.tmpdir(), `sql147-exec-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  process.env.EXECUTOR_IDENTITY = 'checksops-staging-guarded-sql-executor';
  return createHandler({ connect, now: () => Date.parse(NOW), releaseSqlFiles: FILES, releaseSqlPins: { ...PINS, ...pins } });
}

test('pin: SQL 147 staging-authorized from its read-live, code-derived, selectable, packed, in step with the production pin; no predecessor; nothing names it', () => {
  const pin = PINS[KEY];
  const spec = RELEASE_SQL_SPECS[KEY];
  const packed = Object.fromEntries(EXECUTOR_PACK_MEMBERS);
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/guarded-staging-sql-executor.yml'), 'utf8');
  assert.equal(AUTHORIZED_SQL147_EXTERNAL_DISBURSEMENT_RECORD, pin);
  assert.equal(pin.filename, 'aws/workflows/sql/147_external_disbursement_record.sql');
  assert.equal(pin.migration_id, '147_external_disbursement_record');
  assert.equal(spec.choice, 'sql147-external-disbursement-record');
  assert.doesNotMatch(spec.choice, /production/);
  assert.equal(sha(TEXT), pin.source_sha256);
  // Staging apply authorized (owner approved 2026-11-10, "record the SQL 147 staging pin") from staging read-live
  // run 42833250784: already_applied false, precondition_failures []. It read the derived pre-state.
  assertStagingPinState(assert, KEY, pin);
  assert.equal(pin.execute, true);
  assert.equal(pin.authorization, 'Owner approved 2026-11-10: staging apply (wave 42) from staging read-live run 42833250784');
  assert.equal(pin.expected_live_definition_sha256, ABSENT_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(releaseIntendedHash(KEY, TEXT), pin.intended_replacement_sha256);
  // The pre-state (the function absent) has a fingerprint of its own, and renders as absent.
  assert.notEqual(ABSENT_PRE, pin.intended_replacement_sha256);
  assert.equal(ABSENT_PRE, releaseStateHash(KEY, {}));
  assert.deepEqual(releaseStateText(KEY, { functions: { [IDENTITY]: { exists: false } } }).split('\n'),
    ['release sql147 v1', `function ${IDENTITY}: absent`]);
  // The runbook and the production pin name the expected pre-state (derived here) and the intended fingerprint.
  const runbook = fs.readFileSync(path.join(ROOT, 'ops/production-sql-147-apply.md'), 'utf8');
  assert.ok(runbook.includes(ABSENT_PRE));
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 42\) and to production \(2026-11-10\); the production pin is retired/);
  assert.match(runbook, /read-live \(2026-11-10\)\.\*\* Run 42833250784/);
  assert.ok(runbook.includes(pin.expected_live_definition_sha256));
  assert.ok(runbook.includes(pin.intended_replacement_sha256));
  assert.ok(runbook.includes(pin.source_sha256));
  const defs = releaseFunctionDefinitions(TEXT);
  assert.ok(runbook.includes(sha(defs[FN].prosrc)));
  assert.ok(AUTHORIZED_STAGING_SQL.includes(pin));
  assert.equal(resolveAuthorizedMigration({ filename: pin.filename }), pin);
  assert.equal(MIGRATIONS[spec.choice], pin);
  assert.equal(packed[pin.filename], `sql/${path.basename(pin.filename)}`);
  assert.match(workflow, new RegExp(`- ${spec.choice}\\n`));
  assert.match(workflow, /node --test aws\/tests\/release-sql147-executor\.test\.mjs/);
  assert.deepEqual([...pin.function_identities], [...IDENTITIES]);
  assert.deepEqual([...pin.function_identities], spec.functions.map((fn) => fn.identity));
  // No predecessor; nothing refuses after it.
  assert.deepEqual(spec.predecessors, []);
  for (const absent of ['runs_before', 'supersedes', 'refuse_after']) assert.equal(spec[absent], undefined, absent);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)), []);
  // SQL 150 (outside payments up to the check amount) replaces aws_record_external_disbursement in place: it names
  // SQL 147 as predecessor and supersedes it (as SQL 138 does SQL 113); nothing else does.
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].supersedes || []).includes(KEY)), ['sql150']);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].predecessors || []).includes(KEY)), ['sql150']);
  // No other release migration creates, replaces, drops or re-grants the function; SQL 150 replaces it.
  for (const key of RELEASE_SQL_KEYS.filter((k) => k !== KEY)) {
    const other = RELEASE_SQL_SPECS[key];
    const touched = [...(other.functions || []).map((fn) => fn.identity), ...(other.dropped_functions || []), ...(other.acl_functions || []).map((fn) => fn.identity)];
    assert.equal(touched.includes(IDENTITY), key === 'sql150', key);
  }
  const prod = productionPin();
  assert.equal(prod.intended_replacement_sha256, pin.intended_replacement_sha256);
  assert.equal(prod.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(prod.staging_pin_commit, pin.commit);
  assert.equal(prod.source_sha256, pin.source_sha256);
  assert.deepEqual(prod.function_identities, [...IDENTITIES]);
  assert.deepEqual(prod.predecessors, []);
  // Production pin applied 2026-11-10 and retired (owner-approved pin change of 2026-11-10, #1736, on the staging apply).
  // Its pre-state is production's own (read-only inspect SSM ea4ffd03), the derived one (the function absent), the
  // same pre-state staging recorded (read-live run 42833250784).
  assert.equal(prod.execute, false);
  assert.match(prod.authorization, /^Applied to production on 2026-11-10; execute is false again/);
  assert.equal(prod.applied.result, 'applied');
  assert.equal(prod.applied.receipt.before_hash, prod.expected_live_definition_sha256);
  assert.equal(prod.applied.receipt.after_hash, prod.intended_replacement_sha256);
  assert.equal(prod.applied.post_apply_inspect.already_applied, true);
  assert.equal(prod.expected_live_definition_sha256, prod.production_inspect.live_definition_sha256);
  assert.equal(prod.expected_live_definition_sha256, pin.expected_live_definition_sha256);
  assert.equal(prod.expected_live_definition_sha256, ABSENT_PRE);
  assert.notEqual(prod.expected_live_definition_sha256, prod.intended_replacement_sha256);
  assert.equal(prod.production_inspect.status, 'recorded');
  assert.ok(prod.production_inspect.note.includes(ABSENT_PRE));
  assert.match(prod.production_inspect.note, / Earlier: Pending: no release-engine production inspect has been run for SQL 147 yet./);
  assert.ok(prod.order_note.includes(ABSENT_PRE));
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

test('reviewed file and spec: one new DEFINER function with the member gate, the input checks, the check lock, the idempotency key, the amount available and two INSERTs (the batch and the splits); the prerequisite block, the REVOKEs and GRANT EXECUTE TO checksops, nothing else; the spec; pre- and post-conditions', () => {
  assert.equal(releaseSqlExecutableText(KEY, TEXT), TEXT);
  const defs = releaseFunctionDefinitions(TEXT);
  assert.deepEqual(Object.keys(defs), [FN]);
  const def = defs[FN];
  assert.equal(def.language, 'plpgsql');
  assert.equal(def.volatility, 'v');
  assert.equal(def.parallel, 'u');
  assert.equal(def.security_definer, true);
  assert.equal(def.result, 'jsonb');
  assert.deepEqual(def.config, ['search_path=public, pg_temp']);
  const strip = (text) => text.replace(/--[^\n]*/g, '');
  const body = strip(def.prosrc);
  // The member gate first: a signed-in user and SQL 90's aws_can_write_tenant (membership only).
  assert.match(body, /BEGIN\s+IF v_uid IS NULL OR _tenant_id IS NULL OR NOT COALESCE\(public\.aws_can_write_tenant\(_tenant_id\), false\) THEN\s+RAISE EXCEPTION 'external_disbursement_forbidden'\s+USING ERRCODE = '42501';/);
  assert.match(body, /v_uid uuid := auth\.uid\(\);/);
  // The inputs.
  assert.match(body, /_idempotency_key !~ '\^\[A-Za-z0-9_:-\]\{8,100\}\$'/);
  assert.match(body, /IF v_n < 1 OR v_n > 10 THEN/);
  assert.match(body, /\(v_payment ->> 'amount_cents'\)::bigint <= 0/);
  assert.match(body, /length\(COALESCE\(v_name, ''\)\) > 200\s+OR length\(COALESCE\(v_number, ''\)\) > 40\s+OR length\(COALESCE\(v_memo, ''\)\) > 500/);
  // The check, locked and the tenant's; a stakeholder account the tenant's own or on its row for this check.
  assert.match(body, /FROM public\.check_intake_items ci\s+WHERE ci\.id = _check_intake_item_id\s+FOR UPDATE;\s+IF NOT FOUND OR v_check\.tenant_id IS DISTINCT FROM _tenant_id THEN\s+RAISE EXCEPTION 'external_disbursement_check_not_found'\s+USING ERRCODE = 'P0002';/);
  assert.equal([...body.matchAll(/FOR UPDATE/g)].length, 1);
  assert.match(body, /AND \(sa\.tenant_id = _tenant_id\s+OR EXISTS \(SELECT 1 FROM public\.check_stakeholders cs\s+WHERE cs\.check_intake_item_id = _check_intake_item_id\s+AND cs\.tenant_id = _tenant_id\s+AND cs\.stakeholder_account_id = v_account\)\);/);
  // Idempotency, the amount available, the refusal above it.
  assert.match(body, /AND s\.idempotence_key LIKE 'external:' \|\| _idempotency_key \|\| ':%';/);
  assert.match(body, /RAISE EXCEPTION 'external_disbursement_key_reused'\s+USING ERRCODE = '23505';/);
  assert.match(body, /AND pt\.leg_role IN \('send_wallet', 'send_bank'\)/);
  assert.match(body, /v_available := GREATEST\(0, v_gross - v_fee - v_split_out - v_sent_out\);/);
  assert.match(body, /IF v_total > v_available THEN\s+RAISE EXCEPTION 'external_disbursement_exceeds_available: available_cents=%', v_available\s+USING ERRCODE = 'P0001';/);
  // Two writes: the batch and the splits (settled, external_check). No UPDATE, DELETE or payment_transfers write
  // (the one UPDATE keyword is the check's FOR UPDATE lock).
  assert.deepEqual([...body.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\s+(public\.[a-z_]+)?/gi)].map((m) => m[0].trim()),
    ['INSERT INTO public.disbursement_batches', 'INSERT INTO public.disbursement_splits']);
  assert.deepEqual([...body.matchAll(/\bUPDATE\b/g)].length, 1);
  assert.match(body, /'settled', 'external_check',/);

  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.functions, IDENTITIES.map((identity) => ({ identity, acl: [...ACL], revokes: [...REVOKES] })));
  assert.deepEqual(spec.prerequisites.slice(0, 9), [...RELATIONS, 'public.aws_can_write_tenant(uuid)', 'auth.uid()', 'role checksops']);
  // The file's prerequisite block names the same objects, and every column it checks is a spec prerequisite, and nothing else.
  const fileObjects = [...TEXT.matchAll(/^\s+\('([^']+)', (?:pg_catalog\.to_reg|\(SELECT r\.oid)/gm)].map((m) => m[1]);
  assert.deepEqual(fileObjects, spec.prerequisites.slice(0, 9));
  const fileColumns = [...TEXT.matchAll(new RegExp(`\\('(${TABLES.join('|')})', '([a-z_]+)'\\)`, 'g'))].map((m) => `column public.${m[1]}.${m[2]}`);
  assert.equal(fileColumns.length, 42);
  assert.deepEqual(spec.prerequisites.slice(9), fileColumns);
  // Every column the function writes is a checked prerequisite.
  for (const column of ['tenant_id', 'check_intake_item_id', 'created_by', 'check_amount', 'available_amount', 'reserve_held', 'status', 'notes',
    'completed_at', 'approved_at', 'approved_by', 'approved_amount_cents']) {
    assert.ok(spec.prerequisites.includes(`column public.disbursement_batches.${column}`), column);
  }
  for (const column of ['batch_id', 'tenant_id', 'amount', 'status', 'method', 'external_check_number', 'recipient_name', 'recipient_type',
    'external_notes', 'stakeholder_account_id', 'idempotence_key', 'settled_at']) {
    assert.ok(spec.prerequisites.includes(`column public.disbursement_splits.${column}`), column);
  }
  assert.deepEqual(spec.predecessors, []);
  assert.deepEqual(spec.definer_writes, [...RELATIONS]);
  for (const absent of ['tables', 'policies', 'views', 'column_acl', 'indexes', 'unique_covers', 'whole_tables', 'counts', 'dropped_functions',
    'triggers', 'table_privileges', 'acl_functions', 'render', 'production_noop', 'added_columns', 'altered_relations', 'dropped_triggers']) {
    assert.equal(spec[absent], undefined, absent);
  }
  // The prerequisite DO block, one CREATE OR REPLACE FUNCTION, the REVOKE from PUBLIC, the role REVOKE block, the GRANT.
  const code = strip(TEXT);
  assert.equal([...code.matchAll(/\bDO\s+\$sql147_prereq\$/g)].length, 1);
  assert.equal([...code.matchAll(/\bDO\s+\$sql147_revoke\$/g)].length, 1);
  assert.match(code, /sql147_prerequisite_missing/);
  assert.match(code, /sql147_definer_cannot_write/);
  assert.equal([...code.matchAll(/\bCREATE OR REPLACE FUNCTION\b/g)].length, 1);
  assert.equal([...code.matchAll(/^GRANT\b.*$/gm)].map((m) => m[0]).join('\n'), `GRANT EXECUTE ON FUNCTION ${IDENTITY} TO checksops;`);
  assert.equal([...code.matchAll(/^REVOKE\b.*$/gm)].map((m) => m[0]).join('\n'), `REVOKE ALL ON FUNCTION ${IDENTITY} FROM PUBLIC;`);
  const outsideBodies = code.replace(strip(def.prosrc), '');
  for (const forbidden of [/\bDROP\b/, /\bALTER\b/, /\bCOMMENT\b/, /\bCREATE\s+(TABLE|POLICY|VIEW|INDEX|TRIGGER)\b/i,
    /\bTRUNCATE\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+public\./i, /\bDELETE\s+FROM\b/i, /\bBEGIN\s*;/i, /\bCOMMIT\b/, /\bPOLICY\b/]) {
    assert.doesNotMatch(outsideBodies, forbidden, String(forbidden));
  }
  const scope = releaseUnrelatedScope(KEY);
  assert.deepEqual(scope.skip_functions, [...IDENTITIES]);
  assert.deepEqual(scope.skip_views, []);

  const text = releaseStateText(KEY, releaseIntendedState(KEY, TEXT));
  assert.deepEqual(text.split('\n'), [
    'release sql147 v1',
    `function ${IDENTITY}: lang=plpgsql vol=v parallel=u secdef=true result=jsonb config=search_path=public, pg_temp prosrc=${sha(def.prosrc)} acl=checksops EXECUTE;owner EXECUTE`,
  ]);

  // Pre-conditions: absent passes; any relation unreachable or missing refuses; an existing function owned by
  // another role, with another grant or another result refuses; the revoked roles are revocable.
  const definer = Object.fromEntries(RELATIONS.map((table) => [table, true]));
  const base = { prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], dependents: {}, functions: {}, definer };
  const pre = (over = {}) => releaseSharedPreconditionFailures(KEY, { ...base, ...over }, TEXT);
  const fn = (acl, over = {}) => ({ functions: { [IDENTITY]: { ...releaseIntendedState(KEY, TEXT).functions[IDENTITY], owner_is_login: true, acl: [...acl], ...over } } });
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ functions: { [IDENTITY]: { exists: false } } }), []);
  for (const table of RELATIONS) {
    assert.deepEqual(pre({ definer: { ...definer, [table]: false } }), ['definer_can_write_relations'], table);
    assert.ok(pre({ prerequisites_missing: [table] }).includes('prerequisites_present'), table);
  }
  assert.ok(pre({ prerequisites_missing: ['public.aws_can_write_tenant(uuid)'] }).includes('prerequisites_present'));
  assert.deepEqual(pre(fn(ACL)), []);
  assert.deepEqual(pre(fn([...REVOKES, ...ACL])), []);
  assert.deepEqual(pre(fn([...ACL, 'sql147_plain EXECUTE'])), ['function_acl_replaceable']);
  assert.deepEqual(pre(fn(ACL, { owner_is_login: false })), ['functions_owned_by_login']);
  assert.deepEqual(pre(fn(ACL, { result: 'SETOF record' })), ['function_results_match']);
  // Post-conditions: the intended fingerprint with the function owned by the login.
  const post = (over = {}) => ({
    live_definition_sha256: PINS[KEY].intended_replacement_sha256,
    functions: { [IDENTITY]: { exists: true, owner_is_login: true } },
    ...over,
  });
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post(), PINS[KEY]), []);
  assert.deepEqual(releaseSharedPostconditionFailures(KEY, {}, post({ live_definition_sha256: ABSENT_PRE }), PINS[KEY]), ['intended_state']);
});

test('PostgreSQL 16: SQL 147 through the executor: the pre-state as derived; refused while a column is missing or a relation is under FORCE ROW LEVEL SECURITY; a pending pin and an unexpected pre-state cannot apply; one apply on the intended fingerprint, then refused', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql147-exec-', 60400, { extra: [DISBURSEMENT_SCHEMA] });
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
    const present = async () => (await fx.admin.query('SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present', [IDENTITY])).rows[0].present;
    const executeAcl = async () => (await fx.admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
        (SELECT pg_catalog.array_agg(g.name ORDER BY g.name)::text[] FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
           FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') g) AS execute
      FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [IDENTITY])).rows[0];
    const allOk = TABLES.map((name) => ({ name, ok: true }));

    // The pre-state: the function absent, every prerequisite present, all six relations reachable.
    const pre = await inspect();
    assert.deepEqual(pre.precondition_failures, [], JSON.stringify(pre.release_sql_inspect));
    assert.deepEqual(pre.release_sql_inspect.prerequisites_missing, []);
    assert.deepEqual(pre.release_sql_inspect.predecessors, {});
    assert.deepEqual(pre.release_sql_inspect.definer_writes, allOk);
    assert.equal(pre.already_applied, false);
    assert.equal(pre.live_definition_sha256, ABSENT_PRE);
    assert.equal(await present(), false);

    // Any relation under FORCE ROW LEVEL SECURITY (the DEFINER owner would be filtered): refused, nothing applied.
    for (const table of RELATIONS) {
      await fx.admin.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      const forced = await inspect();
      assert.deepEqual(forced.precondition_failures, ['definer_can_write_relations'], `${table}: ${JSON.stringify(forced.release_sql_inspect)}`);
      assert.deepEqual(forced.release_sql_inspect.definer_writes, allOk.map((row) => (row.name === table.replace(/^public\./, '') ? { ...row, ok: false } : row)), table);
      assert.equal((await apply(ABSENT_PRE)).code, CODES.DEPLOYMENT_COLLISION, table);
      assert.equal(await present(), false, table);
      await fx.admin.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
    }
    assert.deepEqual((await inspect()).precondition_failures, []);

    // A column it writes missing: refused, nothing applied.
    await fx.admin.query('ALTER TABLE public.disbursement_splits RENAME COLUMN idempotence_key TO idempotence_moved');
    const missing = await inspect();
    assert.ok(missing.release_sql_inspect.prerequisites_missing.includes('column public.disbursement_splits.idempotence_key'), JSON.stringify(missing.release_sql_inspect.prerequisites_missing));
    assert.ok(missing.precondition_failures.includes('prerequisites_present'));
    assert.equal((await apply(missing.live_definition_sha256)).code, CODES.DEPLOYMENT_COLLISION);
    await fx.admin.query('ALTER TABLE public.disbursement_splits RENAME COLUMN idempotence_moved TO idempotence_key');
    assert.deepEqual((await inspect()).precondition_failures, []);
    assert.equal(await present(), false);

    // A pending pin cannot apply (pend a copy of the committed pin, the pre-state kept recorded).
    const pendingCopy = Object.freeze({ ...pendingPin(PINS[KEY]), expected_live_definition_sha256: ABSENT_PRE });
    const pending = await handlerFor(connect, { pins: { [KEY]: pendingCopy } })(releaseEvent({ pin: pendingCopy }));
    assert.equal(pending.ok, false);
    assert.equal(await present(), false);

    // An unexpected pre-state: a pin recording the intended state as the pre-state is not a valid authorization
    // package; a pin recording a hash the database does not show refuses on the live state. Nothing applied either way.
    const onIntended = await apply(PINS[KEY].intended_replacement_sha256);
    assert.equal(onIntended.ok, false, JSON.stringify(onIntended));
    assert.equal(onIntended.code, CODES.INVALID_MANIFEST);
    assert.equal(await present(), false);
    const unknown = await apply('f'.repeat(64));
    assert.equal(unknown.ok, false, JSON.stringify(unknown));
    assert.equal(unknown.code, CODES.DEPLOYMENT_COLLISION);
    assert.equal(await present(), false);
    assert.equal((await inspect()).live_definition_sha256, ABSENT_PRE);

    // One apply on the intended fingerprint: the function exists, owned by the login, EXECUTE for checksops and the owner.
    const applied = await apply(ABSENT_PRE);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, ABSENT_PRE);
    assert.equal(applied.details.receipt.after_hash, PINS[KEY].intended_replacement_sha256);
    const after = await inspect();
    assert.equal(after.already_applied, true);
    assert.equal(after.live_definition_sha256, PINS[KEY].intended_replacement_sha256);
    assert.deepEqual(after.precondition_failures, []);
    assert.deepEqual(after.release_sql_inspect.functions.map((f) => f.state), ['intended']);
    assert.equal(await present(), true);
    assert.deepEqual(await executeAcl(), { owner: 'checksops_admin', prosecdef: true, proconfig: ['search_path=public, pg_temp'], execute: ['checksops', 'checksops_admin'] });
    // A second apply: refused, the database already past the pinned pre-state.
    assert.equal((await apply(ABSENT_PRE)).code, CODES.UNRELATED_MUTATION);
    assert.equal((await apply(after.live_definition_sha256)).ok, false);
    assert.equal((await inspect()).live_definition_sha256, PINS[KEY].intended_replacement_sha256);
  } finally {
    await fx.close();
  }
});
