/**
 * Production apply path for SQL 81 (platform-owner-only Check Alt depositor
 * registration writer, public.aws_register_checkalt_tenant_account(uuid, jsonb)).
 *
 * The function is new, so the pre-state is the function absent in production as
 * in staging. The table is production's: public.checkalt_tenant_accounts owned by
 * checksops_admin with checksops arwd (what the SQL 80 production apply recorded
 * on 2026-10-15). The PostgreSQL test reproduces that state, re-derives both
 * pinned fingerprints from the real catalog, and runs the real production
 * inspect and apply as checksops_admin with drift, login and rollback refusals.
 * Set SQL81_PG18_BIN to a PostgreSQL 18 bin directory to repeat it on 18.
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
  AUTHORIZED_SQL81_CHECKALT_PRODUCTION_REGISTER as STAGING_PIN,
  CHECKALT_REGISTER_APPLIED_STATE,
  CHECKALT_REGISTER_COMMENT_SHA256,
  CHECKALT_REGISTER_DEFINITION_SHA256,
  CHECKALT_REGISTER_FUNCTION,
  CHECKALT_REGISTER_PRE_STATE,
  checkaltRegisterStateText,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import {
  SQL81_PRODUCTION_PIN_REL,
  evaluateSql81ProductionApply,
  executeSql81ProductionApply,
  inspectSql81Production,
  loadSql81ProductionPin,
  readPinnedSql81,
  sql81FunctionOwner,
  sql81OwnerRoles,
  sql81ProductionPostconditionFailures,
  sql81ProductionPreconditionFailures,
} from '../../scripts/deployment-guard/lib/sql81-checkalt-production-apply.mjs';
import { loadStagingSqlExecutor } from '../../scripts/deployment-guard/lib/staging-sql-executor-module.mjs';
import { main as cliMain } from '../../scripts/deployment-guard/sql81-checkalt-production-apply.mjs';
import { applyBaseSchema, pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/deployment-guard/sql81-checkalt-production-apply.mjs');
const COMMITTED = loadSql81ProductionPin(ROOT);
// The committed pin is pending (execute false, staging acceptance not recorded). The apply
// tests exercise an execute-authorized copy with a placeholder staging acceptance reference;
// the committed pin is checked to refuse.
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = Object.freeze({
  ...COMMITTED,
  execute: true,
  staging_acceptance: { ...COMMITTED.staging_acceptance, ok: true, reference: STAGING_REF, basis: 'test fixture' },
});
const SQL72_PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/sql72-production-apply.json'), 'utf8'));
const SQL80_PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/sql80-checkalt-member-auto-deposit-production-apply.json'), 'utf8'));
const COMMIT = 'a'.repeat(40);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const SQL81_TEXT = fs.readFileSync(path.join(ROOT, COMMITTED.filename), 'utf8');
const executor = await loadStagingSqlExecutor(ROOT);
const REVIEWED_DEF81_SHA = sha(executor.sql81ReviewedFunctiondef(SQL81_TEXT));
const POST_FN_ACL = '{checksops_admin=X/checksops_admin,checksops=X/checksops_admin,authenticated=X/checksops_admin}';
const TABLE_ACL = '{checksops_admin=arwdDxtm/checksops_admin,checksops=arwd/checksops_admin}';
const FN = CHECKALT_REGISTER_FUNCTION;

function manifest(overrides = {}) {
  const fingerprint = { sql: PIN.expected_live_definition_sha256 };
  const workstream = 'prod-sql81-checkalt-test';
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
    one_use_id: `sql81-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-15T20:00:00.000Z',
    ...overrides,
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql81-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
const neverConnect = async () => { throw new Error('should-not-connect'); };

async function runCli(argv, { env = { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, input, deps = {} } = {}) {
  let file = null;
  if (input) {
    file = path.join(os.tmpdir(), `sql81-prod-input-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
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

test('production pin: pending, execute false, absent pre-state, staging post-state, production RDS', () => {
  assert.equal(COMMITTED.migration, 'sql81');
  assert.equal(COMMITTED.execute, false);
  assert.equal(COMMITTED.authorization, 'pending');
  assert.equal(COMMITTED.staging_acceptance.ok, false);
  assert.equal(COMMITTED.staging_acceptance.reference, null);
  assert.match(COMMITTED.staging_acceptance.basis, /^Pending: record the guarded staging SQL executor apply run of sql81-checkalt-depositor-register/);
  assert.ok(COMMITTED.staging_acceptance.basis.includes(STAGING_PIN.expected_live_definition_sha256.slice(0, 8)));
  assert.ok(COMMITTED.staging_acceptance.basis.includes(STAGING_PIN.intended_replacement_sha256.slice(0, 8)));
  for (const field of ['filename', 'migration_id', 'source_sha256', 'expected_live_definition_sha256', 'intended_replacement_sha256']) {
    assert.equal(COMMITTED[field], STAGING_PIN[field], field);
  }
  assert.equal(COMMITTED.staging_pin_commit, STAGING_PIN.commit);
  assert.equal(COMMITTED.function_identity, CHECKALT_REGISTER_FUNCTION);
  assert.equal(COMMITTED.table, 'public.checkalt_tenant_accounts');
  assert.equal(sha(fs.readFileSync(path.join(ROOT, COMMITTED.filename))), COMMITTED.source_sha256);
  assert.equal(COMMITTED.source_sha256, '88aafdacf83ea382e4b2f0c56da8d8c2048d36773ada18c49874e807cdbd8fbe');
  // Pre-state: the function absent (the same fingerprint as staging).
  assert.equal(COMMITTED.expected_live_definition_sha256, sha(checkaltRegisterStateText(CHECKALT_REGISTER_PRE_STATE)));
  assert.equal(COMMITTED.expected_live_definition_sha256, 'e12fdf2fe609d474a9cc215c018cce922cc2a63edfd18f7b5988ce21d1903f37');
  // Post-state: the staging applied state (EXECUTE for checksops and authenticated).
  assert.equal(COMMITTED.intended_replacement_sha256, sha(checkaltRegisterStateText(CHECKALT_REGISTER_APPLIED_STATE)));
  assert.equal(COMMITTED.intended_replacement_sha256, '36623ccebd920a9c6316da7f787ad99126e474656877e01b5854e099ce661225');
  const inspect = COMMITTED.production_inspect;
  assert.equal(inspect.status, 'pending');
  assert.equal(inspect.ssm_command_id, null);
  assert.equal(inspect.function_count, 0);
  assert.equal(inspect.table_owner, 'checksops_admin');
  assert.equal(inspect.table_acl, TABLE_ACL);
  // The table values are the ones the SQL 80 production apply read and left unchanged.
  assert.equal(inspect.table_acl, SQL80_PIN.applied.receipt.table_acl);
  assert.equal(SQL80_PIN.applied.receipt.table_acl_unchanged, true);
  assert.equal(inspect.table_owner, SQL80_PIN.production_inspect.table_owner);
  assert.ok(inspect.source.includes(SQL80_PIN.applied.apply_ssm_command_id));
  assert.equal(sql81FunctionOwner(COMMITTED), 'checksops_admin');
  assert.deepEqual(sql81OwnerRoles(COMMITTED), ['checksops_admin']);
  const post = COMMITTED.intended_post_state;
  assert.equal(post.function_owner, 'checksops_admin');
  assert.equal(post.function_acl, POST_FN_ACL);
  assert.equal(post.table_acl, inspect.table_acl);
  assert.equal(post.function_definition_sha256, CHECKALT_REGISTER_DEFINITION_SHA256.sql81);
  assert.equal(post.comment_sha256, CHECKALT_REGISTER_COMMENT_SHA256.sql81);
  assert.equal(REVIEWED_DEF81_SHA, CHECKALT_REGISTER_DEFINITION_SHA256.sql81);
  for (const field of ['rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(COMMITTED[field], SQL72_PIN[field], field);
  assert.match(COMMITTED.authorization_phrase, /^[A-Z_]{12,}$/);
  assert.notEqual(COMMITTED.authorization_phrase, SQL72_PIN.authorization_phrase);
  assert.notEqual(COMMITTED.authorization_phrase, SQL80_PIN.authorization_phrase);
  assert.equal(SQL81_PRODUCTION_PIN_REL, 'ops/deployment-guard/sql81-checkalt-production-register-production-apply.json');
});

const production = (overrides = {}) => ({
  current_user: 'checksops_admin',
  session_user: 'checksops_admin',
  function_present: false,
  function_acl: null,
  function_owner: null,
  function_acl_entries: [],
  function_acl_entries_with_grantor: [],
  table_present: true,
  table_acl: TABLE_ACL,
  table_owner: 'checksops_admin',
  table_acl_entries_with_grantor: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'].map((p) => `checksops ${p} granted by checksops_admin`),
  table_write_entries: ['checksops INSERT', 'checksops UPDATE'],
  table_grant_option: false,
  column_write_entries: [],
  authenticated_can_write: false,
  authenticated_member_of_checksops: false,
  owner_roles: ['checksops_admin'],
  authenticated_member_of_owner: false,
  ...overrides,
});
const pre = (overrides = {}) => ({
  exists: false,
  overload_count: 0,
  security_definer: false,
  config_as_reviewed: false,
  owner_is_executor: false,
  function_states: { definition: 'absent', comment: 'absent' },
  function_definition_sha256: null,
  acl_as_expected: false,
  required_roles_present: true,
  required_tables_present: true,
  required_functions_present: true,
  required_columns_present: true,
  table_update_granted: true,
  table_insert_granted: true,
  live_definition_sha256: COMMITTED.expected_live_definition_sha256,
  production: production(),
  ...overrides,
});
const postProduction = (overrides = {}) => production({
  function_present: true,
  function_acl: POST_FN_ACL,
  function_owner: 'checksops_admin',
  function_acl_entries: ['authenticated EXECUTE', 'checksops EXECUTE'],
  function_acl_entries_with_grantor: ['authenticated EXECUTE granted by checksops_admin', 'checksops EXECUTE granted by checksops_admin'],
  ...overrides,
});
const post = (overrides = {}) => pre({
  exists: true,
  overload_count: 1,
  security_definer: true,
  config_as_reviewed: true,
  owner_is_executor: true,
  function_states: { definition: 'intended', comment: 'intended' },
  function_definition_sha256: CHECKALT_REGISTER_DEFINITION_SHA256.sql81,
  live_definition_sha256: COMMITTED.intended_replacement_sha256,
  acl_as_expected: true,
  production: postProduction(),
  ...overrides,
});

test('the production rules accept only the absent pre-state on the pinned table and the reviewed post-state', () => {
  assert.deepEqual(sql81ProductionPreconditionFailures(pre(), COMMITTED), []);
  const refusedPre = [
    [{ exists: true }, 'function_absent'],
    [{ production: production({ function_present: true }) }, 'function_absent'],
    [{ overload_count: 1 }, 'no_function_named'],
    [{ function_states: { definition: 'other', comment: 'none' } }, 'definition_absent'],
    // The login must be the pinned owner (it then owns the new function).
    [{ production: production({ current_user: 'checksops' }) }, 'login_is_pinned_owner'],
    [{ production: production({ session_user: 'ubuntu' }) }, 'login_is_pinned_owner'],
    [{ production: production({ current_user: null }) }, 'login_is_pinned_owner'],
    [{ required_roles_present: false }, 'required_roles_present'],
    [{ required_tables_present: false }, 'required_tables_present'],
    [{ required_functions_present: false }, 'required_functions_present'],
    [{ required_columns_present: false }, 'required_columns_present'],
    [{ production: production({ table_acl: `${TABLE_ACL.slice(0, -1)},authenticated=r/checksops_admin}` }) }, 'table_acl_as_inspected'],
    [{ production: production({ table_owner: 'checksops' }) }, 'table_owner_as_inspected'],
    [{ production: production({ table_write_entries: ['authenticated INSERT', 'checksops INSERT', 'checksops UPDATE'] }) }, 'table_write_only_checksops'],
    [{ production: production({ table_write_entries: ['PUBLIC UPDATE', 'checksops INSERT', 'checksops UPDATE'] }) }, 'table_write_only_checksops'],
    [{ production: production({ table_write_entries: ['checksops INSERT', 'checksops UPDATE with grant option'] }) }, 'table_write_only_checksops'],
    [{ production: production({ table_write_entries: ['checksops UPDATE'] }) }, 'table_write_only_checksops'],
    [{ production: production({ table_grant_option: true }) }, 'no_table_grant_option'],
    [{ production: production({ column_write_entries: ['checkalt_tenant_accounts.email authenticated UPDATE'] }) }, 'no_column_write_grants'],
    [{ production: production({ authenticated_can_write: true }) }, 'authenticated_cannot_write_table'],
    [{ production: production({ authenticated_member_of_checksops: true }) }, 'authenticated_not_member_of_checksops'],
    [{ production: production({ authenticated_member_of_owner: true }) }, 'authenticated_not_member_of_owner'],
    [{ production: production({ authenticated_member_of_owner: undefined }) }, 'authenticated_not_member_of_owner'],
    [{ production: production({ owner_roles: [] }) }, 'authenticated_not_member_of_owner'],
    [{ production: production({ owner_roles: ['checksops'] }) }, 'authenticated_not_member_of_owner'],
    [{ production: undefined }, 'table_acl_as_inspected'],
    [{ production: undefined }, 'login_is_pinned_owner'],
    [{ production: undefined }, 'function_absent'],
  ];
  for (const [overrides, name] of refusedPre) {
    assert.ok(sql81ProductionPreconditionFailures(pre(overrides), COMMITTED).includes(name), `${name}: ${JSON.stringify(overrides)}`);
  }
  // A pin without an inspected table or a pinned function owner is refused.
  assert.ok(sql81ProductionPreconditionFailures(pre(), { ...COMMITTED, production_inspect: undefined }).includes('table_acl_as_inspected'));
  const noOwner = { ...COMMITTED, intended_post_state: { ...COMMITTED.intended_post_state, function_owner: undefined } };
  assert.equal(sql81FunctionOwner(noOwner), null);
  assert.ok(sql81ProductionPreconditionFailures(pre(), noOwner).includes('login_is_pinned_owner'));
  assert.deepEqual(sql81OwnerRoles({ ...COMMITTED, production_inspect: undefined, intended_post_state: undefined }), []);

  assert.deepEqual(sql81ProductionPostconditionFailures(pre(), post(), COMMITTED, REVIEWED_DEF81_SHA), []);
  const refusedPost = [
    [{ live_definition_sha256: 'f'.repeat(64) }, 'intended_state'],
    [{ function_definition_sha256: 'f'.repeat(64) }, 'definition_is_reviewed_sql81'],
    [{ function_states: { definition: 'other', comment: 'intended' } }, 'definition_is_reviewed_sql81'],
    [{ function_states: { definition: 'intended', comment: 'none' } }, 'comment_is_sql81'],
    [{ exists: false }, 'function_present'],
    [{ overload_count: 2 }, 'no_overloads'],
    [{ security_definer: false }, 'security_definer'],
    [{ config_as_reviewed: false }, 'config_as_reviewed'],
    [{ owner_is_executor: false }, 'owner_is_session_user'],
    [{ production: postProduction({ function_owner: 'checksops' }) }, 'function_owner_as_pinned'],
    [{ production: postProduction({ function_acl_entries: ['PUBLIC EXECUTE', 'authenticated EXECUTE', 'checksops EXECUTE'] }) }, 'public_execute_revoked'],
    [{ production: postProduction({ function_acl_entries: ['PUBLIC EXECUTE', 'authenticated EXECUTE', 'checksops EXECUTE'] }) }, 'function_execute_checksops_and_authenticated_only'],
    [{ production: postProduction({ function_acl_entries: ['authenticated EXECUTE', 'checksops EXECUTE', 'other EXECUTE'] }) }, 'function_execute_checksops_and_authenticated_only'],
    [{ production: postProduction({ function_acl_entries: ['authenticated EXECUTE with grant option', 'checksops EXECUTE'] }) }, 'function_execute_checksops_and_authenticated_only'],
    [{ production: postProduction({ function_acl_entries: ['checksops EXECUTE'] }) }, 'function_execute_checksops_and_authenticated_only'],
    [{ production: postProduction({ function_acl: null }) }, 'function_acl_as_intended'],
    [{ production: postProduction({ function_acl: '{checksops_admin=X/checksops_admin,authenticated=X/checksops_admin,checksops=X/checksops_admin}' }) }, 'function_acl_as_intended'],
    [{ production: postProduction({ table_acl: '{x}' }) }, 'table_acl_unchanged'],
    [{ production: postProduction({ table_acl_entries_with_grantor: [] }) }, 'table_acl_unchanged'],
    [{ production: postProduction({ authenticated_can_write: true }) }, 'authenticated_cannot_write_table'],
    [{ production: postProduction({ authenticated_member_of_owner: true }) }, 'authenticated_not_member_of_owner'],
    [{ production: postProduction({ current_user: 'checksops' }) }, 'login_is_pinned_owner'],
  ];
  for (const [overrides, name] of refusedPost) {
    assert.ok(sql81ProductionPostconditionFailures(pre(), post(overrides), COMMITTED, REVIEWED_DEF81_SHA).includes(name), `${name}: ${JSON.stringify(overrides)}`);
  }
  // The reviewed definition is the one reconstructed from the pinned file.
  assert.ok(sql81ProductionPostconditionFailures(pre(), post(), COMMITTED, 'e'.repeat(64)).includes('definition_is_reviewed_sql81'));
  assert.ok(sql81ProductionPostconditionFailures(pre(), post(), COMMITTED, undefined).includes('definition_is_reviewed_sql81'));
});

test('the pinned file is exactly the reviewed statements; a tampered pin or file is refused', async () => {
  const sql = await readPinnedSql81(ROOT, COMMITTED);
  assert.equal(sql.ok, true, JSON.stringify(sql));
  assert.equal(sql.details.reviewed_definition_sha256, CHECKALT_REGISTER_DEFINITION_SHA256.sql81);
  for (const field of ['migration', 'filename', 'migration_id', 'source_sha256', 'function_identity', 'table', 'target_environment', 'target_component', 'deployment_type']) {
    const result = await readPinnedSql81(ROOT, { ...COMMITTED, [field]: 'other' });
    assert.equal(result.code, CODES.SQL_COLLISION, field);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql81-prod-tamper-'));
  try {
    for (const [label, text] of [
      ['grant public', SQL81_TEXT.replace('TO checksops, authenticated;', 'TO checksops, authenticated, PUBLIC;')],
      ['owner gate removed', SQL81_TEXT.replace('IF NOT public.is_platform_owner() THEN', 'IF false THEN')],
      ['extra statement', `${SQL81_TEXT}GRANT INSERT, UPDATE ON TABLE public.checkalt_tenant_accounts TO authenticated;\n`],
    ]) {
      const file = path.join(dir, COMMITTED.filename);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      const result = await readPinnedSql81(dir, COMMITTED);
      assert.equal(result.code, CODES.SOURCE_RECONCILIATION_REQUIRED, label);
      // The reviewed-text parse (the staging executor's) refuses it too.
      const parsed = executor.parseSql81(text);
      assert.ok(!parsed || parsed.outside !== executor.SQL81_NORMALIZED_STATEMENTS
        || sha(executor.sql81ReviewedFunctiondef(text)) !== CHECKALT_REGISTER_DEFINITION_SHA256.sql81, label);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('evaluation is bound to the exact pin, a recorded staging acceptance and the production gate', async () => {
  // The committed pin's staging acceptance is pending: any manifest reference is refused.
  const pending = await evaluateSql81ProductionApply(manifest(), { root: ROOT, pin: COMMITTED });
  assert.equal(pending.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const fromDisk = await evaluateSql81ProductionApply(manifest({ staging_acceptance: { ok: true, reference: STAGING_REF } }), { root: ROOT });
  assert.equal(fromDisk.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const okFalse = await evaluateSql81ProductionApply(manifest(), { root: ROOT, pin: { ...PIN, staging_acceptance: { ...PIN.staging_acceptance, ok: false } } });
  assert.equal(okFalse.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const allowed = await evaluateSql81ProductionApply(manifest(), { root: ROOT, pin: PIN });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details.sql81_production_apply_allowed, true);
  for (const field of ['filename', 'migration_id', 'source_sha256', 'expected_live_definition_sha256', 'intended_replacement_sha256', 'live_definition_sha256']) {
    const result = await evaluateSql81ProductionApply(manifest({ [field]: 'f'.repeat(64) }), { root: ROOT, pin: PIN });
    assert.equal(result.code, CODES.SQL_COLLISION, field);
  }
  // The intended hash is not a pre-state.
  const appliedHash = await evaluateSql81ProductionApply(manifest({ live_definition_sha256: PIN.intended_replacement_sha256 }), { root: ROOT, pin: PIN });
  assert.equal(appliedHash.code, CODES.SQL_COLLISION);
  const otherRef = await evaluateSql81ProductionApply(manifest({ staging_acceptance: { ok: true, reference: `${STAGING_REF}0` } }), { root: ROOT, pin: PIN });
  assert.equal(otherRef.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const otherApproval = await evaluateSql81ProductionApply(manifest({ approval: { approved: true, workstream_id: 'another' } }), { root: ROOT, pin: PIN });
  assert.equal(otherApproval.ok, false);
});

test('CLI with the committed (pending) pin refuses before the guard; without a receipt the guard refuses; neither connects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql81-prod-noreceipt-'));
  try {
    const input = path.join(dir, 'sql81.json');
    fs.writeFileSync(input, JSON.stringify(manifest()));
    for (const extra of [{ CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, {}]) {
      const result = spawnSync(process.execPath, [CLI, '--apply', '--input', input], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: dir, ...extra },
      });
      const out = `${result.stdout}${result.stderr}`;
      assert.notEqual(result.status, 0, out);
      assert.match(out, /PRODUCTION_APPROVAL_REQUIRED/);
      assert.doesNotMatch(out, /secretsmanager|ECONNREFUSED|rolled back/i);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // An execute-authorized pin with no receipt: the guard (its non-exiting form) stops it before
  // any connection, and the env flag does not bypass it.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sql81-prod-noreceipt-root-'));
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

test('CLI does not spend the receipt on a wrong phrase, execute false, a wrong owner, a reused id, a missing guard flag or arbitrary SQL', async () => {
  const owned = (filename = PIN.filename) => ({ ok: true, details: { receipt: { owned_components: [filename] } } });
  const argv = ['--apply'];
  const phrase = await runCli(argv, { input: manifest({ authorization_phrase: 'yes' }), deps: { pin: PIN, enforceScriptGuard: () => owned() } });
  assert.equal(phrase.spent, 0);
  assert.match(phrase.out, /PRODUCTION_APPROVAL_REQUIRED/);
  const notExecutable = await runCli(argv, { input: manifest(), deps: { pin: { ...PIN, execute: false }, enforceScriptGuard: () => owned() } });
  assert.equal(notExecutable.spent, 0);
  assert.match(notExecutable.out, /execute is not authorized/);
  // The committed pending pin stops before the guard is even asked.
  const committed = await runCli(argv, { input: manifest(), deps: { pin: COMMITTED, enforceScriptGuard: () => { throw new Error('guard-called'); } } });
  assert.equal(committed.spent, 0);
  assert.match(committed.out, /PRODUCTION_APPROVAL_REQUIRED/);
  assert.doesNotMatch(committed.out, /guard-called/);
  const wrongOwner = await runCli(argv, { input: manifest(), deps: { pin: PIN, enforceScriptGuard: () => owned('aws/workflows/sql/80_checkalt_member_auto_deposit.sql') } });
  assert.equal(wrongOwner.spent, 0);
  assert.match(wrongOwner.out, /RECEIPT_MISMATCH/);
  const reusedFile = consumedPath();
  fs.writeFileSync(reusedFile, JSON.stringify({ consumed: ['sql81-prod-reused-id'] }));
  const reused = await runCli(argv, { input: manifest({ one_use_id: 'sql81-prod-reused-id' }), deps: { pin: PIN, enforceScriptGuard: () => owned(), consumedPath: reusedFile } });
  assert.equal(reused.spent, 0);
  assert.match(reused.out, /RECEIPT_REUSED/);
  const noFlag = await runCli(argv, { env: {}, input: manifest(), deps: { pin: PIN, enforceScriptGuard: () => owned() } });
  assert.equal(noFlag.spent, 0);
  assert.match(noFlag.out, /blocked unless CHECKSOPS_DEPLOYMENT_GUARD_APPLY=1/);
  const arbitrary = await runCli(argv, { input: { ...manifest(), sql_text: 'GRANT INSERT ON public.checkalt_tenant_accounts TO authenticated' }, deps: { pin: PIN, enforceScriptGuard: () => owned() } });
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
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql81-prod-staging-receipt-'));
  const prodRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql81-prod-receipt-'));
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

test('apply refuses before connecting: the committed pending pin, no phrase, no single-use id, execute false, no staging acceptance', async () => {
  const run = (overrides, pin = PIN) => executeSql81ProductionApply(manifest(overrides), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() });
  assert.equal((await run({}, COMMITTED)).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await executeSql81ProductionApply(manifest(), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({}, { ...COMMITTED, staging_acceptance: PIN.staging_acceptance })).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await run({ authorization_phrase: 'yes' })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal((await run({ one_use_id: 'x' })).code, CODES.INVALID_MANIFEST);
  assert.equal((await run({}, { ...PIN, execute: false })).code, CODES.GUARD_APPLY_FORBIDDEN);
  assert.equal((await run({}, { ...PIN, authorization_phrase: '' })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // The authorized copy passes every check up to the connection.
  const authorized = await run({}).catch((error) => error);
  assert.match(String(authorized?.message || ''), /should-not-connect/);
});

// --- PostgreSQL ---------------------------------------------------------------

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const OWNER = 'a1000000-0000-4000-8000-0000000000f1';
const A_ADMIN = 'a1000000-0000-4000-8000-0000000000ad';

/** Builds production's pre-state (function absent, table owned by checksops_admin, checksops arwd). */
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
      sso_user_id text NOT NULL,
      deposit_account_number text NOT NULL,
      first_name text NOT NULL,
      last_name text NOT NULL,
      email text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      registered_at timestamptz,
      last_register_payload jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      auto_approve_enabled boolean NOT NULL DEFAULT false,
      auto_approve_max_cents integer);
    ALTER TABLE public.checkalt_tenant_accounts ENABLE ROW LEVEL SECURITY;
    -- Like production's checksops_admin: a non-superuser login that owns the table.
    CREATE ROLE checksops_admin LOGIN NOSUPERUSER;
    GRANT USAGE, CREATE ON SCHEMA public TO checksops_admin;
    GRANT USAGE ON SCHEMA auth TO checksops_admin;
    GRANT SELECT ON public.tenants, public.tenant_users, public.identity_accounts, public.user_roles TO checksops_admin;
    ALTER TABLE public.checkalt_tenant_accounts OWNER TO checksops_admin;
    REVOKE ALL ON TABLE public.checkalt_tenant_accounts FROM checksops, authenticated;
    INSERT INTO public.tenants (id, name) VALUES ('${TENANT_A}', 'A');
    INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES
      ('${OWNER}', 'checksopsadmin@gmail.com', 'active'), ('${A_ADMIN}', 'admin@a.example', 'active');
    INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ('${TENANT_A}', '${A_ADMIN}', 'admin');
  `);
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.checkalt_tenant_accounts TO checksops');
  } finally {
    await owner.end();
  }
  return { server, admin, connectAs };
}

// PostgreSQL 16 has no MAINTAIN privilege ('m', new in 17), so the owner's own table
// entry reads arwdDxt there; production (18.3) reads arwdDxtm. The PostgreSQL 16
// fixture therefore pins the 16 spelling of the same ACL; on 18 the pin is used as is.
const PG16_TABLE_ACL = TABLE_ACL.replace('arwdDxtm/', 'arwdDxt/');
const pinFor = (bin) => (bin ? PIN : {
  ...PIN,
  production_inspect: { ...PIN.production_inspect, table_acl: PG16_TABLE_ACL },
  intended_post_state: { ...PIN.intended_post_state, table_acl: PG16_TABLE_ACL },
});

const PG_VERSIONS = [
  { label: 'PostgreSQL 16', bin: null, port: 56500 },
  ...(process.env.SQL81_PG18_BIN ? [{ label: 'PostgreSQL 18', bin: process.env.SQL81_PG18_BIN, port: 56600 }] : []),
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
    const { server, admin, connectAs } = await productionFixture(pg, 'pg-sql81-prod-', version.port, version.bin);
    const fixturePin = pinFor(version.bin);
    const tableAcl = fixturePin.production_inspect.table_acl;
    try {
      const catalog = async () => (await admin.query(`
        SELECT to_regprocedure('${FN}') IS NOT NULL AS present,
          (SELECT count(*)::int FROM pg_proc WHERE proname = 'aws_register_checkalt_tenant_account') AS named,
          (SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure('${FN}')) AS fn_acl,
          (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = to_regprocedure('${FN}')) AS fn_owner,
          (SELECT obj_description(to_regprocedure('${FN}'), 'pg_proc')) AS comment,
          (SELECT encode(sha256(convert_to(pg_get_functiondef(to_regprocedure('${FN}')), 'UTF8')), 'hex')) AS def_sha,
          (SELECT relacl::text FROM pg_class WHERE oid = 'public.checkalt_tenant_accounts'::regclass) AS table_acl`)).rows[0];
      const start = await catalog();
      assert.deepEqual(start, { present: false, named: 0, fn_acl: null, fn_owner: null, comment: null, def_sha: null, table_acl: tableAcl });

      const seen = [];
      const connectWith = (user) => async () => {
        const client = await connectAs(user);
        const query = client.query.bind(client);
        client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
        return client;
      };
      const connect = connectWith('checksops_admin');
      const inspect = (c = connect) => inspectSql81Production({ connect: c, pin: fixturePin, root: ROOT });
      const before = await inspect();
      assert.equal(before.ok, true, JSON.stringify(before));
      const b = before.details;
      assert.equal(b.live_definition_sha256, COMMITTED.expected_live_definition_sha256, JSON.stringify(b));
      assert.equal(b.live_matches_expected, true);
      assert.deepEqual(b.precondition_failures, []);
      assert.equal(b.apply_preconditions_met, true);
      assert.equal(b.already_applied, false);
      assert.equal(b.function_present, false);
      assert.deepEqual(b.state.function_states, { definition: 'absent', comment: 'absent' });
      // Readable login, ACLs and owners, not only hashes.
      assert.equal(b.current_user, 'checksops_admin');
      assert.equal(b.session_user, 'checksops_admin');
      assert.equal(b.function_acl, null);
      assert.deepEqual(b.function_acl_entries, []);
      assert.equal(b.table_acl, tableAcl);
      assert.equal(b.table_owner, 'checksops_admin');
      assert.deepEqual(b.table_acl_entries, ['checksops DELETE granted by checksops_admin', 'checksops INSERT granted by checksops_admin', 'checksops SELECT granted by checksops_admin', 'checksops UPDATE granted by checksops_admin']);
      assert.deepEqual(b.table_write_entries, ['checksops INSERT', 'checksops UPDATE']);
      assert.deepEqual(b.column_write_entries, []);
      assert.equal(b.authenticated_can_write_table, false);
      assert.equal(b.authenticated_member_of_checksops, false);
      assert.deepEqual(b.owner_roles, ['checksops_admin']);
      assert.equal(b.authenticated_member_of_owner, false);
      assert.equal(seen[0], 'BEGIN READ ONLY');
      assert.equal(seen.at(-1), 'ROLLBACK');
      assert.ok(seen.slice(1, -1).every((text) => /^\s*(SELECT|WITH|SAVEPOINT|RELEASE)\b/i.test(text)), JSON.stringify(seen));

      // Another login (here the superuser) would own the new function: refused.
      const asSuperuser = await inspect(connectWith('ubuntu'));
      assert.deepEqual(asSuperuser.details.precondition_failures, ['login_is_pinned_owner']);
      assert.equal(asSuperuser.details.apply_preconditions_met, false);
      const superApply = await executeSql81ProductionApply(manifest(), { root: ROOT, pin: fixturePin, connect: connectWith('ubuntu'), consumedPath: consumedPath() });
      assert.equal(superApply.code, CODES.DEPLOYMENT_COLLISION);
      assert.deepEqual(superApply.details.failed, ['login_is_pinned_owner']);

      const apply = (overrides = {}, ctx = {}) => executeSql81ProductionApply(manifest(overrides), { root: ROOT, pin: fixturePin, connect, consumedPath: consumedPath(), ...ctx });
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
        'CREATE FUNCTION public.aws_register_checkalt_tenant_account(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$',
        'DROP FUNCTION public.aws_register_checkalt_tenant_account(uuid)', 'ubuntu', ['no_function_named']);
      await refusedThenRestored('the same signature in another schema',
        'CREATE FUNCTION auth.aws_register_checkalt_tenant_account(uuid, jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$',
        'DROP FUNCTION auth.aws_register_checkalt_tenant_account(uuid, jsonb)', 'ubuntu', ['no_function_named']);
      await refusedThenRestored('table INSERT for authenticated', 'GRANT INSERT ON public.checkalt_tenant_accounts TO authenticated', 'REVOKE INSERT ON public.checkalt_tenant_accounts FROM authenticated', 'checksops_admin');
      await refusedThenRestored('table UPDATE for PUBLIC', 'GRANT UPDATE ON public.checkalt_tenant_accounts TO PUBLIC', 'REVOKE UPDATE ON public.checkalt_tenant_accounts FROM PUBLIC', 'checksops_admin');
      await refusedThenRestored('table grant option', 'GRANT INSERT ON public.checkalt_tenant_accounts TO checksops WITH GRANT OPTION', 'REVOKE GRANT OPTION FOR INSERT ON public.checkalt_tenant_accounts FROM checksops', 'checksops_admin');
      await refusedThenRestored('column UPDATE', 'GRANT UPDATE (deposit_account_number) ON public.checkalt_tenant_accounts TO authenticated', 'REVOKE UPDATE (deposit_account_number) ON public.checkalt_tenant_accounts FROM authenticated', 'checksops_admin');
      await refusedThenRestored('table SELECT for authenticated', 'GRANT SELECT ON public.checkalt_tenant_accounts TO authenticated', 'REVOKE SELECT ON public.checkalt_tenant_accounts FROM authenticated', 'checksops_admin', ['table_acl_as_inspected']);
      await refusedThenRestored('a missing column', 'ALTER TABLE public.checkalt_tenant_accounts RENAME COLUMN sso_user_id TO sso', 'ALTER TABLE public.checkalt_tenant_accounts RENAME COLUMN sso TO sso_user_id', 'ubuntu', ['required_columns_present']);
      // authenticated in the owner role, even through an INHERIT FALSE grant and an intermediate role.
      await refusedThenRestored('authenticated in the owner (INHERIT FALSE)',
        'GRANT checksops_admin TO authenticated WITH INHERIT FALSE', 'REVOKE checksops_admin FROM authenticated', 'ubuntu', ['authenticated_not_member_of_owner']);
      await refusedThenRestored('authenticated in the owner through another role (INHERIT FALSE)',
        'CREATE ROLE sql81_mid NOLOGIN; GRANT checksops_admin TO sql81_mid WITH INHERIT FALSE; GRANT sql81_mid TO authenticated WITH INHERIT FALSE',
        'REVOKE sql81_mid FROM authenticated; REVOKE checksops_admin FROM sql81_mid; DROP ROLE sql81_mid',
        'ubuntu', ['authenticated_not_member_of_owner']);
      assert.deepEqual(await catalog(), start);

      // A file that would also leave PUBLIC EXECUTE is rolled back at the postconditions.
      const sneaky = async () => {
        const client = await connect();
        const query = client.query.bind(client);
        client.query = (sql, params) => (String(sql) === SQL81_TEXT
          ? query(`${sql}\nGRANT EXECUTE ON FUNCTION ${FN} TO PUBLIC;`, params)
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
        client.query = (sql, params) => (String(sql) === SQL81_TEXT
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
      const applied = await executeSql81ProductionApply(input, { root: ROOT, pin: fixturePin, connect, consumedPath: consumed });
      assert.equal(applied.ok, true, JSON.stringify(applied));
      assert.equal(applied.details.receipt.before_hash, COMMITTED.expected_live_definition_sha256);
      assert.equal(applied.details.receipt.after_hash, COMMITTED.intended_replacement_sha256);
      assert.equal(applied.details.receipt.function_owner, 'checksops_admin');
      assert.equal(applied.details.receipt.function_acl_after, POST_FN_ACL);
      assert.equal(applied.details.receipt.table_acl, tableAcl);

      const end = await catalog();
      assert.equal(end.present, true);
      assert.equal(end.named, 1);
      assert.equal(end.fn_acl, COMMITTED.intended_post_state.function_acl);
      assert.equal(end.fn_owner, COMMITTED.intended_post_state.function_owner);
      assert.equal(end.table_acl, start.table_acl);
      assert.equal(end.def_sha, CHECKALT_REGISTER_DEFINITION_SHA256.sql81);
      assert.equal(end.def_sha, REVIEWED_DEF81_SHA);
      assert.equal(sha(end.comment), CHECKALT_REGISTER_COMMENT_SHA256.sql81);
      const after = await inspect();
      assert.equal(after.details.live_definition_sha256, COMMITTED.intended_replacement_sha256);
      assert.equal(after.details.live_definition_sha256, STAGING_PIN.intended_replacement_sha256);
      assert.equal(after.details.already_applied, true);
      assert.equal(after.details.apply_preconditions_met, false);
      assert.deepEqual(after.details.function_acl_entries, ['authenticated EXECUTE granted by checksops_admin', 'checksops EXECUTE granted by checksops_admin']);
      assert.equal(after.details.authenticated_can_write_table, false);

      const replay = await executeSql81ProductionApply(input, { root: ROOT, pin: fixturePin, connect, consumedPath: consumed });
      assert.equal(replay.code, CODES.RECEIPT_REUSED);
      const reapply = await apply();
      assert.equal(reapply.code, CODES.UNRELATED_MUTATION);
      assert.match(reapply.message, /already in place/);

      // Behavior: checksops and authenticated can call it, PUBLIC cannot; only the platform owner registers.
      const privileges = (await admin.query(`
        SELECT has_function_privilege('authenticated', '${FN}', 'EXECUTE') AS authenticated,
          has_function_privilege('checksops', '${FN}', 'EXECUTE') AS checksops,
          EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = '${FN}'::regprocedure AND a.grantee = 0) AS public`)).rows[0];
      assert.deepEqual(privileges, { authenticated: true, checksops: true, public: false });
      const register = async (user, account) => {
        await admin.query('BEGIN');
        try {
          await admin.query('SET LOCAL ROLE checksops');
          await admin.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
          const { rows } = await admin.query('SELECT public.aws_register_checkalt_tenant_account($1::uuid, $2::jsonb) AS r', [TENANT_A, JSON.stringify(account)]);
          await admin.query('COMMIT');
          return rows[0].r;
        } catch (error) {
          await admin.query('ROLLBACK');
          return { error: error.message };
        }
      };
      const account = { sso_user_id: 'dep-1', first_name: 'A', last_name: 'B', email: 'a@b.example', deposit_account_number: '123456789' };
      assert.equal((await register(A_ADMIN, account)).error, 'not_authorized');
      const registered = await register(OWNER, account);
      assert.equal(registered.account_last4, '6789', JSON.stringify(registered));
      assert.equal(JSON.stringify(registered).includes('123456789'), false);
    } finally {
      await admin.end();
      server.stop();
    }
  });
}

test('PostgreSQL 16: a statement failing inside the apply transaction leaves the function absent', { timeout: 180000 }, async (t) => {
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
  const { server, admin, connectAs } = await productionFixture(pg, 'pg-sql81-prod-rb-', 56700);
  const fixturePin = pinFor(null);
  try {
    const connect = async () => {
      const client = await connectAs('checksops_admin');
      const query = client.query.bind(client);
      client.query = (sql, params) => (String(sql) === SQL81_TEXT
        ? query(String(sql).replace('TO checksops, authenticated;', 'TO checksops, sql81_missing_role;'), params)
        : query(sql, params));
      return client;
    };
    const result = await executeSql81ProductionApply(manifest(), { root: ROOT, pin: fixturePin, connect, consumedPath: consumedPath() });
    assert.equal(result.code, CODES.SQL_COLLISION, JSON.stringify(result));
    assert.match(result.message, /rolled back/);
    const row = (await admin.query(`SELECT to_regprocedure('${FN}') AS p,
      (SELECT count(*)::int FROM pg_proc WHERE proname = 'aws_register_checkalt_tenant_account') AS n`)).rows[0];
    assert.deepEqual(row, { p: null, n: 0 });
  } finally {
    await admin.end();
    server.stop();
  }
});
