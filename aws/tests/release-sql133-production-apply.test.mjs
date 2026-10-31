/**
 * Production tool for SQL 133 (scripts/deployment-guard/sql133-financial-totp-admin-reset-enrollment-
 * production-apply.mjs on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 133 included) through the
 * shared refusals; this file covers SQL 133's own:
 *
 *   - the pin has the release pin shape plus the applied record; it was execute-authorized (owner-
 *     approved pin change of 2026-10-30, #1472) with the recorded production pre-state (derived from
 *     the spec in release-sql133-executor.test.mjs; the same one staging had) and the staging apply as
 *     its acceptance, then applied on 2026-10-31 and retired (execute false); it is in step with the
 *     staging pin, the one-shot, the bypass inventory and the test lists;
 *   - no predecessor; the one new function (EXECUTE for checksops and the owner, PUBLIC revoked), the
 *     prerequisites (the enrollment, tenant membership and identity tables and their columns,
 *     auth.uid(), role checksops), the four definer relations; no table, view, policy, trigger or
 *     drop, and no grant but the REVOKE from PUBLIC and the GRANT to checksops on this one function;
 *     the overlay plan records it verified live (this record change) so admin-reset-totp.mjs, held
 *     behind it, can take the guarded Lambda path; the API calls the function and checks for it
 *     first; the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; an execute-authorized copy of the
 *     committed (retired) pin allows only the manifest bound to its recorded pre-state, and the retired
 *     pin itself refuses before connecting; an approved, accepted copy evaluates for the
 *     manifest built from it, and refuses with execute false, another live hash, another staging
 *     reference or a wrong phrase; the CLI spends no receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql133-financial-totp-admin-reset-pg.test.mjs; the
 * executor path is aws/tests/release-sql133-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql133-financial-totp-admin-reset-enrollment-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql133';
const SQL133_FILE = 'aws/workflows/sql/133_financial_totp_admin_reset_enrollment.sql';
const IDENTITY = 'public.financial_totp_admin_reset_enrollment(uuid, uuid)';
const TABLE = 'public.financial_totp_enrollments';
const RELATIONS = Object.freeze([TABLE, 'public.tenant_users', 'public.identity_accounts', 'public.profiles']);
const SQL133_IDENTITIES = Object.freeze([IDENTITY]);
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 133's recorded production pre-state (read-only inspect of 2026-10-30, SSM a28009c3, main 746074fb1):
// the function absent, everything else in place; staging recorded the same pre-state (read-live run 41129536538).
const PRODUCTION_PRE = 'f3b1671e8617df78a20600b43fcfc6636739d78f235ef78d1cc7d1d68f2f909d';
// The guarded staging apply (wave 30).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/41133471065';
const OWNER_WORDS = Object.freeze(['"ok build the reset after SQL 131 and the lockout fix"', '"Merge 1467 and 1466"', '"continue with SQL 133 staging"', '"apply SQL 133 in staging"', '"merge 1470"', '"run the SQL 133 production inspect"']);
// SQL 133's production apply of 2026-10-31 (main d0ac2e079), recorded in applied; the owner's words for the run
// ("run the SQL 133 production inspect then apply SQL 133 in production") carried the apply clause, passed verbatim.
const SQL133_APPLIED = Object.freeze({ ssm: '8bfa1019-ce57-452a-a537-000162bb5485', run: '45f0bf20-56a7-4573-ad09-d88d98bbacb3', one_use_id: 'sql133-prod-7674d0c2-88de-407c-8a8a-dc091399ed85', commit: 'd0ac2e0798ffc6d54b590a1c0705ca903351f6ba', workstream: 'prod-sql133-financial-totp-admin-reset-20261031', approval: 'apply SQL 133 in production' });
const INSPECT_SSM = '6b265063-e6ab-48cc-843c-8969d9c6e62f';
const INSPECT_RUN = '12e7bf02-c2c1-4306-950c-9c4cd6287e67';
const POST_INSPECT_SSM = '5d73b482-dded-47e2-91da-782019a47fff';
const DEFINER_WRITES = Object.freeze(['financial_totp_enrollments', 'tenant_users', 'identity_accounts', 'profiles'].map((name) => ({ name, ok: true })));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql133-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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

test('pin: the release pin shape, applied and retired (owner approved 2026-10-30, on the staging apply; applied 2026-10-31), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Applied 2026-10-31 and retired. The pin change (#1472) recorded the read-only production inspect (SSM
  // a28009c3, main 746074fb1) as the pre-state and the staging apply (run 41133471065) as the acceptance; its
  // words named the build, the merges, the staging step and the inspect, and the apply run had the owner's own
  // words for it.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-10-31; execute is false again/);
  assert.doesNotMatch(pin.authorization, /^Owner approved/);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /none of them words for the production apply/);
  assert.ok(pin.authorization.includes('#1472'));
  assert.ok(pin.authorization.includes('"merge 1472"'));
  assert.ok(pin.authorization.includes(SQL133_APPLIED.workstream));
  assert.ok(pin.authorization.includes(`"${SQL133_APPLIED.approval}"`));
  assert.ok(pin.authorization.includes('"run the SQL 133 production inspect then apply SQL 133 in production"'));
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied.date, '2026-10-31');
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.applied.apply_ssm_command_id, SQL133_APPLIED.ssm);
  assert.equal(pin.applied.one_shot_run_id, SQL133_APPLIED.run);
  assert.equal(pin.applied.one_use_id, SQL133_APPLIED.one_use_id);
  assert.equal(pin.applied.one_use_id_consumed, true);
  assert.equal(pin.applied.workstream_id, SQL133_APPLIED.workstream);
  assert.equal(pin.applied.source_commit, SQL133_APPLIED.commit);
  assert.equal(pin.applied.source_tarball.sha256, 'abb179d5613b6bf008c35f74576561edd929535045c9956dc72e6c713ffb3fe7');
  assert.equal(pin.applied.migration_source_sha256, pin.source_sha256);
  assert.equal(pin.applied.owner_approval, SQL133_APPLIED.approval);
  assert.ok(pin.applied.owner_approval_basis.includes('"run the SQL 133 production inspect then apply SQL 133 in production"'));
  assert.equal(pin.applied.operator, 'michaelcarletta-cmd');
  assert.equal(pin.applied.runner, 'i-0c35557c4e5385406');
  assert.deepEqual(pin.applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  // The read-only --phase inspect before the apply, the separate --inspect after it, and the transfer run.
  assert.match(pin.applied.one_shot_note, new RegExp(INSPECT_SSM));
  assert.match(pin.applied.one_shot_note, new RegExp(INSPECT_RUN));
  assert.match(pin.applied.one_shot_note, new RegExp(POST_INSPECT_SSM));
  assert.match(pin.applied.one_shot_note, /transfer run 41149979809/);
  // The run's JSON was cut by SSM's 24000-character output limit inside applied.receipt (as SQL 131's was): the
  // note says where, and that receipt and post_apply_inspect are the run's identical top-level objects, whose
  // printed prefix was checked byte for byte.
  assert.match(pin.applied.one_shot_note, /The run's JSON did not arrive whole: SSM returned the first 24000 characters/);
  assert.match(pin.applied.one_shot_note, /cut at 12073 characters, inside the one-shot's own applied object at applied\.receipt\.release_sql_inspect/);
  assert.match(pin.applied.one_shot_note, /910 characters of applied\.receipt that were printed are a byte-for-byte prefix of the compact details\.apply_result/);
  assert.match(pin.applied.one_shot_note, /receipt: applyRecord, post_apply_inspect: summary\.post_apply_inspect/);
  assert.doesNotMatch(pin.applied.one_shot_note, /The run's whole JSON arrived/);
  assert.equal(pin.applied.manifest_sha256, 'd3cf8c77ec0ec665888dae4b3ac238aabf252ca59f288eae05fb2b761a1fbbab');
  assert.deepEqual(Object.values(pin.applied.contract_results).map((c) => c.evidence.split(' ')[0]), ['4/4', '6/6', '43/43']);
  for (const c of Object.values(pin.applied.contract_results)) assert.ok(c.evidence.includes(SQL133_APPLIED.run), c.test);
  assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.applied.pre_apply_inspect.live_matches_expected, true);
  assert.equal(pin.applied.pre_apply_inspect.already_applied, false);
  assert.deepEqual(pin.applied.pre_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.pre_apply_inspect.predecessors, {});
  assert.deepEqual(pin.applied.pre_apply_inspect.release_sql_inspect.functions, [{ name: 'financial_totp_admin_reset_enrollment(uuid, uuid)', state: 'absent' }]);
  assert.deepEqual(pin.applied.pre_apply_inspect.release_sql_inspect.function_acl, [{ name: 'financial_totp_admin_reset_enrollment(uuid, uuid)', acl: [] }]);
  assert.deepEqual(pin.applied.pre_apply_inspect.release_sql_inspect.definer_writes, [...DEFINER_WRITES]);
  assert.equal(pin.applied.receipt.before_hash, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.applied.receipt.workstream, SQL133_APPLIED.workstream);
  assert.equal(pin.applied.receipt.commit, SQL133_APPLIED.commit);
  assert.equal(pin.applied.receipt.sql_file, SQL133_FILE);
  assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '2a0f4e9a5dfed9253e619ff9df5cdef0081c388b8abddbd9285222216927820a');
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.functions, 1355);
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.triggers, 184);
  assert.equal(pin.applied.receipt.result, 'applied');
  assert.equal(pin.applied.post_apply_inspect.already_applied, true);
  assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.post_apply_inspect.predecessors, {});
  assert.deepEqual(pin.applied.post_apply_inspect.release_sql_inspect.functions, [{ name: 'financial_totp_admin_reset_enrollment(uuid, uuid)', state: 'intended' }]);
  assert.deepEqual(pin.applied.post_apply_inspect.release_sql_inspect.function_acl, [{ name: 'financial_totp_admin_reset_enrollment(uuid, uuid)', acl: ['checksops EXECUTE', 'owner EXECUTE'] }]);
  assert.deepEqual(pin.applied.post_apply_inspect.release_sql_inspect.definer_writes, [...DEFINER_WRITES]);
  assert.deepEqual(pin.applied.post_apply_inspect.release_sql_inspect.triggers, []);
  assert.equal(pin.applied.post_apply_inspect.release_sql_inspect.dropped_function_dependents, 0);
  assert.deepEqual(pin.applied.receipt.release_sql_inspect, pin.applied.post_apply_inspect.release_sql_inspect);
  for (const evidence of [SQL133_APPLIED.ssm, SQL133_APPLIED.run, SQL133_APPLIED.one_use_id, INSPECT_SSM, POST_INSPECT_SSM, `"${SQL133_APPLIED.approval}"`]) {
    assert.ok(pin.production_evidence['2026-10-31 apply'].includes(evidence), evidence);
  }
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-10-30');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, 'a28009c3-db1c-4567-b7b6-7fe01f7d06f4');
  assert.equal(pin.production_inspect.source_commit, '746074fb1b8f799b6cd413ccf9e4e7fad5694c0d');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('0445edb2fc3ce505fe08c9d9d770e13a27ed456f31af52af1b1b904293fc1ab4'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /financial_totp_admin_reset_enrollment\(uuid, uuid\) absent, function_acl \[\]; definer_writes financial_totp_enrollments ok true, tenant_users ok true, identity_accounts ok true, profiles ok true/);
  assert.match(pin.production_inspect.note, /predecessors \{\} \(none\), predecessors_applied true/);
  assert.match(pin.production_inspect.note, /dropped_function_dependents 0, dropped_function_callers \[\]/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: '));
  assert.match(pin.production_inspect.note, /SSM cfee4512-4988-4fd1-be77-b03d1b4cd50b/);
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql133-financial-totp-admin-reset-enrollment, run 41133471065/);
  assert.match(pin.staging_acceptance.basis, /deploy run 41133133498/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 41133803430 then reported already_applied true/);
  assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin recorded the same pre-state (wave 30): the function absent in both environments.
  assert.equal(staging.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.equal(pin.filename, SQL133_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL133_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, SQL133_IDENTITIES);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_FINANCIAL_TOTP_ADMIN_RESET');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql133-financial-totp-admin-reset-enrollment-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-133-apply.md');
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
  assert.equal(tool.allowed_key, 'sql133_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql133-financial-totp-admin-reset-enrollment-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql133-production-apply"\]/);
  assert.match(rows, /sql129, sql130, sql131, sql132, sql133, sql134, sql135, sql137\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql133-executor.test.mjs', 'aws/tests/release-sql133-production-apply.test.mjs', 'aws/tests/sql133-financial-totp-admin-reset-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; the one new function, its prerequisites and the four definer relations; REVOKE from PUBLIC and GRANT to checksops, nothing else; the plan records it verified live for admin-reset-totp.mjs; the API calls it and checks for it first; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), SQL133_IDENTITIES);
  for (const fn of spec.functions) {
    assert.deepEqual(fn.acl, ['checksops EXECUTE', 'owner EXECUTE'], fn.identity);
    assert.deepEqual(fn.revokes, ['PUBLIC EXECUTE'], fn.identity);
    assert.equal(fn.result, 'TABLE(cleared boolean)');
  }
  assert.equal(spec.dropped_functions, undefined);
  assert.equal(spec.acl_functions, undefined);
  assert.deepEqual(spec.prerequisites.slice(0, 6), [...RELATIONS, 'auth.uid()', 'role checksops']);
  for (const column of ['financial_totp_enrollments.application_user_id', 'tenant_users.tenant_id', 'tenant_users.user_id',
    'identity_accounts.application_user_id', 'identity_accounts.email', 'profiles.id', 'profiles.email']) {
    assert.ok(spec.prerequisites.includes(`column public.${column}`), column);
  }
  assert.deepEqual(spec.definer_writes, [...RELATIONS]);
  for (const absent of ['tables', 'views', 'policies', 'triggers', 'altered_relations']) assert.equal(spec[absent], undefined, absent);
  assert.match(COMMITTED.order_note, /^No predecessor: SQL 133 calls none of SQL 130, 131 or 132's functions/);
  assert.match(COMMITTED.order_note, /definer_can_write_relations/);
  assert.match(COMMITTED.order_note, /tolerates its absence \(the Cognito and profiles reset as before, financialTotpCleared false, never a 500\)/);
  assert.match(COMMITTED.order_note, /no API, Lambda or SPA change is part of this pin\./);
  // SQL 130's and SQL 131's production pins are applied and retired (#1453, #1463); SQL 132's is on
  // its own guarded path (pin #1467); this change touches none of them.
  assert.equal(loadReleaseProductionPin('sql130', ROOT).applied.result, 'applied');
  const sql131 = loadReleaseProductionPin('sql131', ROOT);
  assert.equal(sql131.execute, false);
  assert.equal(sql131.applied.result, 'applied');
  const sql132 = loadReleaseProductionPin('sql132', ROOT);
  assert.equal(sql132.migration, 'sql132');
  assert.equal(typeof sql132.execute, 'boolean');
  // The API member that calls the function pends its REPLACE on this pin: admin-reset-totp.mjs has
  // sql_before SQL 133, which this record change marks verified live in the overlay plan (from the applied
  // record above), so the guarded Lambda path can accept it after its own read-only inspect. The member is
  // not deployed here.
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  const prerequisite = plan.sql_prerequisites[SQL133_FILE];
  assert.equal(prerequisite.verified_live, true);
  assert.equal(prerequisite.pin, RELEASE_SQL_SPECS[KEY].production_pin_rel);
  for (const evidence of [SQL133_APPLIED.ssm, SQL133_APPLIED.run, SQL133_APPLIED.workstream, SQL133_APPLIED.one_use_id, `${PRODUCTION_PRE.slice(0, 8)}… -> ${COMMITTED.intended_replacement_sha256.slice(0, 8)}…`, 'staging acceptance run 41133471065', POST_INSPECT_SSM]) {
    assert.ok(prerequisite.evidence.includes(evidence), evidence);
  }
  assert.match(prerequisite.note, /Holds admin-reset-totp\.mjs \(REPLACE, sql_before SQL 133\)/);
  assert.match(prerequisite.note, /The member is not deployed by this record/);
  const stagingLive = readJson('ops/deployment-guard/staging-sql-live.json').sql[SQL133_FILE];
  assert.equal(stagingLive.verified_live, true);
  for (const evidence of ['run 41133471065', 'read-live run 41133803430', `receipt before ${PRODUCTION_PRE.slice(0, 8)}…`, `after ${COMMITTED.intended_replacement_sha256.slice(0, 8)}…`]) {
    assert.ok(stagingLive.evidence.includes(evidence), evidence);
  }
  assert.equal(plan.members['admin-reset-totp.mjs'].sql_before, SQL133_FILE);
  // The reset REPLACE ran after SQL 133 was recorded live (production run 41189659812, 2026-10-31): the row expects
  // its accepted bytes and names the applied record.
  const ADMIN_RESET_APPLIED = 'aws/tests/fixtures/production-financial-totp-admin-reset-applied-manifest-2026-10-31.json';
  assert.equal(readJson(ADMIN_RESET_APPLIED).members['admin-reset-totp.mjs'].accepted_sha256, plan.members['admin-reset-totp.mjs'].accepted_sha256);
  assert.equal(plan.members['admin-reset-totp.mjs'].expected_live_sha256, plan.members['admin-reset-totp.mjs'].accepted_sha256, 'admin-reset-totp.mjs records the applied reset bytes');
  assert.equal(plan.members['admin-reset-totp.mjs'].manifest, ADMIN_RESET_APPLIED);
  // The API: the one call and the existence check, as checksops, inside the reset transaction before Cognito.
  const call = 'SELECT cleared FROM public.financial_totp_admin_reset_enrollment($1::uuid, $2::uuid)';
  const presentCall = 'SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present';
  const api = fs.readFileSync(path.join(ROOT, 'aws/functions/api/admin-reset-totp.mjs'), 'utf8');
  assert.ok(api.includes(call));
  assert.ok(api.includes(presentCall));
  assert.ok(api.includes(`'${IDENTITY}'`));
  assert.match(api, /export const clearFinancialTotpEnrollment = async \(client, actorUserId, targetUserId\) => \{/);
  assert.ok(api.indexOf('await consumeResetStepUp(') < api.indexOf('await clearFinancialTotpEnrollment(client, mapping.application_user_id, userId)'));
  assert.ok(api.indexOf('await clearFinancialTotpEnrollment(client, mapping.application_user_id, userId)') < api.indexOf('new AdminGetUserCommand('));
  assert.equal([...api.matchAll(/financialTotpCleared: financial\.cleared/g)].length, 3, 'every success answer says whether the authenticator was cleared');
  // One DO block, one CREATE OR REPLACE FUNCTION, the REVOKE from PUBLIC and the GRANT to checksops on it; nothing else.
  const text = fs.readFileSync(path.join(ROOT, SQL133_FILE), 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(text, /\bCREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|VIEW|TABLE|POLICY)\b/i);
  assert.doesNotMatch(text, /\b(DROP|ALTER)\b/);
  assert.equal([...text.matchAll(/\bCREATE\s+OR\s+REPLACE\s+FUNCTION\b/gi)].length, 1);
  assert.equal([...text.matchAll(/\bDO\s+\$/g)].length, 1);
  assert.deepEqual([...text.matchAll(/^\s*(GRANT|REVOKE)\b.*$/gim)].map((m) => m[0].trim()), [
    `REVOKE ALL ON FUNCTION ${IDENTITY} FROM PUBLIC;`,
    `GRANT EXECUTE ON FUNCTION ${IDENTITY} TO checksops;`,
  ]);
  assert.doesNotMatch(text, /financial_totp_(upsert_enrollment|get_enrollment|mark_verified|status|count_code_check)\b/);
  assert.doesNotMatch(text, /consume_financial_totp_rate_limit/);
  assert.match(text, /RAISE EXCEPTION 'platform_owner_protected'/);
  assert.match(text, /RAISE EXCEPTION 'cannot_reset_own_totp'/);
  assert.match(text, /RAISE EXCEPTION 'reset_target_not_teammate'/);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 30\) and to production \(2026-10-31\); the production pin is retired/);
  assert.match(runbook, /\*\*Production apply \(2026-10-31\)\.\*\*/);
  for (const evidence of [SQL133_APPLIED.ssm, SQL133_APPLIED.run, SQL133_APPLIED.workstream, INSPECT_SSM, INSPECT_RUN, POST_INSPECT_SSM, '41149979809', `"${SQL133_APPLIED.approval}"`, 'first 24000 characters']) {
    assert.ok(runbook.includes(evidence), evidence);
  }
  assert.match(runbook, /SSM\s+`a28009c3-db1c-4567-b7b6-7fe01f7d06f4`/);
  assert.match(runbook, /Staging apply \(2026-10-30\)\.\*\* Run 41133471065/);
  assert.match(runbook, /read-live \(2026-10-30\)\.\*\* Run 41129536538/);
  assert.match(runbook, /\*\*Predecessor\.\*\* None/);
  assert.match(runbook, /"ok build the reset\s+after SQL 131 and the lockout fix"/);
  assert.match(runbook, /APPLY_FINANCIAL_TOTP_ADMIN_RESET/);
  assert.match(runbook, /No self-service reset/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql133` \|/);
  assert.match(oneShot, /`sql130`, `sql131`, `sql132`, `sql133`, `sql134`, `sql135`, `sql137`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql133-financial-totp-admin-reset-enrollment-production-apply\.mjs --inspect/);
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
  assert.equal(committedOk.details.sql133_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);
  // The retired committed pin refuses before connecting.
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql133_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_FINANCIAL_TOTP_LOCKOUT' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql133-cli-${process.pid}.json`);
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
