/**
 * Production apply path for SQL 84 (Mortgage Ops Return to Queue), SQL 85
 * (compensation Adjust) and SQL 86 (owner-only compensation helper), each its own
 * tool and pin.
 *
 * All three committed pins record the pre-state read by the production --inspect of
 * 2026-10-16 (expected_live_definition_sha256) but stay locked: authorization
 * "pending", execute false and no staging acceptance, so evaluate and apply refuse
 * with PRODUCTION_APPROVAL_REQUIRED. The no-pre-state refusals use an explicit copy
 * with the hash null (unrecorded()). The apply tests use an execute-authorized copy
 * with a placeholder staging acceptance and, against PostgreSQL, the pre-state the
 * fixture's inspect read. The
 * PostgreSQL fixture is production-like: SQL 47 and every table owned by the
 * non-superuser login checksops_admin, no Cursor SQL 48 / 49 and no per-check index.
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
import {
  AUTHORIZED_SQL84_MORTGAGE_RETURN_TO_QUEUE,
  AUTHORIZED_SQL85_MORTGAGE_COMPENSATION_ADJUST,
  AUTHORIZED_SQL86_MORTGAGE_COMPENSATION_OWNER_ONLY,
  MORTGAGE_DEFINITION_SHA256,
  MORTGAGE_KNOWN_DEFINITION_SHA256,
  MORTGAGE_MIGRATIONS,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { mortgageAclSetFunctions, mortgageIntendedFunctionAcl } from '../../scripts/deployment-guard/lib/mortgage-sql-production-apply.mjs';
import * as sql84 from '../../scripts/deployment-guard/lib/sql84-mortgage-return-to-queue-production-apply.mjs';
import * as sql85 from '../../scripts/deployment-guard/lib/sql85-mortgage-compensation-adjust-production-apply.mjs';
import * as sql86 from '../../scripts/deployment-guard/lib/sql86-mortgage-compensation-owner-only-production-apply.mjs';
import { ONE_SHOT_TOOLS } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { loadStagingSqlExecutor } from '../../scripts/deployment-guard/lib/staging-sql-executor-module.mjs';
import { main as cli84 } from '../../scripts/deployment-guard/sql84-mortgage-return-to-queue-production-apply.mjs';
import { main as cli85 } from '../../scripts/deployment-guard/sql85-mortgage-compensation-adjust-production-apply.mjs';
import { main as cli86 } from '../../scripts/deployment-guard/sql86-mortgage-compensation-owner-only-production-apply.mjs';
import { assertNoSeededPii, mortgageRolesSql, mortgageSchemaSql } from './helpers/mortgage-sql-pg.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const COMMIT = 'a'.repeat(40);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const FIXTURE_PRE = 'e'.repeat(64);
const executor = await loadStagingSqlExecutor(ROOT);
const SQL81_PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/sql81-checkalt-production-register-production-apply.json'), 'utf8'));

const M = {
  sql84: {
    lib: sql84,
    cli: cli84,
    script: 'scripts/deployment-guard/sql84-mortgage-return-to-queue-production-apply.mjs',
    staging: AUTHORIZED_SQL84_MORTGAGE_RETURN_TO_QUEUE,
    evaluate: sql84.evaluateSql84ProductionApply,
    execute: sql84.executeSql84ProductionApply,
    inspect: sql84.inspectSql84Production,
    readPinned: sql84.readPinnedSql84,
    pre: sql84.sql84ProductionPreconditionFailures,
    post: sql84.sql84ProductionPostconditionFailures,
    committed: sql84.loadSql84ProductionPin(ROOT),
    pinRel: 'ops/deployment-guard/sql84-mortgage-return-to-queue-production-apply.json',
    phrase: 'APPLY_MORTGAGE_RETURN_TO_QUEUE',
    allowed: 'sql84_production_apply_allowed',
  },
  sql85: {
    lib: sql85,
    cli: cli85,
    script: 'scripts/deployment-guard/sql85-mortgage-compensation-adjust-production-apply.mjs',
    staging: AUTHORIZED_SQL85_MORTGAGE_COMPENSATION_ADJUST,
    evaluate: sql85.evaluateSql85ProductionApply,
    execute: sql85.executeSql85ProductionApply,
    inspect: sql85.inspectSql85Production,
    readPinned: sql85.readPinnedSql85,
    pre: sql85.sql85ProductionPreconditionFailures,
    post: sql85.sql85ProductionPostconditionFailures,
    committed: sql85.loadSql85ProductionPin(ROOT),
    pinRel: 'ops/deployment-guard/sql85-mortgage-compensation-adjust-production-apply.json',
    phrase: 'APPLY_MORTGAGE_COMPENSATION_ADJUST',
    allowed: 'sql85_production_apply_allowed',
  },
  sql86: {
    lib: sql86,
    cli: cli86,
    script: 'scripts/deployment-guard/sql86-mortgage-compensation-owner-only-production-apply.mjs',
    staging: AUTHORIZED_SQL86_MORTGAGE_COMPENSATION_OWNER_ONLY,
    evaluate: sql86.evaluateSql86ProductionApply,
    execute: sql86.executeSql86ProductionApply,
    inspect: sql86.inspectSql86Production,
    readPinned: sql86.readPinnedSql86,
    pre: sql86.sql86ProductionPreconditionFailures,
    post: sql86.sql86ProductionPostconditionFailures,
    committed: sql86.loadSql86ProductionPin(ROOT),
    pinRel: 'ops/deployment-guard/sql86-mortgage-compensation-owner-only-production-apply.json',
    phrase: 'APPLY_MORTGAGE_COMPENSATION_OWNER_ONLY',
    allowed: 'sql86_production_apply_allowed',
  },
};
const KEYS = Object.keys(M);
const otherKey = (key) => KEYS[(KEYS.indexOf(key) + 1) % KEYS.length];
/** Execute-authorized copy with a placeholder staging acceptance and pre-state. */
const OWNER_APPROVED = 'owner-approved 2026-10-16 in session ("approve applying SQL 8x to production"): test fixture';
const authorized = (key, extra = {}) => Object.freeze({
  ...M[key].committed,
  authorization: OWNER_APPROVED,
  execute: true,
  expected_live_definition_sha256: FIXTURE_PRE,
  staging_acceptance: { ...M[key].committed.staging_acceptance, ok: true, reference: STAGING_REF, basis: 'test fixture' },
  ...extra,
});
/** The committed pin (or another) with no recorded pre-state, for the no-pre-state refusals. */
const unrecorded = (key, pin = M[key].committed) => Object.freeze({ ...pin, expected_live_definition_sha256: null });
// The production --inspect of 2026-10-16 (SSM command 0bd3e2c7-6b9d-4596-a36d-1ba516d73c9d,
// source 2e500dad1). Staging's read-live runs 58 to 60 recorded the same pre-states.
const PRODUCTION_INSPECT = {
  sql84: {
    live: '53a0fa9f2b9cb126b3852a8b0595504fb74947c46a5a8390d67b46d7d67ad496',
    function_states: { return_mortgage_handling_request_to_queue: 'cursor_original' },
  },
  sql85: {
    live: '7d5e766cf30a46e2925af225e9c2c19ee3cdb9a84ccf2685c23393f7cc06ee2d',
    function_states: { adjust_mortgage_agent_compensation: 'absent', adjust_mortgage_agent_compensation_five_arg: 'cursor_original' },
  },
  sql86: {
    live: 'c982ece2661a85293c2122c3aaf8226050d3c6670c436c94e34b870292289d0b',
    function_states: {
      aws_can_admin_mortgage_agent_compensation: 'ledger_original',
      mortgage_agent_compensation_reconciliation: 'ledger_original',
      earn_mortgage_agent_compensation: 'ledger_original',
      tg_earn_mortgage_agent_compensation: 'ledger_original',
    },
  },
};
const TEXT = Object.fromEntries(KEYS.map((key) => [key, fs.readFileSync(path.join(ROOT, M[key].committed.filename), 'utf8')]));
const REVIEWED = Object.fromEntries(KEYS.map((key) => [key, Object.fromEntries(Object.entries(executor.mortgageReviewedFunctiondefs(key, TEXT[key]))
  .map(([identity, def]) => [identity, sha(def)]))]));

function manifest(key, pin, overrides = {}) {
  const fingerprint = { sql: pin.expected_live_definition_sha256 };
  const workstream = `prod-${key}-mortgage-test`;
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
    one_use_id: `${key}-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-16T12:00:00.000Z',
    ...overrides,
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql8486-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
const neverConnect = async () => { throw new Error('should-not-connect'); };

async function runCli(key, argv, { env = { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, input, deps = {} } = {}) {
  let file = null;
  if (input) {
    file = path.join(os.tmpdir(), `sql8486-prod-input-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(input));
  }
  const writes = [];
  let spent = 0;
  const orig = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await M[key].cli(file ? [...argv, '--input', file] : argv, env, {
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

test('production pins: pending, execute false, the recorded production pre-state, the staging post-state, production RDS, one-shot registered', () => {
  for (const key of KEYS) {
    const { committed: pin, staging } = M[key];
    assert.equal(pin.migration, key);
    assert.equal(pin.authorization, 'pending');
    assert.equal(pin.execute, false);
    // The pre-state recorded from the read-only production inspect, not code-derived.
    const inspect = pin.production_inspect;
    assert.equal(pin.expected_live_definition_sha256, PRODUCTION_INSPECT[key].live, key);
    assert.equal(inspect.live_definition_sha256, pin.expected_live_definition_sha256, key);
    assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256, key);
    assert.equal(inspect.status, 'recorded');
    assert.equal(inspect.date, '2026-10-16');
    assert.equal(inspect.ssm_command_id, '0bd3e2c7-6b9d-4596-a36d-1ba516d73c9d');
    assert.equal(inspect.source_commit, '2e500dad1348448b2a225b972ea1e1eecad4381e');
    assert.equal(inspect.read_only, true);
    assert.equal(inspect.connected_as, 'checksops_admin');
    assert.deepEqual(inspect.function_states, PRODUCTION_INSPECT[key].function_states, key);
    assert.deepEqual(inspect.precondition_failures, []);
    assert.equal(inspect.apply_preconditions_met, false, 'the value at inspect time, before the pre-state was recorded');
    // No check ids in the pin.
    assert.doesNotMatch(JSON.stringify(pin), /check_ids/);
    // Staging and production pre-states are recorded separately; here they are the same.
    assert.equal(staging.expected_live_definition_sha256, pin.expected_live_definition_sha256, key);
    assert.match(pin.staging_acceptance.production_differs, /pre-states are the same/);
    assert.ok(pin.staging_acceptance.production_differs.includes(pin.expected_live_definition_sha256), key);
    assert.equal(pin.staging_acceptance.ok, false);
    assert.equal(pin.staging_acceptance.reference, null);
    assert.deepEqual(pin.predecessors, []);
    for (const field of ['filename', 'migration_id', 'source_sha256', 'intended_replacement_sha256']) assert.equal(pin[field], staging[field], `${key} ${field}`);
    assert.equal(pin.staging_pin_commit, staging.commit);
    assert.deepEqual(pin.function_identities, [...staging.function_identities]);
    assert.equal(sha(fs.readFileSync(path.join(ROOT, pin.filename))), pin.source_sha256);
    const targets = MORTGAGE_MIGRATIONS[key].functions.filter((fn) => fn.role === 'target');
    assert.deepEqual(Object.keys(pin.intended_post_state.function_definition_sha256), targets.map((fn) => fn.key));
    for (const fn of targets) {
      assert.equal(pin.intended_post_state.function_definition_sha256[fn.key], MORTGAGE_DEFINITION_SHA256[fn.identity], fn.key);
      assert.equal(REVIEWED[key][fn.identity], MORTGAGE_DEFINITION_SHA256[fn.identity], fn.key);
    }
    assert.equal(pin.intended_post_state.function_owner, 'checksops_admin');
    assert.deepEqual(Object.keys(pin.intended_post_state.function_acl), mortgageAclSetFunctions(key).map((fn) => fn.key));
    for (const fn of mortgageAclSetFunctions(key)) assert.equal(mortgageIntendedFunctionAcl(pin, fn), pin.intended_post_state.function_acl[fn.key]);
    for (const field of ['rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[field], SQL81_PIN[field], field);
    assert.equal(pin.authorization_phrase, M[key].phrase);
    assert.notEqual(pin.authorization_phrase, SQL81_PIN.authorization_phrase);
    assert.equal(M[key].lib[`SQL${key.slice(3)}_PRODUCTION_PIN_REL`], M[key].pinRel);
    assert.deepEqual(ONE_SHOT_TOOLS[key], { key, script: M[key].script, args: [], pin_rel: M[key].pinRel, allowed_key: M[key].allowed });
    // No password in any pin: only the secret ARN (the tool reads it from Secrets Manager).
    assert.doesNotMatch(JSON.stringify(pin), /password|postgres(ql)?:\/\//i);
  }
  assert.equal(new Set(KEYS.map((key) => M[key].phrase)).size, 3);
  assert.equal(M.sql84.committed.intended_post_state.function_acl.return_mortgage_handling_request_to_queue,
    '{checksops_admin=X/checksops_admin,checksops=X/checksops_admin,authenticated=X/checksops_admin}');
  assert.equal(M.sql86.committed.intended_post_state.function_acl.earn_mortgage_agent_compensation, '{checksops_admin=X/checksops_admin}');
  assert.match(M.sql84.committed.order_note, /before SQL 85 and SQL 86/);
  // The recorded Cursor / SQL 47 bodies are the labels the inspect recognises.
  const fns84 = M.sql84.committed.production_inspect.functions;
  assert.equal(fns84.return_mortgage_handling_request_to_queue.definition_sha256,
    MORTGAGE_KNOWN_DEFINITION_SHA256['public.return_mortgage_handling_request_to_queue(uuid, text)'].cursor_original);
  assert.equal(fns84.return_mortgage_handling_request_to_queue.owner, 'checksops_admin');
  assert.equal(fns84.return_mortgage_handling_request_to_queue.proacl,
    '{=X/checksops_admin,checksops_admin=X/checksops_admin,checksops=X/checksops_admin,authenticated=X/checksops_admin}');
  assert.equal(M.sql84.committed.production_inspect.per_check_unique_present, true);
  assert.equal(M.sql84.committed.production_inspect.fallback_index_name_taken, false);
  assert.deepEqual(M.sql84.committed.production_inspect.billing_duplicates, { groups: 0, extra_events: 0 });
  assert.equal(M.sql85.committed.production_inspect.functions.adjust_mortgage_agent_compensation_five_arg.definition_sha256,
    MORTGAGE_KNOWN_DEFINITION_SHA256['public.adjust_mortgage_agent_compensation(uuid, integer, text, uuid, text)'].cursor_original);
  assert.equal(M.sql85.committed.production_inspect.batch_actions_outside_check, 0);
  for (const [name, row] of Object.entries(M.sql86.committed.production_inspect.functions)) {
    const fn = MORTGAGE_MIGRATIONS.sql86.functions.find((f) => f.key === name);
    assert.ok(fn, name);
    assert.equal(row.definition_sha256, MORTGAGE_KNOWN_DEFINITION_SHA256[fn.identity].ledger_original, name);
  }
  assert.equal(M.sql86.committed.production_inspect.earn_owner.earn_owner_safe, true);
});

test('the committed production pins are still refused: execute false and authorization pending give PRODUCTION_APPROVAL_REQUIRED, before any connection', async () => {
  for (const key of KEYS) {
    const { committed } = M[key];
    assert.equal(committed.execute, false);
    assert.equal(committed.authorization, 'pending');
    // A manifest bound exactly to the committed pin (the recorded pre-state), even with a staging acceptance.
    const exact = manifest(key, committed, { staging_acceptance: authorized(key).staging_acceptance });
    const evaluation = await M[key].evaluate(exact, { root: ROOT });
    assert.equal(evaluation.code, CODES.PRODUCTION_APPROVAL_REQUIRED, key);
    assert.match(evaluation.message, /authorization is not an owner approval/);
    const execute = await M[key].execute(exact, { root: ROOT, connect: neverConnect, consumedPath: consumedPath() });
    assert.equal(execute.code, CODES.PRODUCTION_APPROVAL_REQUIRED, key);
    // An owner approval alone is not enough: execute false still refuses, and so does the missing staging acceptance.
    const approvedOnly = { ...committed, authorization: OWNER_APPROVED };
    assert.equal((await M[key].execute(exact, { root: ROOT, pin: { ...approvedOnly, staging_acceptance: authorized(key).staging_acceptance }, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.GUARD_APPLY_FORBIDDEN, key);
    assert.equal((await M[key].evaluate(manifest(key, committed), { root: ROOT, pin: approvedOnly })).code, CODES.PRODUCTION_APPROVAL_REQUIRED, key);
  }
});

test('the three tools are inventoried as GUARDED and their tests run in test:deployment-guard and the deployment-guard workflow', () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/bypass-inventory.json'), 'utf8'));
  const rows = JSON.stringify(inventory);
  for (const key of KEYS) {
    assert.ok(rows.includes(`"path":"${M[key].script}","classification":"GUARDED"`), M[key].script);
    assert.ok(fs.existsSync(path.join(ROOT, M[key].script)), M[key].script);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const file of ['aws/tests/sql84-sql86-mortgage-executor.test.mjs', 'aws/tests/sql84-sql86-mortgage-production-apply.test.mjs']) {
    assert.ok(pkg.scripts['test:deployment-guard'].includes(file), file);
    assert.ok(workflow.includes(file), file);
  }
});

// --- the production rules (synthetic states) ----------------------------------------

const OWNER_ACL = '{checksops_admin=X/checksops_admin,checksops=X/checksops_admin,authenticated=X/checksops_admin}';
const fnRow = (fn, overrides = {}) => ({
  identity: fn.identity,
  role: fn.role,
  exists: fn.role !== 'dropped',
  overload_count: fn.role === 'dropped' ? 0 : 1,
  arguments: fn.arguments,
  argument_names: [...fn.arg_names],
  result: fn.result,
  kind: 'f',
  returns_set: fn.retset,
  security_definer: true,
  config: [...fn.config],
  owner: 'checksops_admin',
  owner_is_executor: true,
  proacl: fn.role === 'acl_only' ? '{checksops_admin=X/checksops_admin}' : OWNER_ACL,
  acl_entries: fn.grantees ? fn.grantees.map((g) => `${g} EXECUTE`).sort() : ['PUBLIC EXECUTE', 'authenticated EXECUTE', 'checksops EXECUTE'],
  definition_sha256: MORTGAGE_DEFINITION_SHA256[fn.identity] || 'b'.repeat(64),
  matches_migration: fn.role === 'target',
  ...overrides,
});
const OBJECTS = {
  sql84: () => ({ audit_table: { present: false }, per_check_unique_present: true }),
  sql85: () => ({ columns: {}, indexes: {}, constraints: {} }),
  sql86: () => ({}),
};
const REPORT = {
  sql84: () => ({ fallback_index_name_taken: false, billing_duplicates: { readable: true, groups: 0, extra_events: 0 } }),
  sql85: () => ({ batch_actions_outside_check: { readable: true, count: 0 }, duplicate_adjust_idempotency_keys: { readable: true, count: 0 } }),
  sql86: () => ({ earn_owner: { earn_owner_safe: true } }),
};
const stateFor = (key, { fns = {}, ...overrides } = {}) => ({
  migration: key,
  current_user: 'checksops_admin',
  session_user: 'checksops_admin',
  required_roles_present: true,
  sql47_prerequisites_present: true,
  required_tables_present: true,
  required_columns_present: true,
  functions: Object.fromEntries(MORTGAGE_MIGRATIONS[key].functions.map((fn) => [fn.key, fnRow(fn, fns[fn.key])])),
  tables: Object.fromEntries(Object.keys(MORTGAGE_MIGRATIONS[key].columns).map((table) => [table, { present: true, owner: 'checksops_admin', owner_is_executor: true }])),
  objects: OBJECTS[key](),
  report: REPORT[key](),
  production: { owner_roles: ['checksops_admin'], authenticated_member_of_owner: false },
  live_definition_sha256: M[key].committed.intended_replacement_sha256,
  ...overrides,
});
const preState = (key, overrides = {}) => stateFor(key, {
  live_definition_sha256: FIXTURE_PRE,
  ...overrides,
  fns: Object.fromEntries(MORTGAGE_MIGRATIONS[key].functions.map((fn) => [fn.key, {
    matches_migration: false,
    definition_sha256: 'd'.repeat(64),
    ...(fn.role === 'target' || fn.role === 'acl_only' ? { acl_entries: ['PUBLIC EXECUTE', 'authenticated EXECUTE', 'checksops EXECUTE'] } : {}),
    ...(overrides.fns?.[fn.key] || {}),
  }])),
});

test('the production rules: safe to apply as the pinned owner before; exactly the reviewed functions, objects and aclitems after', () => {
  for (const key of KEYS) {
    const pin = authorized(key);
    const name = MORTGAGE_MIGRATIONS[key].functions[0].key;
    assert.deepEqual(M[key].pre(preState(key), pin, executor), [], key);
    for (const [overrides, failure] of [
      [{ current_user: 'checksops' }, 'login_is_pinned_owner'],
      [{ session_user: 'ubuntu' }, 'login_is_pinned_owner'],
      [{ fns: { [name]: { owner: 'checksops' } } }, 'objects_owned_by_pinned_owner'],
      [{ fns: { [name]: { owner_is_executor: false } } }, `owner_is_login:${name}`],
      [{ production: { owner_roles: ['checksops_admin'], authenticated_member_of_owner: true } }, 'authenticated_not_member_of_owner'],
      [{ production: undefined }, 'authenticated_not_member_of_owner'],
      [{ fns: { [name]: { overload_count: 2 } } }, `no_other_signature:${name}`],
      [{ fns: { [name]: { result: 'json' } } }, `result_matches:${name}`],
      [{ fns: { [name]: { argument_names: ['x'] } } }, `argument_names_match:${name}`],
      [{ fns: { [name]: { kind: 'p' } } }, `replaceable_kind:${name}`],
      [{ sql47_prerequisites_present: false }, 'sql47_prerequisites_present'],
      [{ required_columns_present: false }, 'required_columns_present'],
      [{ required_roles_present: false }, 'required_roles_present'],
    ]) {
      assert.ok(M[key].pre(preState(key, overrides), pin, executor).includes(failure), `${key} ${failure}: ${JSON.stringify(overrides)}`);
    }
    assert.ok(M[key].pre(preState(key), { ...pin, intended_post_state: undefined }, executor).includes('login_is_pinned_owner'));

    const before = preState(key);
    for (const fn of MORTGAGE_MIGRATIONS[key].functions) before.functions[fn.key].proacl = stateFor(key).functions[fn.key].proacl;
    for (const fn of MORTGAGE_MIGRATIONS[key].functions.filter((f) => f.role === 'acl_only')) {
      before.functions[fn.key].definition_sha256 = stateFor(key).functions[fn.key].definition_sha256;
    }
    assert.deepEqual(M[key].post(stateFor(key), pin, REVIEWED[key], executor, before), [], key);
    for (const [overrides, failure] of [
      [{ live_definition_sha256: 'f'.repeat(64) }, 'intended_state'],
      [{ fns: { [name]: { definition_sha256: 'f'.repeat(64) } } }, `definition_is_reviewed:${name}`],
      [{ fns: { [name]: { matches_migration: false } } }, `definition_is_reviewed:${name}`],
      [{ fns: { [name]: { overload_count: 2 } } }, `no_overloads:${name}`],
      [{ fns: { [name]: { security_definer: false } } }, `security_definer:${name}`],
      [{ fns: { [name]: { config: ['search_path=public'] } } }, `config_as_reviewed:${name}`],
      [{ fns: { [name]: { owner: 'other' } } }, 'objects_owned_by_pinned_owner'],
      [{ current_user: 'other' }, 'login_is_pinned_owner'],
    ]) {
      assert.ok(M[key].post(stateFor(key, overrides), pin, REVIEWED[key], executor, before).includes(failure), `${key} ${failure}`);
    }
    // The reviewed definitions are the ones reconstructed from the pinned file.
    const wrong = Object.fromEntries(Object.keys(REVIEWED[key]).map((identity) => [identity, 'e'.repeat(64)]));
    assert.ok(M[key].post(stateFor(key), pin, wrong, executor, before).includes(`definition_is_reviewed:${name}`));
  }
  // SQL 84 / 85: EXECUTE exactly owner, checksops and authenticated, as aclitems.
  for (const key of ['sql84', 'sql85']) {
    const name = MORTGAGE_MIGRATIONS[key].functions[0].key;
    const post = (fns) => M[key].post(stateFor(key, { fns }), authorized(key), REVIEWED[key], executor, preState(key));
    assert.deepEqual(post({ [name]: { proacl: '{checksops_admin=X/checksops_admin,authenticated=X/checksops_admin,checksops=X/checksops_admin}' } }).filter((f) => f.startsWith('function_acl')), [], 'order-insensitive');
    assert.ok(post({ [name]: { proacl: '{checksops_admin=X/checksops_admin,checksops=X/other,authenticated=X/checksops_admin}' } }).includes(`function_acl_as_intended:${name}`));
    assert.ok(post({ [name]: { acl_entries: ['PUBLIC EXECUTE', 'authenticated EXECUTE', 'checksops EXECUTE'] } }).includes(`public_execute_revoked:${name}`));
    assert.ok(post({ [name]: { acl_entries: ['checksops EXECUTE'] } }).includes(`execute_as_reviewed:${name}`));
  }
  // SQL 84: an existing audit table must be the file's; without a GATE 0 index the fallback must be creatable.
  const pin84 = authorized('sql84');
  const audit = (table) => preState('sql84', { objects: { audit_table: { present: true, owner: 'checksops_admin', owner_is_executor: true, rls_forced: false, acl: [], policies: [], indexes: [], columns: [], ...table }, per_check_unique_present: true } });
  assert.ok(M.sql84.pre(audit({}), pin84, executor).includes('audit_table_columns_match'));
  assert.ok(M.sql84.pre(audit({ owner: 'other', owner_is_executor: false }), pin84, executor).includes('objects_owned_by_pinned_owner'));
  assert.ok(M.sql84.pre(audit({ acl: [{ grantee: 'authenticated', privilege_type: 'INSERT', is_grantable: false }] }), pin84, executor).includes('audit_table_acl_replaceable'));
  assert.ok(M.sql84.pre(audit({ policies: [{ name: 'open' }] }), pin84, executor).includes('audit_table_no_other_policies'));
  const noGate = (report, tables) => preState('sql84', { objects: { audit_table: { present: false }, per_check_unique_present: false }, report: { ...REPORT.sql84(), ...report }, ...(tables ? { tables } : {}) });
  assert.deepEqual(M.sql84.pre(noGate({}), pin84, executor), []);
  assert.ok(M.sql84.pre(noGate({ billing_duplicates: { readable: true, groups: 1, extra_events: 1 } }), pin84, executor).includes('no_duplicate_mortgage_ops_billing_events'));
  assert.ok(M.sql84.pre(noGate({ billing_duplicates: { readable: false, reason: 'row_security_would_filter' } }), pin84, executor).includes('billing_duplicates_readable'));
  assert.ok(M.sql84.pre(noGate({ fallback_index_name_taken: true }), pin84, executor).includes('fallback_index_name_free'));
  const otherBillingOwner = { ...stateFor('sql84').tables, check_billing_events: { present: true, owner: 'other', owner_is_executor: false } };
  assert.ok(M.sql84.pre(noGate({}, otherBillingOwner), pin84, executor).includes('billing_table_owner_is_login'));
  assert.ok(M.sql84.pre(noGate({}, otherBillingOwner), pin84, executor).includes('objects_owned_by_pinned_owner'));
  assert.ok(M.sql84.post(stateFor('sql84', { objects: { per_check_unique_present: false } }), pin84, REVIEWED.sql84, executor, preState('sql84')).includes('per_check_unique_present'));
  // SQL 85: the five-argument body is dropped; batch actions fit the new CHECK.
  const pin85 = authorized('sql85');
  assert.ok(M.sql85.post(stateFor('sql85', { fns: { adjust_mortgage_agent_compensation_five_arg: { exists: true } } }), pin85, REVIEWED.sql85, executor, preState('sql85'))
    .includes('dropped:adjust_mortgage_agent_compensation_five_arg'));
  assert.ok(M.sql85.pre(preState('sql85', { report: { ...REPORT.sql85(), batch_actions_outside_check: { readable: true, count: 2 } } }), pin85, executor).includes('batch_actions_within_new_check'));
  assert.ok(M.sql85.pre(preState('sql85', { objects: { columns: { 'public.mortgage_agent_compensation_batches.idempotency_key': 'character varying(64)' }, indexes: {}, constraints: {} } }), pin85, executor)
    .includes('column_type_matches:idempotency_key'));
  // SQL 86: the earn owner guard, earn left owner-only, the replaced functions' ACLs untouched.
  const pin86 = authorized('sql86');
  assert.ok(M.sql86.pre(preState('sql86', { report: { earn_owner: { earn_owner_safe: false } } }), pin86, executor).includes('earn_owner_safe'));
  assert.ok(M.sql86.pre(preState('sql86', { fns: { earn_mortgage_agent_compensation: { acl_entries: ['anon EXECUTE'] } } }), pin86, executor).includes('acl_replaceable:earn_mortgage_agent_compensation'));
  const before86 = preState('sql86');
  for (const fn of MORTGAGE_MIGRATIONS.sql86.functions) before86.functions[fn.key].proacl = stateFor('sql86').functions[fn.key].proacl;
  before86.functions.earn_mortgage_agent_compensation.definition_sha256 = stateFor('sql86').functions.earn_mortgage_agent_compensation.definition_sha256;
  const post86 = (fns) => M.sql86.post(stateFor('sql86', { fns }), pin86, REVIEWED.sql86, executor, before86);
  assert.ok(post86({ earn_mortgage_agent_compensation: { acl_entries: ['checksops EXECUTE'] } }).includes('owner_only_execute:earn_mortgage_agent_compensation'));
  assert.ok(post86({ earn_mortgage_agent_compensation: { proacl: OWNER_ACL } }).includes('function_acl_as_intended:earn_mortgage_agent_compensation'));
  assert.ok(post86({ earn_mortgage_agent_compensation: { definition_sha256: 'f'.repeat(64) } }).includes('definition_unchanged:earn_mortgage_agent_compensation'));
  assert.ok(post86({ aws_can_admin_mortgage_agent_compensation: { proacl: '{checksops_admin=X/checksops_admin}' } }).includes('acl_unchanged:aws_can_admin_mortgage_agent_compensation'));
});

test('the pinned files are exactly the reviewed statements; a tampered pin or file is refused', async () => {
  for (const key of KEYS) {
    const pin = M[key].committed;
    const sql = await M[key].readPinned(ROOT, pin);
    assert.equal(sql.ok, true, JSON.stringify(sql));
    assert.deepEqual(sql.details.reviewed_definition_sha256, REVIEWED[key]);
    for (const field of ['migration', 'filename', 'migration_id', 'source_sha256', 'staging_pin_commit', 'intended_replacement_sha256', 'target_environment', 'target_component', 'deployment_type']) {
      assert.equal((await M[key].readPinned(ROOT, { ...pin, [field]: 'other' })).code, CODES.SQL_COLLISION, `${key} ${field}`);
    }
    assert.equal((await M[key].readPinned(ROOT, { ...pin, function_identities: [] })).code, CODES.SQL_COLLISION);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql8486-prod-tamper-'));
    try {
      const file = path.join(dir, pin.filename);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${TEXT[key]}GRANT EXECUTE ON FUNCTION ${pin.function_identities[0]} TO PUBLIC;\n`);
      assert.equal((await M[key].readPinned(dir, pin)).code, CODES.SOURCE_RECONCILIATION_REQUIRED, key);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('evaluation needs a recorded pre-state, the exact pin, a recorded staging acceptance and the production gate', async () => {
  for (const key of KEYS) {
    const { committed } = M[key];
    const evaluate = (input, pin) => M[key].evaluate(input, { root: ROOT, pin });
    // No pre-state recorded (null), whatever the manifest says.
    const pending = await evaluate(manifest(key, authorized(key)), unrecorded(key, authorized(key)));
    assert.equal(pending.code, CODES.SQL_COLLISION, key);
    assert.match(pending.message, /no recorded pre-apply live definition hash/);
    const nullManifest = await evaluate(manifest(key, unrecorded(key)), unrecorded(key, { ...committed, staging_acceptance: authorized(key).staging_acceptance }));
    assert.equal(nullManifest.code, CODES.SQL_COLLISION, 'null == null is never a match');
    // The committed pin (pre-state recorded, authorization pending): refused for approval.
    const committedPin = await M[key].evaluate(manifest(key, authorized(key)), { root: ROOT });
    assert.equal(committedPin.code, CODES.PRODUCTION_APPROVAL_REQUIRED, key);
    const noAcceptance = await evaluate(manifest(key, authorized(key)), { ...authorized(key), staging_acceptance: committed.staging_acceptance });
    assert.equal(noAcceptance.code, CODES.PRODUCTION_APPROVAL_REQUIRED, key);
    const allowed = await evaluate(manifest(key, authorized(key)), authorized(key));
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
    assert.equal(allowed.details[M[key].allowed], true);
    assert.equal(allowed.details.migration, key);
    for (const field of ['filename', 'migration_id', 'source_sha256', 'expected_live_definition_sha256', 'intended_replacement_sha256', 'live_definition_sha256']) {
      assert.equal((await evaluate(manifest(key, authorized(key), { [field]: 'f'.repeat(64) }), authorized(key))).code, CODES.SQL_COLLISION, field);
    }
    const otherRef = await evaluate(manifest(key, authorized(key), { staging_acceptance: { ok: true, reference: `${STAGING_REF}0` } }), authorized(key));
    assert.equal(otherRef.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    const otherApproval = await evaluate(manifest(key, authorized(key), { approval: { approved: true, workstream_id: 'another' } }), authorized(key));
    assert.equal(otherApproval.ok, false);
    // One migration's manifest never evaluates under another's pin.
    assert.equal((await evaluate(manifest(otherKey(key), authorized(otherKey(key))), authorized(key))).code, CODES.SQL_COLLISION);
  }
});

test('CLI with the committed (pending) pin refuses before the guard; without a receipt the guard refuses; neither connects', async () => {
  for (const key of KEYS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql8486-prod-noreceipt-'));
    try {
      const input = path.join(dir, `${key}.json`);
      fs.writeFileSync(input, JSON.stringify(manifest(key, authorized(key))));
      for (const extra of [{ CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, {}]) {
        const result = spawnSync(process.execPath, [path.join(ROOT, M[key].script), '--apply', '--input', input], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH, HOME: dir, ...extra },
        });
        const out = `${result.stdout}${result.stderr}`;
        assert.notEqual(result.status, 0, out);
        // The committed pin has its pre-state recorded but authorization "pending".
        assert.match(out, /PRODUCTION_APPROVAL_REQUIRED/);
        assert.match(out, /authorization is not an owner approval/);
        assert.doesNotMatch(out, /secretsmanager|ECONNREFUSED|rolled back/i);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sql8486-prod-noreceipt-root-'));
    try {
      const noReceipt = await runCli(key, ['--apply'], {
        input: manifest(key, authorized(key)),
        deps: { pin: authorized(key), enforceScriptGuard: (spec) => refuseUnguardedDeploy(spec, { root: empty, env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' } }) },
      });
      assert.equal(noReceipt.spent, 0);
      assert.match(noReceipt.out, /DEPLOYMENT_GUARD_REQUIRED/);
      assert.doesNotMatch(noReceipt.out, /should-not-connect/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  }
});

test('--inspect reads the secret from the pinned ARN only, never a flag, and never connects when the secret is refused', async () => {
  for (const key of KEYS) {
    const asked = [];
    const refused = await runCli(key, ['--inspect', '--password', 'hunter2'], {
      deps: { connect: undefined, getSecretValue: async (id) => { asked.push(id); return 'not json'; } },
    });
    assert.deepEqual(asked, [M[key].committed.admin_secret_arn], key);
    assert.match(refused.out, /could not read the production admin secret/);
    assert.doesNotMatch(refused.out, /hunter2|should-not-connect/);
    const otherSecret = await runCli(key, ['--inspect'], {
      deps: { connect: undefined, pin: { ...M[key].committed, admin_secret_arn: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:other' }, getSecretValue: async () => { throw new Error('must not be asked'); } },
    });
    assert.match(otherSecret.out, /not the existing production checksops_admin secret/);
  }
});

test('CLI does not spend the receipt on a wrong phrase, execute false, a wrong owner, a reused id, a missing guard flag or arbitrary SQL', async () => {
  for (const key of KEYS) {
    const pin = authorized(key);
    const owned = (filename = pin.filename) => ({ ok: true, details: { receipt: { owned_components: [filename] } } });
    const argv = ['--apply'];
    const phrase = await runCli(key, argv, { input: manifest(key, pin, { authorization_phrase: 'yes' }), deps: { pin, enforceScriptGuard: () => owned() } });
    assert.equal(phrase.spent, 0);
    assert.match(phrase.out, /PRODUCTION_APPROVAL_REQUIRED/);
    const notExecutable = await runCli(key, argv, { input: manifest(key, pin), deps: { pin: { ...pin, execute: false }, enforceScriptGuard: () => owned() } });
    assert.equal(notExecutable.spent, 0);
    assert.match(notExecutable.out, /execute is not authorized/);
    const committed = await runCli(key, argv, { input: manifest(key, pin), deps: { pin: M[key].committed, enforceScriptGuard: () => { throw new Error('guard-called'); } } });
    assert.equal(committed.spent, 0);
    assert.match(committed.out, /PRODUCTION_APPROVAL_REQUIRED/);
    assert.doesNotMatch(committed.out, /guard-called/);
    const noPreState = await runCli(key, argv, { input: manifest(key, pin), deps: { pin: unrecorded(key, pin), enforceScriptGuard: () => { throw new Error('guard-called'); } } });
    assert.equal(noPreState.spent, 0);
    assert.match(noPreState.out, /SQL_COLLISION/);
    assert.doesNotMatch(noPreState.out, /guard-called/);
    const wrongOwner = await runCli(key, argv, { input: manifest(key, pin), deps: { pin, enforceScriptGuard: () => owned('aws/workflows/sql/83_homeowner_signing_capabilities.sql') } });
    assert.equal(wrongOwner.spent, 0);
    assert.match(wrongOwner.out, /RECEIPT_MISMATCH/);
    const reusedFile = consumedPath();
    fs.writeFileSync(reusedFile, JSON.stringify({ consumed: [`${key}-prod-reused-id`] }));
    const reused = await runCli(key, argv, { input: manifest(key, pin, { one_use_id: `${key}-prod-reused-id` }), deps: { pin, enforceScriptGuard: () => owned(), consumedPath: reusedFile } });
    assert.equal(reused.spent, 0);
    assert.match(reused.out, /RECEIPT_REUSED/);
    const noFlag = await runCli(key, argv, { env: {}, input: manifest(key, pin), deps: { pin, enforceScriptGuard: () => owned() } });
    assert.equal(noFlag.spent, 0);
    assert.match(noFlag.out, /blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1/);
    const arbitrary = await runCli(key, argv, { input: { ...manifest(key, pin), sql_text: 'GRANT UPDATE ON TABLE public.mortgage_handling_requests TO authenticated' }, deps: { pin, enforceScriptGuard: () => owned() } });
    assert.equal(arbitrary.spent, 0);
    assert.match(arbitrary.out, /arbitrary SQL text is forbidden/);
    for (const r of [phrase, notExecutable, committed, noPreState, wrongOwner, reused, noFlag, arbitrary]) assert.doesNotMatch(r.out, /should-not-connect/);
  }
});

test('the real guard: a staging receipt cannot authorize production; a production receipt is spent once and a refusing DB rolls back', async () => {
  const NOW = Date.parse('2026-10-16T12:00:00.000Z');
  for (const key of KEYS) {
    const pin = authorized(key);
    const issue = (root, overrides) => {
      const input = manifest(key, pin);
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
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql8486-prod-staging-receipt-'));
    const prodRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql8486-prod-receipt-'));
    try {
      const staging = issue(stagingRoot, { target_environment: 'staging', target_component: 'staging-sql' });
      const refused = await runCli(key, ['--apply'], { input: staging.input, deps: { pin, enforceScriptGuard: guardWith(stagingRoot, staging.receipt) } });
      assert.equal(refused.spent, 0);
      assert.match(refused.out, /RECEIPT_MISMATCH/);
      const prod = issue(prodRoot, {});
      const refusingDb = async () => ({ query: async () => { throw new Error('db-unavailable'); }, end: async () => {} });
      const valid = await runCli(key, ['--apply'], { input: prod.input, deps: { pin, enforceScriptGuard: guardWith(prodRoot, prod.receipt), connect: refusingDb } });
      assert.equal(valid.spent, 1);
      assert.match(valid.out, /rolled back/);
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      fs.rmSync(prodRoot, { recursive: true, force: true });
    }
  }
});

test('apply refuses before connecting: the committed pin, no pre-state, no phrase, no single-use id, execute false, no staging acceptance, no owner approval', async () => {
  for (const key of KEYS) {
    const run = (overrides, pin = authorized(key)) => M[key].execute(manifest(key, authorized(key), overrides), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() });
    assert.equal((await M[key].execute(manifest(key, authorized(key)), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    assert.equal((await run({}, unrecorded(key, authorized(key)))).code, CODES.SQL_COLLISION);
    assert.equal((await run({}, { ...authorized(key), staging_acceptance: M[key].committed.staging_acceptance })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    assert.equal((await run({}, { ...authorized(key), execute: false })).code, CODES.GUARD_APPLY_FORBIDDEN);
    assert.equal((await run({ authorization_phrase: 'yes' })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    assert.equal((await run({ authorization_phrase: M[otherKey(key)].phrase })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    assert.equal((await run({ one_use_id: 'x' })).code, CODES.INVALID_MANIFEST);
    assert.equal((await run({}, { ...authorized(key), authorization_phrase: '' })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    for (const authorization of ['pending', '', undefined, 'approved', 'not owner-approved']) {
      assert.equal((await run({}, authorized(key, { authorization }))).code, CODES.PRODUCTION_APPROVAL_REQUIRED, JSON.stringify(authorization));
    }
    const passes = await run({}).catch((error) => error);
    assert.match(String(passes?.message || ''), /should-not-connect/);
  }
});

// --- PostgreSQL 16 ---------------------------------------------------------------

const PROD_OWNER = 'checksops_admin';
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK TO)\b/i;

async function productionFixture(pg, prefix, port) {
  const server = startPg(prefix, port);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  const connectAs = async (user) => {
    const client = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await client.connect();
    return client;
  };
  try {
    await admin.query(mortgageRolesSql(PROD_OWNER));
    const owner = await connectAs(PROD_OWNER);
    try {
      await owner.query(mortgageSchemaSql());
    } finally {
      await owner.end();
    }
  } catch (error) {
    await admin.end().catch(() => {});
    server.stop();
    throw error;
  }
  return { server, admin, connectAs };
}

test('PostgreSQL 16: production inspect is read-only and reports the state; SQL 84, 85 and 86 apply exactly once; drift, a wrong login and collateral changes are refused', { timeout: 300000 }, async (t) => {
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
  const { server, admin, connectAs } = await productionFixture(pg, 'pg-sql8486-prod-', 57700);
  try {
    const seen = [];
    const connectWith = (user) => async () => {
      const client = await connectAs(user);
      const query = client.query.bind(client);
      client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
      return client;
    };
    const connect = connectWith(PROD_OWNER);
    for (const key of KEYS) {
      const spec = MORTGAGE_MIGRATIONS[key];
      seen.length = 0;
      // A pin with no recorded pre-state (as before the production inspect was recorded).
      const first = await M[key].inspect({ connect, pin: unrecorded(key), root: ROOT });
      assert.equal(first.ok, true, JSON.stringify(first));
      const d = first.details;
      assert.equal(seen[0], 'BEGIN READ ONLY');
      assert.equal(seen.at(-1), 'ROLLBACK');
      assert.ok(seen.slice(1, -1).every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
      assert.equal(d.read_only, true);
      assert.equal(d.source_ok, true);
      assert.equal(d.pin_execute, false);
      assert.equal(d.pre_state_recorded, false);
      assert.equal(d.expected_live_definition_sha256, null);
      assert.equal(d.live_matches_expected, false);
      assert.equal(d.apply_preconditions_met, false, 'nothing recorded yet');
      assert.deepEqual(d.precondition_failures, [], JSON.stringify(d.precondition_failures));
      assert.equal(d.current_user, PROD_OWNER);
      assert.equal(d.login_rolsuper, false);
      assert.deepEqual(d.owner_roles, [PROD_OWNER]);
      assert.equal(d.authenticated_member_of_owner, false);
      assert.equal(d.sql47_prerequisites_present, true);
      assert.deepEqual(d.missing_prerequisites, []);
      assertNoSeededPii(assert, first, `${key} production inspect`);
      if (key === 'sql86') {
        // SQL 47 as is: the same fingerprint as production's recorded inspect.
        assert.equal(d.live_definition_sha256, M.sql86.committed.expected_live_definition_sha256);
      } else {
        // No Cursor SQL 48 / 49 and no per-check index here, unlike production's recorded
        // inspect: the committed pin would refuse this state.
        assert.notEqual(d.live_definition_sha256, M[key].committed.expected_live_definition_sha256, key);
      }
      if (key === 'sql84') {
        assert.equal(d.functions.return_mortgage_handling_request_to_queue.exists, false);
        assert.equal(d.audit_table.present, false);
        assert.equal(d.per_check_unique_present, false);
        assert.deepEqual(d.billing_per_check_indexes, []);
        assert.deepEqual(d.billing_duplicates, { readable: true, groups: 0, extra_events: 0, check_ids: [] });
        assert.equal(d.tables.check_billing_events.owner, PROD_OWNER);
      }
      if (key === 'sql85') {
        assert.equal(d.functions.adjust_mortgage_agent_compensation.exists, false);
        assert.equal(d.functions.adjust_mortgage_agent_compensation_five_arg.exists, false);
        assert.deepEqual(d.added_columns, { 'public.mortgage_agent_compensation_entries.adjustment_reason': null, 'public.mortgage_agent_compensation_batches.idempotency_key': null });
        assert.match(d.constraints['public.mortgage_agent_compensation_batches.mortgage_agent_compensation_batches_action_check'], /'pay'::text\]/);
      }
      if (key === 'sql86') {
        assert.equal(d.functions.aws_can_admin_mortgage_agent_compensation.state, 'ledger_original');
        assert.match(d.functions.aws_can_admin_mortgage_agent_compensation.definition, /has_role\(auth\.uid\(\), 'admin'/);
        assert.match(d.functions.mortgage_agent_compensation_reconciliation.definition, /^CREATE OR REPLACE FUNCTION public\.mortgage_agent_compensation_reconciliation/);
        assert.equal(d.functions.earn_mortgage_agent_compensation.definition, undefined);
        assert.deepEqual(d.earn_owners.earn_mortgage_agent_compensation, {
          exists: true, rolname: PROD_OWNER, rolsuper: false, member_of_checksops: false, member_of_authenticated: false,
          proacl: `{=X/${PROD_OWNER},${PROD_OWNER}=X/${PROD_OWNER},checksops=X/${PROD_OWNER},authenticated=X/${PROD_OWNER}}`,
        });
        assert.equal(d.earn_owners.tg_earn_mortgage_agent_compensation.rolname, PROD_OWNER);
        assert.equal(d.earn_owner.earn_owner_safe, true);
        assert.deepEqual(d.functions.earn_mortgage_agent_compensation.acl_entries_with_grantor,
          [`PUBLIC EXECUTE granted by ${PROD_OWNER}`, `authenticated EXECUTE granted by ${PROD_OWNER}`, `checksops EXECUTE granted by ${PROD_OWNER}`]);
      }

      // The pin change records the inspected pre-state (and the staging run).
      const pin = authorized(key, { expected_live_definition_sha256: d.live_definition_sha256 });
      const ready = await M[key].inspect({ connect, pin, root: ROOT });
      assert.equal(ready.details.apply_preconditions_met, true, JSON.stringify(ready.details.precondition_failures));
      assert.equal(ready.details.live_matches_expected, true);

      // Another login (the superuser) is refused.
      const asSuperuser = await M[key].inspect({ connect: connectWith('ubuntu'), pin, root: ROOT });
      assert.ok(asSuperuser.details.precondition_failures.includes('login_is_pinned_owner'), JSON.stringify(asSuperuser.details.precondition_failures));
      const superApply = await M[key].execute(manifest(key, pin), { root: ROOT, pin, connect: connectWith('ubuntu'), consumedPath: consumedPath() });
      assert.equal(superApply.code, CODES.DEPLOYMENT_COLLISION);
      assert.ok(superApply.details.failed.includes('login_is_pinned_owner'));

      const apply = (overrides = {}, ctx = {}) => M[key].execute(manifest(key, pin, overrides), { root: ROOT, pin, connect, consumedPath: consumedPath(), ...ctx });
      const catalog = async () => (await admin.query(`SELECT p.oid::regprocedure::text AS sig, encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex') AS def,
        p.proacl::text AS acl, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.proname = ANY($1::text[]) ORDER BY 1`, [[...new Set(spec.functions.map((fn) => fn.name))]])).rows;
      const start = await catalog();

      // authenticated in the owner role (INHERIT FALSE): refused at the precondition.
      await admin.query(`GRANT ${PROD_OWNER} TO authenticated WITH INHERIT FALSE`);
      const member = await apply();
      assert.equal(member.code, CODES.DEPLOYMENT_COLLISION);
      assert.ok(member.details.failed.includes('authenticated_not_member_of_owner'));
      await admin.query(`REVOKE ${PROD_OWNER} FROM authenticated`);

      // Collision: the live state moved after the recorded inspect.
      const owner = await connectAs(PROD_OWNER);
      await owner.query(`CREATE FUNCTION public.${spec.functions[0].name}(p_other bigint) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$`);
      const drift = await apply();
      assert.equal(drift.code, CODES.DEPLOYMENT_COLLISION, JSON.stringify(drift));
      await owner.query(`DROP FUNCTION public.${spec.functions[0].name}(bigint)`);
      await owner.end();
      assert.deepEqual(await catalog(), start);

      // A file that would also touch something unrelated rolls back.
      const wrap = (extra) => async () => {
        const client = await connect();
        const query = client.query.bind(client);
        client.query = (sql, params) => (String(sql) === TEXT[key] ? query(`${sql}\n${extra}`, params) : query(sql, params));
        return client;
      };
      const unrelated = await apply({}, { connect: wrap('ALTER TABLE public.check_billing_events DISABLE ROW LEVEL SECURITY;') });
      assert.equal(unrelated.code, CODES.UNRELATED_MUTATION, JSON.stringify(unrelated));
      assert.deepEqual(unrelated.details.unrelated_changed, ['relations', 'fine_relations_sha256']);
      const otherFunction = await apply({}, { connect: wrap('CREATE FUNCTION public.sql8486_extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;') });
      assert.equal(otherFunction.code, CODES.UNRELATED_MUTATION);
      assert.deepEqual(otherFunction.details.unrelated_changed, ['functions', 'fine_functions_sha256']);
      if (key === 'sql85') {
        // A column added to an altered table outside the reviewed one is caught by the finer snapshot.
        const extraColumn = await apply({}, { connect: wrap('ALTER TABLE public.mortgage_agent_compensation_batches ADD COLUMN note2 text;') });
        assert.equal(extraColumn.code, CODES.UNRELATED_MUTATION);
        assert.deepEqual(extraColumn.details.unrelated_changed, ['fine_columns_sha256']);
      }
      if (key === 'sql86') {
        const helperAcl = await apply({}, { connect: wrap('REVOKE ALL ON FUNCTION public.aws_can_admin_mortgage_agent_compensation() FROM PUBLIC;') });
        assert.equal(helperAcl.code, CODES.UNRELATED_MUTATION);
        assert.ok(helperAcl.details.failed.includes('acl_unchanged:aws_can_admin_mortgage_agent_compensation'));
      }
      assert.deepEqual(await catalog(), start);
      assert.equal((await apply({ live_definition_sha256: 'f'.repeat(64) })).code, CODES.SQL_COLLISION);

      const consumed = consumedPath();
      const input = manifest(key, pin);
      const applied = await M[key].execute(input, { root: ROOT, pin, connect, consumedPath: consumed });
      assert.equal(applied.ok, true, JSON.stringify(applied));
      assert.equal(applied.details.receipt.before_hash, d.live_definition_sha256);
      assert.equal(applied.details.receipt.after_hash, pin.intended_replacement_sha256);
      assert.equal(applied.details.receipt.object_owner, PROD_OWNER);
      for (const fn of mortgageAclSetFunctions(key)) {
        const items = (text) => text.slice(1, -1).split(',').sort();
        assert.deepEqual(items(applied.details.receipt.function_acl_after[fn.key]), items(pin.intended_post_state.function_acl[fn.key]), fn.key);
      }
      const after = await M[key].inspect({ connect, pin, root: ROOT });
      assertNoSeededPii(assert, after, `${key} post-apply inspect`);
      assertNoSeededPii(assert, applied, `${key} apply receipt`);
      assert.equal(after.details.live_definition_sha256, pin.intended_replacement_sha256);
      assert.equal(after.details.already_applied, true);
      assert.equal(after.details.apply_preconditions_met, false);
      for (const fn of spec.functions.filter((f) => f.role === 'target')) {
        assert.equal(after.details.functions[fn.key].matches_migration, true);
        assert.equal(after.details.functions[fn.key].body_matches_migration, true);
      }
      assert.equal((await M[key].execute(input, { root: ROOT, pin, connect, consumedPath: consumed })).code, CODES.RECEIPT_REUSED);
      const reapply = await apply();
      assert.equal(reapply.code, CODES.UNRELATED_MUTATION);
      assert.match(reapply.message, /already in place/);
    }
    const privileges = (await admin.query(`SELECT
      has_function_privilege('authenticated', 'public.return_mortgage_handling_request_to_queue(uuid, text)', 'EXECUTE') AS return_authenticated,
      has_function_privilege('authenticated', 'public.adjust_mortgage_agent_compensation(uuid, integer, text, uuid, text, text)', 'EXECUTE') AS adjust_authenticated,
      has_function_privilege('authenticated', 'public.earn_mortgage_agent_compensation(uuid)', 'EXECUTE') AS earn_authenticated,
      has_function_privilege('checksops', 'public.earn_mortgage_agent_compensation(uuid)', 'EXECUTE') AS earn_checksops,
      to_regclass('public.check_billing_events_one_mortgage_ops_per_check') IS NOT NULL AS fallback_index`)).rows[0];
    assert.deepEqual(privileges, { return_authenticated: true, adjust_authenticated: true, earn_authenticated: false, earn_checksops: false, fallback_index: true });
  } finally {
    await admin.end();
    server.stop();
  }
});
