/**
 * Production apply path for SQL 88 (tg_claim_id_assign_case tenant scope): its own tool
 * (scripts/deployment-guard/sql88-claim-id-assign-case-tenant-scope-production-apply.mjs)
 * and pin (ops/deployment-guard/sql88-claim-id-assign-case-tenant-scope-production-apply.json),
 * on the SQL 84-87 engine.
 *
 * The committed pin records the pre-state read by the production --inspect of 2026-10-16
 * (expected_live_definition_sha256), the guarded staging executor apply run in
 * staging_acceptance and the production apply of 2026-10-16 in applied; it is retired
 * (execute false, authorization "Applied to production …"), so evaluate and apply refuse
 * before any connection. The execute-authorized state it had before the apply (PR #1013)
 * stays tested with an explicit copy (unlocked()); the refusals of the earlier locked state
 * (authorization "pending", execute false, no staging acceptance) with another (pending());
 * the no-pre-state refusals use an explicit copy with the hash null (unrecorded()). The
 * apply tests use an
 * execute-authorized copy (authorized()) with a placeholder staging acceptance and,
 * against PostgreSQL, the pre-state the fixture's inspect read. The PostgreSQL fixture is
 * production-like: the real Supabase migrations, every object owned by the non-superuser
 * login checksops_admin, and rows with known cross-tenant links for the counts.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import { refuseUnguardedDeploy } from '../../scripts/deployment-guard/require-guard.mjs';
import { AUTHORIZED_SQL88_CLAIM_ID_ASSIGN_CASE_TENANT_SCOPE, MORTGAGE_DEFINITION_SHA256, MORTGAGE_KNOWN_DEFINITION_SHA256 } from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { mortgageAuthorizationApproved, mortgageIntendedFunctionAcl, MORTGAGE_PRODUCTION } from '../../scripts/deployment-guard/lib/mortgage-sql-production-apply.mjs';
import * as sql88 from '../../scripts/deployment-guard/lib/sql88-claim-id-assign-case-tenant-scope-production-apply.mjs';
import { INSPECT_RECORD_KEYS, ONE_SHOT_TOOLS, pickInspect } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { sqlGuardErrorMessage } from '../../scripts/deployment-guard/lib/errors.mjs';
import { main as cli88 } from '../../scripts/deployment-guard/sql88-claim-id-assign-case-tenant-scope-production-apply.mjs';
import { CLAIM_A, CLAIM_B, TENANT_A, TENANT_B, assertNoSeededPii, caseRolesSql } from './helpers/check-case-sql-pg.mjs';
import { SEEDED_CROSS_TENANT_COUNTS, SEEDED_CROSS_TENANT_TOTAL, claimIdSchemaSql, seedCrossTenantLinksSql } from './helpers/claim-id-assign-case-sql-pg.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const COMMIT = 'a'.repeat(40);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const FIXTURE_PRE = 'e'.repeat(64);
const SCRIPT = 'scripts/deployment-guard/sql88-claim-id-assign-case-tenant-scope-production-apply.mjs';
const PIN_REL = 'ops/deployment-guard/sql88-claim-id-assign-case-tenant-scope-production-apply.json';
const COMMITTED = JSON.parse(fs.readFileSync(path.join(ROOT, PIN_REL), 'utf8'));
const STAGING = AUTHORIZED_SQL88_CLAIM_ID_ASSIGN_CASE_TENANT_SCOPE;
const SQL87_PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/sql87-resolve-check-case-tenant-scope-production-apply.json'), 'utf8'));
const FN = 'public.tg_claim_id_assign_case()';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const OWNER_APPROVED = 'owner-approved 2026-10-16 in session ("approve applying SQL 88 to production"): test fixture';
/** Execute-authorized copy with a placeholder staging acceptance and pre-state. */
const authorized = (extra = {}) => Object.freeze({
  ...COMMITTED,
  authorization: OWNER_APPROVED,
  execute: true,
  expected_live_definition_sha256: FIXTURE_PRE,
  staging_acceptance: { ...COMMITTED.staging_acceptance, ok: true, reference: STAGING_REF, basis: 'test fixture' },
  ...extra,
});
/** The locked state before the execute change (authorization "pending", execute false, no staging acceptance). */
const PENDING_ACCEPTANCE = Object.freeze({ ok: false, reference: null, basis: 'Pending (test copy of the pre-authorization pin)' });
const pending = (extra = {}) => Object.freeze({
  ...COMMITTED,
  authorization: 'pending',
  execute: false,
  staging_acceptance: { ...COMMITTED.staging_acceptance, ...PENDING_ACCEPTANCE },
  ...extra,
});
/** The execute-authorized state before the apply (PR #1013), as an explicit copy of the retired pin. */
const UNLOCKED_AUTHORIZATION = 'Owner approved 2026-10-16 ("approve the SQL 88 production unlock after the pin PR"; "approve the SQL 88 production apply after unlock"): test copy of the execute-authorized pin before its record-and-retire change';
const unlocked = (extra = {}) => Object.freeze({ ...COMMITTED, authorization: UNLOCKED_AUTHORIZATION, execute: true, ...extra });
// The production apply of 2026-10-16 recorded in applied (its one_use_id is spent).
const APPLIED = Object.freeze({
  apply_ssm_command_id: 'fed3d3ce-659c-49d8-b364-8c625a64cd88',
  one_use_id: 'sql88-prod-e004a3aa-8242-4efb-b0f8-1b730c081b67',
  workstream_id: 'prod-sql88-claim-id-assign-case-20261016',
  source_commit: '44f42cf7ce48c5388058711022b7bc2d62e3f025',
  tarball_sha256: 'caa963c9b0ebc67a3c5ad0d0b00ce2c7f8ae0f801b44d1c1d4365ac754e44bf5',
  steps: ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect'],
});
/** The committed pin (or another) with no recorded pre-state, for the no-pre-state refusals. */
const unrecorded = (pin = COMMITTED) => Object.freeze({ ...pin, expected_live_definition_sha256: null });
// The read-only production --inspect of 2026-10-16 (SSM command 4e8aa79f-e123-4f39-85e8-b669d4072ee8,
// after SQL 87 was applied; source main 72cc069f). The earlier inspect before SQL 87 (SSM
// 4b86eb75-5d78-483c-8899-50a7971e9d42) gave the same hash.
const PRODUCTION_PRE = 'ef7a3e027b63761b2b35a3fdad62d5eacf18f292bc77886f820eb61f70584d1b';
const CROSS_TENANT_CATEGORIES = Object.freeze(Object.keys(SEEDED_CROSS_TENANT_COUNTS));
const CLAIM_TRIGGERS = Object.freeze(['assign_case_on_ledger_events', 'assign_case_on_ledger_tokens', 'assign_case_on_ledger_uploads', 'assign_case_on_mortgage_releases', 'assign_case_on_mortgage_draws', 'assign_case_on_signature_requests']);
// The guarded staging SQL executor apply and read-live runs recorded in staging_acceptance
// (main 13763c2c9, executor package deploy run 89, 38926313149).
const STAGING_ACCEPTANCE = Object.freeze({
  reference: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38927892056',
  apply_run: '38927892056',
  read_live_run: '38928065480',
  executor_code_sha256: '1tpvDpcA+wdCwitVyuOtZrFaBFu3d5YIGnNpkIlHYFQ=',
  migration: 'sql88-claim-id-assign-case-tenant-scope',
});

function manifest(pin, overrides = {}) {
  const fingerprint = { sql: pin.expected_live_definition_sha256 };
  const workstream = 'prod-sql88-claim-case-test';
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
    expected_live_definition_sha256: pin.expected_live_definition_sha256,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    live_definition_sha256: pin.expected_live_definition_sha256,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: pin.staging_acceptance,
    approval: { approved: true, workstream_id: workstream },
    authorization_phrase: pin.authorization_phrase,
    one_use_id: `sql88-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-16T12:00:00.000Z',
    ...overrides,
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql88-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
const neverConnect = async () => { throw new Error('should-not-connect'); };

async function runCli(argv, { env = { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, input, deps = {} } = {}) {
  let file = null;
  if (input) {
    file = path.join(os.tmpdir(), `sql88-prod-input-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(input));
  }
  const writes = [];
  let spent = 0;
  const orig = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await cli88(file ? [...argv, '--input', file] : argv, env, {
      root: ROOT,
      consumeReceiptOnce: () => { spent += 1; return { ok: true }; },
      connect: neverConnect,
      consumedPath: consumedPath(),
      ...deps,
    });
  } finally {
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
    if (file) fs.rmSync(file, { force: true });
  }
  return { out: writes.join(''), spent };
}

test('the production pin is applied and retired: execute false, the 2026-10-16 apply recorded in applied, the recorded production pre-state, the staging apply run; it names SQL 88 exactly and the production RDS; registered for the one-shot', () => {
  assert.equal(COMMITTED.id, 'sql88-claim-id-assign-case-tenant-scope-production-apply');
  assert.equal(COMMITTED.migration, 'sql88');
  assert.equal(COMMITTED.execute, false);
  // Retired: the authorization is no longer an owner approval the tool accepts.
  assert.match(COMMITTED.authorization, /^Applied to production on 2026-10-16; execute is false again/);
  assert.equal(mortgageAuthorizationApproved(COMMITTED), false);
  assert.match(COMMITTED.authorization, /That approval covered that run only$/);
  assert.ok(COMMITTED.authorization.includes(`workstream ${APPLIED.workstream_id}`));
  assert.ok(COMMITTED.authorization.includes('"approve the SQL 88 production unlock after the pin PR"'));
  assert.ok(COMMITTED.authorization.includes('"approve the SQL 88 production apply after unlock"'));
  // The production apply of 2026-10-16 (guarded production SQL one-shot).
  const applied = COMMITTED.applied;
  assert.equal(applied.date, '2026-10-16');
  assert.equal(applied.started_at, '2026-10-16T17:48:32Z');
  assert.equal(applied.finished_at, '2026-10-16T17:48:45Z');
  assert.equal(applied.result, 'applied');
  assert.equal(applied.runner, 'i-0c35557c4e5385406');
  assert.equal(applied.apply_ssm_command_id, APPLIED.apply_ssm_command_id);
  assert.equal(applied.source_commit, APPLIED.source_commit);
  assert.deepEqual(applied.source_tarball, { file: `source-${APPLIED.source_commit}.tar.gz`, sha256: APPLIED.tarball_sha256 });
  assert.equal(applied.workstream_id, APPLIED.workstream_id);
  assert.equal(applied.operator, 'michaelcarletta-cmd');
  assert.equal(applied.owner_approval, 'approve the SQL 88 production apply after unlock');
  assert.equal(applied.one_use_id, APPLIED.one_use_id);
  assert.equal(applied.one_use_id_consumed, true);
  assert.deepEqual(applied.steps, APPLIED.steps.map((step) => ({ step, ok: true })));
  assert.deepEqual(applied.receipt, { result: 'applied', before_hash: PRODUCTION_PRE, after_hash: COMMITTED.intended_replacement_sha256 });
  assert.equal(applied.post_apply_inspect.read_only, true);
  assert.equal(applied.post_apply_inspect.already_applied, true);
  assert.deepEqual(applied.post_apply_inspect.precondition_failures, []);
  assert.deepEqual(applied.post_apply_inspect.function_states, {
    tg_claim_id_assign_case: 'intended',
    resolve_check_case: 'tenant_scoped',
    tg_check_intake_assign_case: 'case_original',
    tg_loss_draft_assign_case: 'case_original',
  });
  assert.equal(applied.post_apply_inspect.cross_tenant_links_total_before, 0);
  assert.equal(applied.post_apply_inspect.cross_tenant_links_total_after, 0);
  assert.match(COMMITTED.production_evidence['2026-10-16 apply'], /execute is false/);
  // The pre-state recorded from the read-only production inspect, not code-derived.
  const inspect = COMMITTED.production_inspect;
  assert.equal(COMMITTED.expected_live_definition_sha256, PRODUCTION_PRE);
  assert.equal(inspect.live_definition_sha256, COMMITTED.expected_live_definition_sha256);
  assert.notEqual(COMMITTED.expected_live_definition_sha256, COMMITTED.intended_replacement_sha256);
  assert.equal(inspect.status, 'recorded');
  assert.equal(inspect.date, '2026-10-16');
  assert.equal(inspect.ssm_command_id, '4e8aa79f-e123-4f39-85e8-b669d4072ee8');
  assert.deepEqual(inspect.ssm_command_ids, ['4e8aa79f-e123-4f39-85e8-b669d4072ee8', '4b86eb75-5d78-483c-8899-50a7971e9d42']);
  assert.equal(inspect.source_commit, '72cc069fa1fef0195056bfe4e2f6d7d85a6283b8');
  assert.equal(inspect.source_tarball_sha256, '4d8a553ea8989a7be30671334f143d074b1622eecb7d176c98e166e5a2fc29df');
  assert.equal(inspect.read_only, true);
  assert.equal(inspect.connected_as, 'checksops_admin');
  assert.equal(inspect.login_rolsuper, false);
  assert.deepEqual(inspect.function_states, {
    tg_claim_id_assign_case: 'case_original',
    resolve_check_case: 'tenant_scoped',
    tg_check_intake_assign_case: 'case_original',
    tg_loss_draft_assign_case: 'case_original',
  });
  // The recorded body is the label the inspect recognises.
  assert.equal(inspect.functions.tg_claim_id_assign_case.definition_sha256, MORTGAGE_KNOWN_DEFINITION_SHA256[FN].case_original);
  assert.equal(inspect.functions.tg_claim_id_assign_case.proacl, '{=X/checksops_admin,checksops_admin=X/checksops_admin,checksops=X/checksops_admin}');
  for (const name of ['tg_claim_id_assign_case', 'resolve_check_case', 'tg_check_intake_assign_case', 'tg_loss_draft_assign_case']) {
    assert.equal(inspect.functions[name].owner, 'checksops_admin', name);
    assert.equal(inspect.functions[name].security_definer, true, name);
    assert.equal(inspect.functions[name].state, inspect.function_states[name], name);
  }
  assert.equal(inspect.case_owner.case_owner_safe, true);
  assert.deepEqual(inspect.other_callers, { trigger_count: 6, total: 0 });
  assert.deepEqual(Object.keys(inspect.claim_triggers), [...CLAIM_TRIGGERS]);
  assert.ok(Object.values(inspect.claim_triggers).every((row) => row.present && row.enabled && row.calls_function));
  // Counts only, every category of the tool, all 0 in production.
  assert.deepEqual(inspect.cross_tenant_links, { readable: true, total: 0, categories: Object.fromEntries(CROSS_TENANT_CATEGORIES.map((key) => [key, 0])), unreadable_categories: [] });
  assert.equal(CROSS_TENANT_CATEGORIES.length, 11);
  assert.deepEqual(inspect.precondition_failures, []);
  assert.equal(inspect.apply_preconditions_met, false, 'the value at inspect time, before the pre-state was recorded');
  assert.match(inspect.note, /SQL 88 production pin: pre-state recorded and execute-authorized after staging acceptance/);
  assert.doesNotMatch(JSON.stringify(COMMITTED), /check_ids|claim_ids|case_ids/);
  // Staging and production pre-states are recorded separately; here they differ.
  assert.equal(STAGING.expected_live_definition_sha256, '57ba25f2ea69adb1a6de030cb42034d4dd1e1c0741a48a96e79afe6d90aae387');
  assert.notEqual(STAGING.expected_live_definition_sha256, COMMITTED.expected_live_definition_sha256);
  const { basis, production_differs: differs } = COMMITTED.staging_acceptance;
  assert.match(differs, /pre-states differ/);
  assert.ok(differs.includes(STAGING.expected_live_definition_sha256));
  assert.ok(differs.includes(COMMITTED.expected_live_definition_sha256));
  assert.match(differs, /check_cases_claim 1, homeowner_ledger_events_case 4/);
  // The guarded staging SQL executor apply run (staging pre-state -> the intended post-state).
  assert.equal(COMMITTED.staging_acceptance.ok, true);
  assert.equal(COMMITTED.staging_acceptance.reference, STAGING_ACCEPTANCE.reference);
  assert.match(COMMITTED.staging_acceptance.reference, /^https:\/\/github\.com\/michaelcarletta-cmd\/ChecksOps\/actions\/runs\/\d+$/);
  assert.ok(basis.startsWith(`Guarded staging SQL executor apply of ${STAGING_ACCEPTANCE.migration}, `));
  assert.ok(basis.includes(`(${STAGING_ACCEPTANCE.apply_run})`));
  assert.ok(basis.includes('read-live run #') && basis.includes(`(${STAGING_ACCEPTANCE.read_live_run})`));
  assert.ok(basis.includes(`${STAGING.expected_live_definition_sha256} -> ${COMMITTED.intended_replacement_sha256}`));
  assert.ok(basis.includes(STAGING_ACCEPTANCE.executor_code_sha256));
  assert.match(basis, /result applied/);
  assert.match(basis, /already_applied true/);
  assert.match(basis, /precondition_failures \[\]/);
  for (const field of ['filename', 'migration_id', 'source_sha256', 'intended_replacement_sha256']) assert.equal(COMMITTED[field], STAGING[field], field);
  assert.equal(COMMITTED.staging_pin_commit, STAGING.commit);
  assert.deepEqual(COMMITTED.function_identities, [...STAGING.function_identities]);
  assert.equal(sha(fs.readFileSync(path.join(ROOT, COMMITTED.filename))), COMMITTED.source_sha256);
  assert.equal(COMMITTED.intended_replacement_sha256, '15fbe8f5f4598ee65b24599fa7396e4e03e75daa163f5cedcc8227aa560b1d2e');
  assert.equal(COMMITTED.authorization_phrase, 'APPLY_CLAIM_ID_ASSIGN_CASE_TENANT_SCOPE');
  assert.notEqual(COMMITTED.authorization_phrase, SQL87_PIN.authorization_phrase);
  for (const field of ['rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(COMMITTED[field], SQL87_PIN[field], field);
  assert.deepEqual(COMMITTED.intended_post_state.function_definition_sha256, { tg_claim_id_assign_case: MORTGAGE_DEFINITION_SHA256[FN] });
  assert.equal(COMMITTED.intended_post_state.function_owner, 'checksops_admin');
  assert.deepEqual(COMMITTED.intended_post_state.function_acl, { tg_claim_id_assign_case: '{checksops_admin=X/checksops_admin}' });
  const fn = { grantees: [] };
  assert.equal(mortgageIntendedFunctionAcl(COMMITTED, fn), COMMITTED.intended_post_state.function_acl.tg_claim_id_assign_case);
  assert.equal(sql88.SQL88_PRODUCTION_PIN_REL, PIN_REL);
  assert.equal(MORTGAGE_PRODUCTION.sql88.staging_pin, STAGING);
  assert.deepEqual(ONE_SHOT_TOOLS.sql88, { key: 'sql88', script: SCRIPT, args: [], pin_rel: PIN_REL, allowed_key: 'sql88_production_apply_allowed' });
});

test('SQL 88 guard errors map to fixed messages; the one-shot records other callers and cross-tenant links as counts only, cross_tenant_links first', () => {
  for (const raw of [
    'claim_case_owner_unsafe: the API role checksops is a member of tg_claim_id_assign_case owner checksops_admin and would keep its EXECUTE',
    'claim_case_callers_unsafe: SQL 88 revokes EXECUTE on tg_claim_id_assign_case from the API roles, but other objects use it: function public.claim_case_probe(), dependent pg_rewrite 16999',
  ]) {
    const message = sqlGuardErrorMessage(new Error(raw));
    assert.doesNotMatch(message, /checksops_admin|claim_case_probe|16999/);
    assert.match(message, /SQL 88|tg_claim_id_assign_case/);
    assert.match(message, /run --inspect for details$/);
  }
  // SQL 87's prefixes keep their own messages.
  assert.match(sqlGuardErrorMessage(new Error('case_owner_unsafe: x')), /SQL 87/);
  const picked = pickInspect({
    case_owner: { case_owner_safe: false, api_roles_member_of_owner: ['checksops'] },
    other_callers: { function_count: 1, functions: ['public.claim_case_probe()'], views_or_rules: [], view_or_rule_count: 0, policy_count: 0, policies: [], dependent_function_count: 0, other_dependent_count: 0, trigger_count: 6, total: 1 },
    cross_tenant_links: { readable: true, total: 2, categories: { check_cases_claim: 2 }, unreadable_categories: [], ids: ['x'] },
  });
  assert.deepEqual(picked.other_callers, { function_count: 1, view_or_rule_count: 0, policy_count: 0, dependent_function_count: 0, other_dependent_count: 0, trigger_count: 6, total: 1 });
  assert.deepEqual(picked.cross_tenant_links, { readable: true, total: 2, categories: { check_cases_claim: 2 }, unreadable_categories: [] });
  assert.equal(Object.keys(picked)[0], 'cross_tenant_links');
  assert.equal(INSPECT_RECORD_KEYS[0], 'cross_tenant_links');
  assert.equal(picked.case_owner.case_owner_safe, false);
});

test('the tool is inventoried as GUARDED and its tests run in test:deployment-guard and the deployment-guard workflow', () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/bypass-inventory.json'), 'utf8'));
  const rows = JSON.stringify(inventory);
  assert.match(rows, /"path":"scripts\/deployment-guard\/sql88-claim-id-assign-case-tenant-scope-production-apply\.mjs","classification":"GUARDED","capabilities":\["sql88-production-apply"\]/);
  assert.match(rows, /\(sql71, sql77, sql78, sql79, sql80, sql81, sql82, sql83, sql84, sql85, sql86, sql87, sql88, sql89, sql90, sql91, sql92, sql93, sql94, sql95, sql96, sql97, sql98, sql99, sql100, sql101, sql102, sql103, sql104, sql105, sql106, sql108, sql109, sql110, sql111, sql112, sql113, sql114, sql115, sql116, sql117, sql118, sql119, sql120, sql121, sql122, sql123, sql124, sql125, sql126, sql127, sql128, sql129, sql130, sql131, sql132, sql133, sql134, sql135, sql137, sql138\)/);
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const name of ['aws/tests/sql88-claim-id-assign-case-executor.test.mjs', 'aws/tests/sql88-claim-id-assign-case-production-apply.test.mjs']) {
    assert.ok(scripts['test:deployment-guard'].includes(name), name);
    assert.ok(workflow.includes(name), name);
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'ops/production-sql-88-apply.md')));
  assert.match(fs.readFileSync(path.join(ROOT, 'ops/production-sql-one-shot.md'), 'utf8'), /\| `sql88` \| `scripts\/deployment-guard\/sql88-claim-id-assign-case-tenant-scope-production-apply\.mjs` \(`ops\/production-sql-88-apply\.md`\) \|/);
});

test('the pre-authorization (pending) pin is refused before any connection: no pre-state is SQL_COLLISION, a recorded one with authorization pending is PRODUCTION_APPROVAL_REQUIRED', async () => {
  const locked = pending();
  assert.equal(locked.execute, false);
  assert.equal(locked.authorization, 'pending');
  assert.equal(locked.staging_acceptance.ok, false);
  assert.equal(locked.expected_live_definition_sha256, COMMITTED.expected_live_definition_sha256);
  // No pre-state recorded (null), whatever the manifest says (the state before this change).
  const noPre = await sql88.evaluateSql88ProductionApply(manifest(unrecorded(locked)), { root: ROOT, pin: unrecorded(locked) });
  assert.equal(noPre.code, CODES.SQL_COLLISION);
  assert.match(noPre.message, /no recorded pre-apply live definition hash/);
  const noPreAuthorized = await sql88.evaluateSql88ProductionApply(manifest(authorized()), { root: ROOT, pin: unrecorded(authorized()) });
  assert.equal(noPreAuthorized.code, CODES.SQL_COLLISION);
  // The pending copy (pre-state recorded, authorization pending), even with a staging acceptance.
  const pendingPin = await sql88.evaluateSql88ProductionApply(manifest(COMMITTED, { staging_acceptance: authorized().staging_acceptance }), { root: ROOT, pin: locked });
  assert.equal(pendingPin.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.match(pendingPin.message, /authorization is not an owner approval/);
  assert.equal((await sql88.executeSql88ProductionApply(manifest(COMMITTED, { staging_acceptance: authorized().staging_acceptance }), { root: ROOT, pin: locked, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // An owner approval alone is not enough: execute false still refuses, and so does the missing staging acceptance.
  const approvedOnly = { ...locked, authorization: OWNER_APPROVED };
  assert.equal((await sql88.evaluateSql88ProductionApply(manifest(COMMITTED), { root: ROOT, pin: approvedOnly })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await sql88.executeSql88ProductionApply(manifest(COMMITTED, { staging_acceptance: authorized().staging_acceptance }), { root: ROOT, pin: { ...approvedOnly, staging_acceptance: authorized().staging_acceptance }, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.GUARD_APPLY_FORBIDDEN);
  const recorded = { ...locked, expected_live_definition_sha256: FIXTURE_PRE, staging_acceptance: authorized().staging_acceptance };
  const pendingApproval = await sql88.evaluateSql88ProductionApply(manifest(recorded), { root: ROOT, pin: recorded });
  assert.equal(pendingApproval.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const run = (overrides, pin = authorized()) => sql88.executeSql88ProductionApply(manifest(authorized(), overrides), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() });
  assert.equal((await run({}, pending({ expected_live_definition_sha256: FIXTURE_PRE }))).code, CODES.PRODUCTION_APPROVAL_REQUIRED, 'a pending pin');
  // The execute-authorized copy is bound to the recorded production pre-state, not the fixture's.
  assert.equal((await sql88.executeSql88ProductionApply(manifest(authorized()), { root: ROOT, pin: unlocked(), connect: neverConnect, consumedPath: consumedPath() })).code, CODES.SQL_COLLISION, 'the unlocked copy');
  // The committed (retired) pin refuses whatever the manifest says.
  assert.equal((await sql88.executeSql88ProductionApply(manifest(authorized()), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED, 'the committed pin');
  assert.equal((await run({}, unrecorded(authorized()))).code, CODES.SQL_COLLISION, 'no pre-state');
  assert.equal((await run({}, { ...authorized(), staging_acceptance: PENDING_ACCEPTANCE })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({}, { ...authorized(), execute: false })).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await run({ authorization_phrase: 'yes' })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({ authorization_phrase: SQL87_PIN.authorization_phrase })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({ one_use_id: 'x' })).code, CODES.INVALID_MANIFEST);
  for (const authorization of ['pending', '', undefined, 'approved']) {
    assert.equal((await run({}, authorized({ authorization }))).code, CODES.PRODUCTION_APPROVAL_REQUIRED, JSON.stringify(authorization));
  }
  // A pin naming another migration's file or post-state is refused.
  for (const forged of [authorized({ filename: SQL87_PIN.filename }), authorized({ intended_replacement_sha256: 'c'.repeat(64) }), authorized({ function_identities: [] })]) {
    const result = await sql88.evaluateSql88ProductionApply(manifest(forged), { root: ROOT, pin: forged });
    assert.equal(result.code, CODES.SQL_COLLISION, JSON.stringify(result));
  }
  const passes = await run({}).catch((error) => error);
  assert.match(String(passes?.message || ''), /should-not-connect/);
});

test('the committed (retired) pin refuses before any connection, also with the spent one_use_id; flipping execute alone does not revive it', async () => {
  for (const opts of [{ root: ROOT }, { root: ROOT, pin: COMMITTED }]) {
    const refused = await sql88.evaluateSql88ProductionApply(manifest(COMMITTED), opts);
    assert.equal(refused.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    assert.match(refused.message, /authorization is not an owner approval/);
    assert.equal((await sql88.executeSql88ProductionApply(manifest(COMMITTED), { ...opts, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  }
  // execute true on the retired pin is still refused: its authorization records the spent run.
  const flipped = { ...COMMITTED, execute: true };
  assert.equal((await sql88.evaluateSql88ProductionApply(manifest(COMMITTED), { root: ROOT, pin: flipped })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await sql88.executeSql88ProductionApply(manifest(COMMITTED), { root: ROOT, pin: flipped, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // An owner approval with execute false (the retired pin's execute) refuses the apply.
  assert.equal((await sql88.executeSql88ProductionApply(manifest(COMMITTED), { root: ROOT, pin: { ...unlocked(), execute: false }, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.GUARD_APPLY_FORBIDDEN);
  // The spent one_use_id is refused as a replay, even on an execute-authorized copy.
  const spentFile = consumedPath();
  fs.writeFileSync(spentFile, JSON.stringify({ consumed: [APPLIED.one_use_id] }));
  try {
    const replay = await sql88.executeSql88ProductionApply(manifest(COMMITTED, { one_use_id: APPLIED.one_use_id }), { root: ROOT, pin: unlocked(), connect: neverConnect, consumedPath: spentFile });
    assert.equal(replay.code, CODES.RECEIPT_REUSED);
    assert.equal((await sql88.executeSql88ProductionApply(manifest(COMMITTED, { one_use_id: APPLIED.one_use_id }), { root: ROOT, connect: neverConnect, consumedPath: spentFile })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  } finally {
    fs.rmSync(spentFile, { force: true });
  }
});

test('the execute-authorized copy (the pin before its record-and-retire change) evaluates with a matching manifest and reaches the connection only after every pre-connect check', async () => {
  for (const opts of [{ root: ROOT, pin: unlocked() }]) {
    const allowed = await sql88.evaluateSql88ProductionApply(manifest(COMMITTED), opts);
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
    assert.equal(allowed.details.sql88_production_apply_allowed, true);
    assert.equal(allowed.details.migration, 'sql88');
    assert.equal(allowed.details.expected_live_definition_sha256, PRODUCTION_PRE);
    assert.equal(allowed.details.intended_replacement_sha256, COMMITTED.intended_replacement_sha256);
    assert.equal(allowed.details.staging_acceptance, STAGING_ACCEPTANCE.reference);
  }
  // The copy still binds the manifest: another staging reference, the placeholder
  // pre-state, staging's pre-state, the post-state as live hash or another workstream's approval refuse.
  const pin = unlocked();
  const otherRef = await sql88.evaluateSql88ProductionApply(manifest(COMMITTED, { staging_acceptance: { ok: true, reference: STAGING_REF } }), { root: ROOT, pin });
  assert.equal(otherRef.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await sql88.evaluateSql88ProductionApply(manifest(authorized()), { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  assert.equal((await sql88.evaluateSql88ProductionApply(manifest(COMMITTED, { live_definition_sha256: STAGING.expected_live_definition_sha256 }), { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  assert.equal((await sql88.evaluateSql88ProductionApply(manifest(COMMITTED, { live_definition_sha256: COMMITTED.intended_replacement_sha256 }), { root: ROOT, pin })).code, CODES.SQL_COLLISION);
  assert.equal((await sql88.evaluateSql88ProductionApply(manifest(COMMITTED, { approval: { approved: true, workstream_id: 'another' } }), { root: ROOT, pin })).ok, false);
  // A wrong phrase (SQL 87's) or no single-use id refuses on the copy too.
  assert.equal((await sql88.executeSql88ProductionApply(manifest(COMMITTED, { authorization_phrase: SQL87_PIN.authorization_phrase }), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await sql88.executeSql88ProductionApply(manifest(COMMITTED, { one_use_id: 'x' }), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.INVALID_MANIFEST);
  // SQL 87's spent one_use_id is not a fresh id for SQL 88 either: once in SQL 88's registry it is a replay.
  const spentFile = consumedPath();
  fs.writeFileSync(spentFile, JSON.stringify({ consumed: [SQL87_PIN.applied.one_use_id] }));
  try {
    assert.equal((await sql88.executeSql88ProductionApply(manifest(COMMITTED, { one_use_id: SQL87_PIN.applied.one_use_id }), { root: ROOT, pin, connect: neverConnect, consumedPath: spentFile })).code, CODES.RECEIPT_REUSED);
  } finally {
    fs.rmSync(spentFile, { force: true });
  }
  // With execute false (as after the record-and-retire change) the apply is refused.
  assert.equal((await sql88.executeSql88ProductionApply(manifest(COMMITTED), { root: ROOT, pin: { ...pin, execute: false }, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.GUARD_APPLY_FORBIDDEN);
  // The apply passes its pre-connect checks on the copy and stops only at the (test) connection.
  const passes = await sql88.executeSql88ProductionApply(manifest(COMMITTED), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() }).catch((error) => error);
  assert.match(String(passes?.message || ''), /should-not-connect/);
});

test('CLI: the committed (retired) pin refuses at evaluation and an execute-authorized copy with no receipt at the guard; a pending pin refuses at evaluation; with an authorized copy no receipt is DEPLOYMENT_GUARD_REQUIRED; the receipt is never spent on a wrong phrase, execute false, a wrong owner, a reused id, a missing guard flag or arbitrary SQL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql88-prod-noreceipt-'));
  try {
    const input = path.join(dir, 'sql88.json');
    fs.writeFileSync(input, JSON.stringify(manifest(COMMITTED)));
    const result = spawnSync(process.execPath, [path.join(ROOT, SCRIPT), '--apply', '--input', input], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
    });
    // The committed pin is retired: evaluation refuses before the guard, the secret or any
    // connection. The env flag does not bypass it.
    const out = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, out);
    assert.match(out, /PRODUCTION_APPROVAL_REQUIRED/);
    assert.match(out, /authorization is not an owner approval/);
    assert.doesNotMatch(out, /secretsmanager|ECONNREFUSED|rolled back/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The retired pin read from disk stops before the guard is asked.
  const retired = await runCli(['--apply'], { input: manifest(COMMITTED), deps: { enforceScriptGuard: () => { throw new Error('guard-called'); } } });
  assert.equal(retired.spent, 0);
  assert.match(retired.out, /PRODUCTION_APPROVAL_REQUIRED/);
  assert.doesNotMatch(retired.out, /guard-called|should-not-connect/);
  // The execute-authorized copy with no receipt stops at the guard (DEPLOYMENT_GUARD_REQUIRED).
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql88-prod-unlocked-noreceipt-'));
  try {
    const unlockedNoReceipt = await runCli(['--apply'], {
      input: manifest(COMMITTED),
      deps: { pin: unlocked(), enforceScriptGuard: (spec) => refuseUnguardedDeploy(spec, { root: emptyRoot, env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' } }) },
    });
    assert.equal(unlockedNoReceipt.spent, 0);
    assert.match(unlockedNoReceipt.out, /DEPLOYMENT_GUARD_REQUIRED/);
    assert.doesNotMatch(unlockedNoReceipt.out, /should-not-connect/);
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
  // A pending pin (authorization "pending", execute false) stops before the guard is asked.
  const locked = await runCli(['--apply'], { input: manifest(COMMITTED), deps: { pin: pending(), enforceScriptGuard: () => { throw new Error('guard-called'); } } });
  assert.equal(locked.spent, 0);
  assert.match(locked.out, /PRODUCTION_APPROVAL_REQUIRED/);
  assert.match(locked.out, /authorization is not an owner approval/);
  assert.doesNotMatch(locked.out, /guard-called|should-not-connect/);
  const pin = authorized();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sql88-prod-noreceipt-root-'));
  try {
    const noReceipt = await runCli(['--apply'], {
      input: manifest(pin),
      deps: { pin, enforceScriptGuard: (spec) => refuseUnguardedDeploy(spec, { root: empty, env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' } }) },
    });
    assert.equal(noReceipt.spent, 0);
    assert.match(noReceipt.out, /DEPLOYMENT_GUARD_REQUIRED/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
  const owned = (filename = pin.filename) => ({ ok: true, details: { receipt: { owned_components: [filename] } } });
  const argv = ['--apply'];
  const phrase = await runCli(argv, { input: manifest(pin, { authorization_phrase: 'yes' }), deps: { pin, enforceScriptGuard: () => owned() } });
  assert.match(phrase.out, /PRODUCTION_APPROVAL_REQUIRED/);
  const notExecutable = await runCli(argv, { input: manifest(pin), deps: { pin: { ...pin, execute: false }, enforceScriptGuard: () => owned() } });
  assert.match(notExecutable.out, /execute is not authorized/);
  // A pending pin (pre-authorization state) stops before the guard is even asked.
  const committed = await runCli(argv, { input: manifest(pin), deps: { pin: pending(), enforceScriptGuard: () => { throw new Error('guard-called'); } } });
  assert.match(committed.out, /PRODUCTION_APPROVAL_REQUIRED/);
  assert.doesNotMatch(committed.out, /guard-called/);
  const noPreState = await runCli(argv, { input: manifest(pin), deps: { pin: unrecorded(pin), enforceScriptGuard: () => { throw new Error('guard-called'); } } });
  assert.match(noPreState.out, /SQL_COLLISION/);
  assert.doesNotMatch(noPreState.out, /guard-called/);
  const wrongOwner = await runCli(argv, { input: manifest(pin), deps: { pin, enforceScriptGuard: () => owned(SQL87_PIN.filename) } });
  assert.match(wrongOwner.out, /RECEIPT_MISMATCH/);
  const reusedFile = consumedPath();
  fs.writeFileSync(reusedFile, JSON.stringify({ consumed: ['sql88-prod-reused-id'] }));
  const reused = await runCli(argv, { input: manifest(pin, { one_use_id: 'sql88-prod-reused-id' }), deps: { pin, enforceScriptGuard: () => owned(), consumedPath: reusedFile } });
  assert.match(reused.out, /RECEIPT_REUSED/);
  const noFlag = await runCli(argv, { env: {}, input: manifest(pin), deps: { pin, enforceScriptGuard: () => owned() } });
  assert.match(noFlag.out, /blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1/);
  const arbitrary = await runCli(argv, { input: { ...manifest(pin), sql_text: `GRANT EXECUTE ON FUNCTION ${FN} TO authenticated` }, deps: { pin, enforceScriptGuard: () => owned() } });
  assert.match(arbitrary.out, /arbitrary SQL text is forbidden/);
  for (const r of [phrase, notExecutable, committed, noPreState, wrongOwner, reused, noFlag, arbitrary]) {
    assert.equal(r.spent, 0);
    assert.doesNotMatch(r.out, /should-not-connect/);
  }
});

test('--inspect reads the secret from the pinned ARN only, never a flag, and never connects when the secret is refused', async () => {
  const asked = [];
  const refused = await runCli(['--inspect', '--password', 'hunter2'], {
    deps: { connect: undefined, getSecretValue: async (id) => { asked.push(id); return 'not json'; } },
  });
  assert.deepEqual(asked, [COMMITTED.admin_secret_arn]);
  assert.match(refused.out, /could not read the production admin secret/);
  assert.doesNotMatch(refused.out, /hunter2|should-not-connect/);
  const otherSecret = await runCli(['--inspect'], {
    deps: { connect: undefined, pin: { ...COMMITTED, admin_secret_arn: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:other' }, getSecretValue: async () => { throw new Error('must not be asked'); } },
  });
  assert.match(otherSecret.out, /not the existing production checksops_admin secret/);
});

test('the real guard: a staging receipt cannot authorize production; a production receipt is spent once and a refusing DB rolls back', async () => {
  const NOW = Date.parse('2026-10-16T12:00:00.000Z');
  const pin = authorized();
  const issue = (root, overrides) => {
    const input = manifest(pin);
    const spec = {
      workstream_id: input.workstream_id,
      branch: 'main',
      commit: COMMIT,
      operator: 'owner',
      target_environment: 'production',
      target_component: 'production-sql',
      deployment_type: 'sql-apply',
      owned_components: [pin.filename],
      preflight_live_fingerprint: input.preflight_live_fingerprint,
      ...overrides,
    };
    const lease = acquireLease(root, {
      workstream_id: spec.workstream_id, component: spec.target_component, environment: spec.target_environment, commit: spec.commit, operator: spec.operator,
    }, NOW);
    assert.equal(lease.ok, true, lease.message);
    spec.lease = lease.details.lease;
    const issued = issueReceipt(root, spec, { now: NOW, ttlMs: 15 * 60 * 1000 });
    assert.equal(issued.ok, true, issued.message);
    return { input, receipt: issued.details.receipt };
  };
  const guardWith = (root, receipt) => (spec) => refuseUnguardedDeploy({ ...spec, receipt_path: undefined, receipt }, { root, now: NOW + 1000, env: {} });
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql88-prod-staging-receipt-'));
  const prodRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql88-prod-receipt-'));
  try {
    const staging = issue(stagingRoot, { target_environment: 'staging', target_component: 'staging-sql' });
    const refused = await runCli(['--apply'], { input: staging.input, deps: { pin, enforceScriptGuard: guardWith(stagingRoot, staging.receipt) } });
    assert.equal(refused.spent, 0);
    assert.match(refused.out, /RECEIPT_MISMATCH/);
    const prod = issue(prodRoot, {});
    const refusingDb = async () => ({ query: async () => { throw new Error('db-unavailable'); }, end: async () => {} });
    const valid = await runCli(['--apply'], { input: prod.input, deps: { pin, enforceScriptGuard: guardWith(prodRoot, prod.receipt), connect: refusingDb } });
    assert.equal(valid.spent, 1);
    assert.match(valid.out, /rolled back/);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.rmSync(prodRoot, { recursive: true, force: true });
  }
});

// --- PostgreSQL 16 ---------------------------------------------------------------

const PROD_OWNER = 'checksops_admin';
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK TO)\b/i;

test('PostgreSQL 16: production inspect is read-only, reports the cross-tenant link counts first and prints no PII or row ids; SQL 88 applies exactly once; a wrong login, drift, other callers and collateral changes are refused', { timeout: 300000 }, async (t) => {
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
  const server = startPg('pg-sql88-prod-', 59600);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  const connectAs = async (user) => {
    const client = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await client.connect();
    return client;
  };
  try {
    await admin.query(caseRolesSql(PROD_OWNER));
    const setup = await connectAs(PROD_OWNER);
    await setup.query(claimIdSchemaSql({ withSql87: true }));
    await setup.end();
    const seen = [];
    const connectWith = (user) => async () => {
      const client = await connectAs(user);
      const query = client.query.bind(client);
      client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
      return client;
    };
    const connect = connectWith(PROD_OWNER);
    // Clean: every count is 0. The pre-authorization pin with no recorded pre-state (as before
    // the production inspect was recorded).
    const clean = await sql88.inspectSql88Production({ connect, pin: unrecorded(pending()), root: ROOT });
    assert.equal(clean.ok, true, JSON.stringify(clean));
    assert.equal(clean.details.cross_tenant_links.total, 0);
    assert.ok(Object.values(clean.details.cross_tenant_links.categories).every((n) => n === 0));
    const owner = await connectAs(PROD_OWNER);
    await owner.query(seedCrossTenantLinksSql());
    seen.length = 0;
    const first = await sql88.inspectSql88Production({ connect, pin: unrecorded(pending()), root: ROOT });
    assert.equal(first.ok, true, JSON.stringify(first));
    const d = first.details;
    assert.equal(seen[0], 'BEGIN READ ONLY');
    assert.equal(seen.at(-1), 'ROLLBACK');
    assert.ok(seen.slice(1, -1).every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
    // The counts, prominently: right after the migration and file names; counts only.
    assert.deepEqual(Object.keys(d).slice(0, 4), ['read_only', 'migration', 'filename', 'cross_tenant_links']);
    assert.deepEqual(d.cross_tenant_links, { readable: true, total: SEEDED_CROSS_TENANT_TOTAL, categories: SEEDED_CROSS_TENANT_COUNTS, unreadable_categories: [] });
    assert.equal(d.live_definition_sha256, clean.details.live_definition_sha256, 'the counts are not part of the fingerprint');
    assert.equal(d.read_only, true);
    assert.equal(d.source_ok, true);
    assert.equal(d.pin_execute, false);
    assert.equal(d.pre_state_recorded, false);
    assert.equal(d.apply_preconditions_met, false);
    assert.deepEqual(d.precondition_failures, [], 'the counts never block');
    assert.equal(d.current_user, PROD_OWNER);
    assert.deepEqual(d.owner_roles, [PROD_OWNER]);
    assert.equal(d.authenticated_member_of_owner, false);
    assert.equal(d.functions.tg_claim_id_assign_case.state, 'case_original');
    assert.match(d.functions.tg_claim_id_assign_case.definition, /^CREATE OR REPLACE FUNCTION public\.tg_claim_id_assign_case\(\)/);
    assert.equal(d.functions.resolve_check_case.definition, undefined, 'only the trigger function definition is printed');
    assert.equal(d.functions.resolve_check_case.state, 'tenant_scoped');
    assert.equal(d.case_owner.case_owner_safe, true);
    assert.equal(d.other_callers.total, 0);
    assert.equal(d.other_callers.trigger_count, 6);
    assert.deepEqual(d.case_owners.resolve_check_case, {
      exists: true, rolname: PROD_OWNER, rolsuper: false, security_definer: true, member_of_checksops: false, member_of_authenticated: false, proacl: `{${PROD_OWNER}=X/${PROD_OWNER}}`,
    });
    assert.equal(d.case_owners.tg_claim_id_assign_case.proacl, `{${PROD_OWNER}=X/${PROD_OWNER}}`);
    assert.ok(Object.values(d.claim_triggers).every((row) => row.present && row.enabled && row.calls_function));
    assertNoSeededPii(assert, first, 'production inspect');
    assert.doesNotMatch(JSON.stringify(first), UUID_RE);
    // The one-shot's recorded copy of the inspect keeps the counts.
    assert.deepEqual(pickInspect(d).cross_tenant_links, d.cross_tenant_links);

    const pin = authorized({ expected_live_definition_sha256: d.live_definition_sha256 });
    const ready = await sql88.inspectSql88Production({ connect, pin, root: ROOT });
    assert.equal(ready.details.apply_preconditions_met, true, JSON.stringify(ready.details.precondition_failures));

    const asSuperuser = await sql88.executeSql88ProductionApply(manifest(pin), { root: ROOT, pin, connect: connectWith('ubuntu'), consumedPath: consumedPath() });
    assert.equal(asSuperuser.code, CODES.DEPLOYMENT_COLLISION);
    assert.ok(asSuperuser.details.failed.includes('login_is_pinned_owner'));
    const apply = (overrides = {}, ctx = {}) => sql88.executeSql88ProductionApply(manifest(pin, overrides), { root: ROOT, pin, connect, consumedPath: consumedPath(), ...ctx });
    await admin.query(`GRANT ${PROD_OWNER} TO authenticated WITH INHERIT FALSE`);
    const member = await apply();
    assert.equal(member.code, CODES.DEPLOYMENT_COLLISION);
    assert.ok(member.details.failed.includes('authenticated_not_member_of_owner'));
    assert.ok(member.details.failed.includes('case_owner_safe'));
    await admin.query(`REVOKE ${PROD_OWNER} FROM authenticated`);
    await owner.query(`GRANT EXECUTE ON FUNCTION ${FN} TO service_role`);
    assert.equal((await apply()).code, CODES.DEPLOYMENT_COLLISION, 'drift');
    await owner.query(`REVOKE EXECUTE ON FUNCTION ${FN} FROM service_role`);
    const text = fs.readFileSync(path.join(ROOT, pin.filename), 'utf8');
    const wrap = (extra) => async () => {
      const client = await connect();
      const query = client.query.bind(client);
      client.query = (sql, params) => (String(sql) === text ? query(`${sql}\n${extra}`, params) : query(sql, params));
      return client;
    };
    const unrelated = await apply({}, { connect: wrap('ALTER TABLE public.check_cases DISABLE ROW LEVEL SECURITY;') });
    assert.equal(unrelated.code, CODES.UNRELATED_MUTATION, JSON.stringify(unrelated));
    assert.deepEqual(unrelated.details.unrelated_changed, ['relations', 'fine_relations_sha256']);
    const trigger = await apply({}, { connect: wrap('ALTER TABLE public.mortgage_releases DISABLE TRIGGER assign_case_on_mortgage_releases;') });
    assert.equal(trigger.code, CODES.UNRELATED_MUTATION);
    assert.ok(trigger.details.unrelated_changed.includes('fine_triggers_sha256'), JSON.stringify(trigger.details));
    assert.equal((await apply({ live_definition_sha256: 'f'.repeat(64) })).code, CODES.SQL_COLLISION);
    // Another caller (a view, and a function owned by another role) refuses before anything changes.
    await owner.query(`CREATE VIEW public.claim_case_view AS SELECT '${FN}'::regprocedure AS f`);
    await admin.query(`CREATE ROLE reporter NOLOGIN;
      CREATE FUNCTION public.claim_case_report() RETURNS text LANGUAGE sql AS $f$ SELECT 'tg_claim_id_assign_case'::text $f$;
      ALTER FUNCTION public.claim_case_report() OWNER TO reporter`);
    const callersInspect = await sql88.inspectSql88Production({ connect, pin, root: ROOT });
    assert.ok(callersInspect.details.precondition_failures.includes('other_callers_present'));
    assert.deepEqual(callersInspect.details.other_callers.views_or_rules, ['public.claim_case_view rule _RETURN']);
    assert.deepEqual(callersInspect.details.other_callers.functions, ['public.claim_case_report()']);
    const callers = await apply();
    assert.equal(callers.code, CODES.DEPLOYMENT_COLLISION);
    assert.ok(callers.details.failed.includes('other_callers_present'));
    await owner.query('DROP VIEW public.claim_case_view');
    await admin.query('DROP FUNCTION public.claim_case_report(); DROP ROLE reporter');
    // The SQL 87 helper with another owner refuses (the case objects stay one owner's).
    await admin.query(`CREATE ROLE migrator NOLOGIN; ALTER FUNCTION public.resolve_check_case(uuid, uuid, uuid, text, text, text, text) OWNER TO migrator`);
    const split = await apply();
    assert.equal(split.code, CODES.DEPLOYMENT_COLLISION);
    assert.ok(split.details.failed.includes('case_owner_safe'));
    await admin.query(`ALTER FUNCTION public.resolve_check_case(uuid, uuid, uuid, text, text, text, text) OWNER TO ${PROD_OWNER}; DROP ROLE migrator`);

    const consumed = consumedPath();
    const input = manifest(pin);
    const applied = await sql88.executeSql88ProductionApply(input, { root: ROOT, pin, connect, consumedPath: consumed });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.before_hash, d.live_definition_sha256);
    assert.equal(applied.details.receipt.after_hash, pin.intended_replacement_sha256);
    assert.equal(applied.details.receipt.object_owner, PROD_OWNER);
    assert.equal(applied.details.receipt.function_acl_after.tg_claim_id_assign_case, pin.intended_post_state.function_acl.tg_claim_id_assign_case);
    assertNoSeededPii(assert, applied, 'apply receipt');
    assert.doesNotMatch(JSON.stringify(applied), UUID_RE);
    const after = await sql88.inspectSql88Production({ connect, pin, root: ROOT });
    assertNoSeededPii(assert, after, 'post-apply inspect');
    assert.doesNotMatch(JSON.stringify(after), UUID_RE);
    assert.equal(after.details.live_definition_sha256, pin.intended_replacement_sha256);
    assert.equal(after.details.already_applied, true);
    assert.equal(after.details.functions.tg_claim_id_assign_case.matches_migration, true);
    assert.equal(after.details.functions.tg_claim_id_assign_case.body_matches_migration, true);
    // No data changed: the existing links are still there, still only counted.
    assert.deepEqual(after.details.cross_tenant_links.categories, SEEDED_CROSS_TENANT_COUNTS);
    assert.equal((await sql88.executeSql88ProductionApply(input, { root: ROOT, pin, connect, consumedPath: consumed })).code, CODES.RECEIPT_REUSED);
    const reapply = await apply();
    assert.equal(reapply.code, CODES.UNRELATED_MUTATION);
    assert.match(reapply.message, /already in place/);
    const privileges = (await admin.query(`SELECT r, has_function_privilege(r, $1, 'EXECUTE') AS can FROM unnest(ARRAY['authenticated', 'anon', 'service_role', 'checksops']) r`, [FN])).rows;
    assert.ok(privileges.every((row) => row.can === false), JSON.stringify(privileges));
    // The triggers still link same-tenant rows, as checksops with no auth.uid(), and not foreign ones.
    const api = await connectAs('checksops');
    await owner.query("DELETE FROM public.check_cases WHERE external_system = 'checksops'");
    const caseA = (await api.query('INSERT INTO public.check_intake_items (tenant_id, claim_id) VALUES ($1, $2) RETURNING case_id', [TENANT_A, CLAIM_A])).rows[0].case_id;
    const own = (await api.query('INSERT INTO public.homeowner_ledger_events (tenant_id, claim_id) VALUES ($1, $2) RETURNING case_id', [TENANT_A, CLAIM_A])).rows[0];
    const foreign = (await api.query('INSERT INTO public.homeowner_ledger_events (tenant_id, claim_id) VALUES ($1, $2) RETURNING case_id', [TENANT_A, CLAIM_B])).rows[0];
    const bRow = (await api.query('INSERT INTO public.signature_requests (claim_id) VALUES ($1) RETURNING case_id', [CLAIM_B])).rows[0];
    const bCase = (await owner.query('SELECT tenant_id FROM public.check_cases WHERE id = $1', [bRow.case_id])).rows[0];
    assert.match(String(caseA), UUID_RE);
    assert.equal(own.case_id, caseA);
    assert.equal(foreign.case_id, null);
    assert.equal(bCase.tenant_id, TENANT_B);
    await assert.rejects(api.query(`SELECT ${FN}`), (error) => error.code === '42501');
    await api.end();
    await owner.end();
  } finally {
    await admin.end();
    server.stop();
  }
});
