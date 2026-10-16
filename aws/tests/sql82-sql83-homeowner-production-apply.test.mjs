/**
 * Production apply path for SQL 82 (homeowner ledger view) and SQL 83 (homeowner
 * signing capabilities), each its own tool and pin.
 *
 * Both committed pins are pending: execute false, no staging acceptance and no
 * recorded pre-state (expected_live_definition_sha256 null), so evaluate and apply
 * refuse. The apply tests use an execute-authorized copy with a placeholder
 * staging acceptance and, against PostgreSQL, the pre-state the real inspect read.
 * The PostgreSQL fixture is production-like: tables owned by the non-superuser
 * login checksops_admin, Cursor SQL 73's ledger view in place (SQL 82 replaces
 * it) and the SQL 83 doorways absent (SQL 83 creates them).
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
  AUTHORIZED_SQL82_HOMEOWNER_LEDGER_VIEW,
  AUTHORIZED_SQL83_HOMEOWNER_SIGNING_CAPABILITIES,
  HOMEOWNER_DEFINITION_SHA256,
  HOMEOWNER_MIGRATIONS,
} from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { homeownerIntendedFunctionAcl } from '../../scripts/deployment-guard/lib/homeowner-sql-production-apply.mjs';
import * as sql82 from '../../scripts/deployment-guard/lib/sql82-homeowner-ledger-production-apply.mjs';
import * as sql83 from '../../scripts/deployment-guard/lib/sql83-homeowner-signing-production-apply.mjs';
import { ONE_SHOT_TOOLS } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { loadStagingSqlExecutor } from '../../scripts/deployment-guard/lib/staging-sql-executor-module.mjs';
import { main as cli82 } from '../../scripts/deployment-guard/sql82-homeowner-ledger-production-apply.mjs';
import { main as cli83 } from '../../scripts/deployment-guard/sql83-homeowner-signing-production-apply.mjs';
import { cursorSql73, homeownerSchemaSql } from './helpers/homeowner-sql-pg.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const COMMIT = 'a'.repeat(40);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const FIXTURE_PRE = 'e'.repeat(64);
const executor = await loadStagingSqlExecutor(ROOT);
const SQL81_PIN = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/sql81-checkalt-production-register-production-apply.json'), 'utf8'));

const M = {
  sql82: {
    lib: sql82,
    cli: cli82,
    script: 'scripts/deployment-guard/sql82-homeowner-ledger-production-apply.mjs',
    staging: AUTHORIZED_SQL82_HOMEOWNER_LEDGER_VIEW,
    evaluate: sql82.evaluateSql82ProductionApply,
    execute: sql82.executeSql82ProductionApply,
    inspect: sql82.inspectSql82Production,
    readPinned: sql82.readPinnedSql82,
    pre: sql82.sql82ProductionPreconditionFailures,
    post: sql82.sql82ProductionPostconditionFailures,
    committed: sql82.loadSql82ProductionPin(ROOT),
    pinRel: 'ops/deployment-guard/sql82-homeowner-ledger-view-production-apply.json',
    phrase: 'REPLACE_HOMEOWNER_LEDGER_VIEW',
    allowed: 'sql82_production_apply_allowed',
  },
  sql83: {
    lib: sql83,
    cli: cli83,
    script: 'scripts/deployment-guard/sql83-homeowner-signing-production-apply.mjs',
    staging: AUTHORIZED_SQL83_HOMEOWNER_SIGNING_CAPABILITIES,
    evaluate: sql83.evaluateSql83ProductionApply,
    execute: sql83.executeSql83ProductionApply,
    inspect: sql83.inspectSql83Production,
    readPinned: sql83.readPinnedSql83,
    pre: sql83.sql83ProductionPreconditionFailures,
    post: sql83.sql83ProductionPostconditionFailures,
    committed: sql83.loadSql83ProductionPin(ROOT),
    pinRel: 'ops/deployment-guard/sql83-homeowner-signing-capabilities-production-apply.json',
    phrase: 'REPLACE_HOMEOWNER_SIGNING_CAPABILITIES',
    allowed: 'sql83_production_apply_allowed',
  },
};
const KEYS = Object.keys(M);
/** Execute-authorized copy with a placeholder staging acceptance and pre-state. */
const authorized = (key, extra = {}) => Object.freeze({
  ...M[key].committed,
  execute: true,
  expected_live_definition_sha256: FIXTURE_PRE,
  staging_acceptance: { ...M[key].committed.staging_acceptance, ok: true, reference: STAGING_REF, basis: 'test fixture' },
  ...extra,
});
const TEXT = Object.fromEntries(KEYS.map((key) => [key, fs.readFileSync(path.join(ROOT, M[key].committed.filename), 'utf8')]));
const REVIEWED = Object.fromEntries(KEYS.map((key) => [key, Object.fromEntries(Object.entries(executor.homeownerReviewedFunctiondefs(key, TEXT[key]))
  .map(([identity, def]) => [identity, sha(def)]))]));

function manifest(key, pin, overrides = {}) {
  const fingerprint = { sql: pin.expected_live_definition_sha256 };
  const workstream = `prod-${key}-homeowner-test`;
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
const consumedPath = () => path.join(os.tmpdir(), `sql8283-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
const neverConnect = async () => { throw new Error('should-not-connect'); };

async function runCli(key, argv, { env = { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, input, deps = {} } = {}) {
  let file = null;
  if (input) {
    file = path.join(os.tmpdir(), `sql8283-prod-input-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
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

test('production pins: pending, execute false, no recorded pre-state, the staging post-state, production RDS, one-shot registered', () => {
  for (const key of KEYS) {
    const { committed: pin, staging } = M[key];
    assert.equal(pin.migration, key);
    assert.equal(pin.authorization, 'pending');
    assert.equal(pin.execute, false);
    assert.equal(pin.expected_live_definition_sha256, null, 'placeholder pending the first inspect');
    assert.equal(pin.production_inspect.status, 'pending');
    assert.equal(pin.production_inspect.live_definition_sha256, null);
    assert.equal(pin.staging_acceptance.ok, false);
    assert.equal(pin.staging_acceptance.reference, null);
    assert.deepEqual(pin.predecessors, []);
    for (const field of ['filename', 'migration_id', 'source_sha256', 'intended_replacement_sha256']) assert.equal(pin[field], staging[field], `${key} ${field}`);
    assert.equal(pin.staging_pin_commit, staging.commit);
    assert.deepEqual(pin.function_identities, [...staging.function_identities]);
    assert.equal(sha(fs.readFileSync(path.join(ROOT, pin.filename))), pin.source_sha256);
    for (const fn of HOMEOWNER_MIGRATIONS[key].functions) {
      assert.equal(pin.intended_post_state.function_definition_sha256[fn.name], HOMEOWNER_DEFINITION_SHA256[fn.identity], fn.name);
      assert.equal(REVIEWED[key][fn.identity], HOMEOWNER_DEFINITION_SHA256[fn.identity], fn.name);
    }
    assert.equal(pin.intended_post_state.function_owner, 'checksops_admin');
    assert.equal(pin.intended_post_state.function_acl, '{checksops_admin=X/checksops_admin,checksops=X/checksops_admin}');
    assert.equal(homeownerIntendedFunctionAcl(pin), pin.intended_post_state.function_acl);
    for (const field of ['rds_identifier', 'rds_host', 'admin_secret_arn']) assert.equal(pin[field], SQL81_PIN[field], field);
    assert.equal(pin.authorization_phrase, M[key].phrase);
    assert.notEqual(pin.authorization_phrase, SQL81_PIN.authorization_phrase);
    assert.equal(M[key].lib[`SQL${key.slice(3)}_PRODUCTION_PIN_REL`], M[key].pinRel);
    assert.deepEqual(ONE_SHOT_TOOLS[key], { key, script: M[key].script, args: [], pin_rel: M[key].pinRel, allowed_key: M[key].allowed });
  }
  assert.notEqual(M.sql82.phrase, M.sql83.phrase);
  assert.match(M.sql82.committed.order_note, /before SQL 83/);
});

test('both tools are inventoried as GUARDED and their tests run in test:deployment-guard and the deployment-guard workflow', () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/bypass-inventory.json'), 'utf8'));
  const rows = JSON.stringify(inventory);
  for (const key of KEYS) {
    assert.ok(rows.includes(`"path":"${M[key].script}","classification":"GUARDED"`), M[key].script);
    assert.ok(fs.existsSync(path.join(ROOT, M[key].script)), M[key].script);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deployment-guard.yml'), 'utf8');
  for (const file of ['aws/tests/sql82-sql83-homeowner-executor.test.mjs', 'aws/tests/sql82-sql83-homeowner-production-apply.test.mjs']) {
    assert.ok(pkg.scripts['test:deployment-guard'].includes(file), file);
    assert.ok(workflow.includes(file), file);
  }
});

// --- the production rules (synthetic states) ----------------------------------------

const fnRow = (key, fn, overrides = {}) => ({
  identity: fn.identity,
  exists: true,
  overload_count: 1,
  named_signatures: [],
  arguments: fn.arguments,
  argument_names: [...fn.arg_names],
  result: 'jsonb',
  kind: 'f',
  returns_set: false,
  security_definer: true,
  config: [...fn.config],
  owner: 'checksops_admin',
  owner_is_executor: true,
  owner_rolsuper: false,
  owner_rolbypassrls: false,
  proacl: '{checksops_admin=X/checksops_admin,checksops=X/checksops_admin}',
  acl_entries: ['checksops EXECUTE'],
  definition_sha256: HOMEOWNER_DEFINITION_SHA256[fn.identity],
  matches_migration: true,
  ...overrides,
});
const stateFor = (key, { fns = {}, ...overrides } = {}) => ({
  migration: key,
  current_user: 'checksops_admin',
  session_user: 'checksops_admin',
  required_roles_present: true,
  required_tables_present: true,
  required_columns_present: true,
  row_security_off_supported: true,
  functions: Object.fromEntries(HOMEOWNER_MIGRATIONS[key].functions.map((fn) => [fn.name, fnRow(key, fn, fns[fn.name])])),
  row_security: Object.fromEntries(HOMEOWNER_MIGRATIONS[key].functions.map((fn) => [fn.name, { rls_tables_not_bypassed: [] }])),
  production: { owner_roles: ['checksops_admin'], authenticated_member_of_owner: false },
  live_definition_sha256: M[key].committed.intended_replacement_sha256,
  ...overrides,
});
const preState = (key, overrides = {}) => stateFor(key, {
  live_definition_sha256: FIXTURE_PRE,
  ...overrides,
  fns: Object.fromEntries(HOMEOWNER_MIGRATIONS[key].functions.map((fn) => [fn.name, {
    matches_migration: false, definition_sha256: 'd'.repeat(64), acl_entries: ['authenticated EXECUTE', 'checksops EXECUTE'], ...(overrides.fns?.[fn.name] || {}),
  }])),
});

test('the production rules: replace safely as the pinned owner before; exactly the reviewed functions and owner + checksops EXECUTE after', () => {
  for (const key of KEYS) {
    const pin = authorized(key);
    const name = HOMEOWNER_MIGRATIONS[key].functions[0].name;
    assert.deepEqual(M[key].pre(preState(key), pin, executor), [], key);
    // New functions (absent) are fine too: the login will own them.
    assert.deepEqual(M[key].pre(preState(key, { fns: { [name]: { exists: false, overload_count: 0, owner: null, acl_entries: [] } } }), pin, executor), [], key);
    for (const [overrides, failure] of [
      [{ current_user: 'checksops' }, 'login_is_pinned_owner'],
      [{ session_user: 'ubuntu' }, 'login_is_pinned_owner'],
      [{ fns: { [name]: { owner: 'checksops' } } }, 'functions_owned_by_pinned_owner'],
      [{ fns: { [name]: { owner_is_executor: false } } }, `owner_is_login:${name}`],
      [{ production: { owner_roles: ['checksops_admin'], authenticated_member_of_owner: true } }, 'authenticated_not_member_of_owner'],
      [{ production: { owner_roles: ['checksops_admin'] } }, 'authenticated_not_member_of_owner'],
      [{ production: undefined }, 'authenticated_not_member_of_owner'],
      [{ fns: { [name]: { overload_count: 2 } } }, `no_other_signature:${name}`],
      [{ fns: { [name]: { result: 'json' } } }, `return_type_jsonb:${name}`],
      [{ fns: { [name]: { argument_names: ['token'] } } }, `argument_names_match:${name}`],
      [{ fns: { [name]: { kind: 'p' } } }, `replaceable_kind:${name}`],
      [{ fns: { [name]: { acl_entries: ['anon EXECUTE', 'checksops EXECUTE'] } } }, `acl_replaceable:${name}`],
      [{ required_columns_present: false }, 'required_columns_present'],
      [{ required_roles_present: false }, 'required_roles_present'],
    ]) {
      assert.ok(M[key].pre(preState(key, overrides), pin, executor).includes(failure), `${key} ${failure}: ${JSON.stringify(overrides)}`);
    }
    assert.ok(M[key].pre(preState(key), { ...pin, intended_post_state: undefined }, executor).includes('login_is_pinned_owner'));

    assert.deepEqual(M[key].post(stateFor(key), pin, REVIEWED[key], executor), [], key);
    for (const [overrides, failure] of [
      [{ live_definition_sha256: 'f'.repeat(64) }, 'intended_state'],
      [{ fns: { [name]: { definition_sha256: 'f'.repeat(64) } } }, `definition_is_reviewed:${name}`],
      [{ fns: { [name]: { matches_migration: false } } }, `definition_is_reviewed:${name}`],
      [{ fns: { [name]: { overload_count: 2 } } }, `no_overloads:${name}`],
      [{ fns: { [name]: { security_definer: false } } }, `security_definer:${name}`],
      [{ fns: { [name]: { config: ['search_path=public, pg_temp'] } } }, `config_as_reviewed:${name}`],
      [{ fns: { [name]: { acl_entries: ['authenticated EXECUTE', 'checksops EXECUTE'] } } }, `execute_checksops_only:${name}`],
      [{ fns: { [name]: { acl_entries: ['PUBLIC EXECUTE', 'checksops EXECUTE'] } } }, `public_execute_revoked:${name}`],
      [{ fns: { [name]: { acl_entries: ['checksops EXECUTE with grant option'] } } }, `execute_checksops_only:${name}`],
      [{ fns: { [name]: { proacl: '{checksops_admin=X/checksops_admin,checksops=X/other}' } } }, `function_acl_as_intended:${name}`],
      [{ fns: { [name]: { owner: 'other' } } }, 'functions_owned_by_pinned_owner'],
      [{ current_user: 'other' }, 'login_is_pinned_owner'],
    ]) {
      assert.ok(M[key].post(stateFor(key, overrides), pin, REVIEWED[key], executor).includes(failure), `${key} ${failure}`);
    }
    // The reviewed definitions are the ones reconstructed from the pinned file.
    const wrong = Object.fromEntries(Object.keys(REVIEWED[key]).map((identity) => [identity, 'e'.repeat(64)]));
    assert.ok(M[key].post(stateFor(key), pin, wrong, executor).includes(`definition_is_reviewed:${name}`));
  }
  // SQL 83 requires row_security=off to be supportable; SQL 82 does not.
  const blocked = { row_security: Object.fromEntries(HOMEOWNER_MIGRATIONS.sql83.functions.map((fn) => [fn.name, { rls_tables_not_bypassed: ['signature_signers'] }])) };
  assert.ok(M.sql83.pre(preState('sql83', blocked), authorized('sql83'), executor).includes('row_security_off_supported:aws_public_homeowner_pending_signatures'));
  assert.ok(M.sql83.post(stateFor('sql83', { row_security_off_supported: false }), authorized('sql83'), REVIEWED.sql83, executor).includes('row_security_off_supported'));
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql8283-prod-tamper-'));
    try {
      const file = path.join(dir, pin.filename);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${TEXT[key]}GRANT EXECUTE ON FUNCTION ${pin.function_identities[0]} TO authenticated;\n`);
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
    // The committed pin: no pre-state recorded (null), whatever the manifest says.
    const pending = await M[key].evaluate(manifest(key, authorized(key)), { root: ROOT });
    assert.equal(pending.code, CODES.SQL_COLLISION, key);
    assert.match(pending.message, /no recorded pre-apply live definition hash/);
    const nullManifest = await evaluate(manifest(key, committed), { ...committed, staging_acceptance: authorized(key).staging_acceptance });
    assert.equal(nullManifest.code, CODES.SQL_COLLISION, 'null == null is never a match');
    // Recorded pre-state but no staging acceptance.
    const noAcceptance = await evaluate(manifest(key, authorized(key)), { ...authorized(key), staging_acceptance: committed.staging_acceptance });
    assert.equal(noAcceptance.code, CODES.PRODUCTION_APPROVAL_REQUIRED, key);
    const allowed = await evaluate(manifest(key, authorized(key)), authorized(key));
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
    assert.equal(allowed.details[M[key].allowed], true);
    assert.equal(allowed.details.migration, key);
    for (const field of ['filename', 'migration_id', 'source_sha256', 'expected_live_definition_sha256', 'intended_replacement_sha256', 'live_definition_sha256']) {
      assert.equal((await evaluate(manifest(key, authorized(key), { [field]: 'f'.repeat(64) }), authorized(key))).code, CODES.SQL_COLLISION, field);
    }
    const appliedHash = await evaluate(manifest(key, authorized(key), { live_definition_sha256: committed.intended_replacement_sha256 }), authorized(key));
    assert.equal(appliedHash.code, CODES.SQL_COLLISION);
    const otherRef = await evaluate(manifest(key, authorized(key), { staging_acceptance: { ok: true, reference: `${STAGING_REF}0` } }), authorized(key));
    assert.equal(otherRef.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    const otherApproval = await evaluate(manifest(key, authorized(key), { approval: { approved: true, workstream_id: 'another' } }), authorized(key));
    assert.equal(otherApproval.ok, false);
    // One migration's manifest never evaluates under the other's pin.
    const other = key === 'sql82' ? 'sql83' : 'sql82';
    assert.equal((await evaluate(manifest(other, authorized(other)), authorized(key))).code, CODES.SQL_COLLISION);
  }
});

test('CLI with the committed (pending) pin refuses before the guard; without a receipt the guard refuses; neither connects', async () => {
  for (const key of KEYS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql8283-prod-noreceipt-'));
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
        assert.match(out, /SQL_COLLISION/);
        assert.match(out, /no recorded pre-apply live definition hash/);
        assert.doesNotMatch(out, /secretsmanager|ECONNREFUSED|rolled back/i);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sql8283-prod-noreceipt-root-'));
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
    assert.match(committed.out, /SQL_COLLISION/);
    assert.doesNotMatch(committed.out, /guard-called/);
    const wrongOwner = await runCli(key, argv, { input: manifest(key, pin), deps: { pin, enforceScriptGuard: () => owned('aws/workflows/sql/81_checkalt_production_register.sql') } });
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
    const arbitrary = await runCli(key, argv, { input: { ...manifest(key, pin), sql_text: 'DROP FUNCTION public.aws_public_homeowner_ledger_remint_signer(text, uuid)' }, deps: { pin, enforceScriptGuard: () => owned() } });
    assert.equal(arbitrary.spent, 0);
    assert.match(arbitrary.out, /arbitrary SQL text is forbidden/);
    for (const r of [phrase, notExecutable, committed, wrongOwner, reused, noFlag, arbitrary]) assert.doesNotMatch(r.out, /should-not-connect/);
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
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql8283-prod-staging-receipt-'));
    const prodRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sql8283-prod-receipt-'));
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

test('apply refuses before connecting: the committed pin, no phrase, no single-use id, execute false, no staging acceptance', async () => {
  for (const key of KEYS) {
    const run = (overrides, pin = authorized(key)) => M[key].execute(manifest(key, authorized(key), overrides), { root: ROOT, pin, connect: neverConnect, consumedPath: consumedPath() });
    assert.equal((await M[key].execute(manifest(key, authorized(key)), { root: ROOT, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.SQL_COLLISION);
    assert.equal((await run({}, { ...authorized(key), staging_acceptance: M[key].committed.staging_acceptance })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    assert.equal((await run({}, { ...authorized(key), execute: false })).code, CODES.GUARD_APPLY_FORBIDDEN);
    assert.equal((await run({ authorization_phrase: 'yes' })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    assert.equal((await run({ authorization_phrase: M[key === 'sql82' ? 'sql83' : 'sql82'].phrase })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    assert.equal((await run({ one_use_id: 'x' })).code, CODES.INVALID_MANIFEST);
    assert.equal((await run({}, { ...authorized(key), authorization_phrase: '' })).code, CODES.PRODUCTION_APPROVAL_REQUIRED);
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
  await admin.query(homeownerSchemaSql(PROD_OWNER));
  const owner = await connectAs(PROD_OWNER);
  try {
    // The ledger view exists (here Cursor SQL 73's body); the SQL 83 doorways do not.
    await owner.query(cursorSql73());
  } finally {
    await owner.end();
  }
  return { server, admin, connectAs };
}

test('PostgreSQL 16: production inspect is read-only and reports the state; SQL 82 replaces and SQL 83 creates exactly once; drift, a wrong login and collateral changes are refused', { timeout: 300000 }, async (t) => {
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
  const { server, admin, connectAs } = await productionFixture(pg, 'pg-sql8283-prod-', 57400);
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
      const spec = HOMEOWNER_MIGRATIONS[key];
      seen.length = 0;
      const first = await M[key].inspect({ connect, pin: M[key].committed, root: ROOT });
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
      assert.equal(d.session_user, PROD_OWNER);
      assert.equal(d.login_rolsuper, false);
      assert.equal(d.login_rolbypassrls, false);
      assert.deepEqual(d.owner_roles, [PROD_OWNER]);
      assert.equal(d.authenticated_member_of_owner, false);
      assert.equal(d.legacy_remint_signer.present, false);
      assert.deepEqual(d.missing_columns, {});
      assert.equal(d.tables.signature_signers.rls_enabled, true);
      assert.equal(d.tables.signature_signers.owner, PROD_OWNER);
      assert.equal(d.row_security_off_supported, true);
      assert.deepEqual(d.status_counts.check_endorsements.groups, [
        { payee_type: 'insured', status: 'sent', count: 2 }, { payee_type: 'mortgage_company', status: 'pending', count: 1 }]);
      assert.equal(d.status_constraints.check_endorsements.length, 2);
      assert.match(d.status_constraints.check_endorsements.find((row) => row.name === 'check_endorsements_status_check').definition, /'sent'::text/);
      assert.equal(JSON.stringify(d).includes('private@example.com'), false, 'no row data');
      if (key === 'sql82') {
        const row = d.functions.aws_public_homeowner_ledger_by_token;
        assert.equal(row.exists, true);
        assert.equal(row.owner, PROD_OWNER);
        assert.equal(row.security_definer, true);
        assert.deepEqual(row.config, ['search_path=public']);
        assert.equal(row.proacl, `{${PROD_OWNER}=X/${PROD_OWNER},checksops=X/${PROD_OWNER}}`);
        assert.deepEqual(row.acl_entries_with_grantor, [`checksops EXECUTE granted by ${PROD_OWNER}`]);
        assert.equal(row.matches_migration, false);
        assert.equal(row.body_matches_migration, false);
        assert.equal(d.ledger_view_raw_endorse_token_link, true);
        assert.deepEqual(d.function_states, { aws_public_homeowner_ledger_by_token: 'other' });
      } else {
        for (const fn of spec.functions) {
          assert.equal(d.functions[fn.name].exists, false, fn.name);
          assert.equal(d.functions[fn.name].proacl, null);
        }
        assert.deepEqual(Object.values(d.function_states), ['absent', 'absent', 'absent']);
        assert.equal('ledger_view_raw_endorse_token_link' in d, false);
      }

      // The pin change records the inspected pre-state (and the staging run).
      const pin = authorized(key, { expected_live_definition_sha256: d.live_definition_sha256 });
      const ready = await M[key].inspect({ connect, pin, root: ROOT });
      assert.equal(ready.details.apply_preconditions_met, true, JSON.stringify(ready.details.precondition_failures));
      assert.equal(ready.details.live_matches_expected, true);

      // Another login (the superuser) would own new functions or cannot replace another's: refused.
      const asSuperuser = await M[key].inspect({ connect: connectWith('ubuntu'), pin, root: ROOT });
      assert.ok(asSuperuser.details.precondition_failures.includes('login_is_pinned_owner'), JSON.stringify(asSuperuser.details.precondition_failures));
      const superApply = await M[key].execute(manifest(key, pin), { root: ROOT, pin, connect: connectWith('ubuntu'), consumedPath: consumedPath() });
      assert.equal(superApply.code, CODES.DEPLOYMENT_COLLISION);
      assert.ok(superApply.details.failed.includes('login_is_pinned_owner'));

      const apply = (overrides = {}, ctx = {}) => M[key].execute(manifest(key, pin, overrides), { root: ROOT, pin, connect, consumedPath: consumedPath(), ...ctx });
      const catalog = async () => (await admin.query(`SELECT p.oid::regprocedure::text AS sig, encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex') AS def,
        p.proacl::text AS acl, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.proname = ANY($1::text[]) ORDER BY 1`, [spec.functions.map((fn) => fn.name)])).rows;
      const start = await catalog();

      // authenticated in the owner role (INHERIT FALSE): refused at the precondition.
      await admin.query(`GRANT ${PROD_OWNER} TO authenticated WITH INHERIT FALSE`);
      const member = await apply();
      assert.equal(member.code, CODES.DEPLOYMENT_COLLISION);
      assert.ok(member.details.failed.includes('authenticated_not_member_of_owner'));
      await admin.query(`REVOKE ${PROD_OWNER} FROM authenticated`);

      // Collision: the live state moved after the recorded inspect.
      const owner = await connectAs(PROD_OWNER);
      await owner.query(`CREATE FUNCTION public.${spec.functions[0].name}(p_other uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT NULL::jsonb $$`);
      const drift = await apply();
      assert.equal(drift.code, CODES.DEPLOYMENT_COLLISION, JSON.stringify(drift));
      await owner.query(`DROP FUNCTION public.${spec.functions[0].name}(uuid)`);
      if (key === 'sql82') {
        await owner.query('GRANT EXECUTE ON FUNCTION public.aws_public_homeowner_ledger_by_token(text) TO authenticated');
        const grantDrift = await apply();
        assert.equal(grantDrift.code, CODES.DEPLOYMENT_COLLISION);
        assert.match(grantDrift.message, /not the pinned pre-apply state/);
        await owner.query('REVOKE EXECUTE ON FUNCTION public.aws_public_homeowner_ledger_by_token(text) FROM authenticated');
      }
      await owner.end();
      assert.deepEqual(await catalog(), start);

      // A file that would also leave PUBLIC EXECUTE, or touch something unrelated, rolls back.
      const wrap = (extra) => async () => {
        const client = await connect();
        const query = client.query.bind(client);
        client.query = (sql, params) => (String(sql) === TEXT[key] ? query(`${sql}\n${extra}`, params) : query(sql, params));
        return client;
      };
      const publicGrant = await apply({}, { connect: wrap(`GRANT EXECUTE ON FUNCTION ${spec.functions[0].identity} TO PUBLIC;`) });
      assert.equal(publicGrant.code, CODES.UNRELATED_MUTATION, JSON.stringify(publicGrant));
      assert.ok(publicGrant.details.failed.includes(`public_execute_revoked:${spec.functions[0].name}`));
      const unrelated = await apply({}, { connect: wrap('ALTER TABLE public.signature_signers DISABLE ROW LEVEL SECURITY;') });
      assert.equal(unrelated.code, CODES.UNRELATED_MUTATION, JSON.stringify(unrelated));
      assert.deepEqual(unrelated.details.unrelated_changed, ['relations']);
      const otherFunction = await apply({}, { connect: wrap('DROP FUNCTION IF EXISTS public.aws_public_homeowner_ledger_remint_signer(text, uuid); CREATE FUNCTION public.sql8283_extra() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;') });
      assert.equal(otherFunction.code, CODES.UNRELATED_MUTATION);
      assert.deepEqual(otherFunction.details.unrelated_changed, ['functions']);
      assert.deepEqual(await catalog(), start);
      assert.equal((await apply({ live_definition_sha256: 'f'.repeat(64) })).code, CODES.SQL_COLLISION);

      const consumed = consumedPath();
      const input = manifest(key, pin);
      const applied = await M[key].execute(input, { root: ROOT, pin, connect, consumedPath: consumed });
      assert.equal(applied.ok, true, JSON.stringify(applied));
      assert.equal(applied.details.receipt.before_hash, d.live_definition_sha256);
      assert.equal(applied.details.receipt.after_hash, pin.intended_replacement_sha256);
      assert.equal(applied.details.receipt.function_owner, PROD_OWNER);
      for (const fn of spec.functions) assert.equal(applied.details.receipt.function_acl_after[fn.name], pin.intended_post_state.function_acl);
      const end = await catalog();
      assert.deepEqual(end.map((row) => row.owner), spec.functions.map(() => PROD_OWNER));
      for (const row of end) {
        assert.equal(row.acl, pin.intended_post_state.function_acl);
        assert.ok(Object.values(HOMEOWNER_DEFINITION_SHA256).includes(row.def), row.sig);
      }
      const after = await M[key].inspect({ connect, pin, root: ROOT });
      assert.equal(after.details.live_definition_sha256, pin.intended_replacement_sha256);
      assert.equal(after.details.already_applied, true);
      assert.equal(after.details.apply_preconditions_met, false);
      for (const fn of spec.functions) {
        assert.equal(after.details.functions[fn.name].matches_migration, true);
        assert.equal(after.details.functions[fn.name].body_matches_migration, true);
        assert.deepEqual(after.details.functions[fn.name].acl_entries_with_grantor, [`checksops EXECUTE granted by ${PROD_OWNER}`]);
      }
      if (key === 'sql82') assert.equal(after.details.ledger_view_raw_endorse_token_link, false);
      assert.equal((await M[key].execute(input, { root: ROOT, pin, connect, consumedPath: consumed })).code, CODES.RECEIPT_REUSED);
      const reapply = await apply();
      assert.equal(reapply.code, CODES.UNRELATED_MUTATION);
      assert.match(reapply.message, /already in place/);
      // checksops can call every function; authenticated and PUBLIC cannot.
      for (const fn of spec.functions) {
        const privileges = (await admin.query(`SELECT has_function_privilege('checksops', $1, 'EXECUTE') AS checksops,
          has_function_privilege('authenticated', $1, 'EXECUTE') AS authenticated`, [fn.identity])).rows[0];
        assert.deepEqual(privileges, { checksops: true, authenticated: false }, fn.identity);
      }
    }
  } finally {
    await admin.end();
    server.stop();
  }
});
