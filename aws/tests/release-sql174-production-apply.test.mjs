/**
 * Production tool for SQL 174 (scripts/deployment-guard/sql174-checkalt-reset-stranded-attempt-production-apply.mjs on
 * lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs). Owner 2026-11-24: "start step 3" (clear
 * the one Check Alt deposit attempt stranded before the provider sign-in). release-sql90-97-production-apply.test.mjs
 * runs every release key (SQL 174 included) through the shared refusals; this file covers SQL 174's own:
 *
 *   - the pin has the release pin shape; it is execute-authorized (owner-approved pin change of 2026-11-24) with the
 *     recorded production pre-state (read-only inspect SSM c67d45d5; the derived pre-state, one stranded attempt) and the
 *     staging apply from the same catalog pre-state (run 45500686914, the zero-row path) as its acceptance; it is in step
 *     with the staging pin, the one-shot, the bypass inventory and the test lists;
 *   - no predecessor; one new owner-only SECURITY DEFINER function, called once by the file for one minute; the declared
 *     counts and the production rule of checkalt_stranded_attempt_in_window (exactly one stranded attempt); no existing
 *     object changed; no overlay plan entry; the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed pin allows only the manifest bound
 *     to its recorded pre-state; an approved, accepted copy evaluates for the manifest built from it,
 *     and refuses with execute false, another live hash, another staging reference or a wrong phrase; the CLI spends no
 *     receipt.
 * The behavior on PostgreSQL 16 (the production tool included) is aws/tests/sql174-checkalt-reset-stranded-attempt-pg.test.mjs;
 * the executor path is aws/tests/release-sql174-executor.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { ONE_SHOT_TOOLS } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { RELEASE_2026_10_17_PENDING_SQL_PINS as STAGING } from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { RELEASE_SQL_SPECS, releaseIntendedHash, releaseSharedPreconditionFailures, releaseStateHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import {
  RELEASE_PRODUCTION,
  evaluateReleaseProductionApply,
  executeReleaseProductionApply,
  loadReleaseProductionPin,
  precheckReleaseProductionApply,
  readPinnedReleaseSql,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { main } from '../../scripts/deployment-guard/sql174-checkalt-reset-stranded-attempt-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql174';
const SQL174_FILE = 'aws/workflows/sql/174_checkalt_reset_stranded_attempt.sql';
const FUNCTIONS = Object.freeze([
  'public.aws_checkalt_reset_stranded_attempt(timestamp with time zone, timestamp with time zone)',
]);
/** The expected pre-state: the function absent. */
const ABSENT_PRE = releaseStateHash(KEY, {});
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 174's recorded production pre-state (read-only inspect of 2026-11-24, SSM c67d45d5, main 0b4f4b789): the function
// absent, the derived pre-state.
const PRODUCTION_PRE = '51db2d269aed8dc824b02831671c6e945fde3cd2d772e167e6ea6bfe6824e83f';
// The guarded staging apply from the same catalog pre-state.
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/45500686914';
// The owner's words for SQL 174, quoted in the authorization.
const OWNER_WORDS = Object.freeze(['"start step 3"', '"Yes, acceptable"', '"run the SQL 174 staging apply"', '"run the SQL 174 production inspect"', '"open the SQL 174 pin PR"']);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql174-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

function manifest(pin) {
  const live = pin.expected_live_definition_sha256;
  const fingerprint = { sql: live };
  const workstream = `prod-${KEY}-release-test`;
  return {
    workstream_id: workstream,
    branch: 'main',
    commit: 'a'.repeat(40),
    operator: 'owner',
    target_environment: 'production',
    target_component: 'production-sql',
    deployment_type: 'sql-apply',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    expected_live_definition_sha256: live,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    live_definition_sha256: live,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: pin.staging_acceptance,
    approval: { approved: true, workstream_id: workstream },
    authorization_phrase: pin.authorization_phrase,
    one_use_id: `${KEY}-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-11-24T00:00:00.000Z',
  };
}
/** An approved, accepted copy of the committed pin with a recorded pre-state (test only). */
const approved = (extra = {}) => Object.freeze({
  ...COMMITTED,
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: PRE,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
  ...extra,
});

test('pin: the release pin shape, execute-authorized on the staging apply, in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-11-24: the read-only production inspect (SSM c67d45d5, main 0b4f4b789) recorded as
  // the pre-state; the staging apply (run 45500686914, from the same catalog pre-state, the zero-row path) as the acceptance.
  assert.equal(pin.execute, true);
  assert.match(pin.authorization, /^Owner approved 2026-11-24 /);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /none of them words for the production apply/);
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE} -> ${pin.intended_replacement_sha256}`));
  assert.match(pin.authorization, /execute true takes effect only when the owner reviews and merges this change\. It does not itself run or approve a run/);
  assert.match(pin.authorization, /each apply still needs the owner's run-time approval/);
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, ABSENT_PRE);
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied, undefined);
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-24');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, 'c67d45d5-0101-4e45-ac6f-0acc4b24dfb6');
  assert.equal(pin.production_inspect.source_commit, '0b4f4b789f4f1c31b9a604cef713755376ce749e');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  for (const text of ['1602ac9030e411871d5b7dd33bd2046f8e9c7946df5ee2dee4f2d4ed175b9c75', 'run 45502123569',
    'prerequisites_missing [], predecessors {}, successors_applied [], precondition_failures []', 'already_applied false',
    'ok true, read_only true, source_ok true, current_user, session_user and admin_login checksops_admin, pin_execute false, predecessors_applied true',
    'definer_writes checkalt_deposits ok and check_intake_items ok', 'counts checkalt_stranded_attempts_in_window 1 and checkalt_reset_attempts_in_window 0',
    '57b460fc-b796-4e78-a2d3-86f67f544635', 'GUARD_APPLY_FORBIDDEN', 'definer_can_write_relations', ABSENT_PRE]) {
    assert.ok(pin.production_inspect.note.includes(text), text);
  }
  assert.match(pin.production_inspect.note, /If already_applied is true, prerequisites_missing is not \[\] or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no release-engine production inspect has been run for SQL 174 yet'));
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql174-checkalt-reset-stranded-attempt, run 45500686914/);
  assert.match(pin.staging_acceptance.basis, /wave 66/);
  assert.match(pin.staging_acceptance.basis, /deploy run 45499584688/);
  assert.match(pin.staging_acceptance.basis, /read-live run 45496290311/);
  assert.ok(pin.staging_acceptance.basis.includes(`before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.match(pin.staging_acceptance.basis, /Read-live run 45501136748 then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /the zero-row path[\s\S]*"Yes, acceptable"/);
  assert.match(pin.staging_acceptance.basis, /Production's catalog pre-state \(production_inspect\) equals staging's/);
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  assert.equal(pin.filename, SQL174_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL174_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, FUNCTIONS);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'RESET_STRANDED_CHECKALT_ATTEMPT');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql174-checkalt-reset-stranded-attempt-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-174-apply.md');
  for (const file of [pin.tooling.production_tool, pin.tooling.runbook, pin.tooling.fingerprint_engine, pin.tooling.production_lib, ...pin.tooling.tests]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  assert.equal(readPinnedReleaseSql(KEY, ROOT, pin).ok, true);
  // One-shot: the release tool (no hash in the registry).
  const tool = ONE_SHOT_TOOLS[KEY];
  assert.equal(tool.key, KEY);
  assert.equal(tool.script, RELEASE_PRODUCTION[KEY].cli);
  assert.deepEqual([...tool.args], []);
  assert.equal(tool.pin_rel, RELEASE_PRODUCTION[KEY].pin_rel);
  assert.equal(tool.allowed_key, 'sql174_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql174-checkalt-reset-stranded-attempt-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql174-production-apply"\]/);
  assert.match(rows, /sql171, sql172, sql173, sql174\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql174-executor.test.mjs', 'aws/tests/release-sql174-production-apply.test.mjs', 'aws/tests/sql174-checkalt-reset-stranded-attempt-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; one new owner-only DEFINER function called once for one minute; the counts and the production rule (exactly one stranded attempt); nothing existing changed; no overlay plan entry; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.production_only, undefined);
  assert.equal(spec.production_noop, undefined);
  assert.deepEqual(spec.functions.map((f) => [f.identity, f.acl]), FUNCTIONS.map((f) => [f, ['owner EXECUTE']]));
  // The function updates checkalt_deposits and reads check_intake_items past RLS (sql174_definer_cannot_read).
  assert.deepEqual(spec.definer_writes, ['public.checkalt_deposits', 'public.check_intake_items']);
  for (const absent of ['tables', 'policies', 'views', 'table_privileges', 'column_acl', 'dropped_functions', 'acl_functions', 'indexes', 'added_columns', 'altered_columns', 'constraints', 'triggers', 'dropped_triggers', 'altered_relations', 'dropped_policies']) {
    assert.equal(spec[absent], undefined, absent);
  }
  assert.deepEqual(Object.keys(spec.counts), ['checkalt_stranded_attempts_in_window', 'checkalt_reset_attempts_in_window']);
  assert.deepEqual(spec.extra_preconditions, ['checkalt_stranded_attempt_in_window']);
  // Aggregate counts of the one minute only: no id, amount or name.
  for (const count of Object.values(spec.counts)) {
    assert.match(count.sql, /^SELECT count\(\*\)::int AS n FROM public\.checkalt_deposits d\n/);
    assert.match(count.sql, /d\.created_at >= '2026-11-24 19:58:00\+00'::timestamptz AND d\.created_at < '2026-11-24 19:59:00\+00'::timestamptz/);
    assert.doesNotMatch(count.sql, /[0-9a-f]{8}-[0-9a-f]{4}-|amount|tenant_id|submitted_by|idempotency_key/);
  }
  // Production: exactly one stranded attempt in the window; 0, 2 or an unreadable count refuses.
  const base = {
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [],
    definer: { 'public.checkalt_deposits': true, 'public.check_intake_items': true },
  };
  const text = fs.readFileSync(path.join(ROOT, SQL174_FILE), 'utf8');
  const pre = (n) => releaseSharedPreconditionFailures(KEY, { ...base, counts: { checkalt_stranded_attempts_in_window: n, checkalt_reset_attempts_in_window: 0 } }, text);
  assert.deepEqual(pre(1), []);
  for (const n of [0, 2, null, undefined]) assert.deepEqual(pre(n), ['checkalt_stranded_attempt_in_window'], String(n));
  // No other release migration names the function.
  for (const key of Object.keys(RELEASE_SQL_SPECS).filter((k) => k !== KEY)) {
    assert.ok(!JSON.stringify(RELEASE_SQL_SPECS[key]).includes('aws_checkalt_reset_stranded_attempt'), key);
  }
  assert.match(COMMITTED.order_note, /^No predecessor\. SQL 174 creates one function and replaces nothing/);
  for (const value of ['"start step 3"', 'sql174_prerequisite_missing', 'sql174_definer_cannot_read', 'sql174_ambiguous_stranded_attempts',
    'checkalt_stranded_attempt_in_window', 'definer_can_write_relations', '9eb0173e-0540-467f-b108-8fb6edc727e2',
    '[2026-11-24 19:58:00+00, 2026-11-24 19:59:00+00)', 'No API, Lambda or SPA change is part of this pin', ABSENT_PRE]) {
    assert.ok(COMMITTED.order_note.includes(value), value);
  }
  // Nothing in the overlay plan waits on SQL 174.
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal(plan.sql_prerequisites?.[SQL174_FILE], undefined);
  assert.doesNotMatch(JSON.stringify(plan), /174_checkalt_reset_stranded_attempt/);
  // The file: three guarded DO blocks (prerequisites, the revoke loop, the one call), the function with its REVOKE and
  // comment; no other object. The only row write is the function's one UPDATE of checkalt_deposits.
  const code = text.replace(/--[^\n]*/g, '');
  const outside = code.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$');
  const bare = outside.replace(/'(?:[^']|'')*'/g, "''");
  assert.equal([...outside.matchAll(/\bDO\s+\$/g)].length, 3);
  assert.deepEqual([...outside.matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|INDEX|FUNCTION|POLICY|TRIGGER|VIEW)\s+(\S+?)(?:\(|\s)/gi)].map((m) => `${m[1].toUpperCase()} ${m[2]}`),
    ['FUNCTION public.aws_checkalt_reset_stranded_attempt']);
  assert.deepEqual([...bare.matchAll(/\b(GRANT|REVOKE)\s+[^;]+;/gi)].map((m) => m[0].replace(/\s+/g, ' ')), [
    'REVOKE ALL ON FUNCTION public.aws_checkalt_reset_stranded_attempt(timestamptz, timestamptz) FROM PUBLIC;',
  ]);
  assert.doesNotMatch(bare, /\bGRANT\b|\bALTER\b|\bDROP\b|\bTRIGGER\b|\bFORCE\b|\bFOR\s+(INSERT|UPDATE|DELETE|ALL)\b/i);
  assert.doesNotMatch(outside, /\b(TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+public\.)/i);
  assert.deepEqual([...code.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(public\.\w+)/gi)].map((m) => m[1]), ['public.checkalt_deposits']);
  // No deposit, check, tenant or user id and no amount anywhere in the file.
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  assert.doesNotMatch(code, /amount_cents|\bamount\b|tenant_id|submitted_by|idempotency_key/);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  for (const value of [COMMITTED.intended_replacement_sha256, COMMITTED.source_sha256, ABSENT_PRE, 'RESET_STRANDED_CHECKALT_ATTEMPT',
    'checkalt_stranded_attempts_in_window', 'checkalt_stranded_attempt_in_window']) {
    assert.ok(runbook.includes(value), value);
  }
  assert.match(runbook, /\*\*Status:\*\* applied in staging \(wave 66, 2026-11-24, apply run 45500686914; the zero-row path\); staging acceptance: the staging apply under the owner's run approval \("run the SQL 174 staging apply"\), the zero-row path accepted by the owner \("Yes, acceptable"\); production pin execute-authorized on production's own pre-state \(read-only inspect SSM `c67d45d5-0101-4e45-ac6f-0acc4b24dfb6`, 2026-11-24\) by the owner-reviewed pin change; not applied in production\./);
  assert.match(runbook, /\*\*Production inspect \(2026-11-24\)\.\*\* Read-only `--inspect`/);
  assert.match(runbook, /the tool's own read-only inspect on the runner\n\s+\(`node scripts\/deployment-guard\/sql174-checkalt-reset-stranded-attempt-production-apply\.mjs --inspect`/);
  assert.match(runbook, /\*\*exactly 1 on production\*\* and \*\*0 on staging\*\*/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql174` \|/);
  assert.match(oneShot, /`sql172`, `sql173`, `sql174`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql174-checkalt-reset-stranded-attempt-production-apply\.mjs --inspect/);
});

test('the pending (pre-authorization) pin refuses before connecting; the committed pin allows only its own manifest; execute false, other hashes and phrases refuse', async () => {
  // The pin before its owner-approved change: no pre-state, no owner approval, no staging acceptance.
  const PENDING = Object.freeze({ ...COMMITTED, authorization: 'pending', execute: false, expected_live_definition_sha256: null, staging_acceptance: { ok: false, reference: null, basis: 'Pending' } });
  const noPre = await evaluateReleaseProductionApply(KEY, manifest({ ...PENDING, expected_live_definition_sha256: PRE }), { root: ROOT, pin: PENDING });
  assert.equal(noPre.code, CODES.SQL_COLLISION);
  const withPre = { ...PENDING, expected_live_definition_sha256: PRE };
  // The committed (authorized) pin allows only the manifest bound to its recorded pre-state: not another hash, not the
  // intended state.
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql174_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(COMMITTED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT })).ok, false);

  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre, connect: neverConnect, consumedPath: consumedPath() })).ok, false);
  // execute true alone does not authorize it.
  const flipped = { ...withPre, execute: true };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(flipped), { root: ROOT, pin: flipped })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql174_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // SQL 173's phrase does not authorize SQL 174.
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'RECORD_JOB_EXPENSES' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql174-cli-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(manifest(pin)));
  const writes = [];
  let spent = 0;
  const orig = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await main(['--apply', '--input', file], { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, {
      root: ROOT, consumeReceiptOnce: () => { spent += 1; return { ok: true }; }, connect: neverConnect, consumedPath: consumedPath(),
    });
    await main(['--inspect', '--password', 'x'], {}, { root: ROOT, connect: neverConnect });
  } finally {
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
    fs.rmSync(file, { force: true });
  }
  const out = writes.join('');
  assert.equal(spent, 0);
  assert.doesNotMatch(out, /should-not-connect/);
  assert.match(out, /SQL_COLLISION|PRODUCTION_APPROVAL_REQUIRED|DEPLOYMENT_GUARD_REQUIRED/);
  assert.match(out, /credential flags are refused/);
});
