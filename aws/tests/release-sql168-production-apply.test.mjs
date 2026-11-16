/**
 * Production tool for SQL 168 (scripts/deployment-guard/sql168-mortgage-desk-same-agent-new-check-production-apply.mjs
 * on lib/release-sql-production-apply.mjs and lib/release-sql-production-cli.mjs). Owner 2026-11-16: "We need to make
 * sure once a mortgage agent handles a check, if another check comes in they handle each one for that check file."
 * release-sql90-97-production-apply.test.mjs runs every release key (SQL 168 included) through the shared refusals;
 * this file covers SQL 168's own:
 *
 *   - the pin has the release pin shape; it was execute-authorized (owner-approved pin change of 2026-11-16, #1939), is
 *     applied (2026-11-16, "apply SQL 168 in production ROUTE_NEW_CHECK_TO_SAME_MORTGAGE_AGENT") and retired (execute false, the
 *     apply run recorded in applied), with the
 *     recorded production pre-state (read-only inspect SSM 64f2c1ff; the derived absent state) and the staging apply from
 *     the same pre-state (run 43882991880) as its acceptance; it is in step with the staging pin, the one-shot, the bypass
 *     inventory and the test lists;
 *   - no predecessor; two new SECURITY DEFINER functions (EXECUTE for the owner only) and two new triggers, nothing
 *     replaced; no table, policy or table grant; the overlay plan held only db-readonly-validate.mjs on it (the DB validator justifies its
 *     two triggers, 2026-11-16), not yet recorded live in production; the runbook, one-shot doc and README name it;
 *   - the pending (pre-authorization) pin refuses before connecting; the committed pin allows only the manifest bound
 *     to its recorded pre-state; an approved, accepted copy evaluates for the manifest built from it,
 *     and refuses with execute false, another live hash, another staging reference or a wrong phrase; the CLI spends no
 *     receipt.
 * The behavior on PostgreSQL 16 is aws/tests/sql168-mortgage-desk-same-agent-new-check-pg.test.mjs; the executor path is
 * aws/tests/release-sql168-executor.test.mjs.
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
import { main } from '../../scripts/deployment-guard/sql168-mortgage-desk-same-agent-new-check-production-apply.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql168';
const SQL168_FILE = 'aws/workflows/sql/168_mortgage_desk_same_agent_new_check.sql';
const ACLS = Object.freeze({
  'public.aws_mortgage_desk_route_same_agent(uuid, text)': ['owner EXECUTE'],
  'public.aws_mortgage_desk_route_same_agent_trigger()': ['owner EXECUTE'],
});
const TRIGGERS = Object.freeze([['public.loss_draft_tracking', 'aws_loss_draft_route_same_agent'], ['public.check_intake_items', 'aws_check_claim_route_same_agent']]);
const IDENTITIES = Object.freeze(Object.keys(ACLS));
const COMMITTED = loadReleaseProductionPin(KEY, ROOT);
const SQL96_PIN = loadReleaseProductionPin('sql96', ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PRE = 'e'.repeat(64);
// SQL 168's recorded production pre-state (read-only inspect of 2026-11-16, SSM 64f2c1ff, main bc52a5889): the two functions
// and the two triggers absent, the derived pre-state.
const PRODUCTION_PRE = 'a364af9a300c5e617db353e67e3f37a18691a27f10d9349d506471067a31ef33';
// The guarded staging apply from the same pre-state.
const STAGING_ACCEPTANCE_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/43882991880';
// The owner's words for SQL 168, quoted in the authorization.
const OWNER_WORDS = Object.freeze(['"apply SQL 168 in staging"', '"merge #1936"', '"merge the SQL 168 staging pin PR"', '"run the SQL 168 production inspect"', '"open the SQL 168 production pin PR"']);
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const keyPaths = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${p}${k}.`) : [`${p}${k}`]));
const neverConnect = async () => { throw new Error('should-not-connect'); };
const consumedPath = () => path.join(os.tmpdir(), `sql168-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    build_timestamp: '2026-11-16T00:00:00.000Z',
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

test('pin: the release pin shape, applied and retired (owner approved 2026-11-16 on the staging apply; applied 2026-11-16), in step with the staging pin, the one-shot, the inventory and the test lists', () => {
  const pin = COMMITTED;
  const staging = STAGING[KEY];
  const shape = new Set(keyPaths(SQL96_PIN).filter((k) => !/^(applied|production_evidence)(\.|$)/.test(k)));
  assert.deepEqual([...shape].filter((k) => !keyPaths(pin).includes(k)), [], 'lacks the engine pin shape');
  // The record-and-retire change adds applied and production_evidence on top of the engine pin shape.
  assert.deepEqual(keyPaths(pin).filter((k) => !shape.has(k) && !/^(applied|production_evidence)(\.|$)/.test(k)), []);
  assert.equal(pin.id, RELEASE_SQL_SPECS[KEY].production_pin_rel.split('/').pop().replace(/\.json$/, ''));
  assert.equal(pin.migration, KEY);
  // Owner-approved pin change of 2026-11-16: the read-only production inspect (SSM 64f2c1ff, main bc52a5889) recorded as
  // the pre-state; the staging apply (run 43882991880, from the same pre-state) as the acceptance.
  // Then applied 2026-11-16 under the owner's own words for that run, and retired.
  assert.equal(pin.execute, false);
  assert.match(pin.authorization, /^Applied to production on 2026-11-16; execute is false again/);
  for (const words of [...OWNER_WORDS, '"merge the SQL 168 production pin PR"', '"apply SQL 168 in production ROUTE_NEW_CHECK_TO_SAME_MORTGAGE_AGENT"']) assert.ok(pin.authorization.includes(words), words);
  assert.ok(pin.authorization.includes('#1939'));
  const applied = pin.applied;
  assert.deepEqual([applied.date, applied.result, applied.apply_ssm_command_id, applied.inspect_ssm_command_id, applied.one_shot_run_id, applied.one_use_id, applied.one_use_id_consumed, applied.owner_approval],
    ['2026-11-16', 'applied', '6781f116-8801-4164-a110-80ccbcb8f437', '22669a58-0fca-481e-9188-ee5bce9a81df', '14532473-eb26-43de-b552-be5def063452', 'sql168-prod-c1d1978f-d118-4880-a015-e43aa0743d52', true, 'apply SQL 168 in production ROUTE_NEW_CHECK_TO_SAME_MORTGAGE_AGENT']);
  assert.equal(applied.workstream_id, 'prod-sql168-desk-same-agent-20261116');
  assert.equal(applied.source_commit, 'e81328645bbcc9755e5e9693e07a769b92349b9e');
  assert.equal(applied.source_tarball.sha256, '15a529ae0b2c1997b9cf7483130f61d9a258ae156e037aa6df504e7f6394ef7d');
  assert.equal(applied.migration_source_sha256, pin.source_sha256);
  assert.equal(applied.manifest_sha256, '7c9931cbbcc377ef102cb4bd3176b987def57bc1d34f7cadca8f93694beb4335');
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
  assert.deepEqual(after.triggers.map((t) => t.state), ['intended', 'intended']);
  assert.deepEqual(after.functions.map((f) => f.state), ['intended', 'intended']);
  assert.deepEqual(applied.receipt.release_sql_inspect, after);
  // The run's whole output arrived: nothing is marked not captured.
  assert.equal(applied.not_captured, undefined);
  for (const text of ['transfer run 43958936335', '22669a58-0fca-481e-9188-ee5bce9a81df', 'aa91232b09b8787e979937c593fecdbd654dbd25952a3701db705019adc4f894', 'Production acceptance: not yet reported by the owner']) assert.ok(applied.one_shot_note.includes(text), text);
  for (const text of ['6781f116-8801-4164-a110-80ccbcb8f437', '14532473-eb26-43de-b552-be5def063452', '22669a58-0fca-481e-9188-ee5bce9a81df', 'DEPLOY db-readonly-validate.mjs TO PRODUCTION']) assert.ok(pin.production_evidence['2026-11-16 apply'].includes(text), text);
  assert.equal(pin.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.expected_live_definition_sha256, releaseStateHash(KEY, {}));
  assert.equal(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256);
  assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256);
  assert.equal(pin.production_inspect.status, 'recorded');
  assert.equal(pin.production_inspect.date, '2026-11-16');
  assert.equal(pin.production_inspect.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(pin.production_inspect.ssm_command_id, '64f2c1ff-e883-47b9-b50b-cf2a11b0a7f2');
  assert.equal(pin.production_inspect.source_commit, 'bc52a5889195d3412ec2f31e5e843fd54c9919fa');
  assert.equal(pin.production_inspect.read_only, true);
  assert.equal(pin.production_inspect.connected_as, 'checksops_admin');
  assert.equal(pin.production_inspect.apply_preconditions_met, false);
  assert.deepEqual(pin.production_inspect.precondition_failures, []);
  for (const text of ['96eb31fc6d7998854c58069d75e1422042f0ce14f4e66bf25e5f9c0dc2b459df', '2ca492ab7ce4087eee57778173189956093d26bdd60c73605ff4bd176e93dc0d',
    'run 43883906810', 'prerequisites_missing [], predecessors {} (none), successors_applied [], precondition_failures []', 'already_applied false',
    'ok true, read_only true, source_ok true, current_user and session_user checksops_admin, pin_execute false, missing_dependencies []', 'definer_writes ok true on',
    'tr_accrue_mortgage_ops_billing', 'trg_auto_create_loss_draft']) {
    assert.ok(pin.production_inspect.note.includes(text), text);
  }
  assert.match(pin.production_inspect.note, /If already_applied is true, prerequisites_missing is not \[\] or precondition_failures is not \[\], stop/);
  assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: no release-engine production inspect has been run for SQL 168 yet'));
  assert.deepEqual([pin.staging_acceptance.ok, pin.staging_acceptance.reference], [true, STAGING_ACCEPTANCE_REF]);
  assert.match(pin.staging_acceptance.basis, /^Guarded staging SQL executor apply of sql168-mortgage-desk-same-agent-new-check, run 43882991880/);
  assert.match(pin.staging_acceptance.basis, /wave 60/);
  assert.match(pin.staging_acceptance.basis, /deploy run 43882354934/);
  assert.match(pin.staging_acceptance.basis, /read-live run 43878936321/);
  assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${PRODUCTION_PRE}, after ${pin.intended_replacement_sha256} == intended`));
  assert.match(pin.staging_acceptance.basis, /Read-live run 43883462531 then reported already_applied true/);
  assert.match(pin.staging_acceptance.basis, /Production's pre-state \(production_inspect\) equals staging's/);
  assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference']);
  assert.equal(pin.filename, SQL168_FILE);
  assert.equal(pin.source_sha256, staging.source_sha256);
  assert.equal(pin.staging_pin_commit, staging.commit);
  assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
  assert.equal(pin.intended_post_state.fingerprint, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, releaseIntendedHash(KEY, fs.readFileSync(path.join(ROOT, SQL168_FILE), 'utf8')));
  assert.deepEqual(pin.function_identities, RELEASE_SQL_SPECS[KEY].functions.map((fn) => fn.identity));
  assert.deepEqual(pin.function_identities, [...IDENTITIES]);
  assert.deepEqual(pin.function_identities, [...staging.function_identities]);
  assert.deepEqual(pin.predecessors, []);
  assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[KEY].predecessors);
  assert.equal(pin.authorization_phrase, 'ROUTE_NEW_CHECK_TO_SAME_MORTGAGE_AGENT');
  for (const k of ['admin_login', 'rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[k], SQL96_PIN[k], k);
  assert.equal(pin.tooling.status, 'built');
  assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[KEY].cli);
  assert.equal(pin.tooling.production_tool, 'scripts/deployment-guard/sql168-mortgage-desk-same-agent-new-check-production-apply.mjs');
  assert.equal(pin.tooling.staging_workflow_choice, RELEASE_SQL_SPECS[KEY].choice);
  assert.equal(pin.tooling.one_shot_migration, KEY);
  assert.equal(pin.tooling.runbook, 'ops/production-sql-168-apply.md');
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
  assert.equal(tool.allowed_key, 'sql168_production_apply_allowed');
  assert.equal(tool.runs_before, undefined);
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const rows = JSON.stringify(readJson('ops/deployment-guard/bypass-inventory.json'));
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql168-mortgage-desk-same-agent-new-check-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql168-production-apply"\]/);
  assert.match(rows, /sql165, sql166, sql167, sql168, sql169\)/);
  const scripts = readJson('package.json').scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/release-sql168-executor.test.mjs', 'aws/tests/release-sql168-production-apply.test.mjs', 'aws/tests/sql168-mortgage-desk-same-agent-new-check-pg.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
});

test('order: no predecessor; two new SECURITY DEFINER functions with their ACL and two triggers, nothing replaced; no table, policy or table grant; the overlay plan holds only the DB validator on it, now recorded live in production; the runbook, one-shot doc and README name it', () => {
  const spec = RELEASE_SQL_SPECS[KEY];
  assert.deepEqual(spec.predecessors, []);
  assert.equal(spec.supersedes, undefined);
  assert.equal(spec.production_only, undefined);
  assert.equal(spec.production_noop, undefined);
  assert.deepEqual(spec.functions.map((fn) => [fn.identity, fn.acl]), Object.entries(ACLS));
  assert.deepEqual(spec.triggers.map((t) => [t.table, t.name]), TRIGGERS);
  assert.deepEqual(spec.altered_relations, TRIGGERS.map(([table]) => table));
  for (const name of ['public.check_intake_items', 'public.loss_draft_tracking', 'public.mortgage_handling_requests', 'public.mortgage_ops_request_audit',
    'public.mortgage_agent_accounts', 'public.has_role(uuid, public.app_role)', 'column public.check_intake_items.deposited_at',
    'column public.check_intake_items.check_stage', 'column public.loss_draft_tracking.check_intake_item_id',
    'column public.mortgage_handling_requests.endorsement_order', 'column public.mortgage_handling_requests.homeowner_ssn_last_four',
    'column public.mortgage_agent_accounts.status', 'public.check_messages', 'column public.check_messages.sender_id', 'public.profiles',
    'column public.profiles.full_name']) {
    assert.ok(spec.prerequisites.includes(name), name);
  }
  assert.deepEqual(spec.definer_writes, ['public.check_intake_items', 'public.loss_draft_tracking', 'public.mortgage_handling_requests', 'public.mortgage_ops_request_audit', 'public.mortgage_agent_accounts', 'public.check_messages', 'public.profiles']);
  for (const absent of ['tables', 'views', 'policies', 'table_privileges', 'column_acl', 'dropped_functions', 'acl_functions', 'indexes', 'added_columns', 'constraints', 'dropped_triggers']) assert.equal(spec[absent], undefined, absent);
  // No other release migration defines or touches the functions or the triggers.
  for (const key of Object.keys(RELEASE_SQL_SPECS).filter((k) => k !== KEY)) {
    const other = JSON.stringify(RELEASE_SQL_SPECS[key]);
    for (const fn of IDENTITIES) assert.ok(!other.includes(fn.replace(/\(.*$/, '(')), `${key} ${fn}`);
    for (const [, name] of TRIGGERS) assert.ok(!other.includes(name), `${key} ${name}`);
  }
  assert.match(COMMITTED.order_note, /^No predecessor\. SQL 168 adds two SECURITY DEFINER functions and two triggers and replaces nothing/);
  for (const text of ['"We need to make sure once a mortgage agent handles a check, if another check comes in they handle each one for that check file"',
    'definer_can_write_relations', 'altered_relations_owned_by_login', 'It never creates a 2nd-mortgagee request', 'db-readonly-validate justified set and trigger count follow after the apply',
    'No backfill', 'No API, Lambda or SPA change is part of this pin', releaseStateHash(KEY, {})]) {
    assert.ok(COMMITTED.order_note.includes(text), text);
  }
  // The API calls nothing new. Only the DB validator waits on SQL 168 (2026-11-16, "fix the staging validator"): its
  // bytes justify the two triggers by name (192), so its production REPLACE follows SQL 168's production record. SQL 168
  // is recorded live in production by its record-and-retire change (SSM 6781f116, 2026-11-16), so the validator is no longer
  // held; in staging it is live too (staging-sql-live.json).
  const plan = readJson('ops/deployment-guard/production-api-overlay-plan.json');
  assert.equal(plan.sql_prerequisites?.[SQL168_FILE]?.verified_live, true);
  assert.ok(plan.sql_prerequisites[SQL168_FILE].evidence.includes('6781f116-8801-4164-a110-80ccbcb8f437'));
  assert.deepEqual(Object.keys(plan.members).filter((m) => plan.members[m].sql_before === SQL168_FILE), ['db-readonly-validate.mjs']);
  assert.equal(readJson('ops/deployment-guard/staging-sql-live.json').sql[SQL168_FILE].verified_live, true);
  const validator = fs.readFileSync(path.join(ROOT, 'aws/functions/api/db-readonly-validate.mjs'), 'utf8');
  assert.match(validator, /export const EXPECTED_PUBLIC_TRIGGERS = 192;/);
  for (const [table, name] of TRIGGERS) {
    assert.match(validator, new RegExp(`table: '${table.replace(/^public\./, '')}',\\n\\s+trigger: '${name}',\\n\\s+functionName: 'aws_mortgage_desk_route_same_agent_trigger'`));
  }
  // The file: the prerequisite DO block, two functions, the REVOKEs from PUBLIC, the role REVOKE DO block, the two
  // triggers each dropped if present and created; no GRANT; nothing else.
  const text = fs.readFileSync(path.join(ROOT, SQL168_FILE), 'utf8').replace(/--[^\n]*/g, '');
  const outside = text.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, '$$body$$');
  assert.deepEqual([...outside.matchAll(/^\s*GRANT\b.*$/gim)].map((m) => m[0].trim()), []);
  assert.deepEqual([...outside.matchAll(/^\s*REVOKE\b.*$/gim)].map((m) => m[0].trim()), IDENTITIES.map((identity) => `REVOKE ALL ON FUNCTION ${identity} FROM PUBLIC;`));
  assert.deepEqual([...outside.matchAll(/^\s*CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(\S+?)\(/gim)].map((m) => m[1]), IDENTITIES.map((identity) => identity.replace(/\(.*$/, '')));
  assert.deepEqual([...outside.matchAll(/^\s*DROP\b.*$/gim)].map((m) => m[0].trim()), TRIGGERS.map(([table, name]) => `DROP TRIGGER IF EXISTS ${name} ON ${table};`));
  assert.deepEqual([...outside.matchAll(/^\s*CREATE\s+TRIGGER\s+(\S+)/gim)].map((m) => m[1]), TRIGGERS.map(([, name]) => name));
  assert.doesNotMatch(outside, /\bCREATE\s+(TABLE|POLICY|VIEW|INDEX)\b|\bALTER\s+TABLE\b|\bDROP\s+(FUNCTION|TABLE|POLICY|INDEX|VIEW)\b/i);
  assert.doesNotMatch(outside, /\b(TRUNCATE|DELETE\s+FROM|INSERT\s+INTO|UPDATE\s+public\.)/i);
  // SQL 158's assign, SQL 160's billing and SQL 167's relink are not touched.
  assert.doesNotMatch(outside, /aws_mortgage_desk_assign_agent|accrue_mortgage_ops_billing|earn_mortgage_agent_compensation|claim_ledger_relink_check/);
  assert.equal([...outside.matchAll(/\bDO\s+\$/g)].length, 2);
  const runbook = fs.readFileSync(path.join(ROOT, COMMITTED.tooling.runbook), 'utf8');
  for (const value of [COMMITTED.intended_replacement_sha256, COMMITTED.source_sha256, releaseStateHash(KEY, {}), 'ROUTE_NEW_CHECK_TO_SAME_MORTGAGE_AGENT']) {
    assert.ok(runbook.includes(value), value);
  }
  assert.match(runbook, /\*\*Status:\*\* applied in staging \(wave 60, 2026-11-16, apply run 43882991880\); staging acceptance: the staging apply under the owner's run approval \(\"apply SQL 168 in staging\"; no separate acceptance statement\); applied to production \(2026-11-16\); the production pin is retired \(`execute: false`\)\./);
  assert.match(runbook, /\*\*Production apply \(2026-11-16\)\.\*\* /);
  assert.match(runbook, /\*\*Production inspect \(2026-11-16\)\.\*\* Read-only `--inspect` through SSM `64f2c1ff-e883-47b9-b50b-cf2a11b0a7f2`/);
  const oneShot = fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8');
  assert.match(oneShot, /\| `sql168` \|/);
  assert.match(oneShot, /`sql166`, `sql167`, `sql168`, `sql169`\) \|/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/README.md'), 'utf8'), /sql168-mortgage-desk-same-agent-new-check-production-apply\.mjs --inspect/);
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
  const AUTHORIZED = Object.freeze({ ...COMMITTED, execute: true, authorization: 'Owner approved 2026-11-16 (test copy of the execute-authorized pin before its record-and-retire change)' });
  assert.equal((await executeReleaseProductionApply(KEY, manifest(COMMITTED), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).ok, false);
  const committedOk = await evaluateReleaseProductionApply(KEY, manifest(AUTHORIZED), { root: ROOT, pin: AUTHORIZED });
  assert.equal(committedOk.ok, true, JSON.stringify(committedOk));
  assert.equal(committedOk.details.sql168_production_apply_allowed, true);
  assert.equal(committedOk.details.staging_acceptance, STAGING_ACCEPTANCE_REF);
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: PRE, expected_live_definition_sha256: PRE }, { root: ROOT, pin: AUTHORIZED })).code, CODES.SQL_COLLISION);
  const onIntended = COMMITTED.intended_replacement_sha256;
  assert.equal((await evaluateReleaseProductionApply(KEY, { ...manifest(AUTHORIZED), live_definition_sha256: onIntended, expected_live_definition_sha256: onIntended }, { root: ROOT, pin: AUTHORIZED })).ok, false);

  const pin = approved();
  const allowed = await evaluateReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql168_production_apply_allowed, true);
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).ok, true);
  const otherLive = { ...manifest(pin), expected_live_definition_sha256: 'f'.repeat(64), live_definition_sha256: 'f'.repeat(64) };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherLive, { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  const otherStaging = { ...manifest(pin), staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } };
  assert.equal((await evaluateReleaseProductionApply(KEY, otherStaging, { root: ROOT, pin })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // SQL 167's phrase does not authorize SQL 168.
  assert.equal((await precheckReleaseProductionApply(KEY, { ...manifest(pin), authorization_phrase: 'RELINK_CHECK_TO_CORRECTED_EXISTING_CLAIM' }, { root: ROOT, pin, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const off = approved({ execute: false });
  const ctx = { root: ROOT, pin: off, connect: neverConnect, consumedPath: consumedPath() };
  assert.equal((await precheckReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await executeReleaseProductionApply(KEY, manifest(off), ctx)).code, CODES.GUARD_APPLY_FORBIDDEN);
  // A tampered file hash is a reconciliation stop.
  assert.equal(readPinnedReleaseSql(KEY, ROOT, { ...COMMITTED, source_sha256: 'f'.repeat(64) }).code, CODES.SQL_COLLISION);

  // CLI: --apply with the committed pin, read from disk, and a manifest on another pre-state refuses without connecting
  // or spending a receipt; credential flags are refused.
  const file = path.join(os.tmpdir(), `sql168-cli-${process.pid}.json`);
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
