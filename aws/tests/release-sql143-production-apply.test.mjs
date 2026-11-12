/**
 * Production tool for SQL 143 (scripts/deployment-guard/sql143-mortgage-companies-member-delete-unused-production-
 * apply.mjs on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 143 included) through the shared
 * refusals; this file covers SQL 143's own:
 *
 *   - the pin has the release pin shape plus the applied record; it was execute-authorized (owner-approved pin
 *     change of 2026-11-05, #1624) with the recorded production pre-state (read-only inspect; the derived one, the
 *     same one staging had) and the staging apply as its acceptance, then applied on 2026-11-05 and retired
 *     (execute false); it is in step with the staging pin, the one-shot, the bypass inventory and the test lists;
 *   - predecessor SQL 142 (superseded); the two functions, the three member policies, SQL 142's two dropped and the
 *     in-use trigger on mortgage_companies; no table, view, column or grant; no overlay plan entry; the runbook,
 *     one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; an execute-authorized copy of the committed
 *     (retired) pin allows only the manifest bound to its recorded pre-state, and the retired pin itself refuses
 *     before connecting; an approved, accepted copy evaluates for the manifest built from
 *     it, and refuses with execute false, another live hash, another staging reference or a wrong phrase; the CLI
 *     spends no receipt.
 * The behaviour on PostgreSQL 16 is aws/tests/sql143-mortgage-companies-member-delete-tool-pg.test.mjs; the
 * executor path is aws/tests/release-sql143-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql143-mortgage-companies-member-delete-unused-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql143';
const SQL143_FILE = 'aws/workflows/sql/143_mortgage_companies_member_delete_unused.sql';
const PRE_SQL142 = 'c62a1b0b337cca713cd8551f1a1c70f507ef451e40731baa6e8479abae51038d';
const FUNCTIONS = ['public.aws_can_edit_mortgage_company_directory()', 'public.aws_mortgage_company_in_use_guard()'];
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
// SQL 143's recorded production pre-state (read-only inspect of 2026-11-05, SSM 34e080cb, main 9e2b0da69): SQL 142's
// two policies, nothing of SQL 143, the derived pre-state; staging recorded the same (read-live runs 42020037212, 42023189620).
const PRODUCTION_PRE = PRE_SQL142;
// The guarded staging apply (wave 38).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/42023495275';
const OWNER_WORDS = Object.freeze(['"record the SQL 143 staging pin"', '"apply SQL 143 in staging"', '"SQL 143 accepted in staging"', '"run the read-only production check for SQL 143"', '"record the SQL 143 production pin"']);
// SQL 143's production apply of 2026-11-05 (main 5446fd292), recorded in applied, on the owner's "apply SQL 143 in production".
const SQL143_APPLIED = Object.freeze({ ssm: 'fecb38b8-9305-41e2-a44b-6e3a0a928f06', run: '2bdbab74-39ad-46a1-8371-f51ce6c532c0', one_use_id: 'sql143-prod-f74ec3d8-c8f5-413b-aef3-ea69b54c7155', commit: '5446fd29246e8a60bb2ffabaa53dade2b6edf6fe', workstream: 'prod-sql143-mortgage-companies-member-delete-unused-20261105', approval: 'apply SQL 143 in production' });
// The separate one-shot --phase inspect before the apply.
const PRE_INSPECT_SSM = '8faa26ab-2dd5-4cf4-922a-a41275a975fe';
const PRE_INSPECT_RUN = '6bfcd677-9a89-4ac9-904b-c7791dec933b';
const COUNTS = Object.freeze({ mortgage_companies_rls_enabled: 1, mortgage_companies_id_uuid_is_active_boolean: 1, mortgage_company_references_uuid: 1, mortgage_companies_owner_policy_intact: 1, mortgage_companies_sql142_policies_replaceable: 1, mortgage_companies_no_unexpected_policy: 1, mortgage_company_references_readable_by_login: 1 });
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql143-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-11-05T00:00:00.000Z',
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


test('pin: the release pin shape, applied and retired (owner approved 2026-11-05, on the staging apply; applied 2026-11-05), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Applied 2026-11-05 and retired. The pin change (#1624) recorded the read-only production inspect (SSM 34e080cb,
  // main 9e2b0da69) as the pre-state and the staging apply (run 42023495275) as the acceptance; its words named the
  // staging steps, the inspect and the pin change, and the apply run had the owner's own words for it.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-11-05; execute is false again/);
  assert.doesNotMatch(pin.authorization, /^Owner approved/);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /none of them words for the production apply/);
  assert.ok(pin.authorization.includes('#1624'));
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE.slice(0, 8)} -> ${pin.intended_replacement_sha256.slice(0, 8)}`));
  assert.ok(pin.authorization.includes(SQL143_APPLIED.workstream));
  assert.ok(pin.authorization.includes(`"${SQL143_APPLIED.approval}"`));
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied.date, '2026-11-05');
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.applied.apply_ssm_command_id, SQL143_APPLIED.ssm);
  assert.equal(pin.applied.one_shot_run_id, SQL143_APPLIED.run);
  assert.equal(pin.applied.one_use_id, SQL143_APPLIED.one_use_id);
  assert.equal(pin.applied.one_use_id_consumed, true);
  assert.equal(pin.applied.workstream_id, SQL143_APPLIED.workstream);
  assert.equal(pin.applied.source_commit, SQL143_APPLIED.commit);
  assert.equal(pin.applied.source_tarball.sha256, '4e1e2a207bd1385798615bb8123e4e9c5d99a257b48c0633cbfea02d6ce8f196');
  assert.equal(pin.applied.migration_source_sha256, pin.source_sha256);
  assert.equal(pin.applied.owner_approval, SQL143_APPLIED.approval);
  assert.ok(pin.applied.owner_approval_basis.includes('#1624'));
  assert.equal(pin.applied.operator, 'michaelcarletta-cmd');
  assert.equal(pin.applied.runner, 'i-0c35557c4e5385406');
  assert.deepEqual(pin.applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  // The transfer run, the separate --phase inspect before the apply, and that SSM cut the JSON inside applied.receipt
  // (receipt and post_apply_inspect come from the run's top-level details, which arrived whole). Production
  // acceptance was not yet reported when this was recorded, and the record says so.
  assert.match(pin.applied.one_shot_note, /transfer run 42053822728/);
  assert.ok(pin.applied.one_shot_note.includes(PRE_INSPECT_SSM));
  assert.ok(pin.applied.one_shot_note.includes(PRE_INSPECT_RUN));
  assert.match(pin.applied.one_shot_note, /The run's JSON did not arrive whole/);
  assert.match(pin.applied.one_shot_note, /details\.apply_result and details\.post_apply_inspect, which arrived whole/);
  assert.match(pin.applied.one_shot_note, /Production acceptance: not yet reported by the owner/);
  assert.equal(pin.applied.manifest_sha256, '6391c149ce74b61015081e45c8c6d658e3c9c268a0a4fe4a43a37ea2bd8508f1');
  assert.deepEqual(Object.values(pin.applied.contract_results).map((c) => c.evidence.split(' ')[0]), ['4/4', '6/6', '43/43']);
  for (const c of Object.values(pin.applied.contract_results)) assert.ok(c.evidence.includes(SQL143_APPLIED.run), c.test);
  assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.applied.pre_apply_inspect.live_matches_expected, true);
  assert.equal(pin.applied.pre_apply_inspect.already_applied, false);
  assert.deepEqual(pin.applied.pre_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.pre_apply_inspect.predecessors, { sql142: true });
  assert.deepEqual(pin.applied.pre_apply_inspect.counts, COUNTS);
  assert.equal(pin.applied.receipt.before_hash, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.applied.receipt.workstream, SQL143_APPLIED.workstream);
  assert.equal(pin.applied.receipt.commit, SQL143_APPLIED.commit);
  assert.equal(pin.applied.receipt.sql_file, SQL143_FILE);
  assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '28044dcf685204deee0258357aa25e738d4171894d3fa49365b03aee70e90d06');
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.policies, 476);
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.functions, 1357);
  assert.equal(pin.applied.receipt.result, 'applied');
  assert.equal(pin.applied.post_apply_inspect.already_applied, true);
  assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.post_apply_inspect.predecessors, { sql142: true });
  assert.deepEqual(pin.applied.post_apply_inspect.counts, COUNTS);
  // Both functions, the three member policies, SQL 142's two dropped and the trigger intended; no prerequisite missing.
  const post = pin.applied.post_apply_inspect.release_sql_inspect;
  assert.deepEqual(post.functions.map((f) => [f.name, f.state]), [['aws_can_edit_mortgage_company_directory()', 'intended'], ['aws_mortgage_company_in_use_guard()', 'intended']]);
  assert.deepEqual(post.policies.map((p) => [p.name, p.state]), [
    ['mortgage_companies aws_insert_mortgage_companies_member', 'intended'],
    ['mortgage_companies aws_update_mortgage_companies_member', 'intended'],
    ['mortgage_companies aws_delete_mortgage_companies_member', 'intended'],
    ['mortgage_companies aws_insert_mortgage_companies_tenant_admin', 'intended'],
    ['mortgage_companies aws_update_mortgage_companies_tenant_admin', 'intended'],
  ]);
  assert.deepEqual(post.triggers.map((t) => [t.name, t.state]), [['mortgage_companies aws_mortgage_company_in_use_guard', 'intended']]);
  assert.deepEqual(post.prerequisites_missing, []);
  assert.deepEqual(pin.applied.receipt.release_sql_inspect, post);
  for (const evidence of [SQL143_APPLIED.ssm, SQL143_APPLIED.run, SQL143_APPLIED.one_use_id, PRE_INSPECT_SSM, `"${SQL143_APPLIED.approval}"`]) {
    assert.ok(pin.production_evidence['2026-11-05 apply'].includes(evidence), evidence);
  }
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-05');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '34e080cb-a508-4f8f-9969-a7433619d673');
  assert.equal(pin.production_inspect.source_commit, '9e2b0da690821fdc89dc0f433b42121f4295731f');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('9b38212579bb7fc90b819c81256cbc978cf0ae3fd53d1596209d021eb997f5b3'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /mortgage_companies_sql142_policies_replaceable 1, mortgage_companies_no_unexpected_policy 1, mortgage_company_references_readable_by_login 1; prerequisites_missing \[\]/);
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no read-only production inspect has been run for SQL 143 yet.'));
  for (const word of ['prerequisites_missing', 'already_applied', 'predecessors {sql142: true}', 'the seven counts 1', 'Production is unverified', PRE_SQL142]) {
    assert.ok(pin.production_inspect.note.includes(word), word);
  }
  for (const code of ['sql143_table_missing', 'sql143_rls_disabled', 'sql143_column_missing', 'sql143_reference_missing', 'sql143_owner_policy_missing',
    'sql143_owner_policy_collision', 'sql143_sql142_policy_collision', 'sql143_sql142_policy_missing', 'sql143_unexpected_policy',
    'sql143_guard_cannot_see_all_rows', 'sql143_function_missing', 'mortgage_companies_rls_enabled', 'mortgage_companies_id_uuid_is_active_boolean',
    'mortgage_company_references_uuid', 'mortgage_companies_owner_policy_intact', 'mortgage_companies_sql142_policies_replaceable',
    'mortgage_companies_no_unexpected_policy', 'mortgage_company_references_readable_by_login', 'The pre-state after SQL 142 is derivable',
    'Remove should delete it']) {
    assert.ok(pin.order_note.includes(code), code);
  }
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql143-mortgage-companies-member-delete-unused, run 42023495275/);
  assert.match(pin.staging_acceptance.basis, /deploy run 42022476995/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 42023847018 then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /"SQL 143 accepted in staging"/);
  assert.ok(pin.staging_acceptance.basis.includes(`before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin recorded the same pre-state (wave 38).
  assert.equal(staging.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.equal(pin.filename, SQL143_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, read(SQL143_FILE)));
  assert.deepEqual(pin.function_identities, FUNCTIONS);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, ['sql142']);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_MORTGAGE_COMPANIES_MEMBER_DELETE_UNUSED');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql143-mortgage-companies-member-delete-unused-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-143-apply.md');
  for (const file of [pin.tooling.production_tool, pin.tooling.runbook, pin.tooling.fingerprint_engine, pin.tooling.production_lib, ...pin.tooling.tests]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  assert.equal(readPinnedReleaseSql(KEY, ROOT, pin).ok, true);
  const tool = ONE_SHOT_TOOLS[KEY];
  assert.equal(tool.key, KEY);
  assert.equal(tool.script, RELEASE_PRODUCTION[KEY].cli);
  assert.deepEqual([...tool.args], []);
  assert.equal(tool.pin_rel, RELEASE_PRODUCTION[KEY].pin_rel);
  assert.equal(tool.allowed_key, 'sql143_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql143-mortgage-companies-member-delete-unused-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql143-production-apply"\]/);
  assert.match(rows, /sql139, sql140, sql141, sql142, sql143, sql144, sql145, sql146, sql147, sql148, sql150, sql152, sql153, sql154, sql155, sql156, sql158, sql159\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = read('.github/workflows/deployment-guard.yml');
  for (const name of ['aws/tests/release-sql143-executor.test.mjs', 'aws/tests/release-sql143-production-apply.test.mjs', 'aws/tests/sql143-mortgage-companies-member-delete-tool-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: predecessor SQL 142, which it supersedes; the two functions, the three member policies, SQL 142\'s two dropped and the in-use trigger on mortgage_companies; no plan entry; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, ['sql142']);
  assert.deepEqual(spec.supersedes, ['sql142']);
  assert.deepEqual(spec.functions.map((fn) => fn.identity), FUNCTIONS);
  assert.deepEqual(spec.policies.map((p) => `${p.table} ${p.name}`), ['public.mortgage_companies aws_insert_mortgage_companies_member',
    'public.mortgage_companies aws_update_mortgage_companies_member', 'public.mortgage_companies aws_delete_mortgage_companies_member']);
  assert.deepEqual(spec.dropped_policies.map((p) => `${p.table} ${p.name}`), ['public.mortgage_companies aws_insert_mortgage_companies_tenant_admin',
    'public.mortgage_companies aws_update_mortgage_companies_tenant_admin']);
  assert.deepEqual(spec.triggers.map((tr) => `${tr.table} ${tr.name}`), ['public.mortgage_companies aws_mortgage_company_in_use_guard']);
  for (const none of ['tables', 'views', 'dropped_functions', 'dropped_triggers', 'added_columns', 'column_acl', 'table_privileges', 'indexes', 'acl_functions']) {
    assert.ok(spec[none] === undefined || spec[none].length === 0, none);
  }
  // The DB validator followed the staging apply (run 42023495275), as 4a3f4658e did for SQL 123, and justifies the
  // trigger by name (185; 187 since SQL 152's two followed; 189 since SQL 154's two; 190 since SQL 155's). Its production overlay row waited
  // for SQL 143 in production (sql_before; applied by run 42058917794), moved on to the SQL 152 validator REPLACE
  // (sql_before SQL 152; applied by run 43034879124) and then to the SQL 154 validator REPLACE (sql_before SQL 154);
  // staging records SQL 143 live (read-live run 42023847018).
  const validator = read('aws/functions/api/db-readonly-validate.mjs');
  assert.match(validator, /trigger: 'aws_mortgage_company_in_use_guard',\n\s+functionName: 'aws_mortgage_company_in_use_guard'/);
  assert.match(validator, /export const EXPECTED_PUBLIC_TRIGGERS = 190;/);
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.deepEqual(Object.keys(plan.members).filter((m) => plan.members[m].sql_before === SQL143_FILE), []);
  assert.equal(plan.members['db-readonly-validate.mjs'].sql_before, 'aws/workflows/sql/154_tenant_starter_package.sql');
  // This record states SQL 143 verified live in production, which lifts the validator's hold.
  const prerequisite = plan.sql_prerequisites[SQL143_FILE];
  assert.equal(prerequisite.verified_live, true);
  assert.equal(prerequisite.pin, RELEASE_PRODUCTION[KEY].pin_rel);
  for (const evidence of [SQL143_APPLIED.ssm, SQL143_APPLIED.run, SQL143_APPLIED.one_use_id, PRE_INSPECT_SSM, 'staging acceptance run 42023495275']) {
    assert.ok(prerequisite.evidence.includes(evidence), evidence);
  }
  assert.match(prerequisite.note, /holds db-readonly-validate\.mjs \(REPLACE, sql_before SQL 143\)/);
  const stagingLive = readJson('ops/deployment-guard/staging-sql-live.json').sql[SQL143_FILE];
  assert.equal(stagingLive.verified_live, true);
  for (const evidence of ['run 42023495275', 'read-live run 42023847018', `after ${COMMITTED.intended_replacement_sha256.slice(0, 8)}…`]) {
    assert.ok(stagingLive.evidence.includes(evidence), evidence);
  }
  const runbook = read(COMMITTED.tooling.runbook);
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.ok(runbook.includes(PRE_SQL142));
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 38\) and to production \(2026-11-05\); the production pin is retired/);
  // Owner production acceptance, recorded after the fact without changing the applied record: "1 and 2 work."
  assert.match(runbook, /\*\*Production acceptance \(2026-11-05\)\.\*\*[\s\S]*"1 and 2 work\."/);
  assert.match(runbook, /owner production acceptance 2026-11-05\./);
  assert.match(runbook, /\*\*Production apply \(2026-11-05\)\.\*\*/);
  for (const evidence of [SQL143_APPLIED.ssm, SQL143_APPLIED.run, SQL143_APPLIED.workstream, PRE_INSPECT_SSM, '42053822728', `"${SQL143_APPLIED.approval}"`]) {
    assert.ok(runbook.includes(evidence), evidence);
  }
  assert.match(runbook, /SSM\s+`34e080cb-a508-4f8f-9969-a7433619d673`/);
  assert.match(runbook, /"SQL 143 accepted in staging"/);
  assert.match(runbook, /\*\*Staging apply \(2026-11-05\)\.\*\* Apply run 42023495275/);
  assert.match(runbook, /Read-live run 42023847018/);
  assert.match(runbook, /APPLY_MORTGAGE_COMPANIES_MEMBER_DELETE_UNUSED/);
  const oneShot = read('ops/production-sql-one-shot.md');
  assert.match(oneShot, /\| `sql143` \|/);
  assert.match(oneShot, /`sql140`, `sql141`, `sql142`, `sql143`, `sql144`, `sql145`, `sql146`, `sql147`, `sql148`, `sql150`, `sql152`, `sql153`, `sql154`, `sql155`, `sql156`, `sql158`, `sql159`\) \|/);
  assert.match(read('ops/deployment-guard/README.md'), /sql143-mortgage-companies-member-delete-unused-production-apply\.mjs --inspect/);
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
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-11-05 (test copy of the execute-authorized pin before its record-and-retire change)' });
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql143_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);
  // The retired committed pin refuses before connecting.
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql143_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_MORTGAGE_COMPANIES' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql143-cli-${process.pid}.json`);
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
