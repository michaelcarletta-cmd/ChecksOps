/**
 * production-sql-one-shot: orchestration of one registered production SQL tool
 * on the runner. Every child process is injected (no database, no AWS, no
 * preflight state written): each stop condition halts before later steps, the
 * apply child is the only one that sees the apply variables, receipts are never
 * an input, and the summary carries a pin-ready `applied` block.
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
import { evaluateDeployment } from '../../scripts/deployment-guard/lib/guard.mjs';
import { receiptDir } from '../../scripts/deployment-guard/lib/paths.mjs';
import {
  GUARD_ENV_KEYS,
  ONE_SHOT_TOOLS,
  compareTreeToTarball,
  normalizeTarPath,
  parseJsonOutput,
  parseTapSummary,
  requiredContracts,
  runProductionSqlOneShot,
} from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { evaluateMemberStakeholderProductionApply } from '../../scripts/deployment-guard/lib/sql-member-stakeholder-production-apply.mjs';
import { evaluateSql80ProductionApply } from '../../scripts/deployment-guard/lib/sql80-checkalt-production-apply.mjs';
import { main as oneShotMain } from '../../scripts/deployment-guard/production-sql-one-shot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMMIT = 'a'.repeat(40);
const WORKSTREAM = 'prod-sql80-checkalt-member-auto-deposit-20261016';
const STATEMENT = 'approve applying SQL 80 to production';
const RECEIPT = path.join(receiptDir(ROOT), 'production::production-sql.json');

const realPin = (key) => JSON.parse(fs.readFileSync(path.join(ROOT, ONE_SHOT_TOOLS[key].pin_rel), 'utf8'));
const executePin = (key, extra = {}) => ({ ...realPin(key), execute: true, ...extra });

function tarballFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-shot-tarball-'));
  const file = path.join(dir, `source-${COMMIT}.tar.gz`);
  fs.writeFileSync(file, 'not really a tarball');
  const sha = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(`${file}.sha256`, `${sha}  source-${COMMIT}.tar.gz\n`);
  return file;
}

const TARBALL = tarballFixture();
const tap = (n, { fail = 0, skipped = 0 } = {}) => `TAP version 13\n1..${n}\n# tests ${n}\n# suites 0\n# pass ${n - fail - skipped}\n# fail ${fail}\n# cancelled 0\n# skipped ${skipped}\n# todo 0\n`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function inspectDetails(key, pin, overrides = {}) {
  return {
    read_only: true,
    migration: key,
    filename: pin.filename,
    source_ok: true,
    pin_execute: true,
    missing_dependencies: [],
    predecessors: {},
    predecessors_applied: true,
    current_user: 'checksops_admin',
    owner_roles: ['checksops_admin'],
    authenticated_member_of_owner: false,
    state: { big: 'not copied' },
    live_definition_sha256: pin.expected_live_definition_sha256,
    expected_live_definition_sha256: pin.expected_live_definition_sha256,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    live_matches_expected: true,
    already_applied: false,
    precondition_failures: [],
    apply_preconditions_met: true,
    ...overrides,
  };
}

/** A runner that answers each step from `responses` and records every call. */
function fakeRunner(key, pin, responses = {}) {
  const calls = [];
  const tool = ONE_SHOT_TOOLS[key];
  const defaults = {
    inspect: () => ({ status: 0, stdout: json({ ok: true, details: inspectDetails(key, pin) }), stderr: '' }),
    contract: (call) => ({ status: 0, stdout: tap(call.args.at(-1).includes('api-write') ? 36 : 4), stderr: '' }),
    preflight: () => ({ status: 0, stdout: json({ ok: true, details: { receipt: RECEIPT, lease: { id: 'l' } } }), stderr: '' }),
    evaluate: () => ({ status: 0, stdout: json({ ok: true, details: { migration: key, [tool.allowed_key]: true } }), stderr: '' }),
    apply: () => ({
      status: 0,
      stdout: json({
        ok: true,
        details: {
          receipt: {
            migration: key,
            before_hash: pin.expected_live_definition_sha256,
            after_hash: pin.intended_replacement_sha256,
            unrelated_catalog_sha256: 'c'.repeat(64),
            unrelated_catalog_counts: { relations: 1 },
            staging_acceptance: pin.staging_acceptance.reference,
            result: 'applied',
          },
        },
      }),
      stderr: '',
    }),
    'post-apply-inspect': () => ({
      status: 0,
      stdout: json({ ok: true, details: inspectDetails(key, pin, { live_definition_sha256: pin.intended_replacement_sha256, live_matches_expected: false, already_applied: true, apply_preconditions_met: false }) }),
      stderr: '',
    }),
  };
  const run = (call) => {
    calls.push(call);
    const kind = call.step.startsWith('contract:') ? 'contract' : call.step;
    const answer = responses[call.step] || responses[kind] || defaults[kind];
    return answer(call);
  };
  return { run, calls, steps: () => calls.map((c) => c.step) };
}

function opts(key = 'sql80', extra = {}) {
  return {
    migration: key,
    commit: COMMIT,
    'workstream-id': WORKSTREAM,
    'approval-statement': STATEMENT,
    phase: 'apply',
    'source-tarball': TARBALL,
    runner: 'i-0c35557c4e5385406',
    ...extra,
  };
}

async function oneShot({ key = 'sql80', o = {}, pin, responses, env = { PATH: '/usr/bin', AWS_ENDPOINT_URL_SECRETS_MANAGER: 'https://vpce.example' }, compareTree } = {}) {
  const thePin = pin === undefined ? executePin(key) : pin;
  const runner = fakeRunner(key, thePin || realPin(key), responses);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-shot-manifest-'));
  const result = await runProductionSqlOneShot(opts(key, o), {
    root: ROOT,
    env,
    run: runner.run,
    nodePath: '/usr/bin/node',
    pin: thePin || undefined,
    tmpDir,
    runId: 'run-1',
    now: () => new Date('2026-10-16T12:00:00.000Z'),
    compareTree: compareTree || (async () => ({ ok: true, details: { tarball_files: 3, tarball_entries: 4 } })),
  });
  return { result, runner, tmpDir };
}

const CONTRACT_STEPS = ['contract:claim-ledger', 'contract:tenant-isolation', 'contract:financial-write-protections'];
const FULL = ['inspect', ...CONTRACT_STEPS, 'preflight', 'evaluate', 'apply', 'post-apply-inspect'];

// --- happy paths ----------------------------------------------------------------

test('apply phase runs every step in order and prints a pin-ready applied block', async () => {
  const { result, runner } = await oneShot();
  assert.equal(result.ok, true, JSON.stringify(result.details.error));
  assert.deepEqual(runner.steps(), FULL);
  const d = result.details;
  assert.deepEqual(d.steps.map((s) => s.step), ['pin', 'source', 'inspect', 'contracts', 'manifest', 'preflight', 'evaluate', 'apply', 'post-apply-inspect']);
  assert.equal(d.receipt_issued, true);
  const applied = d.applied;
  const pin = realPin('sql80');
  assert.equal(applied.result, 'applied');
  assert.equal(applied.date, '2026-10-16');
  assert.equal(applied.source_commit, COMMIT);
  assert.equal(applied.workstream_id, WORKSTREAM);
  assert.equal(applied.owner_approval, STATEMENT);
  assert.match(applied.owner_approval_basis, /cannot verify/);
  assert.equal(applied.runner, 'i-0c35557c4e5385406');
  assert.match(applied.runner_basis, /operator-supplied/);
  assert.match(applied.one_use_id, /^sql80-prod-[0-9a-f-]{36}$/);
  assert.equal(applied.one_use_id_consumed, true);
  assert.match(applied.one_use_id_consumed_basis, /^Inferred/);
  assert.equal(applied.receipt.before_hash, pin.expected_live_definition_sha256);
  assert.equal(applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(applied.pre_apply_inspect.live_definition_sha256, pin.expected_live_definition_sha256);
  assert.equal(applied.pre_apply_inspect.state, undefined, 'the raw state is not copied');
  assert.equal(applied.post_apply_inspect.already_applied, true);
  assert.equal(applied.source_tarball.file, `source-${COMMIT}.tar.gz`);
  assert.deepEqual(Object.keys(applied.contract_results).sort(), ['claim-ledger', 'financial-write-protections', 'tenant-isolation']);
  assert.equal(applied.contract_results['financial-write-protections'].evidence, `36/36 on i-0c35557c4e5385406 at ${COMMIT} (production-sql-one-shot run-1, node --test)`);
  assert.ok(d.not_observed_by_this_run.some((row) => row.startsWith('ssm_command_id')));
  assert.ok(d.not_observed_by_this_run.some((row) => row.startsWith('source_staged_by')));
});

test('runner defaults to the hostname and says so', async () => {
  const { result } = await oneShot({ o: { runner: undefined } });
  assert.equal(result.ok, true);
  assert.equal(result.details.applied.runner, os.hostname());
  assert.match(result.details.applied.runner_basis, /os\.hostname/);
});

test('inspect phase stops after the contracts and writes nothing', async () => {
  const { result, runner, tmpDir } = await oneShot({ o: { phase: 'inspect' } });
  assert.equal(result.ok, true);
  assert.deepEqual(runner.steps(), ['inspect', ...CONTRACT_STEPS]);
  assert.deepEqual(fs.readdirSync(tmpDir), [], 'no manifest is written');
  assert.equal(result.details.applied, undefined);
  assert.equal(result.details.receipt_issued, undefined);
  assert.equal(Object.keys(result.details.contract_results).length, 3);
});

test('every registered migration runs its own tool with its own arguments', async () => {
  for (const key of Object.keys(ONE_SHOT_TOOLS)) {
    const { result, runner } = await oneShot({ key, o: { 'workstream-id': `prod-${key}-one-shot-test` } });
    assert.equal(result.ok, true, `${key}: ${JSON.stringify(result.details.error)}`);
    const tool = ONE_SHOT_TOOLS[key];
    const applyCall = runner.calls.find((c) => c.step === 'apply');
    assert.deepEqual(applyCall.args.slice(0, 1 + tool.args.length), [tool.script, ...tool.args]);
    assert.equal(applyCall.command, '/usr/bin/node');
    assert.equal(applyCall.cwd, ROOT);
    assert.ok(fs.existsSync(path.join(ROOT, tool.script)), tool.script);
    assert.ok(fs.existsSync(path.join(ROOT, tool.pin_rel)), tool.pin_rel);
  }
});

// --- manifest -----------------------------------------------------------------------

test('the manifest is built from the pin, the inspect and the contracts, and the real evaluators accept it', async () => {
  for (const key of Object.keys(ONE_SHOT_TOOLS)) {
    const pin = executePin(key);
    const workstream = `prod-${key}-one-shot-test`;
    const { result } = await oneShot({ key, o: { 'workstream-id': workstream } });
    assert.equal(result.ok, true);
    const manifest = JSON.parse(fs.readFileSync(result.details.manifest_file, 'utf8'));
    assert.equal((fs.statSync(result.details.manifest_file).mode & 0o777), 0o600);
    assert.equal(manifest.workstream_id, workstream);
    assert.equal(manifest.commit, COMMIT);
    assert.equal(manifest.target_environment, 'production');
    assert.equal(manifest.target_component, 'production-sql');
    assert.equal(manifest.deployment_type, 'sql-apply');
    assert.deepEqual(manifest.owned_components, [pin.filename]);
    for (const field of ['filename', 'migration_id', 'source_sha256', 'expected_live_definition_sha256', 'intended_replacement_sha256', 'authorization_phrase']) {
      assert.equal(manifest[field], pin[field], field);
    }
    assert.deepEqual(manifest.staging_acceptance, pin.staging_acceptance);
    for (const field of ['preflight_live_fingerprint', 'production_fingerprint', 'immediately_before_fingerprint']) {
      assert.deepEqual(manifest[field], { sql: pin.expected_live_definition_sha256 }, field);
    }
    assert.deepEqual(manifest.approval, { approved: true, workstream_id: workstream, approved_by: 'owner', statement: STATEMENT });
    assert.equal(manifest.one_use_id, result.details.one_use_id);
    assert.match(manifest.one_use_id, new RegExp(`^${key}-prod-[0-9a-f-]{36}$`));
    assert.equal(manifest.build_timestamp, '2026-10-16T12:00:00.000Z');
    assert.equal(manifest.receipt_path, undefined);
    assert.equal(manifest.operator, 'michaelcarletta-cmd');
    for (const row of Object.values(manifest.contract_results)) assert.equal(row.ok, true);

    // The same checks preflight and the tool's evaluate run (no connection, nothing written).
    const guard = evaluateDeployment(manifest, { root: ROOT, env: {} });
    assert.equal(guard.ok, true, `${key} preflight evaluate: ${JSON.stringify(guard.errors)}`);
    const evaluation = key === 'sql80'
      ? await evaluateSql80ProductionApply(manifest, { root: ROOT, pin })
      : await evaluateMemberStakeholderProductionApply(manifest, { root: ROOT, migration: key, pin });
    assert.equal(evaluation.ok, true, `${key} tool evaluate: ${JSON.stringify(evaluation.errors)}`);
    assert.equal(evaluation.details[ONE_SHOT_TOOLS[key].allowed_key], true);
  }
});

// --- arguments, receipts and environment ------------------------------------------------

test('approval statement is required and recorded verbatim', async () => {
  for (const value of [undefined, '', '   ', true]) {
    const { result, runner } = await oneShot({ o: { 'approval-statement': value } });
    assert.equal(result.ok, false, String(value));
    assert.equal(result.details.stopped_at, 'arguments');
    assert.equal(result.code, CODES.INVALID_MANIFEST);
    assert.equal(runner.calls.length, 0);
  }
  const exact = '  merged, approve applying SQL 80 to production  ';
  const { result } = await oneShot({ o: { 'approval-statement': exact } });
  assert.equal(result.ok, true);
  assert.equal(result.details.applied.owner_approval, exact);
  assert.equal(JSON.parse(fs.readFileSync(result.details.manifest_file, 'utf8')).approval.statement, exact);
});

test('a receipt, manifest or input can never be passed in', async () => {
  for (const flag of ['receipt', 'receipt-path', 'input', 'json', 'manifest', 'financial-write-evidence', 'skip-contracts']) {
    const { result, runner } = await oneShot({ o: { [flag]: '/tmp/x.json' } });
    assert.equal(result.ok, false, flag);
    assert.equal(result.code, CODES.INVALID_MANIFEST, flag);
    assert.deepEqual(result.details.error.details.unknown, [flag]);
    assert.equal(runner.calls.length, 0, flag);
  }
  for (const key of GUARD_ENV_KEYS) {
    const { result, runner } = await oneShot({ env: { PATH: '/usr/bin', [key]: key.endsWith('RECEIPT') ? RECEIPT : '1' } });
    assert.equal(result.ok, false, key);
    assert.equal(result.code, CODES.DEPLOYMENT_GUARD_REQUIRED, key);
    assert.equal(runner.calls.length, 0, key);
  }
});

test('other argument errors stop before any child', async () => {
  for (const o of [
    { migration: 'sql53' },
    { migration: undefined },
    { phase: 'evaluate' },
    { phase: undefined },
    { commit: 'abc' },
    { commit: COMMIT.toUpperCase() },
    { 'workstream-id': 'x' },
    { 'source-tarball': undefined },
    { runner: true },
  ]) {
    const { result, runner } = await oneShot({ o });
    assert.equal(result.ok, false, JSON.stringify(o));
    assert.equal(result.details.stopped_at, 'arguments');
    assert.equal(runner.calls.length, 0);
  }
});

test('only the apply child gets the apply variables, and its receipt is the one preflight issued', async () => {
  const env = { PATH: '/usr/bin', AWS_ENDPOINT_URL_SECRETS_MANAGER: 'https://vpce.example' };
  const { result, runner } = await oneShot({ env });
  assert.equal(result.ok, true);
  for (const call of runner.calls) {
    assert.equal(call.env.AWS_ENDPOINT_URL_SECRETS_MANAGER, 'https://vpce.example', call.step);
    if (call.step === 'apply') {
      assert.equal(call.env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY, '1');
      assert.equal(call.env.CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT, RECEIPT);
      assert.ok(call.args.includes('--apply'));
      assert.ok(!call.args.includes('--receipt'));
    } else {
      for (const key of GUARD_ENV_KEYS) assert.equal(call.env[key], undefined, `${call.step} ${key}`);
      assert.ok(!call.args.includes('--apply'), call.step);
    }
  }
  const preflight = runner.calls.find((c) => c.step === 'preflight');
  assert.deepEqual(preflight.args.slice(0, 3), ['scripts/deployment-guard/preflight.mjs', '--acquire-lease', '--receipt']);
  assert.ok(!preflight.args.includes('--skip-contracts'));
  assert.equal(env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY, undefined, 'the caller env is not mutated');
});

// --- stop conditions ---------------------------------------------------------------------

test('every real production pin (execute false today) is refused before any child', async () => {
  for (const key of Object.keys(ONE_SHOT_TOOLS)) {
    for (const phase of ['inspect', 'apply']) {
      const { result, runner } = await oneShot({ key, pin: null, o: { phase } });
      assert.equal(realPin(key).execute, false);
      assert.equal(result.ok, false);
      assert.equal(result.code, CODES.GUARD_APPLY_FORBIDDEN);
      assert.equal(result.details.stopped_at, 'pin');
      assert.equal(runner.calls.length, 0);
    }
  }
});

test('a pin without staging acceptance or phrase is refused', async () => {
  for (const extra of [{ staging_acceptance: { ok: false, reference: 'x' } }, { staging_acceptance: null }, { authorization_phrase: '' }]) {
    const { result, runner } = await oneShot({ pin: executePin('sql80', extra) });
    assert.equal(result.ok, false);
    assert.equal(result.details.stopped_at, 'pin');
    assert.equal(runner.calls.length, 0);
  }
});

test('source failures stop before the inspect', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-shot-src-'));
  const wrongName = path.join(dir, `source-${'b'.repeat(40)}.tar.gz`);
  fs.copyFileSync(TARBALL, wrongName);
  fs.copyFileSync(`${TARBALL}.sha256`, `${wrongName}.sha256`);
  const badSidecar = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'one-shot-src-')), `source-${COMMIT}.tar.gz`);
  fs.copyFileSync(TARBALL, badSidecar);
  fs.writeFileSync(`${badSidecar}.sha256`, `${'0'.repeat(64)}  source-${COMMIT}.tar.gz\n`);
  const noSidecar = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'one-shot-src-')), `source-${COMMIT}.tar.gz`);
  fs.copyFileSync(TARBALL, noSidecar);
  const cases = [
    [{ o: { 'source-tarball': wrongName } }, CODES.STALE_PACKAGE],
    [{ o: { 'source-tarball': badSidecar } }, CODES.STALE_PACKAGE],
    [{ o: { 'source-tarball': noSidecar } }, CODES.STALE_PACKAGE],
    [{ compareTree: async () => ({ ok: false, code: CODES.SOURCE_RECONCILIATION_REQUIRED, message: 'tree differs', details: {} }) }, CODES.SOURCE_RECONCILIATION_REQUIRED],
    [{ pin: executePin('sql80', { source_sha256: 'f'.repeat(64) }) }, CODES.SOURCE_RECONCILIATION_REQUIRED],
    [{ pin: executePin('sql80', { migration: 'sql79' }) }, CODES.SQL_COLLISION],
    [{ pin: executePin('sql80', { target_environment: 'staging' }) }, CODES.SQL_COLLISION],
  ];
  for (const [args, code] of cases) {
    const { result, runner } = await oneShot(args);
    assert.equal(result.ok, false, JSON.stringify(args.o || args.pin?.source_sha256 || 'tree'));
    assert.equal(result.code, code);
    assert.equal(result.details.stopped_at, 'source');
    assert.equal(runner.calls.length, 0);
  }
});

test('each inspect failure stops before the contracts', async () => {
  const pin = executePin('sql80');
  const cases = {
    pin_execute: { pin_execute: false },
    source_ok: { source_ok: false },
    read_only: { read_only: false },
    migration: { migration: 'sql79' },
    filename: { filename: 'aws/workflows/sql/79_member_stakeholder_writes.sql' },
    state_readable: { state_error: { code: 'X' } },
    missing_dependencies: { missing_dependencies: ['primary key on x'] },
    predecessors_applied: { predecessors_applied: false },
    live_definition_sha256: { live_definition_sha256: 'e'.repeat(64) },
    live_matches_expected: { live_matches_expected: false },
    already_applied: { already_applied: true },
    precondition_failures: { precondition_failures: ['update_not_granted'] },
    apply_preconditions_met: { apply_preconditions_met: false },
    expected_live_definition_sha256: { expected_live_definition_sha256: 'd'.repeat(64) },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    const { result, runner } = await oneShot({
      responses: { inspect: () => ({ status: 0, stdout: json({ ok: true, details: inspectDetails('sql80', pin, overrides) }), stderr: '' }) },
    });
    assert.equal(result.ok, false, name);
    assert.equal(result.code, CODES.DEPLOYMENT_COLLISION, name);
    assert.equal(result.details.stopped_at, 'inspect', name);
    assert.ok(result.details.error.details.failed.includes(name), `${name}: ${result.details.error.details.failed}`);
    assert.deepEqual(runner.steps(), ['inspect'], name);
  }
  const { result, runner } = await oneShot({
    responses: { inspect: () => ({ status: 1, stdout: '', stderr: json({ ok: false, code: 'SQL_COLLISION', message: 'secret unreadable' }) }) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SQL_COLLISION');
  assert.equal(result.details.stopped_at, 'inspect');
  assert.deepEqual(runner.steps(), ['inspect']);
});

test('a failed, skipped or unparseable contract stops before preflight', async () => {
  const bad = [
    () => ({ status: 1, stdout: tap(36, { fail: 1 }), stderr: '' }),
    () => ({ status: 0, stdout: tap(36, { skipped: 1 }), stderr: '' }),
    () => ({ status: 1, stdout: '', stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@aws-sdk/client-s3'" }),
    () => ({ status: 0, stdout: 'no summary', stderr: '' }),
    () => ({ status: 0, stdout: tap(0), stderr: '' }),
  ];
  for (const answer of bad) {
    const { result, runner } = await oneShot({ responses: { 'contract:financial-write-protections': answer } });
    assert.equal(result.ok, false);
    assert.equal(result.code, CODES.REGRESSION_DETECTED);
    assert.equal(result.details.stopped_at, 'contracts');
    assert.equal(runner.steps().at(-1), 'contract:financial-write-protections');
    assert.ok(!runner.steps().includes('preflight'));
  }
});

test('contract tests come from the registry and run on this tree with the TAP reporter', async () => {
  const ids = requiredContracts(ROOT).map((row) => row.id).sort();
  assert.deepEqual(ids, ['claim-ledger', 'financial-write-protections', 'tenant-isolation']);
  const { runner } = await oneShot({ o: { phase: 'inspect' } });
  const call = runner.calls.find((c) => c.step === 'contract:financial-write-protections');
  assert.deepEqual(call.args, ['--test', '--test-reporter=tap', 'aws/tests/api-write.test.mjs']);
  const empty = { contracts: [] };
  const res = await runProductionSqlOneShot(opts('sql80'), {
    root: ROOT, env: {}, run: fakeRunner('sql80', executePin('sql80')).run, pin: executePin('sql80'), registry: empty,
    compareTree: async () => ({ ok: true, details: { tarball_files: 1 } }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.details.stopped_at, 'contracts');
});

test('a preflight refusal or a receipt outside .deployment-guard/receipts stops before evaluate', async () => {
  for (const answer of [
    () => ({ status: 1, stdout: '', stderr: json({ ok: false, code: 'LEASE_HELD', message: 'held by another workstream' }) }),
    () => ({ status: 0, stdout: json({ ok: true, details: {} }), stderr: '' }),
    () => ({ status: 0, stdout: json({ ok: true, details: { receipt: '/tmp/forged.json' } }), stderr: '' }),
    () => ({ status: 0, stdout: json({ ok: true, details: { receipt: { ok: false } } }), stderr: '' }),
  ]) {
    const { result, runner } = await oneShot({ responses: { preflight: answer } });
    assert.equal(result.ok, false);
    assert.equal(result.details.stopped_at, 'preflight');
    assert.equal(runner.steps().at(-1), 'preflight');
  }
  const { result } = await oneShot({ responses: { preflight: () => ({ status: 1, stdout: '', stderr: json({ ok: false, code: 'LEASE_HELD', message: 'held' }) }) } });
  assert.equal(result.code, 'LEASE_HELD');
});

test('apply never runs when evaluate disallows', async () => {
  for (const answer of [
    () => ({ status: 1, stdout: '', stderr: json({ ok: false, code: 'PRODUCTION_APPROVAL_REQUIRED', message: 'no' }) }),
    () => ({ status: 0, stdout: json({ ok: true, details: { migration: 'sql80', sql80_production_apply_allowed: false } }), stderr: '' }),
    () => ({ status: 0, stdout: json({ ok: true, details: { migration: 'sql80' } }), stderr: '' }),
    () => ({ status: 0, stdout: json({ ok: true, details: { migration: 'sql79', sql80_production_apply_allowed: true } }), stderr: '' }),
    () => ({ status: 0, stdout: json({ ok: true, details: { migration: 'sql80', member_stakeholder_production_apply_allowed: true } }), stderr: '' }),
  ]) {
    const { result, runner } = await oneShot({ responses: { evaluate: answer } });
    assert.equal(result.ok, false);
    assert.equal(result.details.stopped_at, 'evaluate');
    assert.ok(!runner.steps().includes('apply'));
    assert.ok(!runner.steps().includes('post-apply-inspect'));
  }
});

test('a failed apply still runs the read-only post-apply inspect and reports the stop', async () => {
  const pin = executePin('sql80');
  for (const answer of [
    () => ({ status: 1, stdout: '', stderr: json({ ok: false, code: 'SQL_COLLISION', message: 'COMMIT outcome is unknown' }) }),
    () => ({ status: 0, stdout: json({ ok: true, details: { receipt: { result: 'applied', before_hash: pin.expected_live_definition_sha256, after_hash: 'x' } } }), stderr: '' }),
  ]) {
    const { result, runner } = await oneShot({ responses: { apply: answer } });
    assert.equal(result.ok, false);
    assert.equal(result.details.stopped_at, 'apply');
    assert.deepEqual(runner.steps().slice(-2), ['apply', 'post-apply-inspect']);
    assert.ok(result.details.post_apply_inspect);
    assert.equal(result.details.applied, undefined);
  }
});

test('a post-apply inspect that does not show the intended state fails the run', async () => {
  const pin = executePin('sql80');
  const { result } = await oneShot({
    responses: { 'post-apply-inspect': () => ({ status: 0, stdout: json({ ok: true, details: inspectDetails('sql80', pin) }), stderr: '' }) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.details.stopped_at, 'post-apply-inspect');
  assert.equal(result.details.applied, undefined);
});

// --- source tree vs tarball (real tar) -----------------------------------------------------

function makeTree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'one-shot-tree-'));
  const src = path.join(base, 'src');
  const long = `node_modules/${'very-long-package-name-'.repeat(5)}/dist/${'nested-'.repeat(10)}/index.js`;
  for (const [rel, text] of [['a.txt', 'a'], ['dir/b.mjs', 'export default 1;\n'], [long, 'long']]) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), text);
  }
  fs.symlinkSync('b.mjs', path.join(src, 'dir/link.mjs'));
  const tarball = path.join(base, `source-${COMMIT}.tar.gz`);
  const res = spawnSync('tar', ['-czf', tarball, '-C', src, '.']);
  assert.equal(res.status, 0, String(res.stderr));
  const extracted = path.join(base, 'x');
  fs.mkdirSync(extracted);
  assert.equal(spawnSync('tar', ['-xzf', tarball, '-C', extracted]).status, 0);
  return { tarball, extracted, long };
}

test('the extracted tree must be exactly the tarball', async () => {
  const { tarball, extracted, long } = makeTree();
  const same = await compareTreeToTarball(extracted, tarball);
  assert.equal(same.ok, true, JSON.stringify(same.details));
  assert.equal(same.details.tarball_files, 3);

  fs.mkdirSync(path.join(extracted, '.deployment-guard/receipts'), { recursive: true });
  fs.writeFileSync(path.join(extracted, '.deployment-guard/receipts/x.json'), '{}');
  assert.equal((await compareTreeToTarball(extracted, tarball)).ok, true, 'local guard state is ignored');

  fs.writeFileSync(path.join(extracted, 'dir/extra.mjs'), 'planted');
  let res = await compareTreeToTarball(extracted, tarball);
  assert.equal(res.ok, false);
  assert.deepEqual(res.details.extra, ['dir/extra.mjs']);
  fs.rmSync(path.join(extracted, 'dir/extra.mjs'));

  fs.writeFileSync(path.join(extracted, long), 'changed');
  res = await compareTreeToTarball(extracted, tarball);
  assert.equal(res.code, CODES.SOURCE_RECONCILIATION_REQUIRED);
  assert.deepEqual(res.details.differing, [long]);
  fs.writeFileSync(path.join(extracted, long), 'long');

  fs.rmSync(path.join(extracted, 'a.txt'));
  res = await compareTreeToTarball(extracted, tarball);
  assert.deepEqual(res.details.missing, ['a.txt']);
  fs.writeFileSync(path.join(extracted, 'a.txt'), 'a');

  fs.rmSync(path.join(extracted, 'dir/link.mjs'));
  fs.symlinkSync('../a.txt', path.join(extracted, 'dir/link.mjs'));
  res = await compareTreeToTarball(extracted, tarball);
  assert.deepEqual(res.details.differing, ['dir/link.mjs']);

  const garbage = path.join(path.dirname(tarball), 'garbage.tar.gz');
  fs.writeFileSync(garbage, 'nope');
  assert.equal((await compareTreeToTarball(extracted, garbage)).code, CODES.STALE_PACKAGE);
});

test('tar entry names cannot escape the tree', () => {
  assert.equal(normalizeTarPath('./a/b'), 'a/b');
  assert.equal(normalizeTarPath('./'), '');
  assert.throws(() => normalizeTarPath('/etc/passwd'));
  assert.throws(() => normalizeTarPath('./a/../../x'));
});

// --- helpers, CLI and registration ---------------------------------------------------------

test('output parsers', () => {
  assert.deepEqual(parseTapSummary(tap(4)), { tests: 4, pass: 4, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.equal(parseTapSummary('nothing').tests, null);
  assert.deepEqual(parseJsonOutput('{"ok":true}'), { ok: true });
  assert.deepEqual(parseJsonOutput('warning line\n{\n  "ok": false\n}\n'), { ok: false });
  assert.equal(parseJsonOutput('not json'), null);
});

test('the CLI refuses positional arguments and forwards to the orchestrator', async () => {
  const writes = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    assert.equal(await oneShotMain(['--phase', 'apply', '--', 'node', 'evil.mjs'], {}, { run: () => assert.fail('no child') }), 1);
    assert.equal(await oneShotMain(['--migration', 'sql80', '--receipt', RECEIPT], {}, { run: () => assert.fail('no child') }), 1);
  } finally {
    process.stderr.write = orig;
  }
  assert.match(writes[0], /positional arguments are not accepted/);
  assert.match(writes[1], /unknown flag/);
});

test('the one-shot is inventoried and never connects or applies SQL itself', () => {
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/bypass-inventory.json'), 'utf8'));
  const row = inventory.scripts.find((r) => r.path === 'scripts/deployment-guard/production-sql-one-shot.mjs');
  assert.equal(row?.classification, 'GUARDED');
  for (const rel of ['scripts/deployment-guard/production-sql-one-shot.mjs', 'scripts/deployment-guard/lib/production-sql-one-shot.mjs']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(text, /from '(?:pg|@aws-sdk\/[^']+)'/, rel);
    assert.doesNotMatch(text, /createProductionDatabaseConnect|resolve\w*DatabaseUrl|issueReceipt|writeReceipt|consumeReceiptOnce/, rel);
  }
});
