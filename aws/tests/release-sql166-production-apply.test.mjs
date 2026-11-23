/**
 * Production tool for SQL 166 (scripts/deployment-guard/sql166-mortgage-desk-set-monitoring-production-apply.mjs on
 * lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs). Owner 2026-11-14: the Mortgage Desk agent
 * switches the request's loss draft between Monitored and Not Monitored, and the tenant sees it on the check.
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 166 included) through the shared refusals; this
 * file covers SQL 166's own:
 *
 *   - the pin has the release pin shape; it was execute-authorized (owner-approved pin change of 2026-11-14, #1909), is
 *     applied (2026-11-14, "apply SQL 166 and SQL 167 in production") and retired (execute false, the apply run recorded in
 *     applied), with the
 *     recorded production pre-state (read-only inspect SSM 6b4e6de5; the derived absent state) and the staging apply from
 *     the same pre-state (run 43627727453) as its acceptance; it is in step with the staging pin, the one-shot, the bypass
 *     inventory and the test lists;
 *   - no predecessor; one new SECURITY DEFINER function (EXECUTE checksops and the owner), nothing replaced; no
 *     table, policy, trigger or table grant; no overlay plan entry; the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed pin allows only the manifest bound
 *     to its recorded pre-state; an approved, accepted copy evaluates for the manifest built from it,
 *     and refuses with execute false, another live hash, another staging reference or a wrong phrase; the CLI spends no
 *     receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql166-mortgage-desk-set-monitoring-pg.test.mjs; the executor path is
 * aws/tests/release-sql166-executor.test.mjs.
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
import { RELEASE_SQL_SPECS, releaseIntendedHash, releaseStateHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import {
  RELEASE_PRODUCTION,
  evaluateReleaseProductionApply,
  executeReleaseProductionApply,
  loadReleaseProductionPin,
  precheckReleaseProductionApply,
  readPinnedReleaseSql,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { main } from '../../scripts/deployment-guard/sql166-mortgage-desk-set-monitoring-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql166';
const SQL166_FILE = 'aws/workflows/sql/166_mortgage_desk_set_monitoring.sql';
const ACLS = Object.freeze({
  'public.aws_mortgage_desk_set_monitoring(uuid, text)': ['checksops EXECUTE', 'owner EXECUTE'],
});
const IDENTITIES = Object.freeze(Object.keys(ACLS));
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 166's recorded production pre-state (read-only inspect of 2026-11-14, SSM 6b4e6de5, main 84dd7e549): the function absent,
// the derived pre-state.
const PRODUCTION_PRE = '11a10b33e6a5a46ea98934487cd9e941ddfe6b232ca6c7d4debad8c2f033f608';
// The guarded staging apply from the same pre-state.
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43627727453';
// The owner's words for SQL 166 and SQL 167, quoted in the authorization.
const OWNER_WORDS = Object.freeze(['"apply SQL 166 and SQL 167 in staging"', '"merge #1908"', '"run the SQL 166 and SQL 167 production inspect"', '"Yes" to "Shall I open the pin PR?"']);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql166-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-11-14T00:00:00.000Z',
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

test('pin: the release pin shape, applied and retired (owner approved 2026-11-14 on the staging apply; applied 2026-11-14), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-11-14: the read-only production inspect (SSM 6b4e6de5, main 84dd7e549) recorded as
  // the pre-state; the staging apply (run 43627727453, from the same pre-state) as the acceptance.
  // Then applied 2026-11-14 under the owner's own words for that run (the same words for SQL 166's and SQL 167's runs), and retired.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-11-14; execute is false again/);
  for (const words of [...OWNER_WORDS, '"apply SQL 166 and SQL 167 in production"']) assert.ok(pin.authorization.includes(words), words);
  assert.ok(pin.authorization.includes('#1909'));
  const applied = pin.applied;
  assert.deepEqual([applied.date, applied.result, applied.apply_ssm_command_id, applied.inspect_ssm_command_id, applied.one_shot_run_id, applied.one_use_id, applied.one_use_id_consumed, applied.owner_approval],
    ['2026-11-14', 'applied', 'a4f2aed0-51ce-4444-8387-1fff041fd4ef', 'd82a9d0b-4f11-48cc-b4eb-f46417374112', 'cca3fb1a-8d24-45b5-838d-5ec0e2e73bfd', 'sql166-prod-9a437e99-306b-46b6-968e-2a0cb7cca1ec', true, 'apply SQL 166 and SQL 167 in production']);
  assert.equal(applied.workstream_id, 'prod-sql166-desk-set-monitoring-20261114');
  assert.equal(applied.source_commit, 'd8da56bac34ab8f24195dbb9d28adb8b690d920e');
  assert.equal(applied.source_tarball.sha256, 'b2d3cadcfea1a2c9681de708d4546f5bc3e7506a72395b3c1f3516617c149774');
  assert.equal(applied.migration_source_sha256, pin.source_sha256);
  assert.equal(applied.manifest_sha256, '3cd2a81b0fae97704a9ce5e4b364f6bcc09a424bafaf1bd99afbf70b6fc5e67c');
  assert.deepEqual(applied.steps, ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  assert.deepEqual(Object.values(applied.contract_results).map((c) => c.evidence.split(' ')[0]), ['4/4', '6/6', '43/43']);
  assert.equal(applied.pre_apply_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.deepEqual(applied.pre_apply_inspect.precondition_failures, []);
  assert.equal(applied.receipt.before_hash, pin.expected_live_definition_sha256);
  assert.equal(applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(applied.receipt.staging_acceptance, pin.staging_acceptance.reference);
  assert.equal(applied.post_apply_inspect.already_applied, true);
  assert.equal(applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256);
  assert.deepEqual(applied.post_apply_inspect.precondition_failures, []);
  const after = applied.post_apply_inspect.release_sql_inspect;
  assert.deepEqual(after.functions.map((fn) => fn.state), ['intended']);
  assert.deepEqual(after.function_acl.map((fn) => fn.acl), Object.values(ACLS).map((acl) => [...acl]));
  assert.deepEqual(applied.receipt.release_sql_inspect, after);
  // The run's whole output arrived: nothing is marked not captured.
  assert.equal(applied.not_captured, undefined);
  for (const text of ['transfer run 43632903546', 'd82a9d0b-4f11-48cc-b4eb-f46417374112', '1f002c3ec60407388070921661f03920bbb48795dfac5a4051e4529768d43d83', 'Let them finish first', 'Production acceptance: not yet reported by the owner']) assert.ok(applied.one_shot_note.includes(text), text);
  for (const text of ['a4f2aed0-51ce-4444-8387-1fff041fd4ef', 'cca3fb1a-8d24-45b5-838d-5ec0e2e73bfd', 'd82a9d0b-4f11-48cc-b4eb-f46417374112']) assert.ok(pin.production_evidence['2026-11-14 apply'].includes(text), text);
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, releaseStateHash(KEY, {}));
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-14');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '6b4e6de5-3548-4477-927c-bcbda4a11391');
  assert.equal(pin.production_inspect.source_commit, '84dd7e5492e911aee336282a6262888965fd6659');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  for (const text of ['f7965818d5b9d95284f125c9fded2fde1c50f3702d24a036e03e5aac68767c03', '02226b4e6a40e408c328669916d22e43ca0827f453feaff929bdfabbeb52e56d',
    'run 43629060749', 'prerequisites_missing [], predecessors {} (none), successors_applied [], precondition_failures []', 'already_applied false',
    'ok true, read_only true, source_ok true, current_user and session_user checksops_admin, pin_execute false, missing_dependencies []', 'definer_writes ok true on']) {
    assert.ok(pin.production_inspect.note.includes(text), text);
  }
  assert.match(pin.production_inspect.note, /If already_applied is true, prerequisites_missing is not \[\] or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no release-engine production inspect has been run for SQL 166 yet'));
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql166-mortgage-desk-set-monitoring, run 43627727453/);
  assert.match(pin.staging_acceptance.basis, /wave 58/);
  assert.match(pin.staging_acceptance.basis, /deploy run 43626936092/);
  assert.match(pin.staging_acceptance.basis, /read-live run 43627497816/);
  assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.match(pin.staging_acceptance.basis, /Read-live run 43627956591 then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /Production's pre-state \(production_inspect\) equals staging's/);
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  assert.equal(pin.filename, SQL166_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL166_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, [...IDENTITIES]);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'LET_MORTGAGE_DESK_SWITCH_LOSS_DRAFT_MONITORING');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql166-mortgage-desk-set-monitoring-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-166-apply.md');
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
  assert.equal(tool.allowed_key, 'sql166_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql166-mortgage-desk-set-monitoring-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql166-production-apply"\]/);
  assert.match(rows, /sql164, sql165, sql166, sql167, sql168, sql169, sql170, sql171, sql172\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql166-executor.test.mjs', 'aws/tests/release-sql166-production-apply.test.mjs', 'aws/tests/sql166-mortgage-desk-set-monitoring-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; one new SECURITY DEFINER function with its ACL, nothing replaced; no table, policy, trigger or table grant; no overlay plan entry; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.production_only, undefined);
  assert.equal(spec.production_noop, undefined);
  assert.deepEqual(spec.functions.map((fn) => [fn.identity, fn.acl]), Object.entries(ACLS));
  for (const name of ['public.mortgage_handling_requests', 'public.loss_draft_tracking', 'public.loss_draft_audit_log', 'public.check_messages',
    'column public.loss_draft_tracking.monitoring_type', 'column public.loss_draft_tracking.escrow_status',
    'public.aws_mortgage_desk_working_request(uuid, text[])', 'role checksops']) {
    assert.ok(spec.prerequisites.includes(name), name);
  }
  assert.deepEqual(spec.definer_writes, ['public.check_messages', 'public.loss_draft_audit_log', 'public.loss_draft_tracking', 'public.mortgage_handling_requests']);
  for (const absent of ['tables', 'views', 'policies', 'table_privileges', 'column_acl', 'dropped_functions', 'acl_functions', 'indexes', 'added_columns', 'constraints', 'triggers', 'altered_relations', 'altered_columns']) assert.equal(spec[absent], undefined, absent);
  // No other release migration defines or touches this function.
  for (const key of Object.keys(RELEASE_SQL_SPECS).filter((k) => k !== KEY)) {
    for (const fn of IDENTITIES) assert.ok(!JSON.stringify(RELEASE_SQL_SPECS[key]).includes(fn.replace(/\(.*$/, '(')), `${key} ${fn}`);
  }
  assert.match(COMMITTED.order_note, /^No predecessor\. SQL 166 adds one SECURITY DEFINER function and replaces nothing/);
  for (const text of ['"Mortgage agent needs to be able to change the claim from monitor to not monitored', 'loss_draft_closed', 'escrow_or_draws_recorded',
    'definer_can_write_relations', 'db-readonly-validate trigger count is not affected', 'no API, Lambda or SPA change is part of this pin', releaseStateHash(KEY, {})]) {
    assert.ok(COMMITTED.order_note.includes(text), text);
  }
  // The desk set monitoring API (2026-11-14, planning only) holds mortgage-desk-return.mjs on SQL 166; production records it
  // verified live from this pin's applied record (#1910).
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.deepEqual(Object.keys(plan.members).filter((m) => plan.members[m].sql_before === SQL166_FILE), ['mortgage-desk-return.mjs']);
  assert.equal(plan.sql_prerequisites[SQL166_FILE].verified_live, true);
  for (const text of [COMMITTED.applied.apply_ssm_command_id, COMMITTED.applied.one_shot_run_id, COMMITTED.applied.one_use_id, '#1910']) {
    assert.ok(plan.sql_prerequisites[SQL166_FILE].evidence.includes(text), text);
  }
  // The file: the prerequisite DO block, one function, its REVOKE from PUBLIC, the role REVOKE DO block and the GRANT to checksops; nothing else.
  const text = fs.readFileSync(path.join(ROOT, SQL166_FILE), 'utf8').replace(/--[^\n]*/g, '');
  const outside = text.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$');
  assert.deepEqual([...outside.matchAll(/^\s*GRANT\b.*$/gim)].map((m) => m[0].trim()), IDENTITIES.map((identity) => `GRANT EXECUTE ON FUNCTION ${identity} TO checksops;`));
  assert.deepEqual([...outside.matchAll(/^\s*REVOKE\b.*$/gim)].map((m) => m[0].trim()), IDENTITIES.map((identity) => `REVOKE ALL ON FUNCTION ${identity} FROM PUBLIC;`));
  assert.deepEqual([...outside.matchAll(/^\s*CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(\S+?)\(/gim)].map((m) => m[1]), IDENTITIES.map((identity) => identity.replace(/\(.*$/, '')));
  assert.doesNotMatch(outside, /\bCREATE\s+(TABLE|POLICY|VIEW|INDEX|TRIGGER)\b|\bALTER\s+TABLE\b|\bDROP\b/i);
  assert.doesNotMatch(outside, /\b(TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+public\.)/i);
  assert.equal([...outside.matchAll(/\bDO\s+\$/g)].length, 2);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  for (const value of [COMMITTED.intended_replacement_sha256, COMMITTED.source_sha256, releaseStateHash(KEY, {}), 'LET_MORTGAGE_DESK_SWITCH_LOSS_DRAFT_MONITORING']) {
    assert.ok(runbook.includes(value), value);
  }
  assert.match(runbook, /\*\*Status:\*\* applied in staging \(wave 58, 2026-11-14, apply run 43627727453\); staging acceptance: the staging apply under the owner's run approval \("apply SQL 166 and SQL 167 in staging"; no separate acceptance statement\); applied to production \(2026-11-14\); the production pin is retired \(`execute: false`\)\./);
  assert.match(runbook, /\*\*Production apply \(2026-11-14\)\.\*\* /);
  assert.match(runbook, /\*\*Production inspect \(2026-11-14\)\.\*\* Read-only `--inspect` through SSM `6b4e6de5-3548-4477-927c-bcbda4a11391`/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql166` \|/);
  assert.match(oneShot, /`sql164`, `sql165`, `sql166`, `sql167`, `sql168`, `sql169`, `sql170`, `sql171`, `sql172`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql166-mortgage-desk-set-monitoring-production-apply\.mjs --inspect/);
});

test('the pending (pre-authorization) pin refuses before connecting; the committed pin allows only its own manifest; execute false, other hashes and phrases refuse', async () => {
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

  // An execute-authorized copy of the committed (retired) pin allows only the manifest bound to its recorded pre-state; the
  // retired pin refuses before connecting.
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-11-14 (test copy of the execute-authorized pin before its record-and-retire change)' });
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql166_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql166_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // SQL 165's phrase does not authorize SQL 166.
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'ENABLE_VENDOR_PAYEE_LOOKUP_AND_PAYROLL_VENDOR' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql166-cli-${process.pid}.json`);
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
  assert.match(out, /GUARD_APPLY_FORBIDDEN|SQL_COLLISION|PRODUCTION_APPROVAL_REQUIRED|DEPLOYMENT_GUARD_REQUIRED/);
  assert.match(out, /credential flags are refused/);
});
