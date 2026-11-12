/**
 * Production tool for SQL 148 (scripts/deployment-guard/sql148-second-mortgagee-link-production-apply.mjs on
 * lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 148 included) through the
 * shared refusals; this file covers SQL 148's own:
 *
 *   - the pin has the release pin shape plus the applied record; it was execute-authorized (owner-approved pin
 *     change of 2026-11-10, #1748) with the recorded production pre-state (read-only inspect; the derived one, the
 *     same one staging had) and the staging apply as its acceptance, then applied on 2026-11-10 and retired
 *     (execute false); it is in step with the staging pin, the one-shot, the bypass inventory and the test lists;
 *   - no predecessor; the one new DEFINER function (EXECUTE for checksops and the owner; PUBLIC, anon,
 *     authenticated and service_role revoked, RETURNS jsonb), the per-check unique index redefined in place (only from
 *     the Supabase definition or its own: replaced_indexes_replaceable; no other per-check unique index:
 *     no_other_per_check_unique_index), the prerequisites (the request table's seven columns, SQL 90's
 *     aws_can_write_tenant(uuid), auth.uid(), role checksops), the definer relation; no table, view, policy, trigger
 *     or other drop, and no grant but the REVOKEs and the GRANT to checksops on this function; the runbook, one-shot
 *     doc and README name it;
 *   - the production precondition rule (the pinned login plus the shared rules) refuses the index absent or under
 *     another definition, and another per-check unique index;
 *   - the pending (pre-authorization) pin refuses before connecting; an execute-authorized copy of the committed
 *     (retired) pin allows only the manifest bound to its recorded pre-state, and the retired pin itself refuses
 *     before connecting; an approved, accepted copy evaluates for the manifest built from it, and refuses with execute false, another live hash, another staging
 *     reference or a wrong phrase; the CLI spends no receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql148-second-mortgagee-link-pg.test.mjs; the executor path (and the
 * engine's index entry on PostgreSQL 16) is aws/tests/release-sql148-executor.test.mjs.
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
import { RELEASE_SQL_SPECS, collapse, releaseIntendedHash, releaseIntendedState, releaseReplacedPreState, releaseStateHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import {
  RELEASE_PRODUCTION,
  evaluateReleaseProductionApply,
  executeReleaseProductionApply,
  loadReleaseProductionPin,
  precheckReleaseProductionApply,
  readPinnedReleaseSql,
  releaseProductionPreconditionFailures,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { main } from '../../scripts/deployment-guard/sql148-second-mortgagee-link-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql148';
const SQL148_FILE = 'aws/workflows/sql/148_second_mortgagee_link.sql';
const IDENTITY = 'public.aws_link_second_mortgagee(uuid, uuid)';
const IDENTITIES = Object.freeze([IDENTITY]);
const TABLE = 'public.mortgage_handling_requests';
const INDEX = 'mortgage_handling_requests_one_open_per_check';
const RELATIONS = Object.freeze([TABLE]);
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
// The derived pre-state (the function absent, the index at the Supabase definition; derived by release-sql148-executor.test.mjs).
const SUPABASE_PRE = '508588e6cd7d48ca74411aba8e0220842e0490bde69a881d362966f77e54d862';
// SQL 148's recorded production pre-state (read-only inspect of 2026-11-10, SSM 3fc740fd, main 952c4139e): the derived
// pre-state; staging recorded the same (read-live runs 42901109448, 42905486022).
const PRODUCTION_PRE = SUPABASE_PRE;
// The guarded staging apply (wave 43).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/42905846810';
// SQL 148's production apply of 2026-11-10 (main eb8e1afc2), recorded in applied, on the owner's "merge it when green and apply SQL 148 in production".
const SQL148_APPLIED = Object.freeze({ ssm: 'a07ba9a4-3fbf-4e85-8cc4-d93336c93c23', run: 'd727eb12-20f9-49a7-9c14-072b570740a5', one_use_id: 'sql148-prod-6de10e9e-b0a4-428a-af04-467d4e9664b1', commit: 'eb8e1afc2df722e23b99c6a0a724da91c4a3bb9a', workstream: 'prod-sql148-second-mortgagee-link-20261110', approval: 'merge it when green and apply SQL 148 in production' });
// The separate one-shot --phase inspect before the apply.
const PRE_INSPECT_SSM = 'a8ad09fa-40a1-4242-9eed-3fc03f5430ba';
const PRE_INSPECT_RUN = '2e5e9a59-a204-4506-ac3a-c48136699374';
const FUNCTION_NAMES = Object.freeze(IDENTITIES.map((identity) => identity.replace(/^public\./, '')));
const INDEX_REPORT = `mortgage_handling_requests ${INDEX}`;
const OWNER_WORDS = Object.freeze(['"build the SQL 148 tooling and merge it when green"', '"apply SQL 148 in staging"', '"record the SQL 148 staging pin and merge it when green"', '"run the read-only SQL 148 production inspect"', '"record the SQL 148 production pin"', '"SQL 148 accepted in staging"']);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql148-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-11-10T00:00:00.000Z',
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

test('pin: the release pin shape, applied and retired (owner approved 2026-11-10, on the staging apply; applied 2026-11-10), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Applied 2026-11-10 and retired. The pin change (#1748) recorded the read-only production inspect (SSM 3fc740fd,
  // main 952c4139e) as the pre-state and the staging apply (run 42905846810) as the acceptance; the owner's acceptance
  // came before the staging apply ran and counted because the apply ended exactly at the intended fingerprint. The
  // apply run had the owner's own words for it, passed verbatim.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-11-10; execute is false again/);
  assert.doesNotMatch(pin.authorization, /^Owner approved/);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /given before the staging apply ran and taken as an acceptance only because that apply ended exactly at the intended fingerprint/);
  assert.ok(pin.authorization.includes('#1748'));
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE.slice(0, 8)} -> ${pin.intended_replacement_sha256.slice(0, 8)}`));
  assert.ok(pin.authorization.includes(SQL148_APPLIED.workstream));
  assert.ok(pin.authorization.includes(`"${SQL148_APPLIED.approval}"`));
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied.date, '2026-11-10');
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.applied.apply_ssm_command_id, SQL148_APPLIED.ssm);
  assert.equal(pin.applied.one_shot_run_id, SQL148_APPLIED.run);
  assert.equal(pin.applied.one_use_id, SQL148_APPLIED.one_use_id);
  assert.equal(pin.applied.one_use_id_consumed, true);
  assert.equal(pin.applied.workstream_id, SQL148_APPLIED.workstream);
  assert.equal(pin.applied.source_commit, SQL148_APPLIED.commit);
  assert.equal(pin.applied.source_tarball.sha256, '3204af5192a18ae361789a3a0180ec6bccbb8af93ac1dfd3f3478aecedebf295');
  assert.equal(pin.applied.migration_source_sha256, pin.source_sha256);
  assert.equal(pin.applied.owner_approval, SQL148_APPLIED.approval);
  assert.ok(pin.applied.owner_approval_basis.includes('#1748'));
  assert.equal(pin.applied.operator, 'michaelcarletta-cmd');
  assert.equal(pin.applied.runner, 'i-0c35557c4e5385406');
  assert.deepEqual(pin.applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  // The transfer run, the separate --phase inspect before the apply, and that the run's JSON arrived whole.
  // Production acceptance was not yet reported when this was recorded, and the record says so.
  assert.match(pin.applied.one_shot_note, /transfer run 42908791627/);
  assert.ok(pin.applied.one_shot_note.includes(PRE_INSPECT_SSM));
  assert.ok(pin.applied.one_shot_note.includes(PRE_INSPECT_RUN));
  assert.match(pin.applied.one_shot_note, /The run's JSON arrived whole/);
  assert.match(pin.applied.one_shot_note, /Production acceptance: not yet reported by the owner/);
  assert.equal(pin.applied.manifest_sha256, '9fa0221b7bfa80a34d07102bcbe48f2ce0413f0b5c649dd341606f7d6d5bb1d1');
  assert.deepEqual(Object.values(pin.applied.contract_results).map((c) => c.evidence.split(' ')[0]), ['4/4', '6/6', '43/43']);
  for (const c of Object.values(pin.applied.contract_results)) assert.ok(c.evidence.includes(SQL148_APPLIED.run), c.test);
  assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.applied.pre_apply_inspect.live_matches_expected, true);
  assert.equal(pin.applied.pre_apply_inspect.already_applied, false);
  assert.deepEqual(pin.applied.pre_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.pre_apply_inspect.predecessors, {});
  assert.deepEqual(pin.applied.pre_apply_inspect.counts, { other_per_check_unique_indexes: 0 });
  assert.deepEqual(pin.applied.pre_apply_inspect.release_sql_inspect.functions.map((f) => [f.name, f.state]), FUNCTION_NAMES.map((name) => [name, 'absent']));
  assert.deepEqual(pin.applied.pre_apply_inspect.release_sql_inspect.index_definitions, [{ name: INDEX_REPORT, definition: 'supabase_20260715110727' }]);
  assert.deepEqual(pin.applied.pre_apply_inspect.release_sql_inspect.definer_writes, [{ name: 'mortgage_handling_requests', ok: true }]);
  assert.equal(pin.applied.receipt.before_hash, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.applied.receipt.workstream, SQL148_APPLIED.workstream);
  assert.equal(pin.applied.receipt.commit, SQL148_APPLIED.commit);
  assert.equal(pin.applied.receipt.sql_file, SQL148_FILE);
  assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '05b0a1bc845383e42dea77cab89e2b4be218dd3060180c301822b788ffa815e9');
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.policies, 479);
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.functions, 1364);
  assert.equal(pin.applied.receipt.result, 'applied');
  assert.equal(pin.applied.post_apply_inspect.already_applied, true);
  assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.post_apply_inspect.predecessors, {});
  assert.deepEqual(pin.applied.post_apply_inspect.counts, { other_per_check_unique_indexes: 0 });
  // The function intended with EXECUTE for checksops and the owner; the index at SQL 148's definition; the definer
  // relation ok; no prerequisite missing.
  const post = pin.applied.post_apply_inspect.release_sql_inspect;
  assert.deepEqual(post.functions.map((f) => [f.name, f.state]), FUNCTION_NAMES.map((name) => [name, 'intended']));
  assert.deepEqual(post.function_acl, FUNCTION_NAMES.map((name) => ({ name, acl: ['checksops EXECUTE', 'owner EXECUTE'] })));
  assert.deepEqual(post.index_definitions, [{ name: INDEX_REPORT, definition: 'intended' }]);
  assert.deepEqual(post.definer_writes, [{ name: 'mortgage_handling_requests', ok: true }]);
  for (const absent of ['policies', 'views', 'tables', 'columns', 'constraints', 'triggers', 'table_privileges']) assert.deepEqual(post[absent], [], absent);
  assert.deepEqual(post.prerequisites_missing, []);
  assert.deepEqual(pin.applied.receipt.release_sql_inspect, post);
  for (const evidence of [SQL148_APPLIED.ssm, SQL148_APPLIED.run, SQL148_APPLIED.one_use_id, PRE_INSPECT_SSM, `"${SQL148_APPLIED.approval}"`, '"DEPLOY workflow-rpc.mjs TO PRODUCTION"']) {
    assert.ok(pin.production_evidence['2026-11-10 apply'].includes(evidence), evidence);
  }
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-10');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '3fc740fd-06b8-4bdb-be60-3042a406c25e');
  assert.equal(pin.production_inspect.source_commit, '952c4139ee6ad2c03898d285adc181eeb3118c96');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('332e1b48c238a0b517b83e77bd0549cbc06940829b04c406e9af263abeff86de'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /index_definitions supabase_20260715110727/);
  assert.match(pin.production_inspect.note, /counts\.other_per_check_unique_indexes 0/);
  assert.match(pin.production_inspect.note, /already_applied false\), live_matches_expected false, precondition_failures \[\], apply_preconditions_met false, errors \[\]/);
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no release-engine production inspect has been run for SQL 148 yet.'));
  assert.match(pin.production_inspect.note, /prerequisites_missing/);
  assert.match(pin.production_inspect.note, /definer_can_write_relations/);
  assert.match(pin.production_inspect.note, /replaced_indexes_replaceable/);
  assert.match(pin.production_inspect.note, /no_other_per_check_unique_index/);
  assert.match(pin.production_inspect.note, /index_definitions \(expected supabase_20260715110727\)/);
  assert.match(pin.production_inspect.note, /counts\.other_per_check_unique_indexes \(must be 0\)/);
  assert.match(pin.production_inspect.note, /functions_owned_by_login/);
  assert.match(pin.production_inspect.note, /function_results_match/);
  assert.match(pin.production_inspect.note, /function_acl_replaceable/);
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql148-second-mortgagee-link, run 42905846810/);
  assert.match(pin.staging_acceptance.basis, /deploy run 42904644950/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 42906285342 \(job 130145005929\) then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /under the owner's words "apply SQL 148 in staging"/);
  assert.match(pin.staging_acceptance.basis, /"SQL 148 accepted in staging"/);
  assert.ok(pin.staging_acceptance.basis.includes(`before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin recorded the same pre-state (wave 43).
  assert.equal(staging.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.equal(pin.filename, SQL148_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL148_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, [...IDENTITIES]);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_SECOND_MORTGAGEE_LINK');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql148-second-mortgagee-link-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-148-apply.md');
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
  assert.equal(tool.allowed_key, 'sql148_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql148-second-mortgagee-link-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql148-production-apply"\]/);
  assert.match(rows, /sql146, sql147, sql148, sql150, sql152, sql153, sql154, sql155, sql156, sql158, sql159, sql160\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql148-executor.test.mjs', 'aws/tests/release-sql148-production-apply.test.mjs', 'aws/tests/sql148-second-mortgagee-link-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; the one new DEFINER function, the index redefined in place, its prerequisites and the definer relation; the REVOKEs and the GRANT to checksops, nothing else; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), [...IDENTITIES]);
  for (const fn of spec.functions) {
    assert.deepEqual(fn.acl, ['checksops EXECUTE', 'owner EXECUTE'], fn.identity);
    assert.deepEqual(fn.revokes, ['PUBLIC EXECUTE', 'anon EXECUTE', 'authenticated EXECUTE', 'service_role EXECUTE'], fn.identity);
    assert.equal(fn.result, undefined, fn.identity);
  }
  assert.equal(spec.dropped_functions, undefined);
  assert.equal(spec.acl_functions, undefined);
  assert.deepEqual(spec.prerequisites.slice(0, 4), [TABLE, 'public.aws_can_write_tenant(uuid)', 'auth.uid()', 'role checksops']);
  for (const column of ['id', 'tenant_id', 'check_intake_item_id', 'status', 'endorsement_order', 'total_mortgagees', 'predecessor_request_id']) {
    assert.ok(spec.prerequisites.includes(`column ${TABLE}.${column}`), column);
  }
  assert.equal(spec.prerequisites.length, 11);
  assert.deepEqual(spec.definer_writes, [...RELATIONS]);
  assert.deepEqual(spec.indexes.map((i) => [i.table, i.name, i.replaces.map((r) => r.label)]), [[TABLE, INDEX, ['supabase_20260715110727']]]);
  assert.deepEqual(spec.extra_preconditions, ['no_other_per_check_unique_index']);
  for (const absent of ['tables', 'views', 'policies', 'triggers', 'altered_relations']) assert.equal(spec[absent], undefined, absent);
  assert.match(COMMITTED.order_note, /^No predecessor: SQL 148 redefines one existing unique index in place and creates one new SECURITY DEFINER function/);
  for (const name of ['definer_can_write_relations', 'replaced_indexes_replaceable', 'no_other_per_check_unique_index', 'release_sql_inspect.index_definitions', 'supabase_20260715110727']) {
    assert.ok(COMMITTED.order_note.includes(name), name);
  }
  assert.match(COMMITTED.order_note, /SQL 90's aws_can_write_tenant\(uuid\)/);
  assert.match(COMMITTED.order_note, /No API, Lambda or SPA change is part of this pin\./);
  // The pre-state the notes name is the code-derived one.
  const pre = releaseStateHash(KEY, releaseReplacedPreState(KEY));
  assert.ok(COMMITTED.order_note.includes(pre));
  assert.ok(COMMITTED.production_inspect.note.includes(pre));
  // Three DO blocks (prerequisites, the index, the REVOKEs), one CREATE OR REPLACE FUNCTION, one DROP INDEX and one
  // CREATE UNIQUE INDEX of this index; the REVOKE from PUBLIC and the GRANT to checksops on the function; nothing else.
  // The only writes are the two UPDATEs of the request table; both rows are locked once.
  const text = fs.readFileSync(path.join(ROOT, SQL148_FILE), 'utf8').replace(/--[^\n]*/g, '');
  assert.doesNotMatch(text, /\bCREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|VIEW|TABLE|POLICY)\b/i);
  assert.doesNotMatch(text, /\bALTER\b/);
  assert.deepEqual([...text.matchAll(/\bDROP\s+\S+\s+\S+/g)].map((m) => m[0]), [`DROP INDEX public.${INDEX};`]);
  assert.deepEqual([...text.matchAll(/^\s*CREATE\s+UNIQUE\s+INDEX\s+(\S+)\s+ON\s+(\S+)/gm)].map((m) => [m[1], m[2]]), [[INDEX, TABLE]]);
  assert.deepEqual([...text.matchAll(/\b(INSERT\s+INTO\s+\S+|UPDATE\s+public\.\S+|DELETE|TRUNCATE)\b/g)].map((m) => m[0]),
    ['UPDATE public.mortgage_handling_requests', 'UPDATE public.mortgage_handling_requests']);
  assert.equal([...text.matchAll(/\bFOR UPDATE\b/g)].length, 1);
  assert.equal([...text.matchAll(/\bCREATE\s+OR\s+REPLACE\s+FUNCTION\b/gi)].length, 1);
  assert.equal([...text.matchAll(/\bDO\s+\$/g)].length, 3);
  assert.deepEqual([...text.matchAll(/^\s*(GRANT|REVOKE)\b.*$/gim)].map((m) => m[0].trim()), [
    `REVOKE ALL ON FUNCTION ${IDENTITY} FROM PUBLIC;`,
    `GRANT EXECUTE ON FUNCTION ${IDENTITY} TO checksops;`,
  ]);
  assert.ok(text.includes(`EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION ${IDENTITY} FROM %I', v_role);`));
  assert.match(text, /FOREACH v_role IN ARRAY ARRAY\['anon', 'authenticated', 'service_role'\] LOOP/);
  assert.match(text, /RAISE EXCEPTION 'mortgagee_link_forbidden'\s+USING ERRCODE = '42501'/);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.ok(runbook.includes(pre));
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 43\) and to production \(2026-11-10\); the production pin is retired/);
  assert.match(runbook, /\*\*Production apply \(2026-11-10\)\.\*\*/);
  for (const evidence of [SQL148_APPLIED.ssm, SQL148_APPLIED.run, SQL148_APPLIED.workstream, PRE_INSPECT_SSM, PRE_INSPECT_RUN, '42908791627', `"${SQL148_APPLIED.approval}"`]) {
    assert.ok(runbook.includes(evidence), evidence);
  }
  assert.match(runbook, /SSM\s+`3fc740fd-06b8-4bdb-be60-3042a406c25e`/);
  assert.match(runbook, /\*\*Staging apply \(2026-11-10\)\.\*\* Apply run 42905846810/);
  assert.match(runbook, /Read-live run 42906285342/);
  assert.match(runbook, /"SQL 148 accepted in staging"/);
  assert.match(runbook, /\*\*Predecessor\.\*\* None/);
  assert.match(runbook, /Owner 2026-11-10: "build the second-mortgagee fix"/);
  assert.match(runbook, /"build the SQL 148\s+tooling and merge it when green"/);
  for (const evidence of ['MORTGAGE_REQUEST_INSERT_ONLY', 'SAFE_WRITE_RPCS', 'link_second_mortgagee', '#1742', '20260715110727',
    'replaced_indexes_replaceable', 'no_other_per_check_unique_index', 'index_definitions', 'other_per_check_unique_indexes']) {
    assert.ok(runbook.includes(evidence), evidence);
  }
  assert.match(runbook, /APPLY_SECOND_MORTGAGEE_LINK/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql148` \|/);
  assert.match(oneShot, /`sql146`, `sql147`, `sql148`, `sql150`, `sql152`, `sql153`, `sql154`, `sql155`, `sql156`, `sql158`, `sql159`, `sql160`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql148-second-mortgagee-link-production-apply\.mjs --inspect/);
});

test('production preconditions: the pinned login and the shared rules; the index only at the Supabase definition or its own, no other per-check unique index', () => {
  const text = fs.readFileSync(path.join(ROOT, SQL148_FILE), 'utf8');
  const [entry] = RELEASE_SQL_SPECS[KEY].indexes;
  const at = (def) => ({ [`${TABLE} ${INDEX}`]: def == null ? { exists: false } : { exists: true, def: collapse(def) } });
  const state = (over = {}) => ({
    current_user: COMMITTED.admin_login, session_user: COMMITTED.admin_login,
    prerequisites_missing: [], predecessors_applied: true, successors_applied: [], dropped_function_callers: [], dependents: {},
    functions: { [IDENTITY]: { exists: false } }, definer: { [TABLE]: true }, indexes: at(entry.replaces[0].def),
    counts: { other_per_check_unique_indexes: 0 },
    ...over,
  });
  const pre = (over) => releaseProductionPreconditionFailures(KEY, state(over), COMMITTED, text);
  assert.deepEqual(pre(), []);
  assert.deepEqual(pre({ indexes: at(entry.def) }), []);
  assert.deepEqual(pre({ indexes: at(null) }), ['replaced_indexes_replaceable']);
  assert.deepEqual(pre({ indexes: at(entry.replaces[0].def.replace('(check_intake_item_id)', '(check_intake_item_id, status)')) }), ['replaced_indexes_replaceable']);
  assert.deepEqual(pre({ counts: { other_per_check_unique_indexes: 2 } }), ['no_other_per_check_unique_index']);
  assert.deepEqual(pre({ definer: { [TABLE]: false } }), ['definer_can_write_relations']);
  assert.deepEqual(pre({ current_user: 'someone_else' }), ['login_is_pinned_admin']);
  // The intended state (the function and the re-keyed index) is not the pre-state.
  assert.notEqual(releaseStateHash(KEY, releaseIntendedState(KEY, text)), releaseStateHash(KEY, releaseReplacedPreState(KEY)));
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
  // record-and-retire change, allows only the manifest bound to its recorded pre-state: not another hash, not the
  // intended state.
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-11-10 (test copy of the execute-authorized pin before its record-and-retire change)' });
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql148_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);
  // The retired committed pin refuses before connecting.
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql148_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_EXTERNAL_DISBURSEMENT_RECORD' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql148-cli-${process.pid}.json`);
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
