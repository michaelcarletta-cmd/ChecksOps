/**
 * Production tool for SQL 132 (scripts/deployment-guard/sql132-financial-totp-code-check-lockout-
 * production-apply.mjs on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 132 included) through the
 * shared refusals; this file covers SQL 132's own:
 *
 *   - the pin has the release pin shape plus the applied record; it was execute-authorized (owner-
 *     approved pin change of 2026-10-30, #1467) with the recorded production pre-state (derived from
 *     the spec in release-sql132-executor.test.mjs; the same one staging had) and the staging apply as
 *     its acceptance, then applied on 2026-10-30 and retired (execute false); it is in step with the
 *     staging pin, the one-shot, the bypass inventory and the test lists;
 *   - predecessor SQL 130 (applied and retired, untouched here); the one new function (EXECUTE for
 *     checksops and the owner, PUBLIC revoked), the prerequisites (the enrollment table and its
 *     columns, mark_verified, auth.uid(), role checksops), the definer write; no table, view, policy,
 *     trigger or drop, and no grant but the REVOKE from PUBLIC and the GRANT to checksops on this one
 *     function; the overlay plan records it verified live (this record change) so the two API members
 *     that call it can take the guarded Lambda path; the API calls the function the same way in both
 *     members and checks for it first; the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; an execute-authorized copy of the
 *     committed (retired) pin allows only the manifest bound to its recorded pre-state, and the retired
 *     pin itself refuses before connecting; an approved, accepted copy evaluates for the
 *     manifest built from it, and refuses with execute false, another live hash, another staging
 *     reference or a wrong phrase; the CLI spends no receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql132-financial-totp-lockout-pg.test.mjs; the
 * executor path is aws/tests/release-sql132-executor.test.mjs.
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
import { RELEASE_SQL_SPECS, releaseIntendedHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import {
  RELEASE_PRODUCTION,
  evaluateReleaseProductionApply,
  executeReleaseProductionApply,
  loadReleaseProductionPin,
  precheckReleaseProductionApply,
  readPinnedReleaseSql,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { main } from '../../scripts/deployment-guard/sql132-financial-totp-code-check-lockout-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql132';
const SQL132_FILE = 'aws/workflows/sql/132_financial_totp_code_check_lockout.sql';
const IDENTITY = 'public.financial_totp_count_code_check(uuid)';
const TABLE = 'public.financial_totp_enrollments';
const SQL132_IDENTITIES = Object.freeze([IDENTITY]);
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 132's recorded production pre-state (read-only inspect of 2026-10-30, SSM ea2ce576, main 42068df3f):
// the function absent, everything else in place; staging recorded the same pre-state (read-live run 41113777003).
const PRODUCTION_PRE = 'e1a1d4edb115e3fa0881112e6759c2d7ee1e9d8c6b3e24a7611b655dcf75741f';
// The guarded staging apply (wave 29).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/41117004966';
const OWNER_WORDS = Object.freeze(['"restart SQL 131 and the lockout fix"', '"Merge SQL 131 and the lockout fix when green"', '"continue with SQL 132 staging"', '"merge 1461 when green"', '"apply SQL 132 in staging"']);
// SQL 132's production apply of 2026-10-30 (main d5780e105), recorded in applied; the owner's words were
// passed to the run verbatim.
const SQL132_APPLIED = Object.freeze({ ssm: 'e3234a9c-ad40-4a13-9078-58a5b1872a35', run: 'aba09b96-f0fc-48c9-94dd-175f45ad638d', one_use_id: 'sql132-prod-47a4dc32-bbc2-428b-91a1-5418e1bd90f0', commit: 'd5780e105f57924b1e12c86a5516f8738389b092', workstream: 'prod-sql132-financial-totp-code-check-lockout-20261030', approval: 'apply SQL 132 in production' });
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql132-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-10-30T00:00:00.000Z',
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

test('pin: the release pin shape, applied and retired (owner approved 2026-10-30, on the staging apply), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Applied 2026-10-30 and retired. The pin change (#1467) recorded the read-only production inspect (SSM
  // ea2ce576, main 42068df3f) as the pre-state and the staging apply (run 41117004966) as the acceptance; its
  // words named the restart, the merges and the staging step, and the apply run had the owner's own words for it.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-10-30; execute is false again/);
  assert.doesNotMatch(pin.authorization, /^Owner approved/);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /none of them words for the production apply/);
  assert.ok(pin.authorization.includes('#1467'));
  assert.ok(pin.authorization.includes('"Merge 1467 and 1466"'));
  assert.ok(pin.authorization.includes(SQL132_APPLIED.workstream));
  assert.ok(pin.authorization.includes(`"${SQL132_APPLIED.approval}"`));
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied.date, '2026-10-30');
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.applied.apply_ssm_command_id, SQL132_APPLIED.ssm);
  assert.equal(pin.applied.one_shot_run_id, SQL132_APPLIED.run);
  assert.equal(pin.applied.one_use_id, SQL132_APPLIED.one_use_id);
  assert.equal(pin.applied.one_use_id_consumed, true);
  assert.equal(pin.applied.workstream_id, SQL132_APPLIED.workstream);
  assert.equal(pin.applied.source_commit, SQL132_APPLIED.commit);
  assert.equal(pin.applied.source_tarball.sha256, '20a490847015c223a0f31f8bb1901e986df83ace99ffd5bd5b458d7e75024d43');
  assert.equal(pin.applied.migration_source_sha256, pin.source_sha256);
  assert.equal(pin.applied.owner_approval, SQL132_APPLIED.approval);
  assert.equal(pin.applied.operator, 'michaelcarletta-cmd');
  assert.equal(pin.applied.runner, 'i-0c35557c4e5385406');
  assert.deepEqual(pin.applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  // The read-only --phase inspect before the apply, the separate --inspect after it, and the transfer run.
  assert.match(pin.applied.one_shot_note, /ba2f3350-034b-41e8-a9af-149ac804a211/);
  assert.match(pin.applied.one_shot_note, /65e549f8-14ae-4b25-b4ba-352c3d4775c2/);
  assert.match(pin.applied.one_shot_note, /2884bd09-63cc-4996-b095-2e3f32c9e4f5/);
  assert.match(pin.applied.one_shot_note, /transfer run 41121202177/);
  // The run's JSON arrived whole, so applied is the one-shot's own object (no reconstruction).
  assert.match(pin.applied.one_shot_note, /The run's whole JSON arrived/);
  assert.doesNotMatch(pin.applied.one_shot_note, /did not arrive whole/);
  assert.equal(pin.applied.manifest_sha256, 'af74d38109c4c70845bf66372c3a15746233799ee4c29b88ae4a42c06b1d9eb6');
  assert.deepEqual(Object.values(pin.applied.contract_results).map((c) => c.evidence.split(' ')[0]), ['4/4', '6/6', '43/43']);
  for (const c of Object.values(pin.applied.contract_results)) assert.ok(c.evidence.includes(SQL132_APPLIED.run), c.test);
  assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.applied.pre_apply_inspect.live_matches_expected, true);
  assert.equal(pin.applied.pre_apply_inspect.already_applied, false);
  assert.deepEqual(pin.applied.pre_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.pre_apply_inspect.predecessors, { sql130: true });
  assert.deepEqual(pin.applied.pre_apply_inspect.release_sql_inspect.functions, [{ name: 'financial_totp_count_code_check(uuid)', state: 'absent' }]);
  assert.deepEqual(pin.applied.pre_apply_inspect.release_sql_inspect.function_acl, [{ name: 'financial_totp_count_code_check(uuid)', acl: [] }]);
  assert.deepEqual(pin.applied.pre_apply_inspect.release_sql_inspect.definer_writes, [{ name: 'financial_totp_enrollments', ok: true }]);
  assert.equal(pin.applied.receipt.before_hash, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.applied.receipt.workstream, SQL132_APPLIED.workstream);
  assert.equal(pin.applied.receipt.commit, SQL132_APPLIED.commit);
  assert.equal(pin.applied.receipt.sql_file, SQL132_FILE);
  assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '25c9872f0c8c4d928d507776053016d5fdc038d0d4ac2584a50d85e774c11e47');
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.functions, 1354);
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.triggers, 184);
  assert.equal(pin.applied.receipt.result, 'applied');
  assert.equal(pin.applied.post_apply_inspect.already_applied, true);
  assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.post_apply_inspect.predecessors, { sql130: true });
  assert.deepEqual(pin.applied.post_apply_inspect.release_sql_inspect.functions, [{ name: 'financial_totp_count_code_check(uuid)', state: 'intended' }]);
  assert.deepEqual(pin.applied.post_apply_inspect.release_sql_inspect.function_acl, [{ name: 'financial_totp_count_code_check(uuid)', acl: ['checksops EXECUTE', 'owner EXECUTE'] }]);
  assert.deepEqual(pin.applied.post_apply_inspect.release_sql_inspect.definer_writes, [{ name: 'financial_totp_enrollments', ok: true }]);
  assert.deepEqual(pin.applied.post_apply_inspect.release_sql_inspect.triggers, []);
  assert.equal(pin.applied.post_apply_inspect.release_sql_inspect.dropped_function_dependents, 0);
  assert.deepEqual(pin.applied.receipt.release_sql_inspect, pin.applied.post_apply_inspect.release_sql_inspect);
  for (const evidence of [SQL132_APPLIED.ssm, SQL132_APPLIED.run, SQL132_APPLIED.one_use_id, 'ba2f3350-034b-41e8-a9af-149ac804a211', '2884bd09-63cc-4996-b095-2e3f32c9e4f5', `"${SQL132_APPLIED.approval}"`]) {
    assert.ok(pin.production_evidence['2026-10-30 apply'].includes(evidence), evidence);
  }
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-10-30');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, 'ea2ce576-471a-4a90-bb50-e52b3430e6ec');
  assert.equal(pin.production_inspect.source_commit, '42068df3f516653ebb96cffbf4d522f0117db4ac');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('4000d070b6f33d354b8a102fc08319ddcc624e8acf73ab07f9ce1c54247b6e33'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /financial_totp_count_code_check\(uuid\) absent, function_acl \[\]; definer_writes financial_totp_enrollments ok true/);
  assert.match(pin.production_inspect.note, /predecessors \{sql130: true\}, predecessors_applied true/);
  assert.match(pin.production_inspect.note, /dropped_function_dependents 0, dropped_function_callers \[\]/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: '));
  assert.match(pin.production_inspect.note, /SSM cfee4512-4988-4fd1-be77-b03d1b4cd50b/);
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql132-financial-totp-code-check-lockout, run 41117004966/);
  assert.match(pin.staging_acceptance.basis, /deploy run 41116686272/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 41117375887 then reported already_applied true/);
  assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin recorded the same pre-state (wave 29): the function absent in both environments.
  assert.equal(staging.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.equal(pin.filename, SQL132_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL132_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, SQL132_IDENTITIES);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, ['sql130']);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_FINANCIAL_TOTP_LOCKOUT');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql132-financial-totp-code-check-lockout-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-132-apply.md');
  for (const file of [pin.tooling.production_tool, pin.tooling.runbook, pin.tooling.fingerprint_engine, pin.tooling.production_lib, ...pin.tooling.tests]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  assert.equal(readPinnedReleaseSql(KEY, ROOT, pin).ok, true);
  // One-shot: the release tool with its order (no hash in the registry).
  const tool = ONE_SHOT_TOOLS[KEY];
  assert.equal(tool.key, KEY);
  assert.equal(tool.script, RELEASE_PRODUCTION[KEY].cli);
  assert.deepEqual([...tool.args], []);
  assert.equal(tool.pin_rel, RELEASE_PRODUCTION[KEY].pin_rel);
  assert.equal(tool.allowed_key, 'sql132_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql132-financial-totp-code-check-lockout-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql132-production-apply"\]/);
  assert.match(rows, /sql128, sql129, sql130, sql131, sql132, sql133, sql134, sql135\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql132-executor.test.mjs', 'aws/tests/release-sql132-production-apply.test.mjs', 'aws/tests/sql132-financial-totp-lockout-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: predecessor SQL 130 (untouched); the one new function, its prerequisites and definer write; REVOKE from PUBLIC and GRANT to checksops, nothing else; the plan records it verified live; the API calls it the same way in both members and checks for it first; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, ['sql130']);
  assert.equal(spec.supersedes, undefined);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), SQL132_IDENTITIES);
  for (const fn of spec.functions) {
    assert.deepEqual(fn.acl, ['checksops EXECUTE', 'owner EXECUTE'], fn.identity);
    assert.deepEqual(fn.revokes, ['PUBLIC EXECUTE'], fn.identity);
    assert.equal(fn.result, 'TABLE(allowed boolean, failed_attempts integer, retry_after_seconds integer)');
  }
  assert.equal(spec.dropped_functions, undefined);
  assert.equal(spec.acl_functions, undefined);
  assert.deepEqual(spec.prerequisites.slice(0, 4), [TABLE, 'public.financial_totp_mark_verified(uuid, bigint)', 'auth.uid()', 'role checksops']);
  for (const column of ['application_user_id', 'failed_attempts', 'locked_until']) {
    assert.ok(spec.prerequisites.includes(`column ${TABLE}.${column}`), column);
  }
  assert.deepEqual(spec.definer_writes, [TABLE]);
  for (const absent of ['tables', 'views', 'policies', 'triggers', 'altered_relations']) assert.equal(spec[absent], undefined, absent);
  assert.match(COMMITTED.order_note, /^Predecessor SQL 130 \(applied to staging and production on 2026-10-30\)/);
  assert.match(COMMITTED.order_note, /definer_can_write_relations/);
  assert.match(COMMITTED.order_note, /tolerates its absence \(no count, no lockout, never a 500\)/);
  assert.match(COMMITTED.order_note, /no API, Lambda or SPA change is part of this pin\./);
  // SQL 130's production pin is as applied and retired; this change does not touch it.
  const sql130 = loadReleaseProductionPin('sql130', ROOT);
  assert.equal(sql130.execute, false);
  assert.equal(sql130.applied.result, 'applied');
  // The API members that call the function pend their REPLACE on this pin: auth-financial-totp.mjs has
  // sql_before SQL 132, which this record change marks verified live in the overlay plan (from the applied
  // record above), so the guarded Lambda path can accept it after its own read-only inspect;
  // checkalt-register.mjs keeps SQL 81, its recorded dependency. Neither member is deployed here.
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  const prerequisite = plan.sql_prerequisites[SQL132_FILE];
  assert.equal(prerequisite.verified_live, true);
  assert.equal(prerequisite.pin, RELEASE_SQL_SPECS[KEY].production_pin_rel);
  for (const evidence of [SQL132_APPLIED.ssm, SQL132_APPLIED.run, SQL132_APPLIED.workstream, SQL132_APPLIED.one_use_id, `${PRODUCTION_PRE.slice(0, 8)}… -> ${COMMITTED.intended_replacement_sha256.slice(0, 8)}…`, 'staging acceptance run 41117004966', '2884bd09-63cc-4996-b095-2e3f32c9e4f5']) {
    assert.ok(prerequisite.evidence.includes(evidence), evidence);
  }
  const stagingLive = readJson('ops/deployment-guard/staging-sql-live.json').sql[SQL132_FILE];
  assert.equal(stagingLive.verified_live, true);
  for (const evidence of ['run 41117004966', 'read-live run 41117375887', `receipt before ${PRODUCTION_PRE.slice(0, 8)}…`, `after ${COMMITTED.intended_replacement_sha256.slice(0, 8)}…`]) {
    assert.ok(stagingLive.evidence.includes(evidence), evidence);
  }
  assert.equal(plan.members['auth-financial-totp.mjs'].sql_before, SQL132_FILE);
  assert.equal(plan.members['providers/production/checkalt-register.mjs'].sql_before, 'aws/workflows/sql/81_checkalt_production_register.sql');
  // The lockout REPLACEs ran after SQL 132 was recorded live: an applied member's row expects its accepted bytes
  // and names the applied record (production-financial-totp-lockout-applied-manifest-2026-10-31.json).
  const LOCKOUT_APPLIED = 'aws/tests/fixtures/production-financial-totp-lockout-applied-manifest-2026-10-31.json';
  const lockoutApplied = readJson(LOCKOUT_APPLIED).members;
  assert.ok(lockoutApplied['providers/production/checkalt-register.mjs'], 'checkalt-register.mjs is recorded applied (production run 41156679208)');
  for (const member of ['auth-financial-totp.mjs', 'providers/production/checkalt-register.mjs']) {
    if (member === 'auth-financial-totp.mjs') {
      // Moved on to the finding 8 REPLACE (first enrollment needs an email code), which starts from the applied
      // lockout bytes: the row expects those bytes live and names its own planning manifest.
      assert.equal(plan.members[member].expected_live_sha256, lockoutApplied[member].accepted_sha256, `${member} expects the applied lockout bytes live`);
      assert.equal(plan.members[member].manifest, 'aws/tests/fixtures/production-financial-totp-enroll-email-code-manifest-2026-10-31.json', member);
    } else if (lockoutApplied[member]) {
      assert.equal(plan.members[member].expected_live_sha256, plan.members[member].accepted_sha256, `${member} records the applied lockout bytes`);
      assert.equal(plan.members[member].manifest, LOCKOUT_APPLIED, member);
    } else {
      assert.notEqual(plan.members[member].expected_live_sha256, plan.members[member].accepted_sha256, `${member} pends the lockout REPLACE`);
    }
  }
  // The API: the same count call and the same existence check in both members, as checksops.
  const call = 'SELECT allowed, failed_attempts, retry_after_seconds FROM public.financial_totp_count_code_check($1::uuid)';
  const presentCall = 'SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present';
  const totp = fs.readFileSync(path.join(ROOT, 'aws/functions/api/auth-financial-totp.mjs'), 'utf8');
  const checkalt = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production/checkalt-register.mjs'), 'utf8');
  for (const api of [totp, checkalt]) {
    assert.ok(api.includes(call));
    assert.ok(api.includes(presentCall));
    assert.ok(api.includes(`'${IDENTITY}'`));
  }
  assert.match(totp, /export const countCodeCheck = async \(client, userId\) => \{/);
  assert.doesNotMatch(totp, /error: 'rate_limited', \.\.\.financialGate\(\) \}/, 'a locked enrollment no longer answers differently from a wrong code');
  // One DO block, one CREATE OR REPLACE FUNCTION, the REVOKE from PUBLIC and the GRANT to checksops on it; nothing else.
  const text = fs.readFileSync(path.join(ROOT, SQL132_FILE), 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(text, /\bCREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|VIEW|TABLE|POLICY)\b/i);
  assert.doesNotMatch(text, /\b(DROP|ALTER)\b/);
  assert.equal([...text.matchAll(/\bCREATE\s+OR\s+REPLACE\s+FUNCTION\b/gi)].length, 1);
  assert.equal([...text.matchAll(/\bDO\s+\$/g)].length, 1);
  assert.deepEqual([...text.matchAll(/^\s*(GRANT|REVOKE)\b.*$/gim)].map((m) => m[0].trim()), [
    `REVOKE ALL ON FUNCTION ${IDENTITY} FROM PUBLIC;`,
    `GRANT EXECUTE ON FUNCTION ${IDENTITY} TO checksops;`,
  ]);
  assert.doesNotMatch(text, /financial_totp_(upsert_enrollment|get_enrollment|status)\b/);
  assert.doesNotMatch(text, /consume_financial_totp_rate_limit/);
  assert.match(text, /WHEN e\.failed_attempts \+ 1 >= 10 THEN v_now \+ interval '15 minutes'/);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 29\) and to production \(2026-10-30\); the production pin is retired/);
  assert.match(runbook, /\*\*Production apply \(2026-10-30\)\.\*\*/);
  for (const evidence of [SQL132_APPLIED.ssm, SQL132_APPLIED.run, SQL132_APPLIED.workstream, 'ba2f3350-034b-41e8-a9af-149ac804a211', '2884bd09-63cc-4996-b095-2e3f32c9e4f5', '41121202177', `"${SQL132_APPLIED.approval}"`]) {
    assert.ok(runbook.includes(evidence), evidence);
  }
  assert.match(runbook, /SSM\s+`ea2ce576-471a-4a90-bb50-e52b3430e6ec`/);
  assert.match(runbook, /Staging apply \(2026-10-30\)\.\*\* Run 41117004966/);
  assert.match(runbook, /read-live \(2026-10-30\)\.\*\* Run 41113777003/);
  assert.match(runbook, /\*\*Predecessor\.\*\* SQL 130/);
  assert.match(runbook, /"restart SQL 131 and the\s+lockout fix"/);
  assert.match(runbook, /APPLY_FINANCIAL_TOTP_LOCKOUT/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql132` \|/);
  assert.match(oneShot, /`sql129`, `sql130`, `sql131`, `sql132`, `sql133`, `sql134`, `sql135`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql132-financial-totp-code-check-lockout-production-apply\.mjs --inspect/);
});

test('the pending (pre-authorization) pin refuses before connecting; an execute-authorized copy of the retired pin allows only its own manifest; execute false, other hashes and phrases refuse', async () => {
  // The pin before its owner-approved change: no pre-state, no owner approval, no staging acceptance.
  const PENDING = Object.freeze({ ...COMMITTED, authorization: 'pending', execute: false, expected_live_definition_sha256: null, staging_acceptance: { ok: false, reference: null, basis: 'Pending' } });
  const noPre = await evaluateReleaseProductionApply(KEY, manifest({ ...PENDING, expected_live_definition_sha256: PRE }), { root: ROOT, pin: PENDING });
  assert.equal(noPre.code, CODES.SQL_COLLISION);
  const withPre = { ...PENDING, expected_live_definition_sha256: PRE };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(withPre), { root: ROOT, pin: withPre, connect: neverConnect, consumedPath: consumedPath() })).ok, false);
  // execute true alone does not authorize it.
  const flipped = { ...withPre, execute: true };
  assert.equal((await evaluateReleaseProductionApply(KEY, manifest(flipped), { root: ROOT, pin: flipped })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);

  // The committed pin is retired (execute false): an execute-authorized copy of it, before the
  // record-and-retire change, allows only the manifest bound to its recorded pre-state: not another
  // hash, not the intended state (which is production's current state).
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-10-30 (test copy of the execute-authorized pin before its record-and-retire change)' });
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql132_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);
  // The retired committed pin refuses before connecting.
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql132_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_FINANCIAL_TOTP_RATE_LIMIT_CODE_CHECK_NO_PUBLIC' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql132-cli-${process.pid}.json`);
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
