/**
 * Production apply path for SQL 71 (GRANT UPDATE (amount) ON TABLE
 * public.check_intake_items TO checksops).
 *
 * The committed pin is pending (authorization "pending", execute false, no
 * recorded pre-state, no staging acceptance) and is checked to refuse. The apply
 * tests use an execute-authorized copy with a placeholder staging acceptance and
 * a recorded production_inspect. The PostgreSQL 16 test builds the table owned
 * by a non-superuser checksops_admin with the real SQL 52 grant, re-derives both
 * pinned fingerprints from the real catalog, and runs the real production
 * inspect and apply as checksops_admin with drift, login, prerequisite and
 * rollback refusals.
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
import { AMOUNT_GRANT_STATE_TEXT, AUTHORIZED_SQL71_AMOUNT_GRANT as STAGING_PIN } from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  SQL71_PRODUCTION_PIN_REL,
  SQL71_SINGLE_STATEMENT_RE,
  evaluateSql71ProductionApply,
  executeSql71ProductionApply,
  inspectSql71Production,
  loadSql71ProductionPin,
  readPinnedSql71,
  sql71AdminLogin,
  sql71ProductionPostconditionFailures,
  sql71ProductionPreconditionFailures,
} from '../../scripts/deployment-guard/lib/sql71-review-amount-production-apply.mjs';
import { ONE_SHOT_TOOLS } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { main as cliMain } from '../../scripts/deployment-guard/sql71-review-amount-production-apply.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/deployment-guard/sql71-review-amount-production-apply.mjs');
const COMMITTED = loadSql71ProductionPin(ROOT);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const SQL71_TEXT = fs.readFileSync(path.join(ROOT, COMMITTED.filename), 'utf8');
const SQL52_TEXT = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/52_verified_ocr_micr_column_grant.sql'), 'utf8');
const SQL72_PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/sql72-production-apply.json'), 'utf8'));
const ABSENT = sha(AMOUNT_GRANT_STATE_TEXT.absent);
const GRANTED = sha(AMOUNT_GRANT_STATE_TEXT.granted);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const TABLE_ACL = '{checksops_admin=arwdDxt/checksops_admin,checksops=r/checksops_admin}';
const PRE_COLUMNS = ['account_number', 'carrier_name', 'routing_number', 'status', 'updated_at'];
const COMMIT = 'a'.repeat(40);

/** An execute-authorized copy with a recorded pre-state and inspect. */
const authorizedPin = (inspect = {}) => Object.freeze({
  ...COMMITTED,
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: ABSENT,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
  production_inspect: {
    ...COMMITTED.production_inspect,
    status: 'recorded',
    live_definition_sha256: ABSENT,
    table_owner: 'checksops_admin',
    table_acl: TABLE_ACL,
    updatable_columns: PRE_COLUMNS,
    updatable_columns_sha256: sha(PRE_COLUMNS.join(',')),
    ...inspect,
  },
});
const PIN = authorizedPin();

function manifest(overrides = {}) {
  const fingerprint = { sql: ABSENT };
  const workstream = 'prod-sql71-review-amount-test';
  return {
    workstream_id: workstream,
    branch: 'main',
    commit: COMMIT,
    operator: 'owner',
    target_environment: 'production',
    target_component: 'production-sql',
    deployment_type: 'sql-apply',
    owned_components: [PIN.filename],
    filename: PIN.filename,
    migration_id: PIN.migration_id,
    source_sha256: PIN.source_sha256,
    expected_live_definition_sha256: ABSENT,
    intended_replacement_sha256: PIN.intended_replacement_sha256,
    live_definition_sha256: ABSENT,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: PIN.staging_acceptance,
    approval: { approved: true, workstream_id: workstream },
    authorization_phrase: PIN.authorization_phrase,
    one_use_id: `sql71-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-16T20:00:00.000Z',
    ...overrides,
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql71-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
const neverConnect = async () => { throw new Error('should-not-connect'); };

async function runCli(argv, { env = { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, input, deps = {} } = {}) {
  let file = null;
  if (input) {
    file = path.join(os.tmpdir(), `sql71-prod-input-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(input));
  }
  const writes = [];
  let spent = 0;
  const orig = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await cliMain(file ? [...argv, '--input', file] : argv, env, {
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

// --- pin ------------------------------------------------------------------------

test('production pin: pending, execute false, no recorded pre-state, no staging acceptance; bound to the staging pin and the production RDS', () => {
  assert.equal(SQL71_PRODUCTION_PIN_REL, 'ops/deployment-guard/sql71-review-amount-production-apply.json');
  assert.equal(COMMITTED.migration, 'sql71');
  assert.equal(COMMITTED.authorization, 'pending');
  assert.equal(COMMITTED.execute, false);
  assert.equal(COMMITTED.expected_live_definition_sha256, null);
  assert.equal(COMMITTED.staging_acceptance.ok, false);
  assert.equal(COMMITTED.staging_acceptance.reference, null);
  assert.equal(COMMITTED.production_inspect.status, 'pending');
  for (const field of ['table_owner', 'table_acl', 'updatable_columns', 'updatable_columns_sha256', 'live_definition_sha256']) {
    assert.equal(COMMITTED.production_inspect[field], null, field);
  }
  for (const field of ['filename', 'migration_id', 'source_sha256', 'intended_replacement_sha256', 'table', 'grantee', 'column']) {
    assert.equal(COMMITTED[field], STAGING_PIN[field], field);
  }
  assert.equal(COMMITTED.staging_pin_commit, STAGING_PIN.commit);
  assert.equal(sha(SQL71_TEXT), COMMITTED.source_sha256);
  assert.ok(SQL71_SINGLE_STATEMENT_RE.test(SQL71_TEXT));
  // The fingerprints are the staging handler's: amount absent before, granted after.
  assert.equal(STAGING_PIN.expected_live_definition_sha256, ABSENT);
  assert.equal(COMMITTED.intended_replacement_sha256, GRANTED);
  assert.equal(GRANTED, 'ff8e86f95a78474068f6b083087ac6fdad7af321aff9a6536ca38faadf5d35a9');
  assert.equal(COMMITTED.intended_post_state.live_definition_sha256, GRANTED);
  // Staging is recorded as already applied (read-live run 71).
  const notes = COMMITTED.notes.join('\n');
  for (const fact of ['read-live run 71', '38903724634', 'b83e5cc33', 'already_applied true', 'amount_update_granted true', 'table_level_update false', 'ff8e86f9']) {
    assert.ok(notes.includes(fact), fact);
  }
  for (const field of ['rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(COMMITTED[field], SQL72_PIN[field], field);
  assert.equal(sql71AdminLogin(COMMITTED), 'checksops_admin');
  assert.match(COMMITTED.authorization_phrase, /^[A-Z_]{12,}$/);
  assert.notEqual(COMMITTED.authorization_phrase, SQL72_PIN.authorization_phrase);
  assert.equal(ONE_SHOT_TOOLS.sql71.pin_rel, SQL71_PRODUCTION_PIN_REL);
  assert.equal(ONE_SHOT_TOOLS.sql71.script, 'scripts/deployment-guard/sql71-review-amount-production-apply.mjs');
  assert.equal(ONE_SHOT_TOOLS.sql71.allowed_key, 'sql71_production_apply_allowed');
});

test('the pinned file is exactly the single reviewed GRANT; a tampered pin or file is refused', () => {
  assert.equal(readPinnedSql71(ROOT, COMMITTED).ok, true);
  for (const field of ['migration', 'filename', 'migration_id', 'source_sha256', 'staging_pin_commit', 'intended_replacement_sha256', 'table', 'grantee', 'column', 'target_environment', 'target_component', 'deployment_type']) {
    assert.equal(readPinnedSql71(ROOT, { ...COMMITTED, [field]: 'other' }).code, CODES.SQL_COLLISION, field);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql71-prod-tamper-'));
  try {
    for (const [label, text] of [
      ['table-level', SQL71_TEXT.replace('GRANT UPDATE (amount)', 'GRANT UPDATE')],
      ['extra column', SQL71_TEXT.replace('(amount)', '(amount, status)')],
      ['extra statement', `${SQL71_TEXT}GRANT UPDATE (status) ON TABLE public.check_intake_items TO checksops;\n`],
    ]) {
      const file = path.join(dir, COMMITTED.filename);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      assert.equal(readPinnedSql71(dir, COMMITTED).code, CODES.SOURCE_RECONCILIATION_REQUIRED, label);
      assert.equal(SQL71_SINGLE_STATEMENT_RE.test(text), false, label);
      // Even with the pin's hash updated, the single-statement rule refuses.
      assert.equal(readPinnedSql71(dir, { ...COMMITTED, source_sha256: sha(text) }).code, CODES.SQL_COLLISION, label);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- rules --------------------------------------------------------------------------

const state = (overrides = {}) => ({
  current_user: 'checksops_admin',
  session_user: 'checksops_admin',
  grantee_role_present: true,
  table_present: true,
  table_owner: 'checksops_admin',
  table_acl: TABLE_ACL,
  table_acl_entries: ['checksops SELECT granted by checksops_admin'],
  amount_column_present: true,
  amount_update_granted: false,
  amount_column_grant: false,
  routing_number_update_granted: true,
  account_number_update_granted: true,
  sql52_columns_missing: [],
  sql52_prerequisite_met: true,
  table_level_update: false,
  updatable_columns: PRE_COLUMNS,
  updatable_columns_sha256: sha(PRE_COLUMNS.join(',')),
  column_update_entries: PRE_COLUMNS.map((c) => `${c} checksops UPDATE granted by checksops_admin`).sort(),
  column_acl_entries: PRE_COLUMNS.map((c) => `${c} checksops UPDATE granted by checksops_admin`).sort(),
  grantee_grant_option: false,
  login_can_grant_amount: true,
  live_definition_sha256: ABSENT,
  ...overrides,
});
const POST_COLUMNS = [...PRE_COLUMNS, 'amount'].sort();
const postEntries = POST_COLUMNS.map((c) => `${c} checksops UPDATE granted by checksops_admin`).sort();
const postState = (overrides = {}) => state({
  amount_update_granted: true,
  amount_column_grant: true,
  updatable_columns: POST_COLUMNS,
  updatable_columns_sha256: sha(POST_COLUMNS.join(',')),
  column_update_entries: postEntries,
  column_acl_entries: postEntries,
  live_definition_sha256: GRANTED,
  ...overrides,
});

test('production preconditions and postconditions', () => {
  assert.deepEqual(sql71ProductionPreconditionFailures(state(), PIN), []);
  const refusedPre = [
    [{ current_user: 'ubuntu' }, 'login_is_pinned_admin'],
    [{ session_user: 'ubuntu' }, 'login_is_pinned_admin'],
    [{ grantee_role_present: false }, 'grantee_role_present'],
    [{ amount_column_present: false }, 'amount_column_present'],
    [{ amount_update_granted: true }, 'amount_update_absent'],
    [{ amount_column_grant: true }, 'amount_update_absent'],
    [{ table_level_update: true }, 'no_table_level_update'],
    [{ routing_number_update_granted: false }, 'sql52_routing_number_granted'],
    [{ account_number_update_granted: false }, 'sql52_account_number_granted'],
    [{ grantee_grant_option: true }, 'no_grantee_grant_option'],
    [{ login_can_grant_amount: false }, 'login_can_grant_amount'],
    [{ table_owner: 'other' }, 'table_owner_as_inspected'],
    [{ table_acl: '{x}' }, 'table_acl_as_inspected'],
    [{ updatable_columns: [...PRE_COLUMNS, 'payee_line'].sort() }, 'updatable_columns_as_inspected'],
    [{ updatable_columns_sha256: 'f'.repeat(64) }, 'updatable_columns_as_inspected'],
  ];
  for (const [overrides, name] of refusedPre) {
    assert.ok(sql71ProductionPreconditionFailures(state(overrides), PIN).includes(name), `${name}: ${JSON.stringify(overrides)}`);
  }
  // The committed pin has no recorded inspect and no other login: those three fail.
  assert.deepEqual(sql71ProductionPreconditionFailures(state(), COMMITTED), ['table_owner_as_inspected', 'table_acl_as_inspected', 'updatable_columns_as_inspected']);
  assert.ok(sql71ProductionPreconditionFailures(state(), { ...PIN, admin_login: undefined }).includes('login_is_pinned_admin'));

  assert.deepEqual(sql71ProductionPostconditionFailures(state(), postState(), PIN), []);
  const refusedPost = [
    [{ live_definition_sha256: ABSENT }, 'intended_state'],
    [{ amount_column_grant: false }, 'amount_update_granted'],
    [{ updatable_columns: [...POST_COLUMNS, 'payee_line'].sort() }, 'updatable_columns_grew_by_amount_only'],
    [{ updatable_columns: PRE_COLUMNS }, 'updatable_columns_grew_by_amount_only'],
    [{ column_update_entries: [...postEntries, 'payee_line checksops UPDATE granted by checksops_admin'].sort() }, 'column_update_entries_grew_by_amount_only'],
    [{ column_update_entries: postEntries.map((l) => l.replace('amount checksops UPDATE granted by checksops_admin', 'amount checksops UPDATE granted by ubuntu')) }, 'column_update_entries_grew_by_amount_only'],
    [{ column_acl_entries: [...postEntries, 'status authenticated SELECT granted by checksops_admin'].sort() }, 'other_column_acl_unchanged'],
    [{ table_level_update: true }, 'no_table_level_update'],
    [{ grantee_grant_option: true }, 'no_grantee_grant_option'],
    [{ sql52_prerequisite_met: false }, 'sql52_still_granted'],
    [{ table_acl: '{x}' }, 'table_acl_unchanged'],
    [{ table_acl_entries: [] }, 'table_acl_unchanged'],
    [{ current_user: 'ubuntu' }, 'login_is_pinned_admin'],
  ];
  for (const [overrides, name] of refusedPost) {
    assert.ok(sql71ProductionPostconditionFailures(state(), postState(overrides), PIN).includes(name), `${name}: ${JSON.stringify(overrides)}`);
  }
  // A pre-state that already had amount cannot "grow by amount".
  assert.ok(sql71ProductionPostconditionFailures(postState(), postState(), PIN).includes('updatable_columns_grew_by_amount_only'));
});

// --- evaluation and CLI -----------------------------------------------------------------

test('evaluation: the committed (pending) pin refuses; it is bound to a recorded pre-state, an owner approval, the staging acceptance and the production gate', async () => {
  const committed = await evaluateSql71ProductionApply(manifest(), { root: ROOT });
  assert.equal(committed.code, CODES.SQL_COLLISION);
  assert.match(committed.message, /no recorded pre-apply live definition hash/);
  // With a recorded pre-state, authorization "pending" still refuses.
  const pending = await evaluateSql71ProductionApply(manifest(), { root: ROOT, pin: { ...PIN, authorization: 'pending' } });
  assert.equal(pending.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  for (const authorization of ['', null, 'approved', 'pending ']) {
    const result = await evaluateSql71ProductionApply(manifest(), { root: ROOT, pin: { ...PIN, authorization } });
    assert.equal(result.code, CODES.PRODUCTION_APPROVAL_REQUIRED, String(authorization));
  }
  // With an owner approval but the committed staging acceptance (ok false, no reference).
  const noStaging = await evaluateSql71ProductionApply(manifest(), { root: ROOT, pin: { ...PIN, staging_acceptance: COMMITTED.staging_acceptance } });
  assert.equal(noStaging.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const allowed = await evaluateSql71ProductionApply(manifest(), { root: ROOT, pin: PIN });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.migration, 'sql71');
  assert.equal(allowed.details.sql71_production_apply_allowed, true);
  for (const field of ['filename', 'migration_id', 'source_sha256', 'expected_live_definition_sha256', 'intended_replacement_sha256', 'live_definition_sha256']) {
    const result = await evaluateSql71ProductionApply(manifest({ [field]: 'f'.repeat(64) }), { root: ROOT, pin: PIN });
    assert.equal(result.code, CODES.SQL_COLLISION, field);
  }
  const appliedHash = await evaluateSql71ProductionApply(manifest({ live_definition_sha256: GRANTED }), { root: ROOT, pin: PIN });
  assert.equal(appliedHash.code, CODES.SQL_COLLISION);
  const otherRef = await evaluateSql71ProductionApply(manifest({ staging_acceptance: { ok: true, reference: `${STAGING_REF}0` } }), { root: ROOT, pin: PIN });
  assert.equal(otherRef.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const otherApproval = await evaluateSql71ProductionApply(manifest({ approval: { approved: true, workstream_id: 'another' } }), { root: ROOT, pin: PIN });
  assert.equal(otherApproval.ok, false);
});

test('CLI with the committed pin refuses before the guard; without a receipt the guard refuses; credential flags are refused; nothing connects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql71-prod-noreceipt-'));
  try {
    const input = path.join(dir, 'sql71.json');
    fs.writeFileSync(input, JSON.stringify(manifest()));
    for (const extra of [{ CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, {}]) {
      const result = spawnSync(process.execPath, [CLI, '--apply', '--input', input], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: dir, ...extra },
      });
      const out = `${result.stdout}${result.stderr}`;
      assert.notEqual(result.status, 0, out);
      assert.match(out, /SQL_COLLISION/);
      assert.match(out, /no recorded pre-apply live definition hash/);
      assert.doesNotMatch(out, /secretsmanager|ECONNREFUSED|rolled back/i);
    }
    for (const flag of ['--password=x', '--database-url=postgresql://u:p@h/d', '--host=h', '--user=u', '--secret-arn=x']) {
      const result = spawnSync(process.execPath, [CLI, '--inspect', flag], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } });
      assert.notEqual(result.status, 0, flag);
      assert.match(`${result.stdout}${result.stderr}`, /credential flags are refused/, flag);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secretsmanager|ECONNREFUSED/i, flag);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sql71-prod-noreceipt-root-'));
  try {
    const noReceipt = await runCli(['--apply'], {
      input: manifest(),
      deps: { pin: PIN, enforceScriptGuard: (spec) => refuseUnguardedDeploy(spec, { root: empty, env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' } }) },
    });
    assert.equal(noReceipt.spent, 0);
    assert.match(noReceipt.out, /DEPLOYMENT_GUARD_REQUIRED/);
    assert.doesNotMatch(noReceipt.out, /should-not-connect/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('CLI does not spend the receipt on a wrong phrase, execute false, a pending pin, a wrong owner, a reused id, a missing guard flag or arbitrary SQL', async () => {
  const owned = (filename = PIN.filename) => ({ ok: true, details: { receipt: { owned_components: [filename] } } });
  const argv = ['--apply'];
  const phrase = await runCli(argv, { input: manifest({ authorization_phrase: 'yes' }), deps: { pin: PIN, enforceScriptGuard: () => owned() } });
  assert.equal(phrase.spent, 0);
  assert.match(phrase.out, /PRODUCTION_APPROVAL_REQUIRED/);
  const notExecutable = await runCli(argv, { input: manifest(), deps: { pin: { ...PIN, execute: false }, enforceScriptGuard: () => owned() } });
  assert.equal(notExecutable.spent, 0);
  assert.match(notExecutable.out, /execute is not authorized/);
  const pending = await runCli(argv, { input: manifest(), deps: { pin: { ...PIN, authorization: 'pending' }, enforceScriptGuard: () => { throw new Error('guard-called'); } } });
  assert.equal(pending.spent, 0);
  assert.match(pending.out, /PRODUCTION_APPROVAL_REQUIRED/);
  assert.doesNotMatch(pending.out, /guard-called/);
  const committed = await runCli(argv, { input: manifest(), deps: { pin: COMMITTED, enforceScriptGuard: () => { throw new Error('guard-called'); } } });
  assert.equal(committed.spent, 0);
  assert.match(committed.out, /SQL_COLLISION/);
  assert.doesNotMatch(committed.out, /guard-called/);
  const wrongOwner = await runCli(argv, { input: manifest(), deps: { pin: PIN, enforceScriptGuard: () => owned('aws/workflows/sql/72_member_payment_writes.sql') } });
  assert.equal(wrongOwner.spent, 0);
  assert.match(wrongOwner.out, /RECEIPT_MISMATCH/);
  const reusedFile = consumedPath();
  fs.writeFileSync(reusedFile, JSON.stringify({ consumed: ['sql71-prod-reused-id'] }));
  const reused = await runCli(argv, { input: manifest({ one_use_id: 'sql71-prod-reused-id' }), deps: { pin: PIN, enforceScriptGuard: () => owned(), consumedPath: reusedFile } });
  assert.equal(reused.spent, 0);
  assert.match(reused.out, /RECEIPT_REUSED/);
  const noFlag = await runCli(argv, { env: {}, input: manifest(), deps: { pin: PIN, enforceScriptGuard: () => owned() } });
  assert.equal(noFlag.spent, 0);
  assert.match(noFlag.out, /blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1/);
  const arbitrary = await runCli(argv, { input: { ...manifest(), sql_text: 'GRANT UPDATE ON public.check_intake_items TO checksops' }, deps: { pin: PIN, enforceScriptGuard: () => owned() } });
  assert.equal(arbitrary.spent, 0);
  assert.match(arbitrary.out, /arbitrary SQL text is forbidden/);
  for (const r of [phrase, notExecutable, pending, committed, wrongOwner, reused, noFlag, arbitrary]) assert.doesNotMatch(r.out, /should-not-connect/);
});

test('the real guard: a staging receipt cannot authorize production; a production receipt is spent once and a refusing DB rolls back', async () => {
  const NOW = Date.parse('2026-10-16T20:00:00.000Z');
  const issue = (root, overrides) => {
    const input = manifest();
    const spec = {
      workstream_id: input.workstream_id,
      branch: 'main',
      commit: COMMIT,
      operator: 'owner',
      target_environment: 'production',
      target_component: 'production-sql',
      deployment_type: 'sql-apply',
      owned_components: [PIN.filename],
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
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql71-prod-staging-receipt-'));
  const prodRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql71-prod-receipt-'));
  try {
    const staging = issue(stagingRoot, { target_environment: 'staging', target_component: 'staging-sql' });
    const refused = await runCli(['--apply'], { input: staging.input, deps: { pin: PIN, enforceScriptGuard: guardWith(stagingRoot, staging.receipt) } });
    assert.equal(refused.spent, 0);
    assert.match(refused.out, /RECEIPT_MISMATCH/);
    const prod = issue(prodRoot, {});
    const refusingDb = async () => ({ query: async () => { throw new Error('db-unavailable'); }, end: async () => {} });
    const valid = await runCli(['--apply'], { input: prod.input, deps: { pin: PIN, enforceScriptGuard: guardWith(prodRoot, prod.receipt), connect: refusingDb } });
    assert.equal(valid.spent, 1);
    assert.match(valid.out, /rolled back/);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.rmSync(prodRoot, { recursive: true, force: true });
  }
});

test('apply refuses before connecting: the committed pin, a pending authorization, execute false, no phrase, no single-use id', async () => {
  const run = (overrides, pin = PIN) => executeSql71ProductionApply(manifest(overrides), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() });
  const committed = await executeSql71ProductionApply(manifest(), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() });
  assert.equal(committed.code, CODES.SQL_COLLISION);
  assert.equal((await run({}, { ...PIN, authorization: 'pending' })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({}, { ...PIN, execute: false })).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await run({}, { ...PIN, staging_acceptance: COMMITTED.staging_acceptance })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({ authorization_phrase: 'yes' })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({}, { ...PIN, authorization_phrase: '' })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({ one_use_id: 'x' })).code, CODES.INVALID_MANIFEST);
  const authorized = await run({}).catch((error) => error);
  assert.match(String(authorized?.message || ''), /should-not-connect/);
});

// --- PostgreSQL -------------------------------------------------------------------

/** Production-like pre-state: the table owned by checksops_admin, SELECT and some column UPDATEs, then the real SQL 52. */
async function productionFixture(pg, prefix, port) {
  const server = startPg(prefix, port);
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  const connectAs = async (user) => {
    const client = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await client.connect();
    return client;
  };
  await admin.query(`
    CREATE ROLE checksops NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE checksops_admin LOGIN NOSUPERUSER;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE TABLE public.check_intake_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, status text, amount numeric,
      routing_number text, account_number text, carrier_name text, payee_line text, updated_at timestamptz);
    ALTER TABLE public.check_intake_items ENABLE ROW LEVEL SECURITY;
    CREATE POLICY aws_select_check_intake_items ON public.check_intake_items FOR SELECT TO checksops USING (true);
    CREATE POLICY aws_update_check_intake_items ON public.check_intake_items FOR UPDATE TO checksops USING (true) WITH CHECK (true);
    CREATE TABLE public.claims (id uuid PRIMARY KEY, org_id uuid);
    ALTER TABLE public.check_intake_items OWNER TO checksops_admin;
    ALTER TABLE public.claims OWNER TO checksops_admin;
  `);
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(`
      GRANT SELECT ON TABLE public.check_intake_items TO checksops;
      GRANT UPDATE (status, carrier_name, updated_at) ON TABLE public.check_intake_items TO checksops;
      GRANT SELECT ON TABLE public.claims TO checksops;`);
    await owner.query(SQL52_TEXT);
  } finally {
    await owner.end();
  }
  return { server, admin, connectAs };
}

test('PostgreSQL 16: inspect is read-only; apply adds exactly amount once; refusals for already granted, table-level UPDATE, missing SQL 52, drift, wrong login and rollback', { timeout: 240000 }, async (t) => {
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
  const { server, admin, connectAs } = await productionFixture(pg, 'pg-sql71-prod-', 56800);
  try {
    const catalog = async () => (await admin.query(`
      SELECT has_column_privilege('checksops', 'public.check_intake_items', 'amount', 'UPDATE') AS amount,
        has_table_privilege('checksops', 'public.check_intake_items', 'UPDATE') AS table_level,
        (SELECT relacl::text FROM pg_class WHERE oid = 'public.check_intake_items'::regclass) AS table_acl,
        (SELECT attacl::text FROM pg_attribute WHERE attrelid = 'public.check_intake_items'::regclass AND attname = 'amount') AS amount_acl,
        ARRAY(SELECT attname::text FROM pg_attribute WHERE attrelid = 'public.check_intake_items'::regclass AND attnum > 0 AND NOT attisdropped
          AND has_column_privilege('checksops', attrelid, attnum, 'UPDATE') ORDER BY 1) AS updatable`)).rows[0];
    const start = await catalog();
    assert.deepEqual(start, { amount: false, table_level: false, table_acl: TABLE_ACL, amount_acl: null, updatable: PRE_COLUMNS });

    const seen = [];
    const connectWith = (user) => async () => {
      const client = await connectAs(user);
      const query = client.query.bind(client);
      client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
      return client;
    };
    const connect = connectWith('checksops_admin');
    const inspect = (c = connect, pin = PIN) => inspectSql71Production({ connect: c, pin, root: ROOT });

    // The committed pin: no recorded pre-state, so the inspect reads but refuses.
    const committed = await inspect(connect, COMMITTED);
    assert.equal(committed.ok, true, JSON.stringify(committed));
    assert.equal(committed.details.live_definition_sha256, ABSENT);
    assert.equal(committed.details.live_matches_expected, false);
    assert.equal(committed.details.apply_preconditions_met, false);
    assert.deepEqual(committed.details.precondition_failures, ['table_owner_as_inspected', 'table_acl_as_inspected', 'updatable_columns_as_inspected']);
    assert.equal(committed.details.pin_execute, false);

    seen.length = 0;
    const before = await inspect();
    assert.equal(before.ok, true, JSON.stringify(before));
    const b = before.details;
    assert.equal(b.read_only, true);
    assert.equal(b.migration, 'sql71');
    assert.equal(b.source_ok, true);
    assert.equal(b.live_definition_sha256, ABSENT);
    assert.equal(b.live_definition_sha256, STAGING_PIN.expected_live_definition_sha256);
    assert.equal(b.live_matches_expected, true);
    assert.equal(b.already_applied, false);
    assert.deepEqual(b.precondition_failures, []);
    assert.equal(b.apply_preconditions_met, true);
    assert.equal(b.current_user, 'checksops_admin');
    assert.equal(b.session_user, 'checksops_admin');
    assert.equal(b.table_owner, 'checksops_admin');
    assert.equal(b.table_acl, TABLE_ACL);
    assert.deepEqual(b.updatable_columns, PRE_COLUMNS);
    assert.equal(b.updatable_columns_sha256, sha(PRE_COLUMNS.join(',')));
    assert.equal(b.amount_update_granted, false);
    assert.equal(b.routing_number_update_granted, true);
    assert.equal(b.account_number_update_granted, true);
    assert.equal(b.sql52_prerequisite_met, true);
    assert.equal(b.table_level_update, false);
    assert.equal(b.grantee_grant_option, false);
    assert.equal(b.login_can_grant_amount, true);
    assert.deepEqual(b.column_update_entries, PRE_COLUMNS.map((c) => `${c} checksops UPDATE granted by checksops_admin`));
    assert.deepEqual(b.post_state, { live_definition_sha256: GRANTED, updatable_columns: POST_COLUMNS, table_level_update: false });
    assert.equal(seen[0], 'BEGIN READ ONLY');
    assert.equal(seen.at(-1), 'ROLLBACK');
    assert.ok(seen.slice(1, -1).every((text) => /^\s*(SELECT|WITH)\b/i.test(text)), JSON.stringify(seen));
    assert.deepEqual(await catalog(), start, 'inspect changed nothing');

    // Wrong login: the superuser (and a non-owner) are refused.
    const asSuperuser = await inspect(connectWith('ubuntu'));
    assert.deepEqual(asSuperuser.details.precondition_failures, ['login_is_pinned_admin']);
    assert.equal(asSuperuser.details.apply_preconditions_met, false);
    const superApply = await executeSql71ProductionApply(manifest(), { root: ROOT, pin: PIN, connect: connectWith('ubuntu'), consumedPath: consumedPath() });
    assert.equal(superApply.code, CODES.DEPLOYMENT_COLLISION);
    assert.deepEqual(superApply.details.failed, ['login_is_pinned_admin']);
    await admin.query('CREATE ROLE sql71_other LOGIN NOSUPERUSER; GRANT SELECT ON public.check_intake_items TO sql71_other');
    const otherApply = await executeSql71ProductionApply(manifest(), { root: ROOT, pin: PIN, connect: connectWith('sql71_other'), consumedPath: consumedPath() });
    assert.equal(otherApply.code, CODES.DEPLOYMENT_COLLISION);
    assert.ok(otherApply.details.failed.includes('login_is_pinned_admin'), JSON.stringify(otherApply.details));
    assert.ok(otherApply.details.failed.includes('login_can_grant_amount'), JSON.stringify(otherApply.details));
    await admin.query('REVOKE ALL ON public.check_intake_items FROM sql71_other; DROP ROLE sql71_other');

    const apply = (overrides = {}, ctx = {}) => executeSql71ProductionApply(manifest(overrides), { root: ROOT, pin: PIN, connect, consumedPath: consumedPath(), ...ctx });
    const refusedThenRestored = async (label, breakIt, restore, code, failures = null) => {
      const owner = await connectAs('checksops_admin');
      try {
        await owner.query(breakIt);
        const refused = await inspect();
        assert.equal(refused.details.apply_preconditions_met, false, label);
        if (failures) assert.deepEqual(refused.details.precondition_failures, failures, label);
        const applyRefused = await apply();
        assert.equal(applyRefused.code, code, `${label}: ${JSON.stringify(applyRefused)}`);
        await owner.query(restore);
      } finally {
        await owner.end();
      }
      const restored = await inspect();
      assert.equal(restored.details.apply_preconditions_met, true, `${label} restored: ${JSON.stringify(restored.details.precondition_failures)}`);
      assert.deepEqual(await catalog(), start, `${label} restored`);
      return null;
    };
    // amount already granted: refuse re-grant.
    await refusedThenRestored('amount already granted',
      'GRANT UPDATE (amount) ON public.check_intake_items TO checksops',
      'REVOKE UPDATE (amount) ON public.check_intake_items FROM checksops',
      CODES.UNRELATED_MUTATION);
    // table-level UPDATE (which also makes amount updatable).
    await refusedThenRestored('table-level UPDATE',
      'GRANT UPDATE ON public.check_intake_items TO checksops',
      'REVOKE UPDATE ON public.check_intake_items FROM checksops; GRANT UPDATE (status, carrier_name, updated_at, routing_number, account_number) ON public.check_intake_items TO checksops',
      CODES.DEPLOYMENT_COLLISION);
    await refusedThenRestored('table-level UPDATE through PUBLIC',
      'GRANT UPDATE ON public.check_intake_items TO PUBLIC',
      'REVOKE UPDATE ON public.check_intake_items FROM PUBLIC',
      CODES.DEPLOYMENT_COLLISION);
    // SQL 52's columns missing.
    await refusedThenRestored('SQL 52 account_number missing',
      'REVOKE UPDATE (account_number) ON public.check_intake_items FROM checksops',
      'GRANT UPDATE (account_number) ON public.check_intake_items TO checksops',
      CODES.DEPLOYMENT_COLLISION, ['sql52_account_number_granted', 'updatable_columns_as_inspected']);
    await refusedThenRestored('SQL 52 never applied',
      'REVOKE UPDATE (routing_number, account_number) ON public.check_intake_items FROM checksops',
      SQL52_TEXT,
      CODES.DEPLOYMENT_COLLISION, ['sql52_routing_number_granted', 'sql52_account_number_granted', 'updatable_columns_as_inspected']);
    // Drift since the recorded inspect: another column, a grant option, a changed table ACL.
    await refusedThenRestored('another updatable column',
      'GRANT UPDATE (payee_line) ON public.check_intake_items TO checksops',
      'REVOKE UPDATE (payee_line) ON public.check_intake_items FROM checksops',
      CODES.DEPLOYMENT_COLLISION, ['updatable_columns_as_inspected']);
    await refusedThenRestored('grant option',
      'GRANT UPDATE (status) ON public.check_intake_items TO checksops WITH GRANT OPTION',
      'REVOKE GRANT OPTION FOR UPDATE (status) ON public.check_intake_items FROM checksops',
      CODES.DEPLOYMENT_COLLISION, ['no_grantee_grant_option']);
    await refusedThenRestored('table ACL drift',
      'GRANT SELECT ON public.check_intake_items TO authenticated',
      'REVOKE SELECT ON public.check_intake_items FROM authenticated',
      CODES.DEPLOYMENT_COLLISION, ['table_acl_as_inspected']);
    // A pin recorded from a different inspect is drift too.
    const stalePin = authorizedPin({ updatable_columns: [...PRE_COLUMNS, 'payee_line'].sort(), updatable_columns_sha256: sha([...PRE_COLUMNS, 'payee_line'].sort().join(',')) });
    const stale = await executeSql71ProductionApply(manifest(), { root: ROOT, pin: stalePin, connect, consumedPath: consumedPath() });
    assert.equal(stale.code, CODES.DEPLOYMENT_COLLISION);
    assert.deepEqual(stale.details.failed, ['updatable_columns_as_inspected']);
    // The manifest's live hash must be the pinned one.
    assert.equal((await apply({ live_definition_sha256: 'f'.repeat(64) })).code, CODES.SQL_COLLISION);
    assert.deepEqual(await catalog(), start);

    // A file that would also grant another column is rolled back at the postconditions.
    const withExtra = (extra) => async () => {
      const client = await connect();
      const query = client.query.bind(client);
      client.query = (sql, params) => (String(sql) === SQL71_TEXT ? query(`${sql}\n${extra}`, params) : query(sql, params));
      return client;
    };
    const extraColumn = await apply({}, { connect: withExtra('GRANT UPDATE (payee_line) ON TABLE public.check_intake_items TO checksops;') });
    assert.equal(extraColumn.code, CODES.UNRELATED_MUTATION, JSON.stringify(extraColumn));
    assert.ok(extraColumn.details.failed.includes('updatable_columns_grew_by_amount_only'), JSON.stringify(extraColumn.details));
    assert.deepEqual(await catalog(), start);
    // An unrelated change in the same transaction is rolled back too.
    const unrelated = await apply({}, { connect: withExtra('ALTER TABLE public.claims DISABLE ROW LEVEL SECURITY; ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY; GRANT INSERT ON public.claims TO checksops;') });
    assert.equal(unrelated.code, CODES.UNRELATED_MUTATION, JSON.stringify(unrelated));
    assert.deepEqual(unrelated.details.unrelated_changed, ['relations']);
    const sameTable = await apply({}, { connect: withExtra('ALTER TABLE public.check_intake_items DISABLE ROW LEVEL SECURITY;') });
    assert.equal(sameTable.code, CODES.UNRELATED_MUTATION, JSON.stringify(sameTable));
    assert.deepEqual(sameTable.details.unrelated_changed, ['check_intake_items_except_amount_acl']);
    // A failing statement inside the transaction rolls back.
    const failing = await apply({}, { connect: withExtra('GRANT UPDATE (amount) ON TABLE public.check_intake_items TO sql71_missing_role;') });
    assert.equal(failing.code, CODES.SQL_COLLISION, JSON.stringify(failing));
    assert.match(failing.message, /rolled back/);
    assert.deepEqual(await catalog(), start);

    // The apply.
    const consumed = consumedPath();
    const input = manifest();
    const applied = await executeSql71ProductionApply(input, { root: ROOT, pin: PIN, connect, consumedPath: consumed });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    const r = applied.details.receipt;
    assert.equal(r.migration, 'sql71');
    assert.equal(r.before_hash, ABSENT);
    assert.equal(r.after_hash, GRANTED);
    assert.deepEqual(r.updatable_columns_before, PRE_COLUMNS);
    assert.deepEqual(r.updatable_columns_after, POST_COLUMNS);
    assert.equal(r.table_level_update, false);
    assert.equal(r.table_acl, TABLE_ACL);
    assert.ok(r.column_update_entries_after.includes('amount checksops UPDATE granted by checksops_admin'));
    assert.equal(r.staging_acceptance, STAGING_REF);
    const end = await catalog();
    assert.deepEqual(end, { ...start, amount: true, amount_acl: '{checksops=w/checksops_admin}', updatable: POST_COLUMNS });

    const after = await inspect();
    assert.equal(after.details.live_definition_sha256, GRANTED);
    assert.equal(after.details.live_definition_sha256, STAGING_PIN.intended_replacement_sha256);
    assert.equal(after.details.already_applied, true);
    assert.equal(after.details.amount_update_granted, true);
    assert.equal(after.details.table_level_update, false);
    assert.equal(after.details.apply_preconditions_met, false);
    assert.deepEqual(after.details.updatable_columns, POST_COLUMNS);

    const replay = await executeSql71ProductionApply(input, { root: ROOT, pin: PIN, connect, consumedPath: consumed });
    assert.equal(replay.code, CODES.RECEIPT_REUSED);
    const reapply = await apply();
    assert.equal(reapply.code, CODES.UNRELATED_MUTATION);
    assert.match(reapply.message, /already/);
    assert.deepEqual(await catalog(), end);

    // Behavior: checksops can now UPDATE amount and still not payee_line.
    await admin.query("INSERT INTO public.check_intake_items (id, status, amount) VALUES ('11111111-1111-4111-8111-111111111111', 'needs_review', 10)");
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE checksops');
      const updated = await admin.query("UPDATE public.check_intake_items SET amount = 12 WHERE id = '11111111-1111-4111-8111-111111111111' AND status = 'needs_review'");
      assert.equal(updated.rowCount, 1);
      await assert.rejects(admin.query("UPDATE public.check_intake_items SET payee_line = 'x'"), /permission denied/);
    } finally {
      await admin.query('ROLLBACK');
    }
  } finally {
    await admin.end();
    server.stop();
  }
});
