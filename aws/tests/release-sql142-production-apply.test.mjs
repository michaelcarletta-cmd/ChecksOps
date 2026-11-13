/**
 * Production tool for SQL 142 (scripts/deployment-guard/sql142-mortgage-companies-tenant-admin-write-production-
 * apply.mjs on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 142 included) through the shared
 * refusals; this file covers SQL 142's own:
 *
 *   - the pin has the release pin shape plus the applied record; it was execute-authorized (owner-approved pin
 *     change of 2026-11-05, #1614) with the recorded production pre-state (read-only inspect; the derived one, the
 *     same one staging had) and the staging apply as its acceptance, then applied on 2026-11-05 and retired
 *     (execute false); it is in step with the staging pin, the one-shot, the bypass inventory and the test lists;
 *   - no predecessor; no function; the two tenant-admin policies on mortgage_companies; no table, view, trigger, drop
 *     or grant; no overlay plan entry; the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; an execute-authorized copy of the committed
 *     (retired) pin allows only the manifest bound to its recorded pre-state, and the retired pin itself refuses
 *     before connecting; an approved, accepted copy evaluates for the manifest built from
 *     it, and refuses with execute false, another live hash, another staging reference or a wrong phrase; the CLI
 *     spends no receipt.
 * The behaviour on PostgreSQL 16 is aws/tests/sql142-mortgage-companies-tenant-admin-tool-pg.test.mjs; the
 * executor path is aws/tests/release-sql142-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql142-mortgage-companies-tenant-admin-write-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql142';
const SQL142_FILE = 'aws/workflows/sql/142_mortgage_companies_tenant_admin_write.sql';
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
// SQL 142's recorded production pre-state (read-only inspect of 2026-11-04, SSM 1252efe9, main c8832e178): both
// policies absent, the derived pre-state; staging recorded the same pre-state (read-live runs 41927312617, 41931277648).
const PRODUCTION_PRE = 'ae3be52e6cdd57b9ba779e573a0e1cdab53c793a63893044fb124efbe81238f3';
// The guarded staging apply (wave 37).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/41931631914';
// SQL 142's production apply of 2026-11-05 (main 2284a5e77), recorded in applied, on the owner's "apply SQL 142 in production".
const SQL142_APPLIED = Object.freeze({ ssm: '9162c542-13a6-4a2b-8aa7-336a355edef5', run: 'd1a23219-f0c1-4a9b-92bd-4694b99e1d9f', one_use_id: 'sql142-prod-4ba0d62c-0745-4a88-b2f8-4dafb53617e9', commit: '2284a5e77c9e47edddcf326e9f551396625f55da', workstream: 'prod-sql142-mortgage-companies-tenant-admin-20261105', approval: 'apply SQL 142 in production' });
// The separate one-shot --phase inspect before the apply.
const PRE_INSPECT_SSM = '0c6dc81e-bf30-4153-978e-b771fe3b83c1';
const PRE_INSPECT_RUN = 'd2bccc09-17dd-430d-9e49-09b9207773c6';
const COUNTS = Object.freeze({ mortgage_companies_rls_enabled: 1, mortgage_companies_is_active_boolean: 1, mortgage_companies_owner_policy_intact: 1, mortgage_companies_no_unexpected_policy: 1 });
const OWNER_WORDS = Object.freeze(['"Option 2"', '"record the SQL 142 staging pin"', '"apply SQL 142 in staging"', '"SQL 142 accepted in staging"', '"merge 1608 and run the read-only production check"', '"record the SQL 142 production pin"']);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql142-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-10-31T00:00:00.000Z',
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
  // Applied 2026-11-05 and retired. The pin change (#1614) recorded the read-only production inspect (SSM 1252efe9,
  // main c8832e178) as the pre-state and the staging apply (run 41931631914) as the acceptance; its words named the
  // staging steps, the inspect and the pin change, and the apply run had the owner's own words for it.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-11-05; execute is false again/);
  assert.doesNotMatch(pin.authorization, /^Owner approved/);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /none of them words for the production apply/);
  assert.ok(pin.authorization.includes('#1614'));
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE.slice(0, 8)} -> ${pin.intended_replacement_sha256.slice(0, 8)}`));
  assert.ok(pin.authorization.includes(SQL142_APPLIED.workstream));
  assert.ok(pin.authorization.includes(`"${SQL142_APPLIED.approval}"`));
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied.date, '2026-11-05');
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.applied.apply_ssm_command_id, SQL142_APPLIED.ssm);
  assert.equal(pin.applied.one_shot_run_id, SQL142_APPLIED.run);
  assert.equal(pin.applied.one_use_id, SQL142_APPLIED.one_use_id);
  assert.equal(pin.applied.one_use_id_consumed, true);
  assert.equal(pin.applied.workstream_id, SQL142_APPLIED.workstream);
  assert.equal(pin.applied.source_commit, SQL142_APPLIED.commit);
  assert.equal(pin.applied.source_tarball.sha256, 'b454cb3d006dd2bdbc6d3559d871b4df43c493b7198671bca5891a2574fc5445');
  assert.equal(pin.applied.migration_source_sha256, pin.source_sha256);
  assert.equal(pin.applied.owner_approval, SQL142_APPLIED.approval);
  assert.ok(pin.applied.owner_approval_basis.includes('#1614'));
  assert.equal(pin.applied.operator, 'michaelcarletta-cmd');
  assert.equal(pin.applied.runner, 'i-0c35557c4e5385406');
  assert.deepEqual(pin.applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  // The transfer run, the separate --phase inspect before the apply, and that the JSON arrived whole. Production
  // acceptance was not yet reported when this was recorded, and the record says so.
  assert.match(pin.applied.one_shot_note, /transfer run 41959100471/);
  assert.ok(pin.applied.one_shot_note.includes(PRE_INSPECT_SSM));
  assert.ok(pin.applied.one_shot_note.includes(PRE_INSPECT_RUN));
  assert.match(pin.applied.one_shot_note, /The run's JSON arrived whole/);
  assert.match(pin.applied.one_shot_note, /Production acceptance: not yet reported by the owner/);
  assert.equal(pin.applied.manifest_sha256, '8b9d7f4842d7a9f9817d2268c4ba78c4367a021f41b732089dd23536dcb2d1a7');
  assert.deepEqual(Object.values(pin.applied.contract_results).map((c) => c.evidence.split(' ')[0]), ['4/4', '6/6', '43/43']);
  for (const c of Object.values(pin.applied.contract_results)) assert.ok(c.evidence.includes(SQL142_APPLIED.run), c.test);
  assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.applied.pre_apply_inspect.live_matches_expected, true);
  assert.equal(pin.applied.pre_apply_inspect.already_applied, false);
  assert.deepEqual(pin.applied.pre_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.pre_apply_inspect.predecessors, {});
  assert.deepEqual(pin.applied.pre_apply_inspect.counts, COUNTS);
  assert.equal(pin.applied.receipt.before_hash, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.applied.receipt.workstream, SQL142_APPLIED.workstream);
  assert.equal(pin.applied.receipt.commit, SQL142_APPLIED.commit);
  assert.equal(pin.applied.receipt.sql_file, SQL142_FILE);
  assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '28044dcf685204deee0258357aa25e738d4171894d3fa49365b03aee70e90d06');
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.policies, 476);
  assert.equal(pin.applied.receipt.unrelated_catalog_counts.functions, 1357);
  assert.equal(pin.applied.receipt.result, 'applied');
  assert.equal(pin.applied.post_apply_inspect.already_applied, true);
  assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.post_apply_inspect.predecessors, {});
  assert.deepEqual(pin.applied.post_apply_inspect.counts, COUNTS);
  // The two tenant-admin policies intended; no function, no prerequisite missing.
  const post = pin.applied.post_apply_inspect.release_sql_inspect;
  assert.deepEqual(post.policies, [
    { name: 'mortgage_companies aws_insert_mortgage_companies_tenant_admin', state: 'intended' },
    { name: 'mortgage_companies aws_update_mortgage_companies_tenant_admin', state: 'intended' },
  ]);
  assert.deepEqual(post.functions, []);
  assert.deepEqual(post.prerequisites_missing, []);
  assert.deepEqual(post.counts, COUNTS);
  assert.deepEqual(pin.applied.receipt.release_sql_inspect, post);
  for (const evidence of [SQL142_APPLIED.ssm, SQL142_APPLIED.run, SQL142_APPLIED.one_use_id, PRE_INSPECT_SSM, `"${SQL142_APPLIED.approval}"`]) {
    assert.ok(pin.production_evidence['2026-11-05 apply'].includes(evidence), evidence);
  }
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-04');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '1252efe9-757d-4366-ad9e-9901488b4a7a');
  assert.equal(pin.production_inspect.source_commit, 'c8832e178aa03684e99a34fabd80917f2fcfd215');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('2e56a4ee375d835e8814a88154aa78da34a211ebc69737d558b26554120e2b74'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /counts mortgage_companies_rls_enabled 1, mortgage_companies_is_active_boolean 1, mortgage_companies_owner_policy_intact 1, mortgage_companies_no_unexpected_policy 1; prerequisites_missing \[\]/);
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no read-only production inspect has been run for SQL 142 yet.'));
  for (const word of ['prerequisites_missing', 'already_applied', 'mortgage_companies_rls_enabled', 'mortgage_companies_is_active_boolean', 'mortgage_companies_owner_policy_intact', 'mortgage_companies_no_unexpected_policy', 'Production is unverified', 'ae3be52e6cdd57b9ba779e573a0e1cdab53c793a63893044fb124efbe81238f3']) {
    assert.ok(pin.production_inspect.note.includes(word), word);
  }
  for (const code of ['sql142_table_missing', 'sql142_rls_disabled', 'sql142_is_active_missing', 'sql142_owner_policy_missing', 'sql142_owner_policy_collision',
    'sql142_unexpected_policy', 'sql142_function_missing', 'The pre-state is derivable', '20:28:16Z']) {
    assert.ok(pin.order_note.includes(code), code);
  }
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql142-mortgage-companies-tenant-admin-write, run 41931631914/);
  assert.match(pin.staging_acceptance.basis, /deploy run 41930617688/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 41932005822 then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /"SQL 142 accepted in staging"/);
  assert.ok(pin.staging_acceptance.basis.includes(`before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin recorded the same pre-state (wave 37): both policies absent in both environments.
  assert.equal(staging.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.equal(pin.filename, SQL142_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, read(SQL142_FILE)));
  assert.deepEqual(pin.function_identities, []);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_MORTGAGE_COMPANIES_TENANT_ADMIN_WRITE');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql142-mortgage-companies-tenant-admin-write-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-142-apply.md');
  for (const file of [pin.tooling.production_tool, pin.tooling.runbook, pin.tooling.fingerprint_engine, pin.tooling.production_lib, ...pin.tooling.tests]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  assert.equal(readPinnedReleaseSql(KEY, ROOT, pin).ok, true);
  const tool = ONE_SHOT_TOOLS[KEY];
  assert.equal(tool.key, KEY);
  assert.equal(tool.script, RELEASE_PRODUCTION[KEY].cli);
  assert.deepEqual([...tool.args], []);
  assert.equal(tool.pin_rel, RELEASE_PRODUCTION[KEY].pin_rel);
  assert.equal(tool.allowed_key, 'sql142_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql142-mortgage-companies-tenant-admin-write-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql142-production-apply"\]/);
  assert.match(rows, /sql138, sql139, sql140, sql141, sql142, sql143, sql144, sql145, sql146, sql147, sql148, sql150, sql152, sql153, sql154, sql155, sql156, sql158, sql159, sql160, sql161, sql162, sql163, sql164, sql165\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = read('.github/workflows/deployment-guard.yml');
  for (const name of ['aws/tests/release-sql142-executor.test.mjs', 'aws/tests/release-sql142-production-apply.test.mjs', 'aws/tests/sql142-mortgage-companies-tenant-admin-tool-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; no function; the two tenant-admin policies on mortgage_companies; no plan entry; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.deepEqual(spec.functions, []);
  assert.deepEqual(spec.policies.map((p) => `${p.table} ${p.name}`), ['public.mortgage_companies aws_insert_mortgage_companies_tenant_admin', 'public.mortgage_companies aws_update_mortgage_companies_tenant_admin']);
  for (const none of ['tables', 'views', 'triggers', 'dropped_functions', 'dropped_policies', 'dropped_triggers', 'added_columns', 'column_acl', 'table_privileges', 'indexes', 'acl_functions']) {
    assert.ok(spec[none] === undefined || spec[none].length === 0, none);
  }
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.ok(!JSON.stringify(plan).includes(SQL142_FILE));
  const runbook = read(COMMITTED.tooling.runbook);
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 37\) and to production \(2026-11-05\); the production pin is retired/);
  // Owner production acceptance, recorded after the fact without changing the applied record: "1 and 2 work."
  assert.match(runbook, /\*\*Production acceptance \(2026-11-05\)\.\*\*[\s\S]*"1 and 2 work\."/);
  assert.match(runbook, /owner production acceptance 2026-11-05\./);
  assert.match(runbook, /\*\*Production apply \(2026-11-05\)\.\*\*/);
  for (const evidence of [SQL142_APPLIED.ssm, SQL142_APPLIED.run, SQL142_APPLIED.workstream, PRE_INSPECT_SSM, '41959100471', `"${SQL142_APPLIED.approval}"`]) {
    assert.ok(runbook.includes(evidence), evidence);
  }
  assert.match(runbook, /SSM\s+`1252efe9-757d-4366-ad9e-9901488b4a7a`/);
  assert.match(runbook, /"SQL 142 accepted in staging"/);
  assert.match(runbook, /\*\*Staging apply \(2026-11-04\)\.\*\* Apply run 41931631914/);
  assert.match(runbook, /Read-live run 41932005822/);
  assert.match(runbook, /APPLY_MORTGAGE_COMPANIES_TENANT_ADMIN_WRITE/);
  assert.match(runbook, /da2687b5/);
  const oneShot = read('ops/production-sql-one-shot.md');
  assert.match(oneShot, /\| `sql142` \|/);
  assert.match(oneShot, /`sql139`, `sql140`, `sql141`, `sql142`, `sql143`, `sql144`, `sql145`, `sql146`, `sql147`, `sql148`, `sql150`, `sql152`, `sql153`, `sql154`, `sql155`, `sql156`, `sql158`, `sql159`, `sql160`, `sql161`, `sql162`, `sql163`, `sql164`, `sql165`\) \|/);
  assert.match(read('ops/deployment-guard/README.md'), /sql142-mortgage-companies-tenant-admin-write-production-apply\.mjs --inspect/);
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

  // The committed (authorized) pin allows only the manifest bound to its recorded pre-state: not
  // another hash, not the intended state.
  // The committed pin is retired (execute false): an execute-authorized copy of it, before the
  // record-and-retire change, allows only the manifest bound to its recorded pre-state.
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-11-05 (test copy of the execute-authorized pin before its record-and-retire change)' });
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql142_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);
  // The retired committed pin refuses before connecting.
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql142_production_apply_allowed, true);
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
  const file = path.join(os.tmpdir(), `sql142-cli-${process.pid}.json`);
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
