/**
 * Production tools for SQL 98, SQL 99 and SQL 100
 * (scripts/deployment-guard/sql98-…, sql99-…, sql100-…-production-apply.mjs on
 * lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (these three included)
 * through the shared refusals (pending pins, binding, evaluate / precheck, the CLI, the real
 * guard); this file covers what is new:
 *
 *   - the reconciled SQL 98 / SQL 99 pins keep their recorded hashes and notes and now have the
 *     SQL 90-97 pins' shape; the new SQL 100 pin has it too (SQL 98 applied and retired on
 *     2026-10-19, SQL 99 applied and retired on 2026-10-21, SQL 100 pending);
 *   - SQL 100 is production_noop: the production precondition production_state_already_intended;
 *   - on PostgreSQL 16: --inspect is read-only for all three; SQL 98 and SQL 99 apply once each as
 *     checksops_admin (the superuser login refused); SQL 100's tool never runs the file: it
 *     refuses while the live state is not production's (production_state_already_intended),
 *     then, once the live state is the intended one (the file already in place, as on
 *     production), reports already_applied and refuses as already in place; another grantor or
 *     a policy comment makes the live state not the intended one again.
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
import { RELEASE_SQL_SPECS, readReleaseSqlState } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import {
  RELEASE_PRODUCTION,
  evaluateReleaseProductionApply,
  executeReleaseProductionApply,
  inspectReleaseProduction,
  loadReleaseProductionPin,
  precheckReleaseProductionApply,
  readPinnedReleaseSql,
  releaseProductionPreconditionFailures,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { pgSkipReason, releaseFixture, sql98To100Schema } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEYS = Object.freeze(['sql98', 'sql99', 'sql100']);
const BEFORE = Object.freeze(['sql90', 'sql91', 'sql92', 'sql93', 'sql94', 'sql96', 'sql97', 'sql95']);
const COMMITTED = Object.freeze(Object.fromEntries(KEYS.map((key) => [key, loadReleaseProductionPin(key, ROOT)])));
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
// SQL 98's and SQL 99's production pins before their owner-approved changes (the pending state the shared refusals start from).
const PENDING = Object.freeze(Object.fromEntries(KEYS.map((key) => [key, COMMITTED[key].authorization !== 'pending'
  ? Object.freeze({ ...COMMITTED[key], authorization: 'pending', execute: false, expected_live_definition_sha256: null, staging_acceptance: { ok: false, reference: null, basis: 'Pending' }, production_inspect: { ...COMMITTED[key].production_inspect, status: 'pending' } })
  : COMMITTED[key]])));
// SQL 98's recorded production pre-state (read-only inspect of 2026-10-19, SSM 0c34e957, main b59b4520c).
const SQL98_PRODUCTION_PRE = 'd64218dc145fc7b55632c7d5cfdef3fdbbb02592a79f6ff339c4814fc4ae6dbc';
// SQL 99's recorded production pre-state (read-only inspect of 2026-10-21, SSM 43cb1d1f, main
// 69dbe9b01): the same pre-state staging recorded before its wave 1 apply (run 39080577323).
const SQL99_PRODUCTION_PRE = '4d174e86d8c9f0940a0d38da3e432676143dc34946e8d1619cfc36d8a9a834e9';
const SQL99_STAGING_REFERENCE = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39080577323';
// SQL 99's production apply of 2026-10-21 (main dcd865256), recorded in applied.
const SQL99_APPLIED = Object.freeze({ ssm: 'fa655042-6ae1-41e6-96cc-a5b3ed61f4a8', run: 'bfb0c630-87a6-46f8-819d-4155a7b54640', one_use_id: 'sql99-prod-56ce276e-16ea-49c5-9d44-7746a5a9c673', commit: 'dcd86525690e0732691ab7bf0723dc25167d89e9', approval: 'apply SQL 97, 95 and 99 in production' });
// SQL 98's production apply of 2026-10-19 (#1071), recorded in applied.
const SQL98_APPLIED = Object.freeze({ ssm: '817865e7-2684-4f87-9f56-e57ed5386add', run: 'bef29dcf-c1fa-48d8-8c5f-0511b90e3403', one_use_id: 'sql98-prod-5a067c1d-8c6b-44b5-b646-2f7175d7b66e', commit: 'ce212b5aa296125bfde3fbab7617263a68539b34', approval: 'approve #1071 and apply SQL 98 in production' });
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const COMMIT = 'a'.repeat(40);
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const text = (key) => fs.readFileSync(path.join(ROOT, STAGING[key].filename), 'utf8');

const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));

const authorized = (key, live) => Object.freeze({
  ...COMMITTED[key],
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: live,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
});
function manifest(key, pin) {
  const live = pin.expected_live_definition_sha256;
  const fingerprint = { sql: live };
  const workstream = `prod-${key}-release-test`;
  return {
    workstream_id: workstream,
    branch: 'main',
    commit: COMMIT,
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
    one_use_id: `${key}-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-17T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql98100-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

test('pins: the reconciled SQL 98 / SQL 99 pins keep their recorded hashes and notes; SQL 100 is new; all have the SQL 90-97 shape; SQL 98 and SQL 99 are applied and retired, SQL 100 stays pending', () => {
  // SQL 96's pin is the engine pin shape without its record-only applied / production_evidence sections.
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  for (const key of KEYS) {
    const pin = COMMITTED[key];
    const staging = STAGING[key];
    // A record-and-retire change adds applied and production_evidence on top of the engine pin shape.
    const extra = keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)).sort();
    assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], `${key} lacks the engine pin shape`);
    assert.deepEqual(extra, key === 'sql100' ? ['production_inspect.already_applied', 'production_noop'] : ['tooling.superseded_note'], key);
    assert.equal(pin.id, `${RELEASE_SQL_SPECS[key].production_pin_rel.split('/').pop().replace(/\.json$/, '')}`);
    if (key === 'sql98') {
      // Applied to production 2026-10-19 and retired: the owner approved the pin (#1071) on the
      // read-only production inspect and the staging apply (run 39085677318, from staging's own
      // pre-state) as substitute evidence, then the one apply run recorded in applied.
      assert.equal(pin.execute, false, key);
      assert.match(pin.authorization, /^Applied to production on 2026-10-19; execute is false again/, key);
      assert.doesNotMatch(pin.authorization, /^Owner approved/, key);
      assert.ok(pin.authorization.includes('"accept the SQL 98 staging apply as substitute evidence and do the SQL 98 pin"'), key);
      assert.ok(pin.authorization.includes(`"${SQL98_APPLIED.approval}"`), key);
      assert.ok(pin.authorization.includes('#1071'), key);
      assert.equal(pin.applied.result, 'applied', key);
      assert.equal(pin.applied.apply_ssm_command_id, SQL98_APPLIED.ssm, key);
      assert.equal(pin.applied.one_shot_run_id, SQL98_APPLIED.run, key);
      assert.equal(pin.applied.one_use_id, SQL98_APPLIED.one_use_id, key);
      assert.equal(pin.applied.one_use_id_consumed, true, key);
      assert.equal(pin.applied.source_commit, SQL98_APPLIED.commit, key);
      assert.equal(pin.applied.source_tarball.sha256, '756cf4fa143f9fb7d1384dc7e2c8dd223d70390489bc938ba8dd4a23e629805c', key);
      assert.equal(pin.applied.owner_approval, SQL98_APPLIED.approval, key);
      assert.equal(pin.applied.migration_source_sha256, pin.source_sha256, key);
      assert.equal(pin.applied.manifest_sha256, 'a198b8327451278c2fcf72ebf7bfdebb94754f320d4b6013ea44fdaf754998bf', key);
      assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, SQL98_PRODUCTION_PRE, key);
      assert.equal(pin.applied.receipt.before_hash, SQL98_PRODUCTION_PRE, key);
      assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256, key);
      assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '9b6ffc5c21b307e1859af4069d433ac05d6282309f318b5aa5bffdd846eea318', key);
      assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference, key);
      assert.equal(pin.applied.post_apply_inspect.already_applied, true, key);
      assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256, key);
      assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, [], key);
      assert.equal(pin.applied.later_inspect, undefined, key);
      assert.ok(pin.production_evidence['2026-10-19 apply'].includes(SQL98_APPLIED.ssm), key);
      assert.equal(pin.expected_live_definition_sha256, SQL98_PRODUCTION_PRE, key);
      assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256, key);
      assert.equal(pin.production_inspect.status, 'recorded', key);
      assert.equal(pin.production_inspect.live_definition_sha256, SQL98_PRODUCTION_PRE, key);
      assert.equal(pin.production_inspect.ssm_command_id, '0c34e957-68f5-4ea5-9e2e-dd5639b7a67e', key);
      assert.equal(pin.production_inspect.source_commit, 'b59b4520ce4b2ad47d4da7401b236097f15c0c63', key);
      assert.deepEqual(pin.production_inspect.precondition_failures, [], key);
      assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39085677318'], key);
      assert.match(pin.staging_acceptance.basis, /^Owner-accepted substitute evidence/, key);
      assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${STAGING[key].expected_live_definition_sha256}, after ${pin.intended_replacement_sha256}`), key);
      assert.match(pin.staging_acceptance.basis, /The pre-states differ/, key);
      assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference'], key);
    } else if (key === 'sql99') {
      // Applied to production 2026-10-21 and retired: the owner approved the pin (#1112, "Everything
      // else should be pushed live no exceptions") on the read-only production inspect and the
      // staging wave 1 apply from the same pre-state, then the one apply run recorded in applied.
      assert.equal(pin.execute, false, key);
      assert.match(pin.authorization, /^Applied to production on 2026-10-21; execute is false again/, key);
      assert.doesNotMatch(pin.authorization, /^Owner approved/, key);
      assert.ok(pin.authorization.includes('"Everything else should be pushed live no exceptions"'), key);
      assert.ok(pin.authorization.includes(`"${SQL99_APPLIED.approval}"`), key);
      assert.ok(pin.authorization.includes('#1112'), key);
      assert.equal(pin.applied.result, 'applied', key);
      assert.equal(pin.applied.apply_ssm_command_id, SQL99_APPLIED.ssm, key);
      assert.equal(pin.applied.one_shot_run_id, SQL99_APPLIED.run, key);
      assert.equal(pin.applied.one_use_id, SQL99_APPLIED.one_use_id, key);
      assert.equal(pin.applied.one_use_id_consumed, true, key);
      assert.equal(pin.applied.source_commit, SQL99_APPLIED.commit, key);
      assert.equal(pin.applied.source_tarball.sha256, '2c0c0fac5b042df8657cf553b630c572a1f9bb02f23541f9384b024a1f31487e', key);
      assert.equal(pin.applied.owner_approval, SQL99_APPLIED.approval, key);
      assert.equal(pin.applied.migration_source_sha256, pin.source_sha256, key);
      assert.equal(pin.applied.manifest_sha256, '2ba74dca48ec9f8926a6266757a59c0b16fa920314884722c75249df4dcad437', key);
      assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, SQL99_PRODUCTION_PRE, key);
      assert.equal(pin.applied.receipt.before_hash, SQL99_PRODUCTION_PRE, key);
      assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256, key);
      assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '8a56ccd66383f7551f612d70f220982c1e1297c29eeaad2446b57e6c29072df6', key);
      assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference, key);
      assert.equal(pin.applied.post_apply_inspect.already_applied, true, key);
      assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256, key);
      assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, [], key);
      assert.equal(pin.applied.later_inspect, undefined, key);
      assert.ok(pin.production_evidence['2026-10-21 apply'].includes(SQL99_APPLIED.ssm), key);
      assert.equal(pin.expected_live_definition_sha256, SQL99_PRODUCTION_PRE, key);
      assert.equal(pin.expected_live_definition_sha256, STAGING[key].expected_live_definition_sha256, key);
      assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256, key);
      assert.equal(pin.production_inspect.status, 'recorded', key);
      assert.equal(pin.production_inspect.date, '2026-10-21', key);
      assert.equal(pin.production_inspect.live_definition_sha256, SQL99_PRODUCTION_PRE, key);
      assert.equal(pin.production_inspect.ssm_command_id, '43cb1d1f-f589-43b2-9315-7cad80fffb5c', key);
      assert.equal(pin.production_inspect.source_commit, '69dbe9b01cbcd8f04847cab248e243105c85f022', key);
      assert.equal(pin.production_inspect.read_only, true, key);
      assert.deepEqual(pin.production_inspect.precondition_failures, [], key);
      assert.ok(pin.production_inspect.note.includes('1424a8c418324c7c520b385c96dbdca79b869478a076a7802ec7ae2a560ff4b4'), key);
      assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, SQL99_STAGING_REFERENCE], key);
      assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${SQL99_PRODUCTION_PRE}, after ${pin.intended_replacement_sha256}`), key);
      assert.match(pin.staging_acceptance.basis, /read-live \(run 39076376639\)/, key);
      assert.match(pin.staging_acceptance.basis, /run 39619293510/, key);
      assert.match(pin.staging_acceptance.basis, /Same pre-state/, key);
      assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference'], key);
    } else {
      assert.equal(pin.execute, false, key);
      assert.equal(pin.authorization, 'pending', key);
      assert.equal(pin.expected_live_definition_sha256, null, key);
      assert.equal(pin.staging_acceptance.ok, false, key);
      assert.equal(pin.production_inspect.status, 'pending', key);
    }
    assert.equal(pin.source_sha256, staging.source_sha256, key);
    assert.equal(pin.staging_pin_commit, staging.commit, key);
    assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256, key);
    assert.deepEqual(pin.function_identities, [...staging.function_identities], key);
    assert.equal(pin.tooling.status, 'built', key);
    assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[key].cli, key);
    assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[key].choice, key);
    assert.equal(pin.tooling.one_shot_migration, key, key);
    for (const file of [pin.tooling.production_tool, pin.tooling.runbook, pin.tooling.fingerprint_engine, pin.tooling.production_lib, ...pin.tooling.tests]) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${key} ${file}`);
    }
    assert.equal(readPinnedReleaseSql(key, ROOT, pin).ok, true, key);
    assert.equal(ONE_SHOT_TOOLS[key].script, RELEASE_PRODUCTION[key].cli, key);
  }
  // The recorded hashes of the earlier pending pins (ops/fee-collection-deltas.md section 3).
  assert.equal(COMMITTED.sql98.source_sha256, '5a42e485c84f7c9976390d12c275cdf32612fbba7656b66f553110c0ae697c2a');
  assert.equal(COMMITTED.sql98.staging_pin_commit, '567772a9034cae4ec4d7c56b07c983fb4e797103');
  assert.equal(COMMITTED.sql99.source_sha256, '0c079fe41c932f34f33262ba00a17f3201f99960c89a944750f5312bd97f8b15');
  assert.equal(COMMITTED.sql99.staging_pin_commit, '600311866039adb0a85217be84d7dfb09f9eeec2');
  // ... and their notes (kept, with an update appended; the old tooling note kept as superseded_note).
  assert.match(COMMITTED.sql98.order_note, /^After SQL 96 \(SQL 98 refuses with 55000 sql98_prerequisite_missing/);
  // SQL 98's inspect note is now the recorded production inspect; the earlier pending note is kept after it.
  assert.match(COMMITTED.sql98.production_inspect.note, /^Recorded from the read-only production inspect of 2026-10-19/);
  assert.match(COMMITTED.sql98.production_inspect.note, / Earlier: Pending: no read-only production inspect has been run for SQL 98\. It must record/);
  assert.match(COMMITTED.sql98.tooling.superseded_note, /^Pending: no guarded tooling exists for SQL 98 yet/);
  assert.match(COMMITTED.sql98.intended_post_state.note, /^check_processing events stamped once per check/);
  assert.match(COMMITTED.sql99.order_note, /^After SQL 90 \(required: the file refuses with sql99_prerequisite_missing/);
  // SQL 99's inspect note is now the recorded production inspect; the earlier pending note is kept after it.
  assert.match(COMMITTED.sql99.production_inspect.note, /^Recorded from the read-only production inspect of 2026-10-21/);
  assert.match(COMMITTED.sql99.production_inspect.note, / Earlier: Pending: no read-only production inspect has been run for SQL 99/);
  assert.match(COMMITTED.sql99.tooling.superseded_note, /^Pending: no guarded tooling exists for SQL 99 yet/);
  assert.deepEqual(COMMITTED.sql98.predecessors, ['sql96']);
  assert.deepEqual(COMMITTED.sql99.predecessors, ['sql90']);
  assert.deepEqual(COMMITTED.sql100.predecessors, ['sql90']);
  assert.equal(COMMITTED.sql100.production_noop, true);
  for (const key of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(COMMITTED.sql100[key], COMMITTED.sql99[key], key);
});

test('SQL 98\'s committed (retired) pin refuses; its execute-authorized copy (before the record-and-retire change) allows only its own manifest; the spent one_use_id is refused as a replay', async () => {
  const retired = COMMITTED.sql98;
  const unlocked = Object.freeze({ ...retired, authorization: 'Owner approved 2026-10-19 (test copy of the execute-authorized pin before its record-and-retire change)', execute: true });
  const bound = manifest('sql98', unlocked);
  const allowed = await evaluateReleaseProductionApply('sql98', bound, { root: ROOT, pin: unlocked });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  // The committed pin, read from disk, is no longer an owner approval.
  const refused = await evaluateReleaseProductionApply('sql98', bound, { root: ROOT });
  assert.equal(refused.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const spentPath = consumedPath();
  fs.writeFileSync(spentPath, JSON.stringify({ consumed: [SQL98_APPLIED.one_use_id] }));
  try {
    const replay = await precheckReleaseProductionApply('sql98', { ...bound, one_use_id: SQL98_APPLIED.one_use_id }, { root: ROOT, pin: unlocked, consumedPath: spentPath });
    assert.equal(replay.code, CODES.RECEIPT_REUSED);
  } finally {
    fs.rmSync(spentPath, { force: true });
  }
});

test('SQL 99\'s committed (retired) pin refuses; its execute-authorized copy (before the record-and-retire change) allows only the manifest bound to it, the cheap prechecks pass without connecting, and the spent one_use_id is refused as a replay', async () => {
  const retired = COMMITTED.sql99;
  const pin = Object.freeze({ ...retired, authorization: 'Owner approved 2026-10-21 (test copy of the execute-authorized pin before its record-and-retire change)', execute: true });
  const neverConnect = async () => { throw new Error('should-not-connect'); };
  const bound = manifest('sql99', pin);
  // The committed pin, read from disk, is no longer an owner approval.
  const refused = await evaluateReleaseProductionApply('sql99', bound, { root: ROOT });
  assert.equal(refused.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const allowed = await evaluateReleaseProductionApply('sql99', bound, { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details[RELEASE_PRODUCTION.sql99.allowed_key], true);
  const prechecked = await precheckReleaseProductionApply('sql99', bound, { root: ROOT, pin, consumedPath: consumedPath() });
  assert.equal(prechecked.ok, true, JSON.stringify(prechecked));
  const wrongLive = await evaluateReleaseProductionApply('sql99', { ...bound, live_definition_sha256: 'f'.repeat(64) }, { root: ROOT, pin });
  assert.equal(wrongLive.code, CODES.SQL_COLLISION);
  const wrongStaging = await evaluateReleaseProductionApply('sql99', { ...bound, staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } }, { root: ROOT, pin });
  assert.equal(wrongStaging.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const executeFalse = await executeReleaseProductionApply('sql99', bound, { root: ROOT, pin: { ...pin, execute: false }, consumedPath: consumedPath(), connect: neverConnect });
  assert.equal(executeFalse.code, CODES.GUARD_APPLY_FORBIDDEN);
  const wrongPhrase = await executeReleaseProductionApply('sql99', { ...bound, authorization_phrase: 'APPLY' }, { root: ROOT, pin, consumedPath: consumedPath(), connect: neverConnect });
  assert.equal(wrongPhrase.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const spentPath = consumedPath();
  fs.writeFileSync(spentPath, JSON.stringify({ consumed: [SQL99_APPLIED.one_use_id] }));
  try {
    const replay = await precheckReleaseProductionApply('sql99', { ...bound, one_use_id: SQL99_APPLIED.one_use_id }, { root: ROOT, pin, consumedPath: spentPath });
    assert.equal(replay.code, CODES.RECEIPT_REUSED);
  } finally {
    fs.rmSync(spentPath, { force: true });
  }
});

test('the production tool applies the production fee-destination rule: a sandbox-only row (staging\'s shape) is refused, the reviewed row is not', () => {
  const RULE = 'platform_billing_destination_absent_empty_or_reviewed';
  const login = { current_user: 'checksops_admin', session_user: 'checksops_admin' };
  const at = (counts) => releaseProductionPreconditionFailures('sql98', {
    ...login, live_definition_sha256: 'e'.repeat(64), tables: { 'public.platform_billing_destination': { exists: true } }, counts,
  }, COMMITTED.sql98, text('sql98')).includes(RULE);
  assert.equal(at({
    platform_billing_destination_rows: 1, platform_billing_destination_sandbox_rows: 1, platform_billing_destination_production_rows: 0,
    platform_billing_destination_production_reviewed_account_rows: 0, platform_billing_destination_payment_method_rows: 1,
    platform_billing_destination_verified_rows: 1,
  }), true);
  assert.equal(at({
    platform_billing_destination_rows: 1, platform_billing_destination_sandbox_rows: 0, platform_billing_destination_production_rows: 1,
    platform_billing_destination_production_reviewed_account_rows: 1, platform_billing_destination_payment_method_rows: 1,
    platform_billing_destination_verified_rows: 1,
  }), false);
});

test('SQL 100 is production_noop: production refuses unless the live state is already the intended one; other keys have no such rule', () => {
  const login = { current_user: 'checksops_admin', session_user: 'checksops_admin' };
  const intended = COMMITTED.sql100.intended_replacement_sha256;
  assert.ok(releaseProductionPreconditionFailures('sql100', { ...login, live_definition_sha256: 'e'.repeat(64) }, COMMITTED.sql100, text('sql100'))
    .includes('production_state_already_intended'));
  assert.ok(!releaseProductionPreconditionFailures('sql100', { ...login, live_definition_sha256: intended }, COMMITTED.sql100, text('sql100'))
    .includes('production_state_already_intended'));
  for (const key of ['sql98', 'sql99', 'sql90', 'sql96']) {
    assert.ok(!releaseProductionPreconditionFailures(key, { ...login, live_definition_sha256: 'e'.repeat(64) }, loadReleaseProductionPin(key, ROOT), text(key))
      .includes('production_state_already_intended'), key);
  }
});

async function withPg(t, prefix, port, fn) {
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
  const fx = await releaseFixture(pg, prefix, port, { extra: sql98To100Schema() });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: read-only inspects; SQL 98 and SQL 99 apply once as checksops_admin; SQL 100\'s tool never runs the file on production', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql98100-prod-', 59300, async ({ admin, connectAs, applyPredecessors }) => {
  await applyPredecessors();
  const owner = await connectAs('checksops_admin');
  try {
    for (const key of BEFORE) await owner.query(text(key));
  } finally {
    await owner.end();
  }
  const seen = [];
  const connectWith = (user) => async () => {
    const client = await connectAs(user);
    const query = client.query.bind(client);
    client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
    return client;
  };
  const connect = connectWith('checksops_admin');
  const inspect = async (key, pin = PENDING[key]) => {
    seen.length = 0;
    const inspected = await inspectReleaseProduction(key, { connect, pin, root: ROOT });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    assert.equal(seen[0], 'BEGIN READ ONLY', key);
    assert.equal(seen.at(-1), 'ROLLBACK', key);
    assert.ok(seen.slice(1, -1).every((sql) => READ_ONLY_STATEMENT_RE.test(sql)), JSON.stringify(seen.filter((sql) => !READ_ONLY_STATEMENT_RE.test(sql))));
    assert.doesNotMatch(JSON.stringify(inspected.details), /Private|example\.invalid|checksopsadmin@|11111111-1111/, key);
    return inspected.details;
  };

  for (const key of ['sql98', 'sql99']) {
    const d = await inspect(key);
    assert.equal(d.read_only, true);
    assert.equal(d.pin_execute, false);
    assert.deepEqual(d.precondition_failures, [], `${key}: ${JSON.stringify(d.release_sql_inspect)}`);
    assert.equal(d.apply_preconditions_met, false, 'no recorded pre-state');
    assert.equal(d.production_noop, undefined, key);
    if (key === 'sql98') {
      assert.deepEqual(d.counts, { duplicate_billing_periods: 0, check_billing_event_duplicates: 0, check_billing_config_rows: 0, check_billing_config_active_rows: 0, platform_billing_destination_rows: null, platform_billing_destination_production_rows: null, platform_billing_destination_sandbox_rows: null, platform_billing_destination_reviewed_account_rows: null, platform_billing_destination_production_reviewed_account_rows: null, platform_billing_destination_payment_method_rows: null, platform_billing_destination_verified_rows: null });
    }
    const pin = authorized(key, d.live_definition_sha256);
    const asSuper = await executeReleaseProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect: connectWith('ubuntu'), consumedPath: consumedPath() });
    assert.equal(asSuper.code, CODES.DEPLOYMENT_COLLISION, key);
    assert.ok(asSuper.details.failed.includes('login_is_pinned_admin'));
    const applied = await executeReleaseProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.after_hash, pin.intended_replacement_sha256);
    assert.equal((await inspect(key, pin)).already_applied, true, key);
    const replay = await executeReleaseProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(replay.code, CODES.UNRELATED_MUTATION, key);
  }

  // SQL 100 against a database that is not production's state (12 / 24 / SQL 50): refused, nothing runs.
  const file100 = text('sql100');
  let d = await inspect('sql100');
  assert.deepEqual(d.production_noop, { required: true, live_is_intended: false });
  assert.deepEqual(d.precondition_failures, ['production_state_already_intended']);
  assert.equal(d.already_applied, false);
  assert.equal(d.apply_preconditions_met, false);
  const notProduction = d.live_definition_sha256;
  seen.length = 0;
  let pin = authorized('sql100', notProduction);
  const refused = await executeReleaseProductionApply('sql100', manifest('sql100', pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(refused.code, CODES.DEPLOYMENT_COLLISION, JSON.stringify(refused));
  assert.deepEqual(refused.details.failed, ['production_state_already_intended']);
  assert.ok(!seen.includes(file100), 'the SQL 100 file is never sent');
  assert.equal((await inspect('sql100')).live_definition_sha256, notProduction);

  // Production already has SQL 100's state (here: the file run outside the tool, as checksops_admin).
  const prod = await connectAs('checksops_admin');
  try {
    await prod.query(file100);
  } finally {
    await prod.end();
  }
  d = await inspect('sql100');
  assert.equal(d.already_applied, true);
  assert.deepEqual(d.production_noop, { required: true, live_is_intended: true });
  assert.deepEqual(d.precondition_failures, []);
  assert.equal(d.apply_preconditions_met, false);
  assert.equal(d.live_definition_sha256, COMMITTED.sql100.intended_replacement_sha256);
  // Even an authorized apply is refused as already in place, without sending the file.
  seen.length = 0;
  pin = authorized('sql100', notProduction);
  const inPlace = await executeReleaseProductionApply('sql100', manifest('sql100', pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(inPlace.code, CODES.UNRELATED_MUTATION, JSON.stringify(inPlace));
  assert.match(inPlace.message, /already in place/);
  assert.ok(!seen.includes(file100), 'the SQL 100 file is never sent');

  // Another grantor, a policy comment or a widened helper EXECUTE: production is no longer SQL 100's state.
  for (const setup of [
    ['GRANT UPDATE (status) ON public.mortgage_handling_requests TO checksops WITH GRANT OPTION', 'SET ROLE checksops',
      'GRANT UPDATE (note) ON public.mortgage_handling_requests TO authenticated', 'RESET ROLE'],
    ["COMMENT ON POLICY aws_select_mortgage_ops_agent_queue ON public.mortgage_handling_requests IS 'x'"],
    ['GRANT EXECUTE ON FUNCTION public.aws_is_mortgage_ops_agent() TO PUBLIC'],
    ['REVOKE EXECUTE ON FUNCTION public.aws_mortgage_agent_queue_visible(text, uuid) FROM checksops'],
    ["COMMENT ON POLICY aws_update_mortgage_ops_accept_complete ON public.mortgage_handling_requests IS 'edited'"],
  ]) {
    await admin.query('BEGIN');
    try {
      for (const sql of setup) await admin.query(sql);
      await admin.query("SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)");
      const state = (await readReleaseSqlState(admin, 'sql100')).details;
      assert.notEqual(state.live_definition_sha256, COMMITTED.sql100.intended_replacement_sha256, setup.join('; '));
      assert.ok(releaseProductionPreconditionFailures('sql100', state, COMMITTED.sql100, file100).includes('production_state_already_intended'), setup.join('; '));
    } finally {
      await admin.query('ROLLBACK');
    }
  }
  assert.equal((await inspect('sql100')).already_applied, true);
}));
