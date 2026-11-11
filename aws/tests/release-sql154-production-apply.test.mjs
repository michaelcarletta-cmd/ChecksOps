/**
 * Production tool for SQL 154 (scripts/deployment-guard/sql154-tenant-starter-package-production-apply.mjs on
 * lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs).
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 154 included) through the shared refusals;
 * this file covers SQL 154's own:
 *
 *   - the pin has the release pin shape plus the applied record; it was execute-authorized (owner-approved pin change
 *     of 2026-11-11, #1780) with the recorded production pre-state (read-only inspect; the derived one, the same one
 *     staging had) and the staging apply as its acceptance, then applied on 2026-11-11 and retired (execute false); it is
 *     in step with the staging pin, the one-shot, the bypass inventory and the test lists;
 *   - predecessor SQL 102 (supersedes SQL 102 and SQL 98); four functions with their reviewed ACLs (the Checks used
 *     and the setter for checksops and the owner) and SQL 102's guard replaced with its ACL kept, five columns, the
 *     CHECK and two triggers; the overlay plan holds tenant-billing-engine.mjs and tenant-billing-handlers.mjs on
 *     SQL 154 (recorded live 2026-11-11); SQL 151 has no pin; the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; an execute-authorized copy of the committed
 *     (retired) pin allows only the manifest bound to its recorded pre-state, and the retired pin itself refuses before
 *     connecting; an approved, accepted copy evaluates for the manifest built from it,
 *     and refuses with execute false, another live hash, another staging reference or a wrong phrase; the CLI spends no
 *     receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql154-starter-package-pg.test.mjs; the executor path is
 * aws/tests/release-sql154-executor.test.mjs.
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
import { RELEASE_SQL_KEYS, RELEASE_SQL_SPECS, releaseIntendedHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import {
  RELEASE_PRODUCTION,
  evaluateReleaseProductionApply,
  executeReleaseProductionApply,
  loadReleaseProductionPin,
  precheckReleaseProductionApply,
  readPinnedReleaseSql,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { main } from '../../scripts/deployment-guard/sql154-tenant-starter-package-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql154';
const SQL154_FILE = 'aws/workflows/sql/154_tenant_starter_package.sql';
const SQL151_FILE = 'aws/workflows/sql/' + '151_tenant_starter_package.sql';
const GUARD = 'public.aws_tenants_member_column_guard()';
const ACLS = Object.freeze({
  'public.aws_starter_package_checks_used(uuid)': ['checksops EXECUTE', 'owner EXECUTE'],
  'public.aws_apply_starter_package_to_event()': ['owner EXECUTE'],
  'public.aws_platform_owner_set_tenant_starter_package(uuid, boolean, date, date, integer)': ['checksops EXECUTE', 'owner EXECUTE'],
  'public.aws_tenant_starter_package_audit_row()': ['owner EXECUTE'],
  [GUARD]: ['PUBLIC EXECUTE', 'owner EXECUTE'],
});
const IDENTITIES = Object.freeze(Object.keys(ACLS));
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
// SQL 154's recorded production pre-state (read-only inspect of 2026-11-11, SSM b64a59d7, main 928ef7a49): SQL 102's
// guard with everything else absent, the derived pre-state (release-sql154-executor.test.mjs); staging recorded the same
// (read-live run 43033279908).
const PRODUCTION_PRE = '05fb0b9959f677fb828ee1efaf7ffce3513ea83e6d5ed071417a7511be3231ca';
// The guarded staging apply (wave 46).
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43063499920';
// SQL 154's production apply of 2026-11-11 (main 863b52230), recorded in applied, on the owner's "merge 1780 when green and apply SQL 154 in production".
const SQL154_APPLIED = Object.freeze({ ssm: 'ca26f381-f12f-41c8-a31e-2313a1a4c18b', run: 'eb19b5c7-9cd9-4925-b7d5-4dbb8f22058a', one_use_id: 'sql154-prod-deb5606d-8db0-4497-b46d-40016aa8b90b', commit: '863b522309b0f78f6dddfa3a5ec49a75b22232a0', workstream: 'prod-sql154-tenant-starter-package-20261111', approval: 'merge 1780 when green and apply SQL 154 in production' });
// The separate one-shot --phase inspect before the apply.
const PRE_INSPECT_SSM = '60fc1cf4-fccb-4621-acef-5d24d1ffd68b';
const PRE_INSPECT_RUN = '7bcade84-58d6-48b9-8438-60721e43855a';
// The owner's words for SQL 154, quoted in the authorization (no separate staging acceptance statement was given).
const OWNER_WORDS = Object.freeze(['"Redeploy the staging executor and run SQL 154 read-live"', '"Record the SQL 154 staging pin and merge it when green"', '"then apply SQL 154 in staging"', '"run the read-only SQL 154 production inspect"', '"record the SQL 154 production pin"']);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql154-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-11-11T00:00:00.000Z',
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

test('pin: the release pin shape, applied and retired (owner approved 2026-11-11, on the staging apply; applied 2026-11-11), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-11-11: the read-only production inspect (SSM b64a59d7, main 928ef7a49) recorded as
  // the pre-state; the staging apply (run 43063499920) as the acceptance.
  // Applied 2026-11-11 and retired (pin change #1780; the apply run had the owner's own words for it, passed verbatim).
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-11-11; execute is false again/);
  assert.doesNotMatch(pin.authorization, /^Owner approved/);
  for (const words of OWNER_WORDS) assert.ok(pin.authorization.includes(words), words);
  assert.match(pin.authorization, /no separate staging acceptance statement was given/);
  assert.ok(pin.authorization.includes('#1780'));
  assert.ok(pin.authorization.includes(`${PRODUCTION_PRE.slice(0, 8)} -> ${pin.intended_replacement_sha256.slice(0, 8)}`));
  assert.ok(pin.authorization.includes(SQL154_APPLIED.workstream));
  assert.ok(pin.authorization.includes(`"${SQL154_APPLIED.approval}"`));
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.applied.date, '2026-11-11');
  assert.equal(pin.applied.result, 'applied');
  assert.equal(pin.applied.apply_ssm_command_id, SQL154_APPLIED.ssm);
  assert.equal(pin.applied.one_shot_run_id, SQL154_APPLIED.run);
  assert.equal(pin.applied.one_use_id, SQL154_APPLIED.one_use_id);
  assert.equal(pin.applied.one_use_id_consumed, true);
  assert.equal(pin.applied.workstream_id, SQL154_APPLIED.workstream);
  assert.equal(pin.applied.source_commit, SQL154_APPLIED.commit);
  assert.equal(pin.applied.source_tarball.sha256, 'fe45e621f76472ad5ea1f12219e7cc6a4f4e39554e6dce8fbeef1cb980d01f7e');
  assert.equal(pin.applied.migration_source_sha256, pin.source_sha256);
  assert.equal(pin.applied.owner_approval, SQL154_APPLIED.approval);
  assert.ok(pin.applied.owner_approval_basis.includes('#1780'));
  assert.equal(pin.applied.runner, 'i-0c35557c4e5385406');
  assert.deepEqual(pin.applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  assert.match(pin.applied.one_shot_note, /transfer run 43079287025/);
  assert.ok(pin.applied.one_shot_note.includes(PRE_INSPECT_SSM));
  assert.ok(pin.applied.one_shot_note.includes(PRE_INSPECT_RUN));
  // The apply output was cut at the 24000-character SSM limit; the record says so and names what was not observed.
  assert.match(pin.applied.one_shot_note, /The run's JSON did not arrive whole: SSM StandardOutputContent is capped at 24000 characters/);
  assert.match(pin.applied.one_shot_note, /Not observed by this record:/);
  assert.match(pin.applied.one_shot_note, /Production acceptance: not yet reported by the owner/);
  assert.equal(pin.applied.manifest_sha256, 'ac9080ba3c1d34dbb91c8655cd6e2dc8d7d8b09e2b5b781e7c6e2ba38b9f2d66');
  assert.deepEqual(Object.values(pin.applied.contract_results).map((c) => c.evidence.split(' ')[0]), ['4/4', '6/6', '43/43']);
  assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.applied.pre_apply_inspect.live_matches_expected, true);
  assert.deepEqual(pin.applied.pre_apply_inspect.precondition_failures, []);
  assert.deepEqual(pin.applied.pre_apply_inspect.predecessors, { sql102: true });
  assert.equal(pin.applied.receipt.before_hash, PRODUCTION_PRE);
  assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.applied.receipt.workstream, SQL154_APPLIED.workstream);
  assert.equal(pin.applied.receipt.commit, SQL154_APPLIED.commit);
  assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '03e7ad54b5fbab4746664c529023525d0e7d0697d07622f0927ed205b83509df');
  assert.equal(pin.applied.receipt.result, 'applied');
  assert.equal(pin.applied.post_apply_inspect.already_applied, true);
  assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, []);
  const post = pin.applied.post_apply_inspect.release_sql_inspect;
  assert.deepEqual(post.functions.map((f) => [f.name, f.state]), IDENTITIES.map((identity) => [identity.replace(/^public\./, ''), 'intended']));
  assert.deepEqual(post.function_acl, IDENTITIES.map((identity) => ({ name: identity.replace(/^public\./, ''), acl: ACLS[identity] })));
  assert.ok(post.columns.length === 5 && post.columns.every((c) => c.state === 'intended'));
  assert.deepEqual(post.constraints.map((c) => [c.name, c.state]), [['tenants tenants_starter_package_valid', 'intended']]);
  assert.deepEqual(post.triggers.map((t) => [t.name, t.state]), [['check_billing_events aws_check_billing_event_starter_package', 'intended'], ['tenants aws_tenant_starter_package_audit', 'intended']]);
  assert.ok(post.definer_writes.length === 3 && post.definer_writes.every((w) => w.ok === true));
  assert.deepEqual(post.prerequisites_missing, []);
  assert.deepEqual(post.predecessors, { sql102: true });
  assert.deepEqual(pin.applied.receipt.release_sql_inspect, post);
  for (const evidence of [SQL154_APPLIED.ssm, SQL154_APPLIED.run, SQL154_APPLIED.one_use_id, PRE_INSPECT_SSM, `"${SQL154_APPLIED.approval}"`, '24000-character']) {
    assert.ok(pin.production_evidence['2026-11-11 apply'].includes(evidence), evidence);
  }
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-11');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, 'b64a59d7-0704-4750-843d-9971fd927a29');
  assert.equal(pin.production_inspect.source_commit, '928ef7a498f7438d1cb82b9695eae9ee9042ec92');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  assert.ok(pin.production_inspect.note.includes('808af4ffb4101dc483aff05471a0599e11e0d42e5f0517735a097443bdd88760'));
  assert.ok(pin.production_inspect.note.includes(`migration source sha256 on the runner ${pin.source_sha256} == source_sha256`));
  assert.match(pin.production_inspect.note, /already_applied false\), live_matches_expected false, precondition_failures \[\], apply_preconditions_met false, errors \[\]/);
  assert.match(pin.production_inspect.note, /If already_applied is true, or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no release-engine production inspect has been run for SQL 154 yet.'));
  for (const name of ['prerequisites_missing', 'definer_writes', 'already_applied false', 'precondition_failures']) {
    assert.ok(pin.production_inspect.note.includes(name), name);
  }
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql154-tenant-starter-package, run 43063499920/);
  assert.match(pin.staging_acceptance.basis, /deploy run 43062554159/);
  assert.match(pin.staging_acceptance.basis, /Read-live run 43064000809 \(job 130673917866\) then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /under the owner's words "then apply SQL 154 in staging"/);
  assert.match(pin.staging_acceptance.basis, /no separate staging acceptance statement was given/);
  assert.ok(pin.staging_acceptance.basis.includes(`before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  // The staging pin recorded the same pre-state (wave 46).
  assert.equal(staging.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.filename, SQL154_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL154_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, [...IDENTITIES]);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, ['sql102']);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'APPLY_TENANT_STARTER_PACKAGE');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql154-tenant-starter-package-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-154-apply.md');
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
  assert.equal(tool.allowed_key, 'sql154_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(RELEASE_SQL_SPECS[KEY].runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  // SQL 151, never applied, has no tool, pin or spec.
  assert.equal(ONE_SHOT_TOOLS.sql151, undefined);
  assert.equal(RELEASE_PRODUCTION.sql151, undefined);
  assert.equal(RELEASE_SQL_SPECS.sql151, undefined);
  assert.equal(STAGING.sql151, undefined);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql154-tenant-starter-package-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql154-production-apply"\]/);
  assert.match(rows, /sql147, sql148, sql150, sql152, sql154, sql155\)/);
  assert.doesNotMatch(rows, /sql151/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql154-executor.test.mjs', 'aws/tests/release-sql154-production-apply.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: predecessor SQL 102 (supersedes SQL 102 and SQL 98); four functions with their ACLs and SQL 102\'s guard replaced, five columns, the CHECK, two triggers; the overlay plan holds the engine and the handlers on SQL 154 (recorded live 2026-11-11); the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, ['sql102']);
  assert.deepEqual(spec.supersedes, ['sql102', 'sql98']);
  // No refuse_after on SQL 102 (re-running it puts back its guard, which fails closed).
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => (RELEASE_SQL_SPECS[key].refuse_after || []).some((m) => m.key === KEY)), []);
  assert.deepEqual(spec.functions.map((fn) => [fn.identity, fn.acl]), Object.entries(ACLS));
  assert.deepEqual(spec.functions.filter((fn) => fn.revokes !== undefined).map((fn) => [fn.identity, fn.revokes]), [[GUARD, []]]);
  for (const name of ['public.aws_check_processing_price_cents(uuid)', 'public.aws_failed_deposit_fee_cents()', GUARD, 'role checksops']) {
    assert.ok(spec.prerequisites.includes(name), name);
  }
  assert.deepEqual(spec.altered_relations, ['public.tenants', 'public.check_billing_events']);
  assert.deepEqual(spec.definer_writes, ['public.tenants', 'public.tenant_pricing_audit', 'public.check_billing_events']);
  assert.deepEqual(spec.added_columns.map((c) => `${c.table}.${c.column}`), [
    'public.tenants.starter_package_enabled', 'public.tenants.starter_package_starts_on', 'public.tenants.starter_package_maintenance_ends_on',
    'public.tenants.starter_package_included_checks', 'public.check_billing_events.package_included']);
  assert.deepEqual(spec.constraints.map((c) => [c.table, c.name]), [['public.tenants', 'tenants_starter_package_valid']]);
  assert.deepEqual(spec.triggers.map((t) => [t.table, t.name]), [
    ['public.check_billing_events', 'aws_check_billing_event_starter_package'], ['public.tenants', 'aws_tenant_starter_package_audit']]);
  for (const absent of ['tables', 'views', 'policies', 'table_privileges', 'column_acl', 'dropped_functions', 'acl_functions', 'indexes']) assert.equal(spec[absent], undefined, absent);
  assert.match(COMMITTED.order_note, /^Predecessor and supersedes SQL 102/);
  assert.match(COMMITTED.order_note, /SQL 154 replaces SQL 151, never applied and given no spec or pin/);
  assert.match(COMMITTED.order_note, /No refuse_after is added to SQL 102/);
  assert.match(COMMITTED.order_note, /definer_can_write_relations/);
  assert.match(COMMITTED.order_note, /No API, Lambda or SPA change is part of this pin\./);
  assert.match(COMMITTED.order_note, /db-readonly-validate trigger count/);
  // The overlay plan holds the engine and the handlers on SQL 154, recorded verified live by the SQL 154 record change
  // (2026-11-11) from this retired pin; the members are not deployed by it. SQL 151 is gone from it.
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal(plan.sql_prerequisites[SQL154_FILE].verified_live, true);
  assert.equal(plan.sql_prerequisites[SQL154_FILE].pin, RELEASE_SQL_SPECS[KEY].production_pin_rel);
  for (const evidence of [SQL154_APPLIED.ssm, SQL154_APPLIED.run, SQL154_APPLIED.one_use_id, 'staging acceptance run 43063499920']) {
    assert.ok(plan.sql_prerequisites[SQL154_FILE].evidence.includes(evidence), evidence);
  }
  assert.equal(plan.members['tenant-billing-engine.mjs'].sql_before, SQL154_FILE);
  assert.equal(plan.members['tenant-billing-handlers.mjs'].sql_before, SQL154_FILE);
  assert.equal(plan.sql_prerequisites[SQL151_FILE], undefined);
  assert.equal(readJson('ops/deployment-guard/staging-sql-live.json').sql[SQL151_FILE], undefined);
  // SQL 154's statements outside function bodies: two DO blocks, two ALTER TABLE, the REVOKEs and the two GRANTs.
  const text = fs.readFileSync(path.join(ROOT, SQL154_FILE), 'utf8').replace(/--[^\n]*/g, '');
  const outside = text.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$');
  assert.deepEqual([...outside.matchAll(/^\s*GRANT\b.*$/gim)].map((m) => m[0].trim()), [
    'GRANT EXECUTE ON FUNCTION public.aws_starter_package_checks_used(uuid) TO checksops;',
    'GRANT EXECUTE ON FUNCTION public.aws_platform_owner_set_tenant_starter_package(uuid, boolean, date, date, integer) TO checksops;']);
  assert.deepEqual([...outside.matchAll(/^\s*REVOKE\b.*$/gim)].map((m) => m[0].trim()),
    IDENTITIES.filter((identity) => identity !== GUARD).map((identity) => `REVOKE ALL ON FUNCTION ${identity} FROM PUBLIC;`));
  assert.doesNotMatch(outside, /\bCREATE\s+(TABLE|POLICY|VIEW|INDEX)\b/i);
  assert.doesNotMatch(outside, /\b(TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+public\.)/i);
  assert.equal([...outside.matchAll(/\bDO\s+\$/g)].length, 2);
  assert.deepEqual([...outside.matchAll(/^\s*ALTER\s+TABLE\s+(\S+)/gim)].map((m) => m[1]), ['public.tenants', 'public.check_billing_events']);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  assert.ok(runbook.includes(COMMITTED.intended_replacement_sha256));
  assert.ok(runbook.includes(COMMITTED.source_sha256));
  for (const value of Object.values(STAGING[KEY].superseded_intended_sha256)) assert.ok(runbook.includes(value), value);
  assert.match(runbook, /\*\*Status:\*\* applied to staging \(wave 46\) and to production \(2026-11-11\); the production pin is retired/);
  assert.match(runbook, /\*\*Production apply \(2026-11-11\)\.\*\*/);
  for (const evidence of [SQL154_APPLIED.ssm, SQL154_APPLIED.run, SQL154_APPLIED.workstream, PRE_INSPECT_SSM, PRE_INSPECT_RUN, '43079287025', `"${SQL154_APPLIED.approval}"`, '24000 characters']) {
    assert.ok(runbook.includes(evidence), evidence);
  }
  assert.match(runbook, /SSM\s+`b64a59d7-0704-4750-843d-9971fd927a29`/);
  assert.match(runbook, /\*\*Staging apply \(2026-11-11\)\.\*\* Apply run 43063499920/);
  assert.match(runbook, /\*\*Predecessor\.\*\* SQL 102/);
  for (const words of ['option A', '#1753', '"unused check can roll over"', 'db-readonly-validate trigger count']) {
    assert.ok(runbook.replace(/\s+/g, ' ').includes(words), words);
  }
  assert.match(runbook, /APPLY_TENANT_STARTER_PACKAGE/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql154` \|/);
  assert.match(oneShot, /`sql150`, `sql152`, `sql154`, `sql155`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql154-tenant-starter-package-production-apply\.mjs --inspect/);
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

  // The committed (authorized) pin allows only the manifest bound to its recorded pre-state: not another hash, not the
  // intended state.
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-11-11 (test copy of the execute-authorized pin before its record-and-retire change)' });
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql154_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);
  // The retired committed pin refuses before connecting.
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql154_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // SQL 152's phrase does not authorize SQL 154.
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'APPLY_INVOICE_AND_FAILED_DEPOSIT_FEES' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql154-cli-${process.pid}.json`);
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
