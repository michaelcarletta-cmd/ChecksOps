/**
 * Production apply path for SQL 80 (Check Alt Auto-Deposit save for tenant
 * operators).
 *
 * Production's pre-state differs from staging's (read-only inspect 2026-10-15,
 * SSM 1b849090-4596-49ef-aa76-c2a89b58a3a1): the SQL 38 body without its
 * comment, EXECUTE for PUBLIC and checksops (not authenticated), and checksops
 * arwd on public.checkalt_tenant_accounts. The PostgreSQL test reproduces that
 * state (SQL 38's CREATE only, then GRANT EXECUTE TO PUBLIC, checksops, no
 * comment), re-derives both pinned fingerprints from the real catalog, and runs
 * the real production inspect and apply with drift and rollback refusals.
 * Set SQL80_PG18_BIN to a PostgreSQL 18 bin directory to repeat it on 18.
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
  AUTHORIZED_SQL80_CHECKALT_MEMBER_AUTO_DEPOSIT as STAGING_PIN,
  CHECKALT_AUTO_DEPOSIT_APPLIED_STATE,
  CHECKALT_AUTO_DEPOSIT_COMMENT_SHA256,
  CHECKALT_AUTO_DEPOSIT_CONFIG,
  CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256,
  CHECKALT_AUTO_DEPOSIT_FUNCTION,
  CHECKALT_AUTO_DEPOSIT_SQL38_FILE,
  checkaltAutoDepositStateText,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  SQL80_PRODUCTION_PIN_REL,
  evaluateSql80ProductionApply,
  executeSql80ProductionApply,
  inspectSql80Production,
  loadSql80ProductionPin,
  readPinnedSql80,
  sql80ProductionPostconditionFailures,
  sql80OwnerRoles,
  sql80ProductionPreconditionFailures,
} from '../../scripts/deployment-guard/lib/sql80-checkalt-production-apply.mjs';
import { loadStagingSqlExecutor } from '../../scripts/deployment-guard/lib/staging-sql-executor-module.mjs';
import { main as cliMain } from '../../scripts/deployment-guard/sql80-checkalt-production-apply.mjs';
import { applyBaseSchema, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/deployment-guard/sql80-checkalt-production-apply.mjs');
const COMMITTED = loadSql80ProductionPin(ROOT);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38723636938';
// The committed pin is execute-authorized with the recorded staging acceptance; apply tests use it as is.
const PIN = COMMITTED;
// The pre-authorization state (execute false, staging acceptance pending), built here so the
// refusals of a pending pin stay tested after the committed pin was authorized.
const PENDING = Object.freeze({
  ...COMMITTED,
  authorization: 'pending',
  execute: false,
  staging_acceptance: { ok: false, reference: null, basis: 'pending' },
});
const SQL72_PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/sql72-production-apply.json'), 'utf8'));
const COMMIT = 'a'.repeat(40);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const SQL38_TEXT = fs.readFileSync(path.join(ROOT, CHECKALT_AUTO_DEPOSIT_SQL38_FILE), 'utf8');
const SQL80_TEXT = fs.readFileSync(path.join(ROOT, COMMITTED.filename), 'utf8');
const executor = await loadStagingSqlExecutor(ROOT);
const REVIEWED_DEF80_SHA = sha(executor.sql80ReviewedFunctiondef(SQL80_TEXT));
const PRE_FN_ACL = '{=X/checksops_admin,checksops_admin=X/checksops_admin,checksops=X/checksops_admin}';
const POST_FN_ACL = '{checksops_admin=X/checksops_admin,checksops=X/checksops_admin,authenticated=X/checksops_admin}';
const TABLE_ACL = '{checksops_admin=arwdDxtm/checksops_admin,checksops=arwd/checksops_admin}';

function manifest(overrides = {}) {
  const fingerprint = { sql: PIN.expected_live_definition_sha256 };
  const workstream = 'prod-sql80-checkalt-test';
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
    expected_live_definition_sha256: PIN.expected_live_definition_sha256,
    intended_replacement_sha256: PIN.intended_replacement_sha256,
    live_definition_sha256: PIN.expected_live_definition_sha256,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: PIN.staging_acceptance,
    approval: { approved: true, workstream_id: workstream },
    authorization_phrase: PIN.authorization_phrase,
    one_use_id: `sql80-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-15T20:00:00.000Z',
    ...overrides,
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql80-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
const neverConnect = async () => { throw new Error('should-not-connect'); };

async function runCli(argv, { env = { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, input, deps = {} } = {}) {
  let file = null;
  if (input) {
    file = path.join(os.tmpdir(), `sql80-prod-input-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
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

const entry = (grantee) => ({ grantee, privilege_type: 'EXECUTE', is_grantable: false });
/** The staging fingerprint input of the production pre-state the inspect read. */
const PRODUCTION_PRE_STATE = Object.freeze({
  exists: true,
  overload_count: 1,
  definition_sha256: CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256.sql38,
  security_definer: true,
  config: [...CHECKALT_AUTO_DEPOSIT_CONFIG],
  owner_is_executor: true,
  comment_sha256: null,
  acl: [entry('PUBLIC'), entry('checksops')],
});

test('production pin: inspected pre-state, staging post-state, execute-authorized after staging acceptance, production RDS', () => {
  assert.equal(COMMITTED.migration, 'sql80');
  assert.equal(COMMITTED.execute, true);
  assert.match(COMMITTED.authorization, /takes effect only when the owner reviews and merges this change/);
  // The authorization records the owner's approval to merge the execute pin, not a run.
  assert.match(COMMITTED.authorization, /run-time approval/);
  assert.match(COMMITTED.authorization, /authorization phrase/);
  assert.match(COMMITTED.authorization, /one_use_id/);
  assert.equal(COMMITTED.staging_acceptance.ok, true);
  assert.equal(COMMITTED.staging_acceptance.reference, STAGING_REF);
  assert.match(COMMITTED.staging_acceptance.basis, /sql80-checkalt-member-auto-deposit/);
  assert.match(COMMITTED.staging_acceptance.basis, /38723779280/);
  assert.ok(COMMITTED.staging_acceptance.basis.includes(STAGING_PIN.expected_live_definition_sha256.slice(0, 8)));
  assert.ok(COMMITTED.staging_acceptance.basis.includes(COMMITTED.intended_replacement_sha256.slice(0, 8)));
  for (const field of ['filename', 'migration_id', 'source_sha256', 'intended_replacement_sha256']) {
    assert.equal(COMMITTED[field], STAGING_PIN[field], field);
  }
  assert.equal(COMMITTED.staging_pin_commit, STAGING_PIN.commit);
  assert.equal(COMMITTED.function_identity, CHECKALT_AUTO_DEPOSIT_FUNCTION);
  assert.equal(sha(fs.readFileSync(path.join(ROOT, COMMITTED.filename))), COMMITTED.source_sha256);
  // Pre-state: SQL 38 body, no comment, EXECUTE for PUBLIC and checksops.
  assert.equal(COMMITTED.expected_live_definition_sha256, sha(checkaltAutoDepositStateText(PRODUCTION_PRE_STATE)));
  assert.equal(COMMITTED.expected_live_definition_sha256, 'dce5b13151f4b6c6fe7660e0ef9576d4a80e80ad66cfcffbad6d880ad8a07d65');
  assert.notEqual(COMMITTED.expected_live_definition_sha256, STAGING_PIN.expected_live_definition_sha256);
  // Post-state: the staging applied state (EXECUTE for checksops and authenticated).
  assert.equal(COMMITTED.intended_replacement_sha256, sha(checkaltAutoDepositStateText(CHECKALT_AUTO_DEPOSIT_APPLIED_STATE)));
  assert.equal(COMMITTED.intended_replacement_sha256, '5ad9a81cfc01ba8affc165b42986c1a6e7ce87c5f61df6a5ebcac293e00fa0db');
  const inspect = COMMITTED.production_inspect;
  assert.equal(inspect.ssm_command_id, '1b849090-4596-49ef-aa76-c2a89b58a3a1');
  assert.equal(inspect.date, '2026-10-15');
  assert.equal(inspect.function_definition_sha256, CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256.sql38);
  assert.equal(inspect.function_acl, PRE_FN_ACL);
  assert.equal(inspect.table_acl, TABLE_ACL);
  assert.equal(inspect.function_owner, 'checksops_admin');
  assert.equal(inspect.table_owner, 'checksops_admin');
  assert.equal(inspect.comment, null);
  // The latest read-only inspect with the official tool, on main 43377df1a.
  assert.equal(inspect.latest.ssm_command_id, 'da23b804-07c0-4c93-b686-cb8b0bb36de5');
  assert.equal(inspect.latest.source_commit, '43377df1a');
  assert.equal(inspect.latest.read_only, true);
  assert.equal(inspect.latest.live_definition_sha256, COMMITTED.expected_live_definition_sha256);
  assert.equal(inspect.latest.apply_preconditions_met, true);
  assert.deepEqual(inspect.latest.precondition_failures, []);
  assert.equal(inspect.latest.function_acl, inspect.function_acl);
  assert.equal(inspect.latest.table_acl, inspect.table_acl);
  assert.deepEqual(sql80OwnerRoles(COMMITTED), ['checksops_admin']);
  assert.equal(COMMITTED.intended_post_state.function_acl, POST_FN_ACL);
  assert.equal(COMMITTED.intended_post_state.table_acl, inspect.table_acl);
  assert.equal(COMMITTED.intended_post_state.function_definition_sha256, CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256.sql80);
  assert.equal(COMMITTED.intended_post_state.comment_sha256, CHECKALT_AUTO_DEPOSIT_COMMENT_SHA256.sql80);
  assert.equal(REVIEWED_DEF80_SHA, CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256.sql80);
  for (const field of ['rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(COMMITTED[field], SQL72_PIN[field], field);
  assert.match(COMMITTED.authorization_phrase, /^[A-Z_]{12,}$/);
  assert.notEqual(COMMITTED.authorization_phrase, SQL72_PIN.authorization_phrase);
  assert.equal(SQL80_PRODUCTION_PIN_REL, 'ops/deployment-guard/sql80-checkalt-member-auto-deposit-production-apply.json');
});

const production = (overrides = {}) => ({
  function_acl: PRE_FN_ACL,
  function_owner: 'checksops_admin',
  function_acl_entries: ['PUBLIC EXECUTE', 'checksops EXECUTE'],
  function_acl_entries_with_grantor: ['PUBLIC EXECUTE granted by checksops_admin', 'checksops EXECUTE granted by checksops_admin'],
  table_present: true,
  table_acl: TABLE_ACL,
  table_owner: 'checksops_admin',
  table_acl_entries_with_grantor: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'].map((p) => `checksops ${p} granted by checksops_admin`),
  table_update_entries: ['checksops UPDATE'],
  table_grant_option: false,
  column_update_entries: [],
  authenticated_can_update: false,
  authenticated_member_of_checksops: false,
  owner_roles: ['checksops_admin'],
  authenticated_member_of_owner: false,
  ...overrides,
});
const pre = (overrides = {}) => ({
  exists: true,
  overload_count: 1,
  security_definer: true,
  config_as_reviewed: true,
  owner_is_executor: true,
  function_states: { definition: 'expected', comment: 'none' },
  function_definition_sha256: CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256.sql38,
  acl_as_expected: false,
  required_roles_present: true,
  required_tables_present: true,
  required_functions_present: true,
  table_update_granted: true,
  live_definition_sha256: COMMITTED.expected_live_definition_sha256,
  production: production(),
  ...overrides,
});
const post = (overrides = {}) => pre({
  function_states: { definition: 'intended', comment: 'intended' },
  function_definition_sha256: CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256.sql80,
  live_definition_sha256: COMMITTED.intended_replacement_sha256,
  acl_as_expected: true,
  production: production({
    function_acl: POST_FN_ACL,
    function_acl_entries: ['authenticated EXECUTE', 'checksops EXECUTE'],
    function_acl_entries_with_grantor: ['authenticated EXECUTE granted by checksops_admin', 'checksops EXECUTE granted by checksops_admin'],
  }),
  ...overrides,
});

test('the production rules accept only the inspected pre-state and the reviewed post-state', () => {
  assert.deepEqual(sql80ProductionPreconditionFailures(pre(), COMMITTED), []);
  const refusedPre = [
    // The staging pre-state (SQL 38 comment, EXECUTE for checksops and authenticated).
    [{ function_states: { definition: 'expected', comment: 'expected' } }, 'comment_absent'],
    [{ production: production({ function_acl_entries: ['authenticated EXECUTE', 'checksops EXECUTE'] }) }, 'function_execute_public_and_checksops_only'],
    [{ production: production({ function_acl_entries: ['PUBLIC EXECUTE', 'authenticated EXECUTE', 'checksops EXECUTE'] }) }, 'function_execute_public_and_checksops_only'],
    [{ production: production({ function_acl_entries: ['PUBLIC EXECUTE', 'checksops EXECUTE with grant option'] }) }, 'function_execute_public_and_checksops_only'],
    [{ production: production({ function_acl: '{=X/checksops_admin,checksops_admin=X/checksops_admin,checksops=X/someone}' }) }, 'function_acl_as_inspected'],
    [{ production: production({ function_owner: 'checksops' }) }, 'function_owner_as_inspected'],
    [{ function_states: { definition: 'other', comment: 'none' } }, 'definition_is_sql38'],
    [{ function_states: { definition: 'intended', comment: 'none' } }, 'definition_is_sql38'],
    [{ overload_count: 2 }, 'no_overloads'],
    [{ exists: false }, 'function_present'],
    [{ security_definer: false }, 'security_definer'],
    [{ config_as_reviewed: false }, 'config_as_reviewed'],
    [{ owner_is_executor: false }, 'owner_is_session_user'],
    [{ required_functions_present: false }, 'required_functions_present'],
    [{ production: production({ table_acl: '{checksops_admin=arwdDxtm/checksops_admin,checksops=arwd/checksops_admin,authenticated=r/checksops_admin}' }) }, 'table_acl_as_inspected'],
    [{ production: production({ table_owner: 'checksops' }) }, 'table_owner_as_inspected'],
    [{ production: production({ table_update_entries: ['authenticated UPDATE', 'checksops UPDATE'] }) }, 'table_update_only_checksops'],
    [{ production: production({ table_update_entries: ['PUBLIC UPDATE', 'checksops UPDATE'] }) }, 'table_update_only_checksops'],
    [{ production: production({ table_update_entries: ['checksops UPDATE with grant option'] }) }, 'table_update_only_checksops'],
    [{ production: production({ table_update_entries: [] }) }, 'table_update_only_checksops'],
    [{ production: production({ table_grant_option: true }) }, 'no_table_grant_option'],
    [{ production: production({ column_update_entries: ['checkalt_tenant_accounts.auto_approve_enabled authenticated UPDATE'] }) }, 'no_column_update_grants'],
    [{ production: production({ authenticated_can_update: true }) }, 'authenticated_cannot_update_table'],
    [{ production: production({ authenticated_member_of_checksops: true }) }, 'authenticated_not_member_of_checksops'],
    [{ production: undefined }, 'table_acl_as_inspected'],
    [{ production: undefined }, 'authenticated_not_member_of_checksops'],
    // authenticated in the function/table owner role (any route, INHERIT FALSE included).
    [{ production: production({ authenticated_member_of_owner: true }) }, 'authenticated_not_member_of_owner'],
    [{ production: production({ authenticated_member_of_owner: undefined }) }, 'authenticated_not_member_of_owner'],
    [{ production: production({ owner_roles: [] }) }, 'authenticated_not_member_of_owner'],
    [{ production: production({ owner_roles: ['checksops'] }) }, 'authenticated_not_member_of_owner'],
    [{ production: undefined }, 'authenticated_not_member_of_owner'],
  ];
  for (const [overrides, name] of refusedPre) {
    assert.ok(sql80ProductionPreconditionFailures(pre(overrides), COMMITTED).includes(name), `${name}: ${JSON.stringify(overrides)}`);
  }
  assert.ok(sql80ProductionPreconditionFailures(pre(), { ...COMMITTED, production_inspect: undefined }).includes('function_acl_as_inspected'));
  // A pin without inspected owners names no owner role, so it is refused.
  assert.deepEqual(sql80OwnerRoles({ ...COMMITTED, production_inspect: undefined }), []);
  assert.ok(sql80ProductionPreconditionFailures(pre(), { ...COMMITTED, production_inspect: undefined }).includes('authenticated_not_member_of_owner'));

  assert.deepEqual(sql80ProductionPostconditionFailures(pre(), post(), COMMITTED, REVIEWED_DEF80_SHA), []);
  const refusedPost = [
    [{ live_definition_sha256: 'f'.repeat(64) }, 'intended_state'],
    [{ function_definition_sha256: 'f'.repeat(64) }, 'definition_is_reviewed_sql80'],
    [{ function_states: { definition: 'other', comment: 'intended' } }, 'definition_is_reviewed_sql80'],
    [{ function_states: { definition: 'intended', comment: 'none' } }, 'comment_is_sql80'],
    [{ production: production({ function_acl: PRE_FN_ACL }) }, 'public_execute_revoked'],
    [{ production: production({ function_acl_entries: ['PUBLIC EXECUTE', 'authenticated EXECUTE', 'checksops EXECUTE'] }) }, 'public_execute_revoked'],
    [{ production: production({ function_acl_entries: ['authenticated EXECUTE', 'checksops EXECUTE', 'other EXECUTE'] }) }, 'function_execute_checksops_and_authenticated_only'],
    [{ production: production({ function_acl_entries: ['authenticated EXECUTE with grant option', 'checksops EXECUTE'] }) }, 'function_execute_checksops_and_authenticated_only'],
    [{ production: production({ function_acl_entries: ['authenticated EXECUTE', 'checksops EXECUTE'], function_acl: '{x}' }) }, 'function_acl_as_intended'],
    [{ production: production({ function_acl_entries: ['authenticated EXECUTE', 'checksops EXECUTE'], function_acl: POST_FN_ACL, function_owner: 'checksops' }) }, 'function_owner_unchanged'],
    [{ production: production({ function_acl_entries: ['authenticated EXECUTE', 'checksops EXECUTE'], function_acl: POST_FN_ACL, table_acl: '{x}' }) }, 'table_acl_unchanged'],
    [{ production: production({ function_acl_entries: ['authenticated EXECUTE', 'checksops EXECUTE'], function_acl: POST_FN_ACL, authenticated_can_update: true }) }, 'authenticated_cannot_update_table'],
    [{ production: production({ function_acl_entries: ['authenticated EXECUTE', 'checksops EXECUTE'], function_acl: POST_FN_ACL, authenticated_member_of_owner: true }) }, 'authenticated_not_member_of_owner'],
    [{ overload_count: 2 }, 'no_overloads'],
    [{ security_definer: false }, 'security_definer'],
  ];
  for (const [overrides, name] of refusedPost) {
    assert.ok(sql80ProductionPostconditionFailures(pre(), post(overrides), COMMITTED, REVIEWED_DEF80_SHA).includes(name), `${name}: ${JSON.stringify(overrides)}`);
  }
  // The reviewed definition is the one reconstructed from the pinned file.
  assert.ok(sql80ProductionPostconditionFailures(pre(), post(), COMMITTED, 'e'.repeat(64)).includes('definition_is_reviewed_sql80'));
  assert.ok(sql80ProductionPostconditionFailures(pre(), post(), COMMITTED, undefined).includes('definition_is_reviewed_sql80'));
});

test('the pinned file is exactly the reviewed statements; a tampered pin or file is refused', async () => {
  const sql = await readPinnedSql80(ROOT, COMMITTED);
  assert.equal(sql.ok, true, JSON.stringify(sql));
  assert.equal(sql.details.reviewed_definition_sha256, CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256.sql80);
  for (const field of ['filename', 'migration_id', 'source_sha256', 'function_identity', 'table', 'target_environment', 'target_component']) {
    const result = await readPinnedSql80(ROOT, { ...COMMITTED, [field]: 'other' });
    assert.equal(result.code, CODES.SQL_COLLISION, field);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql80-prod-tamper-'));
  try {
    for (const [label, text] of [
      ['grant public', SQL80_TEXT.replace('TO checksops, authenticated;', 'TO checksops, authenticated, PUBLIC;')],
      ['widened body', SQL80_TEXT.replace("'manager', 'operator'", "'manager', 'operator', 'viewer'")],
      ['extra statement', `${SQL80_TEXT}GRANT UPDATE ON TABLE public.checkalt_tenant_accounts TO authenticated;\n`],
    ]) {
      const file = path.join(dir, COMMITTED.filename);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      const result = await readPinnedSql80(dir, COMMITTED);
      assert.equal(result.code, CODES.SOURCE_RECONCILIATION_REQUIRED, label);
      // The reviewed-text parse (the staging executor's) refuses it too.
      const parsed = executor.parseSql80(text);
      assert.ok(!parsed || parsed.outside !== executor.SQL80_NORMALIZED_STATEMENTS
        || sha(executor.sql80ReviewedFunctiondef(text)) !== CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256.sql80, label);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluation is bound to the exact pin, a recorded staging acceptance and the production gate', async () => {
  // A pin whose staging acceptance is pending refuses any manifest reference.
  const pending = await evaluateSql80ProductionApply(manifest({ staging_acceptance: { ok: true, reference: STAGING_REF } }), { root: ROOT, pin: PENDING });
  assert.equal(pending.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const okFalse = await evaluateSql80ProductionApply(manifest(), { root: ROOT, pin: { ...PIN, staging_acceptance: { ...PIN.staging_acceptance, ok: false } } });
  assert.equal(okFalse.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // The committed pin allows evaluation with its own recorded reference.
  const allowed = await evaluateSql80ProductionApply(manifest(), { root: ROOT, pin: COMMITTED });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  for (const field of ['filename', 'migration_id', 'source_sha256', 'expected_live_definition_sha256', 'intended_replacement_sha256', 'live_definition_sha256']) {
    const result = await evaluateSql80ProductionApply(manifest({ [field]: 'f'.repeat(64) }), { root: ROOT, pin: PIN });
    assert.equal(result.code, CODES.SQL_COLLISION, field);
  }
  // The staging pre-state hash is not the production one.
  const stagingHash = await evaluateSql80ProductionApply(manifest({ live_definition_sha256: STAGING_PIN.expected_live_definition_sha256 }), { root: ROOT, pin: PIN });
  assert.equal(stagingHash.code, CODES.SQL_COLLISION);
  const otherRef = await evaluateSql80ProductionApply(manifest({ staging_acceptance: { ok: true, reference: `${STAGING_REF}0` } }), { root: ROOT, pin: PIN });
  assert.equal(otherRef.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const otherApproval = await evaluateSql80ProductionApply(manifest({ approval: { approved: true, workstream_id: 'another' } }), { root: ROOT, pin: PIN });
  assert.equal(otherApproval.ok, false);
});

test('CLI with the committed (execute-authorized) pin and no receipt refuses at the guard and never connects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql80-prod-noreceipt-'));
  try {
    const input = path.join(dir, 'sql80.json');
    fs.writeFileSync(input, JSON.stringify(manifest()));
    for (const extra of [{ CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, {}]) {
      const result = spawnSync(process.execPath, [CLI, '--apply', '--input', input], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: dir, ...extra },
      });
      // Evaluation passes on the committed pin; without a receipt the guard stops it (exit 2)
      // before the secret is resolved or any connection is made. The env flag does not bypass it.
      const out = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, 2, out);
      assert.match(out, /DEPLOYMENT_GUARD_REQUIRED/);
      assert.doesNotMatch(out, /secretsmanager|ECONNREFUSED|rolled back/i);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI does not spend the receipt on a wrong phrase, execute false, a wrong owner, a reused id, a missing guard flag or arbitrary SQL', async () => {
  const owned = (filename = PIN.filename) => ({ ok: true, details: { receipt: { owned_components: [filename] } } });
  const argv = ['--apply'];
  const phrase = await runCli(argv, { input: manifest({ authorization_phrase: 'yes' }), deps: { pin: PIN, enforceScriptGuard: () => owned() } });
  assert.equal(phrase.spent, 0);
  assert.match(phrase.out, /PRODUCTION_APPROVAL_REQUIRED/);
  const notExecutable = await runCli(argv, { input: manifest(), deps: { pin: { ...PIN, execute: false }, enforceScriptGuard: () => owned() } });
  assert.equal(notExecutable.spent, 0);
  assert.match(notExecutable.out, /execute is not authorized/);
  // A pending pin (staging acceptance not recorded) stops before the guard is even asked.
  const committed = await runCli(argv, { input: manifest(), deps: { pin: PENDING, enforceScriptGuard: () => { throw new Error('guard-called'); } } });
  assert.equal(committed.spent, 0);
  assert.match(committed.out, /PRODUCTION_APPROVAL_REQUIRED/);
  assert.doesNotMatch(committed.out, /guard-called/);
  const wrongOwner = await runCli(argv, { input: manifest(), deps: { pin: PIN, enforceScriptGuard: () => owned('aws/workflows/sql/79_member_stakeholder_writes.sql') } });
  assert.equal(wrongOwner.spent, 0);
  assert.match(wrongOwner.out, /RECEIPT_MISMATCH/);
  const reusedFile = consumedPath();
  fs.writeFileSync(reusedFile, JSON.stringify({ consumed: ['sql80-prod-reused-id'] }));
  const reused = await runCli(argv, { input: manifest({ one_use_id: 'sql80-prod-reused-id' }), deps: { pin: PIN, enforceScriptGuard: () => owned(), consumedPath: reusedFile } });
  assert.equal(reused.spent, 0);
  assert.match(reused.out, /RECEIPT_REUSED/);
  const noFlag = await runCli(argv, { env: {}, input: manifest(), deps: { pin: PIN, enforceScriptGuard: () => owned() } });
  assert.equal(noFlag.spent, 0);
  assert.match(noFlag.out, /blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1/);
  const arbitrary = await runCli(argv, { input: { ...manifest(), sql_text: 'GRANT UPDATE ON public.checkalt_tenant_accounts TO authenticated' }, deps: { pin: PIN, enforceScriptGuard: () => owned() } });
  assert.equal(arbitrary.spent, 0);
  assert.match(arbitrary.out, /arbitrary SQL text is forbidden/);
  for (const r of [phrase, notExecutable, committed, wrongOwner, reused, noFlag, arbitrary]) assert.doesNotMatch(r.out, /should-not-connect/);
});

test('the real guard: a staging receipt cannot authorize production; a production receipt is spent once and a refusing DB rolls back', async () => {
  const NOW = Date.parse('2026-10-15T20:00:00.000Z');
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
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql80-prod-staging-receipt-'));
  const prodRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql80-prod-receipt-'));
  try {
    const staging = issue(stagingRoot, { target_environment: 'staging', target_component: 'staging-sql' });
    const refused = await runCli(['--apply'], { input: staging.input, deps: { pin: PIN, enforceScriptGuard: guardWith(stagingRoot, staging.receipt) } });
    assert.equal(refused.spent, 0);
    assert.match(refused.out, /RECEIPT_MISMATCH/);
    const production = issue(prodRoot, {});
    const refusingDb = async () => ({ query: async () => { throw new Error('db-unavailable'); }, end: async () => {} });
    const valid = await runCli(['--apply'], { input: production.input, deps: { pin: PIN, enforceScriptGuard: guardWith(prodRoot, production.receipt), connect: refusingDb } });
    assert.equal(valid.spent, 1);
    assert.match(valid.out, /rolled back/);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.rmSync(prodRoot, { recursive: true, force: true });
  }
});

test('apply refuses before connecting without the phrase, a single-use id, execute or staging acceptance', async () => {
  const run = (overrides, pin = PIN) => executeSql80ProductionApply(manifest(overrides), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() });
  assert.equal((await run({ authorization_phrase: 'yes' })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({ one_use_id: 'x' })).code, CODES.INVALID_MANIFEST);
  assert.equal((await run({}, { ...PIN, execute: false })).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await run({}, PENDING)).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({}, { ...PENDING, staging_acceptance: PIN.staging_acceptance })).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await run({}, { ...PIN, authorization_phrase: '' })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
});

// --- PostgreSQL ---------------------------------------------------------------

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const A_OPERATOR = 'a1000000-0000-4000-8000-00000000000a';
const A_VIEWER = 'a1000000-0000-4000-8000-00000000000c';
// SQL 38's CREATE statement only (production has neither its COMMENT nor its REVOKE/GRANT).
const SQL38_CREATE_ONLY = SQL38_TEXT.slice(0, SQL38_TEXT.indexOf('COMMENT ON FUNCTION'));

/** Builds the production pre-state the 2026-10-15 inspect read; returns the server, an admin client and connectAs. */
async function productionFixture(pg, prefix, port, bin) {
  const server = startPg(prefix, port, bin ? { bin } : {});
  const admin = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await admin.connect();
  const connectAs = async (user) => {
    const client = new pg.Client({ host: server.host, port: server.port, user, database: 'postgres' });
    await client.connect();
    return client;
  };
  await applyBaseSchema(admin);
  await admin.query(`
    CREATE TABLE public.checkalt_tenant_accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE UNIQUE,
      enabled boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now(),
      auto_approve_enabled boolean NOT NULL DEFAULT false,
      auto_approve_max_cents integer);
    ALTER TABLE public.checkalt_tenant_accounts ENABLE ROW LEVEL SECURITY;
    -- Like production's checksops_admin: a non-superuser login that owns the table and the function.
    CREATE ROLE checksops_admin LOGIN NOSUPERUSER;
    GRANT USAGE, CREATE ON SCHEMA public TO checksops_admin;
    GRANT USAGE ON SCHEMA auth TO checksops_admin;
    GRANT SELECT ON public.tenant_users, public.identity_accounts TO checksops_admin;
    ALTER TABLE public.checkalt_tenant_accounts OWNER TO checksops_admin;
    REVOKE ALL ON TABLE public.checkalt_tenant_accounts FROM checksops, authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.checkalt_tenant_accounts TO checksops;
    INSERT INTO public.tenants (id, name) VALUES ('${TENANT_A}', 'A');
    INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
      ('${TENANT_A}', '${A_OPERATOR}', 'operator'), ('${TENANT_A}', '${A_VIEWER}', 'viewer');
    INSERT INTO public.checkalt_tenant_accounts (tenant_id, auto_approve_enabled, auto_approve_max_cents)
      VALUES ('${TENANT_A}', true, 200000);
  `);
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(SQL38_CREATE_ONLY);
    await owner.query(`GRANT EXECUTE ON FUNCTION ${CHECKALT_AUTO_DEPOSIT_FUNCTION} TO PUBLIC`);
    await owner.query(`GRANT EXECUTE ON FUNCTION ${CHECKALT_AUTO_DEPOSIT_FUNCTION} TO checksops`);
  } finally {
    await owner.end();
  }
  return { server, admin, connectAs };
}

// PostgreSQL 16 has no MAINTAIN privilege ('m', new in 17), so the owner's own table
// entry reads arwdDxt there; production (18.3) reads arwdDxtm. The PostgreSQL 16
// fixture therefore pins the 16 spelling of the same ACL; on 18 the committed pin is used as is.
const PG16_TABLE_ACL = TABLE_ACL.replace('arwdDxtm/', 'arwdDxt/');
const pinFor = (bin) => (bin ? PIN : {
  ...PIN,
  production_inspect: { ...PIN.production_inspect, table_acl: PG16_TABLE_ACL },
  intended_post_state: { ...PIN.intended_post_state, table_acl: PG16_TABLE_ACL },
});

const PG_VERSIONS = [
  { label: 'PostgreSQL 16', bin: null, port: 56100 },
  ...(process.env.SQL80_PG18_BIN ? [{ label: 'PostgreSQL 18', bin: process.env.SQL80_PG18_BIN, port: 56200 }] : []),
];

for (const version of PG_VERSIONS) {
  test(`${version.label}: the production pre-state reads the pinned hashes; inspect is read-only; apply lands once and refuses drift`, { timeout: 240000 }, async (t) => {
    const reason = pgSkipReason(version.bin || undefined);
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
    const { server, admin, connectAs } = await productionFixture(pg, 'pg-sql80-prod-', version.port, version.bin);
    const fn = CHECKALT_AUTO_DEPOSIT_FUNCTION;
    const fixturePin = pinFor(version.bin);
    const tableAcl = fixturePin.production_inspect.table_acl;
    try {
      const catalog = async () => (await admin.query(`
        SELECT p.proacl::text AS fn_acl, pg_get_userbyid(p.proowner) AS fn_owner, obj_description(p.oid, 'pg_proc') AS comment,
          encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex') AS def_sha,
          (SELECT relacl::text FROM pg_class WHERE oid = 'public.checkalt_tenant_accounts'::regclass) AS table_acl
        FROM pg_proc p WHERE p.oid = '${fn}'::regprocedure`)).rows[0];
      const start = await catalog();
      // The fixture is the production inspect's state, byte for byte.
      assert.equal(start.fn_acl, COMMITTED.production_inspect.function_acl);
      assert.equal(start.table_acl, tableAcl);
      assert.equal(start.def_sha, COMMITTED.production_inspect.function_definition_sha256);
      assert.equal(start.comment, null);
      assert.equal(start.fn_owner, 'checksops_admin');

      const seen = [];
      const connect = async () => {
        const client = await connectAs('checksops_admin');
        const query = client.query.bind(client);
        client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
        return client;
      };
      const inspect = () => inspectSql80Production({ connect, pin: fixturePin, root: ROOT });
      const before = await inspect();
      assert.equal(before.ok, true, JSON.stringify(before));
      const b = before.details;
      assert.equal(b.live_definition_sha256, COMMITTED.expected_live_definition_sha256, JSON.stringify(b));
      assert.equal(b.live_matches_expected, true);
      assert.deepEqual(b.precondition_failures, []);
      assert.equal(b.apply_preconditions_met, true);
      assert.equal(b.already_applied, false);
      assert.equal(b.state.function_definition_sha256, CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256.sql38);
      // Readable ACLs and owners, not only hashes.
      assert.equal(b.function_acl, PRE_FN_ACL);
      assert.deepEqual(b.function_acl_entries, ['PUBLIC EXECUTE granted by checksops_admin', 'checksops EXECUTE granted by checksops_admin']);
      assert.equal(b.table_acl, tableAcl);
      assert.equal(b.table_owner, 'checksops_admin');
      assert.equal(b.function_owner, 'checksops_admin');
      assert.deepEqual(b.table_acl_entries, ['checksops DELETE granted by checksops_admin', 'checksops INSERT granted by checksops_admin', 'checksops SELECT granted by checksops_admin', 'checksops UPDATE granted by checksops_admin']);
      assert.deepEqual(b.table_update_entries, ['checksops UPDATE']);
      assert.deepEqual(b.column_update_entries, []);
      assert.equal(b.authenticated_can_update_table, false);
      assert.equal(b.authenticated_member_of_checksops, false);
      assert.deepEqual(b.owner_roles, ['checksops_admin']);
      assert.equal(b.authenticated_member_of_owner, false);
      assert.equal(seen[0], 'BEGIN READ ONLY');
      assert.equal(seen.at(-1), 'ROLLBACK');
      assert.ok(seen.slice(1, -1).every((text) => /^\s*(SELECT|WITH|SAVEPOINT|RELEASE)\b/i.test(text)), JSON.stringify(seen));

      const apply = (overrides = {}, ctx = {}) => executeSql80ProductionApply(manifest(overrides), { root: ROOT, pin: fixturePin, connect, consumedPath: consumedPath(), ...ctx });
      const refusedThenRestored = async (label, breakIt, restore, as = 'ubuntu', failures = null) => {
        const client = as === 'ubuntu' ? admin : await connectAs(as);
        await client.query(breakIt);
        const refused = await inspect();
        assert.equal(refused.details.apply_preconditions_met, false, label);
        if (failures) assert.deepEqual(refused.details.precondition_failures, failures, label);
        const applyRefused = await apply();
        assert.equal(applyRefused.code, CODES.DEPLOYMENT_COLLISION, `${label}: ${JSON.stringify(applyRefused)}`);
        await client.query(restore);
        if (client !== admin) await client.end();
        const restored = await inspect();
        assert.equal(restored.details.apply_preconditions_met, true, `${label} restored: ${JSON.stringify(restored.details.precondition_failures)}`);
      };
      await refusedThenRestored('an overload',
        'CREATE FUNCTION public.aws_save_checkalt_tenant_auto_deposit(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$',
        'DROP FUNCTION public.aws_save_checkalt_tenant_auto_deposit(uuid)');
      await refusedThenRestored('authenticated EXECUTE (the staging grant)', `GRANT EXECUTE ON FUNCTION ${fn} TO authenticated`, `REVOKE EXECUTE ON FUNCTION ${fn} FROM authenticated`, 'checksops_admin');
      await refusedThenRestored('another grantee', 'CREATE ROLE sql80_other; GRANT EXECUTE ON FUNCTION public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) TO sql80_other',
        'REVOKE EXECUTE ON FUNCTION public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) FROM sql80_other; DROP ROLE sql80_other');
      await refusedThenRestored('grant option', `GRANT EXECUTE ON FUNCTION ${fn} TO checksops WITH GRANT OPTION`, `REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION ${fn} FROM checksops`, 'checksops_admin');
      await refusedThenRestored('the SQL 38 comment', `COMMENT ON FUNCTION ${fn} IS 'x'`, `COMMENT ON FUNCTION ${fn} IS NULL`);
      await refusedThenRestored('table UPDATE for authenticated', 'GRANT UPDATE ON public.checkalt_tenant_accounts TO authenticated', 'REVOKE UPDATE ON public.checkalt_tenant_accounts FROM authenticated', 'checksops_admin');
      await refusedThenRestored('table UPDATE for PUBLIC', 'GRANT UPDATE ON public.checkalt_tenant_accounts TO PUBLIC', 'REVOKE UPDATE ON public.checkalt_tenant_accounts FROM PUBLIC', 'checksops_admin');
      await refusedThenRestored('table grant option', 'GRANT UPDATE ON public.checkalt_tenant_accounts TO checksops WITH GRANT OPTION', 'REVOKE GRANT OPTION FOR UPDATE ON public.checkalt_tenant_accounts FROM checksops', 'checksops_admin');
      await refusedThenRestored('column UPDATE', 'GRANT UPDATE (auto_approve_enabled) ON public.checkalt_tenant_accounts TO checksops', 'REVOKE UPDATE (auto_approve_enabled) ON public.checkalt_tenant_accounts FROM checksops', 'checksops_admin');
      // authenticated in checksops cannot be built here: the role shim already makes checksops a member
      // of authenticated, so the reverse grant is circular (the rule is covered by the unit test above).
      // authenticated in the owner role, even through an INHERIT FALSE grant (which
      // has_any_column_privilege does not see), and through an intermediate role.
      await admin.query('GRANT checksops_admin TO authenticated WITH INHERIT FALSE');
      const inheritFalse = await inspect();
      assert.equal(inheritFalse.details.authenticated_member_of_owner, true);
      assert.equal(inheritFalse.details.authenticated_can_update_table, false);
      assert.deepEqual(inheritFalse.details.precondition_failures, ['authenticated_not_member_of_owner']);
      assert.equal(inheritFalse.details.live_definition_sha256, COMMITTED.expected_live_definition_sha256);
      assert.equal(inheritFalse.details.apply_preconditions_met, false);
      assert.equal((await apply()).code, CODES.DEPLOYMENT_COLLISION);
      await admin.query('REVOKE checksops_admin FROM authenticated');
      await refusedThenRestored('authenticated in the owner through another role (INHERIT FALSE)',
        'CREATE ROLE sql80_mid NOLOGIN; GRANT checksops_admin TO sql80_mid WITH INHERIT FALSE; GRANT sql80_mid TO authenticated WITH INHERIT FALSE',
        'REVOKE sql80_mid FROM authenticated; REVOKE checksops_admin FROM sql80_mid; DROP ROLE sql80_mid',
        'ubuntu', ['authenticated_not_member_of_owner']);
      await refusedThenRestored('table SELECT for authenticated', 'GRANT SELECT ON public.checkalt_tenant_accounts TO authenticated', 'REVOKE SELECT ON public.checkalt_tenant_accounts FROM authenticated', 'checksops_admin');
      await refusedThenRestored('SECURITY INVOKER', `ALTER FUNCTION ${fn} SECURITY INVOKER`, `ALTER FUNCTION ${fn} SECURITY DEFINER`, 'checksops_admin');
      assert.deepEqual(await catalog(), start);

      // A file that would also grant PUBLIC again is rolled back at the postconditions.
      const sneaky = async () => {
        const client = await connect();
        const query = client.query.bind(client);
        client.query = (sql, params) => (String(sql) === SQL80_TEXT
          ? query(`${sql}\nGRANT EXECUTE ON FUNCTION ${fn} TO PUBLIC;`, params)
          : query(sql, params));
        return client;
      };
      const rolledBack = await apply({}, { connect: sneaky });
      assert.equal(rolledBack.code, CODES.UNRELATED_MUTATION, JSON.stringify(rolledBack));
      assert.ok(rolledBack.details.failed.includes('public_execute_revoked'), JSON.stringify(rolledBack.details));
      assert.deepEqual(await catalog(), start);
      // An unrelated change in the same transaction is rolled back too.
      const unrelated = async () => {
        const client = await connect();
        const query = client.query.bind(client);
        client.query = (sql, params) => (String(sql) === SQL80_TEXT
          ? query(`${sql}\nALTER TABLE public.checkalt_tenant_accounts DISABLE ROW LEVEL SECURITY;`, params)
          : query(sql, params));
        return client;
      };
      const unrelatedResult = await apply({}, { connect: unrelated });
      assert.equal(unrelatedResult.code, CODES.UNRELATED_MUTATION, JSON.stringify(unrelatedResult));
      assert.deepEqual(unrelatedResult.details.unrelated_changed, ['relations']);
      assert.deepEqual(await catalog(), start);
      // The manifest's live hash must be the pinned one.
      assert.equal((await apply({ live_definition_sha256: 'f'.repeat(64) })).code, CODES.SQL_COLLISION);

      const consumed = consumedPath();
      const input = manifest();
      const applied = await executeSql80ProductionApply(input, { root: ROOT, pin: fixturePin, connect, consumedPath: consumed });
      assert.equal(applied.ok, true, JSON.stringify(applied));
      assert.equal(applied.details.receipt.before_hash, COMMITTED.expected_live_definition_sha256);
      assert.equal(applied.details.receipt.after_hash, COMMITTED.intended_replacement_sha256);
      assert.equal(applied.details.receipt.function_acl_before, PRE_FN_ACL);
      assert.equal(applied.details.receipt.function_acl_after, POST_FN_ACL);
      assert.equal(applied.details.receipt.table_acl, tableAcl);

      const end = await catalog();
      assert.equal(end.fn_acl, COMMITTED.intended_post_state.function_acl);
      assert.equal(end.table_acl, start.table_acl);
      assert.equal(end.def_sha, CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256.sql80);
      assert.equal(end.def_sha, REVIEWED_DEF80_SHA);
      assert.equal(sha(end.comment), CHECKALT_AUTO_DEPOSIT_COMMENT_SHA256.sql80);
      const after = await inspect();
      assert.equal(after.details.live_definition_sha256, COMMITTED.intended_replacement_sha256);
      assert.equal(after.details.live_definition_sha256, STAGING_PIN.intended_replacement_sha256);
      assert.equal(after.details.already_applied, true);
      assert.equal(after.details.apply_preconditions_met, false);
      assert.deepEqual(after.details.function_acl_entries, ['authenticated EXECUTE granted by checksops_admin', 'checksops EXECUTE granted by checksops_admin']);
      assert.equal(after.details.authenticated_can_update_table, false);

      const replay = await executeSql80ProductionApply(input, { root: ROOT, pin: fixturePin, connect, consumedPath: consumed });
      assert.equal(replay.code, CODES.RECEIPT_REUSED);
      const reapply = await apply();
      assert.equal(reapply.code, CODES.UNRELATED_MUTATION);
      assert.match(reapply.message, /already in place/);

      // Behavior: authenticated can call it; PUBLIC cannot; an operator saves, a viewer is refused.
      const privileges = (await admin.query(`
        SELECT has_function_privilege('authenticated', '${fn}', 'EXECUTE') AS authenticated,
          has_function_privilege('checksops', '${fn}', 'EXECUTE') AS checksops,
          EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = '${fn}'::regprocedure AND a.grantee = 0) AS public`)).rows[0];
      assert.deepEqual(privileges, { authenticated: true, checksops: true, public: false });
      const save = async (user, settings) => {
        await admin.query('BEGIN');
        try {
          await admin.query('SET LOCAL ROLE checksops');
          await admin.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
          const { rows } = await admin.query('SELECT public.aws_save_checkalt_tenant_auto_deposit($1::uuid, $2::jsonb) AS r', [TENANT_A, JSON.stringify(settings)]);
          await admin.query('COMMIT');
          return rows[0].r;
        } catch (error) {
          await admin.query('ROLLBACK');
          return { error: error.message };
        }
      };
      assert.deepEqual(await save(A_OPERATOR, { auto_approve_enabled: false, auto_approve_max_cents: 150000 }), {
        tenant_id: TENANT_A, auto_approve_enabled: false, auto_approve_max_cents: 150000,
      });
      assert.equal((await save(A_VIEWER, { auto_approve_enabled: true })).error, 'not_authorized');
    } finally {
      await admin.end();
      server.stop();
    }
  });
}

test('PostgreSQL 16: a statement failing inside the apply transaction leaves the production pre-state in place', { timeout: 180000 }, async (t) => {
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
  const { server, admin, connectAs } = await productionFixture(pg, 'pg-sql80-prod-rb-', 56300);
  const fixturePin = pinFor(null);
  try {
    const connect = async () => {
      const client = await connectAs('checksops_admin');
      const query = client.query.bind(client);
      client.query = (sql, params) => (String(sql) === SQL80_TEXT
        ? query(String(sql).replace('TO checksops, authenticated;', 'TO checksops, sql80_missing_role;'), params)
        : query(sql, params));
      return client;
    };
    const result = await executeSql80ProductionApply(manifest(), { root: ROOT, pin: fixturePin, connect, consumedPath: consumedPath() });
    assert.equal(result.code, CODES.SQL_COLLISION, JSON.stringify(result));
    assert.match(result.message, /rolled back/);
    const row = (await admin.query(`SELECT proacl::text AS acl, obj_description(oid, 'pg_proc') AS comment,
      encode(sha256(convert_to(pg_get_functiondef(oid), 'UTF8')), 'hex') AS def_sha
      FROM pg_proc WHERE oid = '${CHECKALT_AUTO_DEPOSIT_FUNCTION}'::regprocedure`)).rows[0];
    assert.deepEqual(row, { acl: PRE_FN_ACL, comment: null, def_sha: CHECKALT_AUTO_DEPOSIT_DEFINITION_SHA256.sql38 });
  } finally {
    await admin.end();
    server.stop();
  }
});
