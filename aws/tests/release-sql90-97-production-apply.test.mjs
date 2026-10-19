/**
 * Production apply tools for SQL 90 to SQL 97
 * (scripts/deployment-guard/sql9x-*-production-apply.mjs; lib release-sql-production-apply.mjs
 * and release-sql-production-cli.mjs), mirroring the SQL 29 / 30 / 88 / 89 tool tests:
 *
 *   - the committed pins are pending (authorization "pending", execute false, no pre-state,
 *     no staging acceptance; SQL 103's is applied and retired (execute false, applied
 *     recorded), and its locked-state checks run on an explicit pre-authorization copy), bound to the staging pins, the predecessors and the production
 *     RDS, and name the built tooling; the tools are inventoried and registered in the one-shot;
 *   - evaluate / precheck / apply refuse before connecting (no pre-state, no approval, the
 *     staging acceptance, execute false, the phrase, the single-use id, replay, binding);
 *   - the CLI refuses credential flags and arbitrary SQL, and never spends a receipt or
 *     connects on a refusal; a staging receipt cannot authorize production;
 *   - on PostgreSQL 16: --inspect is BEGIN READ ONLY ... ROLLBACK, prints no row data and
 *     changes nothing; execute-authorized copies apply once each as checksops_admin in the
 *     release order; the superuser login is refused; a file that changes anything outside
 *     its scope rolls back.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import { ONE_SHOT_TOOLS } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { refuseUnguardedDeploy } from '../../scripts/deployment-guard/require-guard.mjs';
import { RELEASE_2026_10_17_PENDING_SQL_PINS as STAGING } from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { RELEASE_SQL_KEYS, RELEASE_SQL_SPECS } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import {
  RELEASE_PRODUCTION,
  evaluateReleaseProductionApply,
  executeReleaseProductionApply,
  inspectReleaseProduction,
  loadReleaseProductionPin,
  precheckReleaseProductionApply,
  readPinnedReleaseSql,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLIS = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, RELEASE_PRODUCTION[key].cli)])));
const MAINS = Object.freeze(Object.fromEntries(await Promise.all(RELEASE_SQL_KEYS.map(async (key) => [key, (await import(CLIS[key])).main]))));
const COMMITTED = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, loadReleaseProductionPin(key, ROOT)])));
// SQL 91's and SQL 92's production pins are execute-authorized (owner approved 2026-10-19)
// until their record-and-retire changes. SQL 103's production pin was (owner approved
// 2026-10-19) until its record-and-retire change after the 2026-10-19 apply: it records the
// apply in applied and is execute false again (its own checks are in
// release-sql103-production-apply.test.mjs). Every other release pin is pending. The
// locked-state checks below run on an explicit pre-authorization copy of an execute-authorized
// or applied pin.
const EXECUTE_AUTHORIZED = Object.freeze(['sql91', 'sql92']);
// The staging acceptance each execute-authorized pin records (SQL 91: the guarded staging apply
// from the same pre-state; SQL 92: the owner-accepted substitute staging read-live).
const AUTHORIZED_STAGING_REFERENCE = Object.freeze({
  sql91: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39080306273',
  sql92: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39075498539',
});
const AUTHORIZED_PRODUCTION_PRE = Object.freeze({
  sql91: 'bdbc697f75e7a9c57c91c9ce12956800e92417a93acfbbaa0c2d1cf69542972e',
  sql92: '3cfbd32cde289775073221e99404b8b0ce82ff8d7e365cbf14d9e3e7fc6edb9f',
});
const APPLIED_RETIRED = Object.freeze(['sql103']);
const LOCKED = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, [...EXECUTE_AUTHORIZED, ...APPLIED_RETIRED].includes(key)
  ? Object.freeze({
    ...COMMITTED[key],
    authorization: 'pending',
    execute: false,
    expected_live_definition_sha256: null,
    staging_acceptance: { ok: false, reference: null, basis: 'Pending' },
    production_inspect: { ...COMMITTED[key].production_inspect, status: 'pending' },
  })
  : COMMITTED[key]])));
const ORDER = Object.freeze(['sql90', 'sql91', 'sql92', 'sql93', 'sql94', 'sql96', 'sql97', 'sql95']);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const COMMIT = 'a'.repeat(40);
const PRE = 'e'.repeat(64);
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const sha = (text) => createHash('sha256').update(text).digest('hex');

/** An execute-authorized copy with a recorded pre-state and staging acceptance (test only). */
const authorized = (key, live = PRE, extra = {}) => Object.freeze({
  ...COMMITTED[key],
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: live,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
  ...extra,
});

function manifest(key, pin, overrides = {}) {
  const live = pin.expected_live_definition_sha256;
  const fingerprint = { sql: live };
  const workstream = `prod-${key}-release-test`;
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
    expected_live_definition_sha256: live,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    live_definition_sha256: live,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: pin.staging_acceptance,
    approval: { approved: true, workstream_id: workstream },
    authorization_phrase: pin.authorization_phrase,
    one_use_id: `${key}-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-17T20:00:00.000Z',
    ...overrides,
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql9097-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
const neverConnect = async () => { throw new Error('should-not-connect'); };

async function runCli(key, argv, { env = { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, input, deps = {} } = {}) {
  let file = null;
  if (input) {
    file = path.join(os.tmpdir(), `sql9097-prod-input-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(input));
  }
  const writes = [];
  let spent = 0;
  const orig = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await MAINS[key](file ? [...argv, '--input', file] : argv, env, {
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

test('committed pins are pending (SQL 91 and SQL 92 execute-authorized, SQL 103 applied and retired), bound to the staging pins, predecessors and the production RDS, and name the built tooling', () => {
  const inventory = JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/bypass-inventory.json'), 'utf8')));
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => COMMITTED[key].execute !== false), [...EXECUTE_AUTHORIZED]);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => COMMITTED[key].applied !== undefined), [...APPLIED_RETIRED]);
  for (const key of RELEASE_SQL_KEYS) {
    const pin = COMMITTED[key];
    const staging = STAGING[key];
    assert.equal(pin.migration, key);
    if (APPLIED_RETIRED.includes(key)) {
      // Applied to production and retired: execute false, the apply recorded in applied.
      assert.equal(pin.execute, false, key);
      assert.match(pin.authorization, /^Applied to production on \d{4}-\d{2}-\d{2}; execute is false again/, key);
      assert.match(pin.expected_live_definition_sha256, /^[0-9a-f]{64}$/, key);
      assert.equal(pin.staging_acceptance.ok, true, key);
      assert.equal(pin.production_inspect.status, 'recorded', key);
      assert.equal(pin.applied.result, 'applied', key);
      assert.equal(pin.applied.receipt.before_hash, pin.expected_live_definition_sha256, key);
      assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256, key);
      assert.equal(pin.applied.post_apply_inspect.already_applied, true, key);
    } else if (EXECUTE_AUTHORIZED.includes(key)) {
      assert.equal(pin.execute, true, key);
      assert.match(pin.authorization, /^Owner approved /, key);
      assert.match(pin.expected_live_definition_sha256, /^[0-9a-f]{64}$/, key);
      assert.equal(pin.staging_acceptance.ok, true, key);
      assert.match(pin.staging_acceptance.reference, /^https:\/\/github\.com\/michaelcarletta-cmd\/ChecksOps\/actions\/runs\/\d+$/, key);
      assert.equal(pin.production_inspect.status, 'recorded', key);
      assert.equal(pin.production_inspect.live_definition_sha256, pin.expected_live_definition_sha256, key);
      // Owner approved 2026-10-19: the read-only production inspect of 2026-10-19 (main f51863bbd).
      assert.match(pin.authorization, /^Owner approved 2026-10-19 /, key);
      assert.ok(pin.authorization.includes('"open the SQL 91/92 one-shot and pin PRs and accept that evidence for SQL 92"'), key);
      assert.ok(pin.authorization.includes(`${pin.expected_live_definition_sha256} -> ${pin.intended_replacement_sha256}`), key);
      assert.match(pin.authorization, /each apply still needs the owner's run-time approval/, key);
      assert.equal(pin.expected_live_definition_sha256, AUTHORIZED_PRODUCTION_PRE[key], key);
      assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256, key);
      assert.equal(pin.staging_acceptance.reference, AUTHORIZED_STAGING_REFERENCE[key], key);
      assert.ok(pin.staging_acceptance.production_differs.includes(pin.expected_live_definition_sha256), key);
      assert.equal(pin.production_inspect.ssm_command_id, '433d5e4e-51ec-4d82-8220-87ac9f04d8d7', key);
      assert.equal(pin.production_inspect.source_commit, 'f51863bbdc60b6d371bf2b28a1165fc00216b6fb', key);
      assert.equal(pin.production_inspect.source_tarball_sha256, '52e3f4aa3bcbd14c54fdcc9b92810312657fbcb6ca181158d4de0b2477c12cd9', key);
      assert.equal(pin.production_inspect.read_only, true, key);
      assert.equal(pin.production_inspect.already_applied, false, key);
      assert.deepEqual(pin.production_inspect.precondition_failures, [], key);
      if (key === 'sql91') {
        // The guarded staging apply started from the same pre-state production reports.
        assert.match(pin.staging_acceptance.basis, /run 39080306273/);
        assert.match(pin.staging_acceptance.basis, /read-live \(run 39075362413\)/);
        assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${pin.expected_live_definition_sha256}, after ${pin.intended_replacement_sha256}`));
      } else {
        // Owner-accepted substitute evidence: staging already had SQL 92.
        assert.ok(pin.staging_acceptance.basis.includes('"open the SQL 91/92 one-shot and pin PRs and accept that evidence for SQL 92"'));
        assert.match(pin.staging_acceptance.basis, /run 39075498539, already_applied true/);
        for (const file of ['aws/tests/release-sql90-97-executor.test.mjs', 'aws/tests/release-sql90-97-production-apply.test.mjs', 'aws/tests/signature-sql-source.test.mjs']) {
          assert.ok(pin.staging_acceptance.basis.includes(file), file);
          assert.ok(fs.existsSync(path.join(ROOT, file)), file);
        }
      }
    } else {
      assert.equal(pin.authorization, 'pending', key);
      assert.equal(pin.execute, false, key);
      assert.equal(pin.expected_live_definition_sha256, null, key);
      assert.equal(pin.staging_acceptance.ok, false, key);
      assert.equal(pin.staging_acceptance.reference, null, key);
      assert.equal(pin.production_inspect.status, 'pending', key);
    }
    assert.notEqual(pin.verified_live, true, key);
    assert.equal(pin.filename, staging.filename);
    assert.equal(pin.migration_id, staging.migration_id);
    assert.equal(pin.source_sha256, staging.source_sha256);
    assert.equal(pin.staging_pin_commit, staging.commit);
    assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
    assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[key].predecessors);
    assert.equal(pin.admin_login, 'checksops_admin');
    assert.equal(pin.rds_identifier, 'checksops-production');
    assert.match(pin.admin_secret_arn, /^arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials\/checksops-production\/checksops_admin\//);
    assert.equal(RELEASE_PRODUCTION[key].pin_rel, `ops/deployment-guard/${pin.id}.json`);
    assert.equal(pin.tooling.status, 'built');
    assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[key].cli);
    assert.ok(fs.existsSync(path.join(ROOT, pin.tooling.production_tool)));
    for (const testFile of pin.tooling.tests) assert.ok(fs.existsSync(path.join(ROOT, testFile)), testFile);
    assert.equal(readPinnedReleaseSql(key, ROOT, pin).ok, true, key);
    assert.ok(inventory.includes(RELEASE_PRODUCTION[key].cli), key);
    assert.equal(ONE_SHOT_TOOLS[key].script, RELEASE_PRODUCTION[key].cli);
    assert.equal(ONE_SHOT_TOOLS[key].pin_rel, RELEASE_PRODUCTION[key].pin_rel);
  }
});

test('a tampered pin or file is refused', () => {
  for (const key of RELEASE_SQL_KEYS) {
    for (const field of ['filename', 'source_sha256', 'intended_replacement_sha256', 'target_environment', 'staging_pin_commit', 'migration']) {
      const bad = { ...COMMITTED[key], [field]: field === 'target_environment' ? 'staging' : 'x' };
      assert.equal(readPinnedReleaseSql(key, ROOT, bad).code, CODES.SQL_COLLISION, `${key} ${field}`);
    }
    // The pin's predecessors must be the tooling's.
    assert.equal(readPinnedReleaseSql(key, ROOT, { ...COMMITTED[key], predecessors: ['sql99'] }).code, CODES.SQL_COLLISION, key);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sql9097-tamper-'));
  try {
    for (const key of RELEASE_SQL_KEYS) {
      const pin = COMMITTED[key];
      fs.mkdirSync(path.join(tmp, path.dirname(pin.filename)), { recursive: true });
      fs.writeFileSync(path.join(tmp, pin.filename), `${fs.readFileSync(path.join(ROOT, pin.filename), 'utf8')}\nSELECT 1;\n`);
      assert.equal(readPinnedReleaseSql(key, tmp, pin).code, CODES.SOURCE_RECONCILIATION_REQUIRED, key);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('evaluate, precheck and apply refuse before connecting', async () => {
  for (const key of RELEASE_SQL_KEYS) {
    // The pending state (for an execute-authorized or applied pin, its explicit pre-authorization copy).
    const committed = await evaluateReleaseProductionApply(key, manifest(key, { ...LOCKED[key], expected_live_definition_sha256: PRE }), { root: ROOT, pin: LOCKED[key] });
    assert.equal(committed.code, CODES.SQL_COLLISION, key);
    assert.match(committed.message, /no recorded pre-apply live definition hash/);
    const pendingWithPre = { ...LOCKED[key], expected_live_definition_sha256: PRE };
    const notApproved = await evaluateReleaseProductionApply(key, manifest(key, pendingWithPre), { root: ROOT, pin: pendingWithPre });
    assert.equal(notApproved.code, CODES.PRODUCTION_APPROVAL_REQUIRED, key);
    const pin = authorized(key);
    const good = await evaluateReleaseProductionApply(key, manifest(key, pin), { root: ROOT, pin });
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.equal(good.details[RELEASE_PRODUCTION[key].allowed_key], true);
    const wrongLive = await evaluateReleaseProductionApply(key, manifest(key, pin, { live_definition_sha256: 'f'.repeat(64) }), { root: ROOT, pin });
    assert.equal(wrongLive.code, CODES.SQL_COLLISION);
    const wrongStaging = await evaluateReleaseProductionApply(key, manifest(key, pin, { staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } }), { root: ROOT, pin });
    assert.equal(wrongStaging.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    const noApproval = await evaluateReleaseProductionApply(key, manifest(key, pin, { approval: null }), { root: ROOT, pin });
    assert.equal(noApproval.ok, false);

    const ctx = { root: ROOT, pin, consumedPath: consumedPath(), connect: neverConnect };
    const executeFalse = await executeReleaseProductionApply(key, manifest(key, pin), { ...ctx, pin: authorized(key, PRE, { execute: false }) });
    assert.equal(executeFalse.code, CODES.GUARD_APPLY_FORBIDDEN);
    const wrongPhrase = await executeReleaseProductionApply(key, manifest(key, pin, { authorization_phrase: 'APPLY' }), ctx);
    assert.equal(wrongPhrase.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    const noOneUse = await executeReleaseProductionApply(key, manifest(key, pin, { one_use_id: 'x' }), ctx);
    assert.equal(noOneUse.code, CODES.INVALID_MANIFEST);
    const spentPath = consumedPath();
    fs.writeFileSync(spentPath, JSON.stringify({ consumed: ['reused-id-0001'] }));
    const replay = await precheckReleaseProductionApply(key, manifest(key, pin, { one_use_id: 'reused-id-0001' }), { root: ROOT, pin, consumedPath: spentPath });
    assert.equal(replay.code, CODES.RECEIPT_REUSED);
  }
});

test('the committed SQL 91 and SQL 92 pins allow only the manifest bound to them; the cheap prechecks pass without connecting', async () => {
  for (const key of EXECUTE_AUTHORIZED) {
    const pin = COMMITTED[key];
    const bound = manifest(key, pin, { staging_acceptance: { ok: true, reference: AUTHORIZED_STAGING_REFERENCE[key] } });
    const allowed = await evaluateReleaseProductionApply(key, bound, { root: ROOT });
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
    assert.equal(allowed.details[RELEASE_PRODUCTION[key].allowed_key], true, key);
    const prechecked = await precheckReleaseProductionApply(key, bound, { root: ROOT, consumedPath: consumedPath() });
    assert.equal(prechecked.ok, true, JSON.stringify(prechecked));
    const wrongLive = await evaluateReleaseProductionApply(key, { ...bound, live_definition_sha256: 'f'.repeat(64) }, { root: ROOT });
    assert.equal(wrongLive.code, CODES.SQL_COLLISION, key);
    const wrongStaging = await evaluateReleaseProductionApply(key, { ...bound, staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } }, { root: ROOT });
    assert.equal(wrongStaging.code, CODES.PRODUCTION_APPROVAL_REQUIRED, key);
    const executeFalse = await executeReleaseProductionApply(key, bound, { root: ROOT, pin: { ...pin, execute: false }, consumedPath: consumedPath(), connect: neverConnect });
    assert.equal(executeFalse.code, CODES.GUARD_APPLY_FORBIDDEN, key);
    const wrongPhrase = await executeReleaseProductionApply(key, { ...bound, authorization_phrase: 'APPLY' }, { root: ROOT, consumedPath: consumedPath(), connect: neverConnect });
    assert.equal(wrongPhrase.code, CODES.PRODUCTION_APPROVAL_REQUIRED, key);
  }
});

test('CLI: credential flags and arbitrary SQL are refused; pending pins stop before the guard; no receipt is spent and nothing connects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql9097-cli-'));
  try {
    for (const key of RELEASE_SQL_KEYS) {
      for (const flag of ['--password=x', '--database-url=postgresql://u:p@h/d', '--host=h', '--user=u', '--secret-arn=x']) {
        const result = spawnSync(process.execPath, [CLIS[key], '--inspect', flag], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } });
        assert.notEqual(result.status, 0, `${key} ${flag}`);
        assert.match(`${result.stdout}${result.stderr}`, /credential flags are refused/, flag);
        assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secretsmanager|ECONNREFUSED/i, flag);
      }
      const committed = await runCli(key, ['--apply'], { input: manifest(key, { ...COMMITTED[key], expected_live_definition_sha256: PRE }), deps: { enforceScriptGuard: () => { throw new Error('guard-called'); } } });
      assert.equal(committed.spent, 0);
      // A pending pin has no pre-state (SQL_COLLISION); an applied, retired pin's authorization
      // is no longer an owner approval (PRODUCTION_APPROVAL_REQUIRED).
      assert.match(committed.out, APPLIED_RETIRED.includes(key) ? /PRODUCTION_APPROVAL_REQUIRED/ : /SQL_COLLISION/, key);
      assert.doesNotMatch(committed.out, /guard-called|should-not-connect/);
      const sqlText = await runCli(key, ['--apply'], { input: { ...manifest(key, authorized(key)), sql_text: 'DROP TABLE x' }, deps: { pin: authorized(key) } });
      assert.match(sqlText.out, /arbitrary SQL text is forbidden/);
      const emptyRoot = fs.mkdtempSync(path.join(dir, 'noreceipt-'));
      const noReceipt = await runCli(key, ['--apply'], {
        input: manifest(key, authorized(key)),
        deps: { pin: authorized(key), enforceScriptGuard: (spec) => refuseUnguardedDeploy(spec, { root: emptyRoot, env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' } }) },
      });
      assert.equal(noReceipt.spent, 0);
      assert.match(noReceipt.out, /DEPLOYMENT_GUARD_REQUIRED/);
      const noFlag = await runCli(key, ['--apply'], {
        env: {},
        input: manifest(key, authorized(key)),
        deps: { pin: authorized(key), enforceScriptGuard: () => ({ ok: true, details: { receipt: { owned_components: [COMMITTED[key].filename] } } }) },
      });
      assert.equal(noFlag.spent, 0);
      assert.match(noFlag.out, /GUARD_APPLY_FORBIDDEN/);
      const otherFile = await runCli(key, ['--apply'], {
        input: manifest(key, authorized(key)),
        deps: { pin: authorized(key), enforceScriptGuard: () => ({ ok: true, details: { receipt: { owned_components: ['aws/workflows/sql/89_check_intake_items_column_update.sql'] } } }) },
      });
      assert.equal(otherFile.spent, 0);
      assert.match(otherFile.out, /RECEIPT_MISMATCH/);
      const envBypass = await runCli(key, ['--apply'], {
        env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1', CHECKSOPS_DEPLOYMENT_GUARD_BYPASS: '1', CHECKSOPS_SKIP_DEPLOYMENT_GUARD: '1' },
        input: manifest(key, authorized(key)),
        deps: { pin: authorized(key), enforceScriptGuard: (spec) => refuseUnguardedDeploy(spec, { root: emptyRoot, env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1', CHECKSOPS_DEPLOYMENT_GUARD_BYPASS: '1' } }) },
      });
      assert.equal(envBypass.spent, 0);
      assert.match(envBypass.out, /DEPLOYMENT_GUARD_REQUIRED/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real guard: a staging receipt cannot authorize production; a production receipt is spent once and a refusing DB rolls back', async () => {
  const NOW = Date.parse('2026-10-17T20:00:00.000Z');
  for (const key of RELEASE_SQL_KEYS) {
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
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${key}-staging-receipt-`));
    const prodRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${key}-prod-receipt-`));
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

async function withPg(t, prefix, port, fn) {
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
  const fx = await releaseFixture(pg, prefix, port);
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: inspect is read-only with no row data; authorized copies apply once each as checksops_admin in order; the superuser is refused; out-of-scope changes roll back', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql9097-prod-', 58700, async ({ admin, connectAs, applyPredecessors }) => {
  await applyPredecessors();
  const seen = [];
  const connectWith = (user) => async () => {
    const client = await connectAs(user);
    const query = client.query.bind(client);
    client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
    return client;
  };
  const connect = connectWith('checksops_admin');
  for (const key of ORDER) {
    seen.length = 0;
    const inspected = await inspectReleaseProduction(key, { connect, pin: LOCKED[key], root: ROOT });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const d = inspected.details;
    assert.equal(d.read_only, true);
    assert.equal(d.source_ok, true);
    assert.equal(d.pin_execute, false);
    assert.equal(d.apply_preconditions_met, false, 'no recorded pre-state');
    assert.deepEqual(d.precondition_failures, [], `${key}: ${JSON.stringify(d.release_sql_inspect)}`);
    assert.deepEqual(d.missing_dependencies, []);
    assert.equal(d.predecessors_applied, true);
    assert.equal(seen[0], 'BEGIN READ ONLY');
    assert.equal(seen.at(-1), 'ROLLBACK');
    assert.ok(seen.slice(1, -1).every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
    assert.doesNotMatch(JSON.stringify(d), /Private|example\.invalid|checksopsadmin@|11111111-1111/, key);
    if (key === 'sql94') assert.deepEqual(d.counts, { rows_outside_sql94_rule: 0 });
    if (key === 'sql97') assert.deepEqual(d.release_sql_inspect.table_privileges[0].other_write_grants, []);

    const pin = authorized(key, d.live_definition_sha256);
    const asSuper = await executeReleaseProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect: connectWith('ubuntu'), consumedPath: consumedPath() });
    assert.equal(asSuper.code, CODES.DEPLOYMENT_COLLISION, key);
    assert.ok(asSuper.details.failed.includes('login_is_pinned_admin'));

    if (key === 'sql92') {
      // A file that changes anything outside its scope rolls back, before COMMIT.
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sql92-prod-tampered-'));
      try {
        const tampered = `${fs.readFileSync(path.join(ROOT, pin.filename), 'utf8')}\nCREATE TABLE public.zz_unrelated (id int);\n`;
        fs.mkdirSync(path.join(tmp, path.dirname(pin.filename)), { recursive: true });
        fs.writeFileSync(path.join(tmp, pin.filename), tampered);
        const tamperedPin = { ...pin, source_sha256: sha(tampered) };
        // The committed staging pin binds the bytes, so the tool refuses before connecting ...
        assert.equal((await executeReleaseProductionApply(key, manifest(key, tamperedPin), { root: tmp, pin: tamperedPin, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.SQL_COLLISION);
        // ... and the post-condition snapshot catches an out-of-scope change made inside the transaction.
        const sneaky = async () => {
          const client = await connectAs('checksops_admin');
          const query = client.query.bind(client);
          client.query = (sql, params) => (String(sql) === fs.readFileSync(path.join(ROOT, pin.filename), 'utf8')
            ? query(`${sql}\nCREATE TABLE public.zz_unrelated (id int);`, params)
            : query(sql, params));
          return client;
        };
        const rolledBack = await executeReleaseProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect: sneaky, consumedPath: consumedPath() });
        assert.equal(rolledBack.code, CODES.UNRELATED_MUTATION, JSON.stringify(rolledBack));
        assert.deepEqual(rolledBack.details.unrelated_changed, ['relations', 'columns']);
        assert.equal((await admin.query("SELECT to_regclass('public.zz_unrelated') IS NULL AS gone")).rows[0].gone, true);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    const applied = await executeReleaseProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.after_hash, pin.intended_replacement_sha256);
    assert.doesNotMatch(JSON.stringify(applied.details.receipt), /Private|example\.invalid|checksopsadmin@/);
    const after = await inspectReleaseProduction(key, { connect, pin, root: ROOT });
    assert.equal(after.details.already_applied, true, key);
    const replay = await executeReleaseProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(replay.code, CODES.UNRELATED_MUTATION, key);
  }
}));
