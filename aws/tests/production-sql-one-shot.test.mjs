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
  CHILD_ENV_ALLOWLIST,
  GUARD_ENV_KEYS,
  LOADER_ENV_KEYS,
  ONE_SHOT_EXCEPTION,
  ONE_SHOT_TOOLS,
  compareTreeToTarball,
  normalizeTarPath,
  parseJsonOutput,
  parseTapSummary,
  requiredContracts,
  runProductionSqlOneShot,
} from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { evaluateMemberStakeholderProductionApply } from '../../scripts/deployment-guard/lib/sql-member-stakeholder-production-apply.mjs';
import { evaluateSql71ProductionApply } from '../../scripts/deployment-guard/lib/sql71-review-amount-production-apply.mjs';
import { evaluateSql80ProductionApply } from '../../scripts/deployment-guard/lib/sql80-checkalt-production-apply.mjs';
import { evaluateSql81ProductionApply } from '../../scripts/deployment-guard/lib/sql81-checkalt-production-apply.mjs';
import { evaluateSql82ProductionApply } from '../../scripts/deployment-guard/lib/sql82-homeowner-ledger-production-apply.mjs';
import { evaluateSql83ProductionApply } from '../../scripts/deployment-guard/lib/sql83-homeowner-signing-production-apply.mjs';
import { evaluateSql84ProductionApply } from '../../scripts/deployment-guard/lib/sql84-mortgage-return-to-queue-production-apply.mjs';
import { evaluateSql85ProductionApply } from '../../scripts/deployment-guard/lib/sql85-mortgage-compensation-adjust-production-apply.mjs';
import { evaluateSql86ProductionApply } from '../../scripts/deployment-guard/lib/sql86-mortgage-compensation-owner-only-production-apply.mjs';
import { evaluateSql87ProductionApply } from '../../scripts/deployment-guard/lib/sql87-resolve-check-case-tenant-scope-production-apply.mjs';
import { evaluateSql88ProductionApply } from '../../scripts/deployment-guard/lib/sql88-claim-id-assign-case-tenant-scope-production-apply.mjs';
import { evaluateSql89ProductionApply } from '../../scripts/deployment-guard/lib/sql89-check-intake-column-update-production-apply.mjs';
import { RELEASE_PRODUCTION, evaluateReleaseProductionApply } from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { LIBRARY_PRODUCTION, evaluateLibraryProductionApply } from '../../scripts/deployment-guard/lib/sql29-sql30-library-production-apply.mjs';
import { main as oneShotMain } from '../../scripts/deployment-guard/production-sql-one-shot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMMIT = 'a'.repeat(40);
const WORKSTREAM = 'prod-sql80-checkalt-member-auto-deposit-20261016';
const STATEMENT = 'approve applying SQL 80 to production';
const RECEIPT = path.join(receiptDir(ROOT), 'production::production-sql.json');

// The registered tools with their own evaluator (sql77-79 share the member-stakeholder one).
const EVALUATORS = Object.freeze({
  // SQL 29 and SQL 30 share the library evaluator.
  ...Object.fromEntries(Object.keys(LIBRARY_PRODUCTION).map((key) => [key, (input, opts) => evaluateLibraryProductionApply(key, input, opts)])),
  sql71: evaluateSql71ProductionApply,
  sql80: evaluateSql80ProductionApply,
  sql81: evaluateSql81ProductionApply,
  sql82: evaluateSql82ProductionApply,
  sql83: evaluateSql83ProductionApply,
  sql84: evaluateSql84ProductionApply,
  sql85: evaluateSql85ProductionApply,
  sql86: evaluateSql86ProductionApply,
  sql87: evaluateSql87ProductionApply,
  sql88: evaluateSql88ProductionApply,
  sql89: evaluateSql89ProductionApply,
  // SQL 90-97 share the release evaluator.
  ...Object.fromEntries(Object.keys(RELEASE_PRODUCTION).map((key) => [key, (input, opts) => evaluateReleaseProductionApply(key, input, opts)])),
});
const realPin = (key) => JSON.parse(fs.readFileSync(path.join(ROOT, ONE_SHOT_TOOLS[key].pin_rel), 'utf8'));
// A pin whose staging acceptance is still pending (SQL 71 today) gets a placeholder
// reference in the execute-authorized test copy, and a pin whose pre-state is not recorded
// (expected_live_definition_sha256 null, SQL 71 today) a placeholder hash; the committed pins are checked to
// refuse below.
const FIXTURE_STAGING_ACCEPTANCE = Object.freeze({ ok: true, reference: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000', basis: 'test fixture' });
const FIXTURE_EXPECTED_LIVE = 'e'.repeat(64);
const executePin = (key, extra = {}) => {
  const pin = realPin(key);
  const stagingAcceptance = pin.staging_acceptance?.ok === true ? pin.staging_acceptance : FIXTURE_STAGING_ACCEPTANCE;
  const expected = pin.expected_live_definition_sha256 ?? FIXTURE_EXPECTED_LIVE;
  // A pending pin, or one retired after its apply ("Applied to production …"), gets the test approval.
  const authorization = pin.authorization === 'pending' || /^Applied to production /.test(pin.authorization) ? 'owner-approved test fixture' : pin.authorization;
  return { ...pin, execute: true, authorization, staging_acceptance: stagingAcceptance, expected_live_definition_sha256: expected, ...extra };
};

function tarballFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-shot-tarball-'));
  const file = path.join(dir, `source-${COMMIT}.tar.gz`);
  fs.writeFileSync(file, 'not really a tarball');
  const sha = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(`${file}.sha256`, `${sha}  source-${COMMIT}.tar.gz\n`);
  return { file, sha };
}

const { file: TARBALL, sha: TARBALL_SHA } = tarballFixture();
const tap = (n, { fail = 0, skipped = 0 } = {}) => `TAP version 13\n1..${n}\n# tests ${n}\n# suites 0\n# pass ${n - fail - skipped}\n# fail ${fail}\n# cancelled 0\n# skipped ${skipped}\n# todo 0\n`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The SQL 29 / SQL 30 tools' --inspect shape (inspectLibraryProduction): no
 * missing_dependencies or predecessors fields; prerequisites_missing, sql90_applied and
 * the sql29 / sql30 catalog reports instead.
 */
function libraryInspectDetails(key, pin, overrides = {}) {
  return {
    read_only: true,
    migration: key,
    filename: pin.filename,
    counts: { mortgage_request_library_documents: 0, rows_outside_sql30_values: 0 },
    source_ok: true,
    pin_execute: true,
    current_user: 'checksops_admin',
    session_user: 'checksops_admin',
    admin_login: 'checksops_admin',
    prerequisites_missing: [],
    sql90_applied: false,
    sql29: { live_definition_sha256: key === 'sql29' ? pin.expected_live_definition_sha256 : 'f'.repeat(64), functions_present: 0 },
    sql30: { live_definition_sha256: key === 'sql30' ? pin.expected_live_definition_sha256 : 'f'.repeat(64), check_shape: 'predecessor_6' },
    live_definition_sha256: pin.expected_live_definition_sha256,
    expected_live_definition_sha256: pin.expected_live_definition_sha256 ?? null,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    live_matches_expected: true,
    already_applied: false,
    precondition_failures: [],
    apply_preconditions_met: true,
    ...overrides,
  };
}

function inspectDetails(key, pin, overrides = {}) {
  if (Object.hasOwn(LIBRARY_PRODUCTION, key)) return libraryInspectDetails(key, pin, overrides);
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
  const manifests = [];
  const run = (call) => {
    calls.push(call);
    const input = call.args.indexOf('--input');
    if (input !== -1) manifests.push({ step: call.step, text: fs.readFileSync(call.args[input + 1], 'utf8') });
    const kind = call.step.startsWith('contract:') ? 'contract' : call.step;
    const answer = responses[call.step] || responses[kind] || defaults[kind];
    return answer(call);
  };
  return { run, calls, manifests, steps: () => calls.map((c) => c.step) };
}

function opts(key = 'sql80', extra = {}) {
  return {
    migration: key,
    commit: COMMIT,
    'workstream-id': WORKSTREAM,
    'approval-statement': STATEMENT,
    'approval-scope': key,
    phase: 'apply',
    'source-tarball': TARBALL,
    'expected-tarball-sha256': TARBALL_SHA,
    operator: 'michaelcarletta-cmd',
    runner: 'i-0c35557c4e5385406',
    ...extra,
  };
}

async function oneShot({ key = 'sql80', o = {}, pin, responses, env = { PATH: '/usr/bin', AWS_ENDPOINT_URL_SECRETS_MANAGER: 'https://vpce.example' }, compareTree, sourceCommit = `${COMMIT}\n`, execArgv } = {}) {
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
    readTarball: async () => ({ sha256: TARBALL_SHA, index: new Map() }),
    compareTreeToIndex: compareTree || (async () => ({ ok: true, details: { tarball_files: 3, tarball_entries: 4 } })),
    readSourceCommit: () => sourceCommit,
    ...(execArgv ? { execArgv } : {}),
  });
  return { result, runner, tmpDir };
}

const CONTRACT_STEPS = ['contract:claim-ledger', 'contract:tenant-isolation', 'contract:financial-write-protections'];
const FULL = ['inspect', ...CONTRACT_STEPS, 'preflight', 'evaluate', 'apply', 'post-apply-inspect'];
const lastManifest = (runner) => JSON.parse(runner.manifests.at(-1).text);

// --- happy paths ----------------------------------------------------------------

test('apply phase runs every step in order and prints a pin-ready applied block', async () => {
  const { result, runner } = await oneShot();
  assert.equal(result.ok, true, JSON.stringify(result.details.error));
  assert.deepEqual(runner.steps(), FULL);
  const d = result.details;
  assert.deepEqual(d.steps.map((s) => s.step), ['pin', 'source', 'inspect', 'contracts', 'manifest', 'source-recheck-before-preflight', 'preflight', 'evaluate', 'source-recheck-before-apply', 'apply', 'post-apply-inspect']);
  assert.equal(d.source.tarball_sha256, TARBALL_SHA);
  assert.equal(d.source.tarball_sha256_matches_expected, true);
  assert.equal(d.source.source_commit, COMMIT);
  assert.equal(d.manifest_deleted, true);
  assert.equal(fs.existsSync(path.dirname(d.manifest_file)), false, 'the manifest temp dir is deleted');
  assert.match(d.manifest_sha256, /^[0-9a-f]{64}$/);
  assert.equal(d.receipt_issued, true);
  const applied = d.applied;
  const pin = realPin('sql80');
  assert.equal(applied.result, 'applied');
  assert.equal(applied.date, '2026-10-16');
  assert.equal(applied.source_commit, COMMIT);
  assert.match(applied.source_commit_basis, /SOURCE_COMMIT/);
  assert.match(applied.source_commit_basis, /--expected-tarball-sha256/);
  assert.equal(applied.operator, 'michaelcarletta-cmd');
  assert.equal(applied.workstream_id, WORKSTREAM);
  assert.equal(applied.owner_approval, STATEMENT);
  assert.match(applied.owner_approval_basis, /cannot verify/);
  assert.match(applied.owner_approval_basis, /--approval-scope sql80/);
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
  assert.equal(applied.contract_results['financial-write-protections'].evidence, `36/36 on i-0c35557c4e5385406 (operator-supplied --runner (not verified by the one-shot)) at ${COMMIT} (production-sql-one-shot run-1, node --test)`);
  assert.ok(d.not_observed_by_this_run.some((row) => row.startsWith('ssm_command_id')));
  assert.ok(d.not_observed_by_this_run.some((row) => row.startsWith('source_staged_by')));
});

test('runner defaults to the hostname and says so', async () => {
  const { result } = await oneShot({ o: { runner: undefined } });
  assert.equal(result.ok, true);
  assert.equal(result.details.applied.runner, os.hostname());
  assert.match(result.details.applied.runner_basis, /os\.hostname/);
  assert.match(result.details.applied.contract_results['claim-ledger'].evidence, /\(os\.hostname\(\) of the host/);
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
    const modes = [];
    const { result, runner } = await oneShot({
      key,
      o: { 'workstream-id': workstream },
      responses: { preflight: (call) => {
        modes.push(fs.statSync(call.args.at(-1)).mode & 0o777);
        return { status: 0, stdout: json({ ok: true, details: { receipt: RECEIPT } }), stderr: '' };
      } },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(modes, [0o600]);
    assert.deepEqual(runner.manifests.map((m) => m.step), ['preflight', 'evaluate', 'apply'], 'every child reads the same manifest');
    assert.equal(new Set(runner.manifests.map((m) => m.text)).size, 1);
    const manifest = lastManifest(runner);
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
    const evaluation = EVALUATORS[key]
      ? await EVALUATORS[key](manifest, { root: ROOT, pin })
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
  const { result, runner } = await oneShot({ o: { 'approval-statement': exact } });
  assert.equal(result.ok, true);
  assert.equal(result.details.applied.owner_approval, exact);
  assert.equal(lastManifest(runner).approval.statement, exact);
});

test('--approval-statement-b64 carries the exact words; it is exclusive with --approval-statement', async () => {
  const words = "merged, \"approve\" applying SQL 80 to production — it's fine\n";
  const b64 = Buffer.from(words, 'utf8').toString('base64');
  const { result, runner } = await oneShot({ o: { 'approval-statement': undefined, 'approval-statement-b64': b64 } });
  assert.equal(result.ok, true, JSON.stringify(result.details.error));
  assert.equal(result.details.applied.owner_approval, words);
  assert.equal(lastManifest(runner).approval.statement, words);
  for (const o of [
    { 'approval-statement-b64': b64 },
    { 'approval-statement': undefined, 'approval-statement-b64': 'not base64!' },
    { 'approval-statement': undefined, 'approval-statement-b64': 'YWJj' + '=' },
    { 'approval-statement': undefined, 'approval-statement-b64': Buffer.from([0xff, 0xfe]).toString('base64') },
    { 'approval-statement': undefined, 'approval-statement-b64': Buffer.from('   ').toString('base64') },
    { 'approval-statement': undefined, 'approval-statement-b64': true },
  ]) {
    const res = await oneShot({ o });
    assert.equal(res.result.ok, false, JSON.stringify(o));
    assert.equal(res.result.details.stopped_at, 'arguments');
    assert.equal(res.runner.calls.length, 0);
  }
});

test('--approval-scope must name the migration being run', async () => {
  for (const scope of [undefined, 'sql79', 'SQL80', '', true]) {
    const { result, runner } = await oneShot({ o: { 'approval-scope': scope } });
    assert.equal(result.ok, false, String(scope));
    assert.match(result.details.error.details.errors.join('\n'), /--approval-scope/);
    assert.equal(runner.calls.length, 0);
  }
  const { result } = await oneShot({ key: 'sql79', o: { 'workstream-id': 'prod-sql79-scope-test' } });
  assert.equal(result.ok, true);
  assert.equal(result.details.approval_scope, 'sql79');
});

test('a receipt, manifest or input can never be passed in', async () => {
  for (const flag of ['receipt', 'receipt-path', 'input', 'json', 'manifest', 'financial-write-evidence', 'skip-contracts']) {
    const { result, runner } = await oneShot({ o: { [flag]: '/tmp/x.json' } });
    assert.equal(result.ok, false, flag);
    assert.equal(result.code, CODES.INVALID_MANIFEST, flag);
    assert.deepEqual(result.details.error.details.unknown, [flag]);
    assert.equal(runner.calls.length, 0, flag);
  }
  for (const key of [...GUARD_ENV_KEYS, 'CHECKSOPS_DEPLOYMENT_GUARD_KMS_PUBLIC_KEY_DER_B64', 'CHECKSOPS_DEPLOYMENT_GUARD_ANYTHING_NEW']) {
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
    { 'expected-tarball-sha256': undefined },
    { 'expected-tarball-sha256': TARBALL_SHA.toUpperCase() },
    { 'expected-tarball-sha256': 'abc' },
    { operator: undefined },
    { operator: '  ' },
    { runner: true },
    { migration: '__proto__', 'approval-scope': '__proto__' },
    { migration: 'constructor', 'approval-scope': 'constructor' },
    { migration: 'hasOwnProperty', 'approval-scope': 'hasOwnProperty' },
  ]) {
    const { result, runner } = await oneShot({ o });
    assert.equal(result.ok, false, JSON.stringify(o));
    assert.equal(result.details.stopped_at, 'arguments');
    assert.equal(runner.calls.length, 0);
  }
});

test('node loader variables and node flags are refused before any child', async () => {
  for (const key of [...LOADER_ENV_KEYS, 'DYLD_INSERT_LIBRARIES']) {
    const { result, runner } = await oneShot({ env: { PATH: '/usr/bin', [key]: '--require /tmp/evil.js' } });
    assert.equal(result.ok, false, key);
    assert.equal(result.code, CODES.DEPLOYMENT_GUARD_REQUIRED, key);
    assert.deepEqual(result.details.error.details.preset, [key]);
    assert.equal(runner.calls.length, 0, key);
  }
  const { result, runner } = await oneShot({ execArgv: ['--import', '/tmp/evil.mjs'] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.details.error.details.exec_argv, ['--import', '/tmp/evil.mjs']);
  assert.equal(runner.calls.length, 0);
});

test('children get only the allowlisted environment', async () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/root',
    TZ: 'UTC',
    AWS_REGION: 'us-east-1',
    AWS_ENDPOINT_URL_SECRETS_MANAGER: 'https://vpce.example',
    CHECKSOPS_COMMIT: 'b'.repeat(40),
    CHECKSOPS_WORKSTREAM_ID: 'other-workstream',
    NODE_EXTRA_CA_CERTS: '/tmp/ca.pem',
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    SOMETHING_ELSE: 'x',
  };
  const { result, runner } = await oneShot({ env });
  assert.equal(result.ok, true);
  const expected = { PATH: '/usr/bin', HOME: '/root', TZ: 'UTC', AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL_SECRETS_MANAGER: 'https://vpce.example' };
  for (const call of runner.calls) {
    const { CHECKSOPS_DEPLOYMENT_GUARD_APPLY, CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT, ...rest } = call.env;
    assert.deepEqual(rest, expected, call.step);
    for (const key of Object.keys(call.env)) {
      assert.ok(CHILD_ENV_ALLOWLIST.includes(key) || (call.step === 'apply' && key.startsWith('CHECKSOPS_DEPLOYMENT_GUARD_')), `${call.step} ${key}`);
    }
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

// SQL 106's pin was execute-authorized (owner-approved pin change of 2026-10-21, #1120: the read-only
// production inspect SSM 4539d0f0 recorded as its pre-state, owner-accepted substitute staging
// evidence) and SQL 97's (owner approved 2026-10-21, #1112) until their record-and-retire change after
// their 2026-10-21 applies (SQL 106 first; SQL 97 had stopped at an earlier inspect on
// other_write_grants). SQL 95's and SQL 99's pins were (owner approved
// 2026-10-21) until their record-and-retire change after their 2026-10-21 applies. SQL 82's to 86's
// pins were (owner approved 2026-10-16) until
// their record-and-retire change of 2026-10-21 (result verified_live: production state verified by
// read-only inspects of 2026-10-21); every other pin is execute false (SQL 87, SQL 88 and SQL 89 retired
// after their 2026-10-16 applies, SQL 103, SQL 29, SQL 30, SQL 91, SQL 92, SQL 90, SQL 101, SQL 93,
// SQL 96, SQL 94, SQL 104 and SQL 98 after their 2026-10-19 applies, SQL 102 and SQL 105 after their
// 2026-10-20 applies, SQL 95, SQL 99, SQL 106 and SQL 97 after their 2026-10-21 applies).
// SQL 108's pin was execute-authorized (owner-approved pin change of 2026-10-21, #1132, "apply SQL 108
// in production then ...": the read-only production inspect SSM 6d0fb8ce recorded as its pre-state, the
// guarded staging apply run 39662760919 from the same pre-state) until its record-and-retire change
// after its 2026-10-21 apply.
// SQL 109's pin was execute-authorized (owner-approved pin change of 2026-10-21, #1143, "apply SQL 109
// in production": the read-only production inspect SSM 57c033fc recorded as its pre-state, the guarded
// staging apply run 39673516794 from the same pre-state) until its record-and-retire change after its
// 2026-10-21 apply.
// SQL 110's pin was execute-authorized (owner-approved pin change of 2026-10-22, #1167, "apply SQL 110
// in production": the read-only production inspect SSM 85ee4f39 recorded as its pre-state, the guarded
// staging apply run 39838878110 from the same pre-state) until its record-and-retire change after its
// 2026-10-22 apply.
// SQL 111's pin was execute-authorized (owner-approved pin change of 2026-10-23, #1177, "Run
// production": the read-only production inspect SSM 7e6fdcf5 recorded as its pre-state, the guarded
// staging apply run 39877945144 from the same pre-state) until its record-and-retire change after its
// 2026-10-23 apply.
// SQL 112's pin was execute-authorized (owner-approved pin change of 2026-10-23, #1190, "applying SQL
// 112 for parity.": the read-only production inspect SSM a868258f recorded as its pre-state, the
// guarded staging apply run 39967007467 from a different pre-state accepted as substitute evidence)
// until its record-and-retire change after its 2026-10-23 apply.
// SQL 113's pin was execute-authorized (owner-approved pin change of 2026-10-23, #1208, "Approve SQL
// 113 for production": the read-only production inspect SSM 8ee0c634 recorded as its pre-state, the
// guarded staging apply run 40022413642 from the same pre-state) until its record-and-retire change
// after its 2026-10-23 apply.
// SQL 114's pin was execute-authorized (owner-approved pin change of 2026-10-25, #1234, "approve SQL
// 114 production apply": the read-only production inspect SSM f4d57070 recorded as its pre-state, the
// guarded staging apply run 40154043207 from the same pre-state) until its record-and-retire change
// after its 2026-10-25 apply.
// SQL 116's pin was execute-authorized (owner-approved pin change of 2026-10-26, #1266, "build the
// SQL 116 pin PR": the read-only production inspect SSM 5120ddac recorded as its pre-state, the
// guarded staging apply run 40339373370 from the same pre-state) until its record-and-retire change
// after its 2026-10-26 apply.
// SQL 118's pin was execute-authorized (owner-approved pin change of 2026-10-27, #1283: the read-only
// production inspect SSM 7e8004f8 recorded as its pre-state, the guarded staging apply run
// 40438147297 from the same pre-state) until its record-and-retire change after its 2026-10-27 apply.
// SQL 119's pin was execute-authorized (owner-approved pin change of 2026-10-27, #1289, "Approve a pin PR
// for SQL 119, then one for SQL 115": the read-only production inspect SSM 0019857c recorded as its
// pre-state, the guarded staging read-live run 40501861802, already in the intended state there) until
// its record-and-retire change after its 2026-10-27 apply.
// SQL 115's pin was execute-authorized (owner-approved pin change of 2026-10-27, #1290: the read-only
// production inspect SSM 6f6692d8, after SQL 119, recorded as its pre-state, the guarded staging apply
// run 40243363235, whose pre-state differs only in the EXECUTE ACL) until its record-and-retire change
// after its 2026-10-27 apply.
const EXECUTE_AUTHORIZED = Object.freeze([]);
// SQL 95's and SQL 99's production applies of 2026-10-21 (main dcd865256) and SQL 106's and SQL 97's
// (main 7124a160b; both runs passed the SQL 106 workstream id), recorded in applied.
const APPLIED_2026_10_21 = Object.freeze({
  sql95: Object.freeze({ ssm: '2f1530c2-0cf9-42a9-8fef-685b5e83589a', run: '3b4fe182-94bd-494f-b411-af75f4f3ce92', one_use_id: 'sql95-prod-d04849eb-31b3-4657-a622-d0ffa030207d', workstream: 'prod-sql95-remove-freedom-claims-bridge-20261021', approval: 'apply SQL 97, 95 and 99 in production' }),
  sql99: Object.freeze({ ssm: 'fa655042-6ae1-41e6-96cc-a5b3ed61f4a8', run: 'bfb0c630-87a6-46f8-819d-4155a7b54640', one_use_id: 'sql99-prod-56ce276e-16ea-49c5-9d44-7746a5a9c673', workstream: 'prod-sql99-mortgage-desk-completion-messages-20261021', approval: 'apply SQL 97, 95 and 99 in production' }),
  sql106: Object.freeze({ ssm: '43070c9e-2bb5-4e49-80f3-97fe6f35e3d0', run: '0ae3e5dc-a34f-4799-ba75-d79a9b2ade28', one_use_id: 'sql106-prod-c994fcc1-bbff-414b-bfad-3b864d96d4a6', workstream: 'prod-sql106-financial-stepup-log-append-only-20261021', approval: 'apply SQL 106 and SQL 97 in production' }),
  sql97: Object.freeze({ ssm: '0a7a1b66-47c4-4fa8-8380-9b60296360f5', run: '9834d407-6758-486d-9f3f-bc85ec6e129f', one_use_id: 'sql97-prod-87263eb2-8523-4646-9a28-d7a4d22e38c8', workstream: 'prod-sql106-financial-stepup-log-append-only-20261021', approval: 'apply SQL 106 and SQL 97 in production' }),
  // SQL 108's production apply of 2026-10-21 (main 970d514bc).
  sql108: Object.freeze({ ssm: '9b6a1df3-6146-464e-9f37-995faaf739e0', run: 'ee45c3a0-71d6-4821-952b-5c92c0e706b5', one_use_id: 'sql108-prod-aa304e1f-6e2d-4e90-900d-99207be30bd6', workstream: 'prod-sql108-check-intake-items-funds-type-values-20261021', approval: 'apply SQL 108 in production' }),
  // SQL 109's production apply of 2026-10-21 (main 513585432).
  sql109: Object.freeze({ ssm: '5da87122-dc6b-4e08-b799-1abc17ee14eb', run: '6a7ba5c9-98f6-44e8-958d-fd3292a3f96d', one_use_id: 'sql109-prod-40ec7c00-60a0-4825-9129-66f43914c3ba', workstream: 'prod-sql109-moov-transfer-webhook-status-20261021', approval: 'apply SQL 109 in production' }),
  // SQL 110's production apply of 2026-10-22 (main e29b971fb), kept with the 2026-10-21 ones.
  sql110: Object.freeze({ ssm: 'dff74531-5a77-4f17-9027-e927f7f10644', run: '04f2dadf-1866-492e-a9e9-d301a2766b2b', one_use_id: 'sql110-prod-a04eae17-2564-42ba-87a1-51bc200582ff', workstream: 'prod-sql110-homeowner-preclaim-links-20261022', approval: 'apply SQL 110 in production' }),
  // SQL 116's production apply of 2026-10-26 (main f403dbdfd), kept with the 2026-10-21 ones.
  sql116: Object.freeze({ ssm: '8a72e2fc-c769-4ebf-9f00-64feb23d1df4', run: 'c415fcce-e3ac-4b65-9312-61763899f9b1', one_use_id: 'sql116-prod-95c04535-a6bc-4311-9ac5-50422f3cd1e6', workstream: 'prod-sql116-moov-onboarding-profile-industry-20261026', approval: 'apply SQL 116 in production' }),
  // SQL 115's production apply of 2026-10-27 (main 40678dc44), after SQL 119's.
  sql115: Object.freeze({ ssm: 'bf96510f-4f95-42d5-974b-cf99d9a952ac', run: '250cdbb8-0e46-42c8-a4a8-4a9a646ff07a', one_use_id: 'sql115-prod-2ee1c7dd-6d5b-4f25-a4ce-19a1a64be13e', workstream: 'prod-sql115-provider-stakeholder-one-partner-payout-20261027', approval: 'AWS reconnected, apply SQL 115 in production' }),
  // SQL 119's production apply of 2026-10-27 (main a01deea9b).
  sql119: Object.freeze({ ssm: '2a047b4d-b43b-45c4-8152-1bd4372daed9', run: '924b34f9-4fc6-446f-9190-e4bd9529cac8', one_use_id: 'sql119-prod-ffb5846b-682d-400b-8b49-323215e196f5', workstream: 'prod-sql119-provider-stakeholder-sync-acl-20261027', approval: 'Apply in production: SQL 119 first, then SQL 115' }),
  // SQL 118's production apply of 2026-10-27 (main 4d9763eff).
  sql118: Object.freeze({ ssm: '9bccc7c9-9fe2-4e6f-988d-a778f07b1607', run: 'a47888ef-daf8-4add-adac-3a703176b67d', one_use_id: 'sql118-prod-327fe57a-22b1-452f-afdc-6c52b653f153', workstream: 'prod-sql118-tenant-lifecycle-20261027', approval: 'Apply SQL 118 in production' }),
  // SQL 114's production apply of 2026-10-25 (main 9fa66403c), kept with the 2026-10-21 ones.
  sql114: Object.freeze({ ssm: 'f32cfcbd-c69e-46a7-958c-0cf3d1510d91', run: '65090c03-0403-4a95-92e4-3687e7f173b5', one_use_id: 'sql114-prod-a664d4c7-f0ce-4876-9b88-39b11c6a9701', workstream: 'prod-sql114-stakeholder-settings-20261025', approval: 'approve SQL 114 production apply' }),
  // SQL 113's production apply of 2026-10-23 (main 09425a013), kept with the 2026-10-21 ones.
  sql113: Object.freeze({ ssm: '9f209788-6247-47ed-bc6e-838d5791a42e', run: '594619a2-671f-45f5-a260-7f991d5007ef', one_use_id: 'sql113-prod-86f11689-ab1d-4459-9f15-10ff2d135818', workstream: 'prod-sql113-payee-setup-20261023', approval: 'apply SQL 113 in production and merge 1209 when green' }),
  // SQL 112's production apply of 2026-10-23 (main 4d2cf0c11), kept with the 2026-10-21 ones.
  sql112: Object.freeze({ ssm: '654fb07f-7c95-4828-ad95-7fce135f1d27', run: '3f3f7d9d-51df-458f-b9fe-49b4bc91f841', one_use_id: 'sql112-prod-95240935-fac1-4d76-b727-7fd1f2f55bf4', workstream: 'prod-sql112-moov-invoice-table-grants-20261023', approval: 'apply SQL 112 in production' }),
  // SQL 111's production apply of 2026-10-23 (main 8f534384e), kept with the 2026-10-21 ones.
  sql111: Object.freeze({ ssm: 'c006d74b-7c52-4e6f-972f-b17afcc448cf', run: '4bf98369-6fd4-477a-8d04-30a7952f977c', one_use_id: 'sql111-prod-761afdca-3fd7-4e7b-932a-bce2369faff6', workstream: 'prod-sql111-tenant-referral-codes-20261023', approval: 'apply SQL 111 in production' }),
});
const VERIFIED_LIVE_RETIRED = Object.freeze(['sql82', 'sql83', 'sql84', 'sql85', 'sql86']);
const VERIFIED_LIVE_SSM = Object.freeze({
  sql82: '65da22f4-495e-4186-8860-ef052c255243',
  sql83: '65da22f4-495e-4186-8860-ef052c255243',
  sql84: 'ab678be8-7fd3-4f7d-a6d0-ed905cfed9aa',
  sql85: 'ab678be8-7fd3-4f7d-a6d0-ed905cfed9aa',
  sql86: 'ab678be8-7fd3-4f7d-a6d0-ed905cfed9aa',
});

test('every real production pin with execute false is refused before any child', async () => {
  // Every pin is retired or pending (execute false): SQL 82's to 86's since their 2026-10-21 record-and-retire change, SQL 81's since its 2026-10-15 record-and-retire change, SQL 87's, SQL 88's and SQL 89's since their 2026-10-16 applies, SQL 103's, SQL 29's and SQL 30's since their 2026-10-19 applies, SQL 71's pending.
  assert.deepEqual(Object.keys(ONE_SHOT_TOOLS).filter((key) => realPin(key).execute !== false), [...EXECUTE_AUTHORIZED]);
  for (const key of Object.keys(ONE_SHOT_TOOLS).filter((k) => realPin(k).execute === false)) {
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
  // SQL 81's pin without its recorded staging acceptance stops at the pin even with execute true.
  const sql81 = realPin('sql81');
  assert.equal(sql81.staging_acceptance.ok, true);
  const pending = { ...sql81, execute: true, staging_acceptance: { ok: false, reference: null, basis: 'Pending' } };
  const { result, runner } = await oneShot({ key: 'sql81', pin: pending, o: { 'workstream-id': 'prod-sql81-pending-test' } });
  assert.equal(result.ok, false);
  assert.equal(result.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal(result.details.stopped_at, 'pin');
  assert.equal(runner.calls.length, 0);
  // SQL 82's to 86's committed pins are retired (verified_live), and SQL 90's, SQL 101's, SQL 93's and SQL 96's are retired, and SQL 87's, SQL 88's, SQL 89's,
  // SQL 103's, SQL 29's, SQL 30's, SQL 91's and SQL 92's are retired after their applies; their pre-authorization state (no staging
  // acceptance, authorization "pending") is an explicit copy here. SQL 71's committed pin is
  // still pending, with no recorded pre-state (null). Even with execute flipped that state
  // stops at the pin, and the evaluators refuse a null pre-state (explicit copy) and the
  // pending authorization (with a placeholder pre-state for SQL 71).
  const RECORDED_PRODUCTION_PRE = {
    sql71: null,
    sql87: '9f264af15a4e912d6b0aef85afbb8f17bea7f322230ddf4e8616b4fb4c19a68f',
    sql88: 'ef7a3e027b63761b2b35a3fdad62d5eacf18f292bc77886f820eb61f70584d1b',
    sql89: 'c22a75fa2535712f1ef9b2210a8c3f6bd8576b5b255a9a01c6e352e7369cc8c4',
    sql82: '9892d5ca12b426c303fdfdd4f92c9ef9a2a84ab94031989b09ee6c860a981229',
    sql83: 'c01704546922410e1f08088b39c69f02fbe004dcb919b12635d0908eb34e7936',
    sql84: '53a0fa9f2b9cb126b3852a8b0595504fb74947c46a5a8390d67b46d7d67ad496',
    sql85: '7d5e766cf30a46e2925af225e9c2c19ee3cdb9a84ccf2685c23393f7cc06ee2d',
    sql86: 'c982ece2661a85293c2122c3aaf8226050d3c6670c436c94e34b870292289d0b',
    sql103: 'bade6813d689c91e3c8e39e33203e64eca23cc363f557062a7669407a01d5b9c',
    sql29: 'd8247ab9a31a7c1c57a464a768a650397059e67519f9e1522f881293e28e0079',
    sql30: '37f22340383b1a5e1b1350fc602b2953c2bb72d32234456888616fd749cbf504',
    sql91: 'bdbc697f75e7a9c57c91c9ce12956800e92417a93acfbbaa0c2d1cf69542972e',
    sql92: '3cfbd32cde289775073221e99404b8b0ce82ff8d7e365cbf14d9e3e7fc6edb9f',
    sql90: 'b5a1998de14922c26b9d829909fada17d3994cf8d0757d410c3e04f6c1f5d9fe',
    sql101: '1c7e1d52a88e4ddb93b751ec972eebfe17600a156d6e56968c9026aa41425c1a',
    sql93: 'ef2ce6baec304517f50b063a3d11048492ae69d34122e26020063f0c53413eb9',
    sql96: '275400ff40caf1ff9d036e62f8bab687f82e9302622afef91f77a314c0f40f7f',
    sql94: '724115983687d882d8240e8d06e4670bc6e24dbb16540d3134cc1ccc47d66af1',
    sql104: '57443d0a26c26859f2e939fb00fef51b554108b20f28aa6f262b9906cad1cfc6',
    sql98: 'd64218dc145fc7b55632c7d5cfdef3fdbbb02592a79f6ff339c4814fc4ae6dbc',
    sql102: 'd3b2cd30d9b06347c4a08febac3fce49732bd0babcacfeea0a2b49dbdc9cb752',
    sql105: '065795875078407c8b607fc8b8018a7d76354e4bf5d776e8962b0613137520bb',
    sql95: '48535b69b1a2f9b1ad69584f677dae78c830a482f58b9380c881205f91d8e05f',
    sql97: '56b1f63192df1147fbbdd0206226129aeea35467d13c8bf0c8bc399316d06079',
    sql99: '4d174e86d8c9f0940a0d38da3e432676143dc34946e8d1619cfc36d8a9a834e9',
    sql106: '56b5e4bb1a2db3133c32c9cc3cca02c1e7fb876839544dbdfd0717aad8f25880',
    sql108: 'c83dcc9b97b84d294a743063adb0c1f5231f5c37ade2f00d65dc134a1d55cf00',
    sql109: 'e0f02501f167f4bee2bbb8bc32c1e19b23deb5425a650c63102030531aa9a077',
    sql110: '3fdbb3d323c1c0edab0c2ee7e4a6c1b08aa30c1a021c7d81899e95a616f186fd',
    sql111: 'b78704b4d46b3ca88146d8368e09c630ead8930d3717e89287bf07bb46b86978',
    sql112: 'a61983121c4739f38084c66c6aaafcb67968b008526ff0c69459713280292acd',
    sql113: '88787a89c85585f25c18ea31d60740a6526522377a1b0d7b02e7902fe18970c1',
    sql114: '8b5d1d4d49188412317a60036a392c27727852b246a1d59a9c2807cb17186e00',
    sql116: 'd145c18e29fb0e309222d250e270f5750be7f23a8cbe336190d5c9d7bfd7d9dd',
    sql118: '1b5eec31635d869abbabc9d4584674ee5852a27689629d9c199627d7c8653cde',
    sql119: '249237decc1f079bf04915a5f42862792efb13f00729a8d0bbbfdb8b5c456e35',
    sql115: 'ee9d2d5222dd9f8850173384b13468154fa03def6487824c3ef378db4874775b',
  };
  for (const key of ['sql71', 'sql87', 'sql88', 'sql89', 'sql82', 'sql83', 'sql84', 'sql85', 'sql86', 'sql103', 'sql29', 'sql30', 'sql91', 'sql92', 'sql90', 'sql101', 'sql93', 'sql96', 'sql94', 'sql104', 'sql98', 'sql102', 'sql105', 'sql95', 'sql97', 'sql99', 'sql106', 'sql108', 'sql109', 'sql110', 'sql111', 'sql112', 'sql113', 'sql114', 'sql116', 'sql118', 'sql119', 'sql115']) {
    const real = realPin(key);
    assert.equal(real.expected_live_definition_sha256, RECORDED_PRODUCTION_PRE[key]);
    // Execute-authorized and applied (retired) pins get an explicit pre-authorization copy; SQL 71's committed pin is still pending.
    const committed = real.authorization === 'pending'
      ? real
      : { ...real, authorization: 'pending', execute: false, staging_acceptance: { ...real.staging_acceptance, ok: false, reference: null, basis: 'Pending' } };
    assert.equal(committed.authorization, 'pending');
    assert.equal(committed.execute, false);
    assert.equal(committed.staging_acceptance.ok, false);
    assert.equal(committed.expected_live_definition_sha256, RECORDED_PRODUCTION_PRE[key]);
    const stopped = await oneShot({ key, pin: { ...committed, execute: true }, o: { 'workstream-id': `prod-${key}-pending-test` } });
    assert.equal(stopped.result.ok, false);
    assert.equal(stopped.result.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    assert.equal(stopped.result.details.stopped_at, 'pin');
    assert.equal(stopped.runner.calls.length, 0);
    // A staging acceptance alone is not enough while the pre-state is unrecorded.
    const unrecorded = { ...committed, execute: true, expected_live_definition_sha256: null, staging_acceptance: FIXTURE_STAGING_ACCEPTANCE };
    const fixtureManifest = { ...committed, expected_live_definition_sha256: null, live_definition_sha256: null, staging_acceptance: FIXTURE_STAGING_ACCEPTANCE };
    const refused = await EVALUATORS[key](fixtureManifest, { root: ROOT, pin: unrecorded });
    assert.equal(refused.code, CODES.SQL_COLLISION, key);
    assert.match(refused.message, /no recorded pre-apply live definition hash/, key);
    // With the recorded pre-state and a staging acceptance, authorization "pending" still refuses.
    const recordedPre = committed.expected_live_definition_sha256 ?? FIXTURE_EXPECTED_LIVE;
    const recordedManifest = { ...committed, expected_live_definition_sha256: recordedPre, live_definition_sha256: recordedPre, staging_acceptance: FIXTURE_STAGING_ACCEPTANCE };
    const pendingApproval = await EVALUATORS[key](recordedManifest, { root: ROOT, pin: { ...committed, execute: true, expected_live_definition_sha256: recordedPre, staging_acceptance: FIXTURE_STAGING_ACCEPTANCE } });
    assert.equal(pendingApproval.code, CODES.PRODUCTION_APPROVAL_REQUIRED, key);
  }
});

test('SQL 82 to SQL 86 are retired with a verified_live record; their execute-authorized state (an explicit copy) passes the pin stage, and their evaluators allow the manifest built from it', async () => {
  const STAGING_REFERENCE = {
    sql82: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38837281138',
    sql83: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38837509160',
    sql84: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38894893179',
    sql85: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38895045712',
    sql86: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/38895163945',
  };
  for (const key of VERIFIED_LIVE_RETIRED) {
    const retired = realPin(key);
    assert.equal(retired.execute, false, key);
    assert.equal(retired.applied.result, 'verified_live', key);
    assert.equal(retired.applied.verified_live_inspect.ssm_command_id, VERIFIED_LIVE_SSM[key], key);
    assert.equal(retired.applied.verified_live_inspect.read_only, true, key);
    assert.equal(retired.applied.verified_live_inspect.already_applied, true, key);
    assert.equal(retired.applied.verified_live_inspect.live_definition_sha256, retired.intended_replacement_sha256, key);
    assert.deepEqual(retired.applied.verified_live_inspect.precondition_failures, [], key);
    // The execute-authorized state before the record-and-retire change, as an explicit copy.
    const committed = { ...retired, execute: true };
    delete committed.applied;
    assert.match(committed.authorization, /^Owner approved 2026-10-16 /, key);
    assert.equal(committed.staging_acceptance.ok, true);
    assert.equal(committed.staging_acceptance.reference, STAGING_REFERENCE[key]);
    for (const phase of ['inspect', 'apply']) {
      const { result, runner } = await oneShot({ key, pin: committed, o: { phase, 'workstream-id': `prod-${key}-committed-pin-test` } });
      assert.equal(result.ok, true, `${key} ${phase}: ${JSON.stringify(result)}`);
      assert.deepEqual(result.details.steps[0], { step: 'pin', ok: true, pin: ONE_SHOT_TOOLS[key].pin_rel, execute: true, staging_acceptance: STAGING_REFERENCE[key] });
      assert.equal(runner.steps()[0], 'inspect');
      if (phase === 'inspect') {
        assert.ok(!runner.steps().includes('apply'), key);
        continue;
      }
      const manifest = lastManifest(runner);
      for (const field of ['filename', 'migration_id', 'source_sha256', 'expected_live_definition_sha256', 'intended_replacement_sha256', 'authorization_phrase']) {
        assert.equal(manifest[field], committed[field], `${key} ${field}`);
      }
      assert.deepEqual(manifest.staging_acceptance, committed.staging_acceptance);
      // The tool's own evaluator, with the execute-authorized copy, allows it.
      const allowed = await EVALUATORS[key](manifest, { root: ROOT, pin: committed });
      assert.equal(allowed.ok, true, `${key}: ${JSON.stringify(allowed)}`);
      assert.equal(allowed.details[ONE_SHOT_TOOLS[key].allowed_key], true);
      assert.equal(allowed.details.staging_acceptance, STAGING_REFERENCE[key]);
    }
  }
});

test('the execute-authorized copies of the retired SQL 95, SQL 97, SQL 99, SQL 106, SQL 108, SQL 109, SQL 110, SQL 111, SQL 112, SQL 113, SQL 114, SQL 115, SQL 116, SQL 118 and SQL 119 pins pass the pin stage, and their evaluators allow the manifest built from them', async () => {
  const STAGING_REFERENCE = {
    // SQL 95 / SQL 97: the guarded staging read-live of 2026-10-21 (intended state), owner-accepted
    // substitute evidence (different pre-state; their wave 4 apply runs are not recorded).
    sql95: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39616185934',
    sql97: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39618586101',
    // SQL 99: its guarded staging wave 1 apply from the same pre-state.
    sql99: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39080577323',
    // SQL 106: the guarded staging read-live of 2026-10-21 (already in effect in staging, live =
    // intended), owner-accepted substitute evidence.
    sql106: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39633390440',
    // SQL 108: its guarded staging apply of 2026-10-21 from the same pre-state.
    sql108: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39662760919',
    // SQL 109: its guarded staging apply of 2026-10-21 from the same pre-state.
    sql109: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39673516794',
    // SQL 110: its guarded staging apply of 2026-10-22 from the same pre-state.
    sql110: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39838878110',
    // SQL 111: its guarded staging apply of 2026-10-23 from the same pre-state.
    sql111: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39877945144',
    // SQL 112: its guarded staging apply of 2026-10-23 from a different pre-state (owner-accepted).
    sql112: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39967007467',
    // SQL 113: its guarded staging apply of 2026-10-23 from the same pre-state.
    sql113: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/40022413642',
    // SQL 114: its guarded staging apply of 2026-10-25 from the same pre-state.
    sql114: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/40154043207',
    // SQL 116: its guarded staging apply of 2026-10-26 from the same pre-state.
    sql116: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/40339373370',
    // SQL 118: its guarded staging apply of 2026-10-27 from the same pre-state.
    sql118: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/40438147297',
    // SQL 119: its guarded staging read-live of 2026-10-27 (already in the intended state; no staging apply).
    sql119: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/40501861802',
    // SQL 115: its guarded staging apply of 2026-10-25 (pre-state different only in the EXECUTE ACL).
    sql115: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/40243363235',
  };
  for (const key of ['sql95', 'sql97', 'sql99', 'sql106', 'sql108', 'sql109', 'sql110', 'sql111', 'sql112', 'sql113', 'sql114', 'sql116', 'sql118', 'sql119', 'sql115']) {
    const real = realPin(key);
    let committed = real;
    if (APPLIED_2026_10_21[key]) {
      // Applied 2026-10-21 (SQL 110: 2026-10-22, SQL 111, SQL 112 and SQL 113: 2026-10-23, SQL 114: 2026-10-25, SQL 116: 2026-10-26, SQL 115, SQL 118 and SQL 119: 2026-10-27) and retired: execute false, the one apply run recorded in applied.
      const run = APPLIED_2026_10_21[key];
      assert.equal(real.execute, false, key);
      assert.match(real.authorization, /^Applied to production on 2026-10-2[123567]; execute is false again/, key);
      assert.ok(real.authorization.includes(`"${run.approval}"`), key);
      assert.equal(real.applied.owner_approval, run.approval, key);
      assert.equal(real.applied.result, 'applied', key);
      assert.equal(real.applied.apply_ssm_command_id, run.ssm, key);
      assert.equal(real.applied.one_shot_run_id, run.run, key);
      assert.equal(real.applied.one_use_id, run.one_use_id, key);
      assert.equal(real.applied.workstream_id, run.workstream, key);
      assert.equal(real.applied.receipt.before_hash, real.expected_live_definition_sha256, key);
      assert.equal(real.applied.receipt.after_hash, real.intended_replacement_sha256, key);
      // The execute-authorized state before the record-and-retire change, as an explicit copy.
      committed = { ...real, authorization: 'Owner approved 2026-10-21 (test copy of the execute-authorized pin before its record-and-retire change)', execute: true };
      delete committed.applied;
      delete committed.production_evidence;
    } else {
      assert.ok(EXECUTE_AUTHORIZED.includes(key), key);
      assert.equal(committed.execute, true);
      assert.match(committed.authorization, /^Owner approved 2026-10-2[123567] /, key);
      assert.equal(committed.applied, undefined, key);
    }
    assert.equal(committed.staging_acceptance.ok, true);
    assert.equal(committed.staging_acceptance.reference, STAGING_REFERENCE[key]);
    for (const phase of ['inspect', 'apply']) {
      const { result, runner } = await oneShot({ key, pin: committed, o: { phase, 'workstream-id': `prod-${key}-committed-pin-test` } });
      assert.equal(result.ok, true, `${key} ${phase}: ${JSON.stringify(result)}`);
      assert.deepEqual(result.details.steps[0], { step: 'pin', ok: true, pin: ONE_SHOT_TOOLS[key].pin_rel, execute: true, staging_acceptance: STAGING_REFERENCE[key] });
      assert.equal(runner.steps()[0], 'inspect');
      if (phase === 'inspect') {
        assert.ok(!runner.steps().includes('apply'), key);
        continue;
      }
      const manifest = lastManifest(runner);
      for (const field of ['filename', 'migration_id', 'source_sha256', 'expected_live_definition_sha256', 'intended_replacement_sha256', 'authorization_phrase']) {
        assert.equal(manifest[field], committed[field], `${key} ${field}`);
      }
      assert.deepEqual(manifest.staging_acceptance, committed.staging_acceptance);
      const allowed = await EVALUATORS[key](manifest, { root: ROOT, pin: committed });
      assert.equal(allowed.ok, true, `${key}: ${JSON.stringify(allowed)}`);
      assert.equal(allowed.details[ONE_SHOT_TOOLS[key].allowed_key], true);
      assert.equal(allowed.details.staging_acceptance, STAGING_REFERENCE[key]);
    }
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
    [{ o: { 'expected-tarball-sha256': 'f'.repeat(64) } }, CODES.STALE_PACKAGE],
    [{ sourceCommit: null }, CODES.STALE_PACKAGE],
    [{ sourceCommit: `${'b'.repeat(40)}\n` }, CODES.STALE_PACKAGE],
    [{ sourceCommit: COMMIT }, CODES.STALE_PACKAGE],
    [{ sourceCommit: `${COMMIT}\nextra\n` }, CODES.STALE_PACKAGE],
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
    readTarball: async () => ({ sha256: TARBALL_SHA, index: new Map() }),
    compareTreeToIndex: async () => ({ ok: true, details: { tarball_files: 1 } }),
    readSourceCommit: () => `${COMMIT}\n`,
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

test('a symlink that resolves outside the tree is refused', async () => {
  for (const linkname of ['../../../etc/passwd', '/etc/passwd', '../..']) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'one-shot-link-'));
    const src = path.join(base, 'src');
    fs.mkdirSync(path.join(src, 'dir'), { recursive: true });
    fs.writeFileSync(path.join(src, 'a.txt'), 'a');
    fs.symlinkSync(linkname, path.join(src, 'dir/escape'));
    const tarball = path.join(base, `source-${COMMIT}.tar.gz`);
    assert.equal(spawnSync('tar', ['-czf', tarball, '-C', src, '.']).status, 0);
    const x = path.join(base, 'x');
    fs.mkdirSync(x);
    assert.equal(spawnSync('tar', ['-xzf', tarball, '-C', x]).status, 0);
    const res = await compareTreeToTarball(x, tarball);
    assert.equal(res.ok, false, linkname);
    assert.equal(res.code, CODES.SOURCE_RECONCILIATION_REQUIRED);
    assert.deepEqual(res.details.escaping_symlinks, ['dir/escape'], linkname);
  }
});

test('the tree is re-compared right before preflight and right before apply', async () => {
  const failOnCall = (n) => {
    let calls = 0;
    return async () => {
      calls += 1;
      return calls === n
        ? { ok: false, code: CODES.SOURCE_RECONCILIATION_REQUIRED, message: 'changed after the source step', details: { differing: ['scripts/deployment-guard/preflight.mjs'] } }
        : { ok: true, details: { tarball_files: 3 } };
    };
  };
  let { result, runner } = await oneShot({ compareTree: failOnCall(2) });
  assert.equal(result.ok, false);
  assert.equal(result.details.stopped_at, 'source-recheck-before-preflight');
  assert.ok(!runner.steps().includes('preflight'));
  assert.equal(result.details.manifest_deleted, true);

  ({ result, runner } = await oneShot({ compareTree: failOnCall(3) }));
  assert.equal(result.ok, false);
  assert.equal(result.details.stopped_at, 'source-recheck-before-apply');
  assert.deepEqual(runner.steps().slice(-2), ['preflight', 'evaluate']);
  assert.ok(!runner.steps().includes('apply'));
});

test('the manifest temp dir is deleted when a later step fails', async () => {
  const { result, tmpDir } = await oneShot({ responses: { evaluate: () => ({ status: 1, stdout: '', stderr: json({ ok: false, code: 'X', message: 'no' }) }) } });
  assert.equal(result.ok, false);
  assert.equal(result.details.manifest_deleted, true);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
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
  // A test that prints a fake summary line cannot win: the reporter's own summary is last.
  assert.deepEqual(parseTapSummary(`# tests 9\n# pass 9\n# fail 0\n${tap(4, { fail: 1 })}`), { tests: 4, pass: 3, fail: 1, cancelled: 0, skipped: 0, todo: 0 });
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

test('the transfer workflow runs no npm or test code where an AWS token can be minted', () => {
  const text = fs.readFileSync(path.join(ROOT, '.github/workflows/sql53-temporary-transfer.yml'), 'utf8');
  const jobsAt = text.indexOf('\njobs:\n');
  assert.ok(jobsAt > 0);
  assert.doesNotMatch(text.slice(0, jobsAt).replace(/^#.*$/gm, ''), /id-token/, 'no workflow-level id-token permission');
  const jobs = Object.fromEntries(text.slice(jobsAt + 7).split(/\n(?= {2}[a-z][a-z0-9-]*:\n)/).map((chunk) => [chunk.trim().split(':')[0], chunk]));
  assert.deepEqual(Object.keys(jobs), ['package', 'contracts', 'upload']);
  for (const name of ['package', 'contracts']) {
    assert.doesNotMatch(jobs[name], /id-token|configure-aws-credentials|aws s3/, name);
    assert.match(jobs[name], /permissions:\n\s+contents: read\n/, name);
  }
  const upload = jobs.upload;
  assert.match(upload, /needs: \[package, contracts\]/);
  assert.match(upload, /id-token: write/);
  assert.doesNotMatch(upload, /\bnpm\b|\bnode\b|setup-node|checkout@/, 'the upload job runs no repository or npm code');
  assert.match(upload, /EXPECTED: \$\{\{ needs\.package\.outputs\.sha256 \}\}/);
  assert.ok(upload.indexOf('sha256sum -c -') !== -1 && upload.indexOf('sha256sum -c -') < upload.indexOf('configure-aws-credentials'), 'verified before the token is minted');
  // The contracts job tests a copy extracted from the hashed tarball, with the registry's list.
  assert.match(jobs.contracts, /needs: package/);
  assert.match(jobs.contracts, /echo "\$\{EXPECTED\}  \$\{TARBALL\}" \| sha256sum -c -/);
  assert.match(jobs.contracts, /relevantContracts\(loadContractRegistry/);
  // Fail closed: command substitution (a failing node exits the step) and a non-empty list.
  assert.match(jobs.contracts, /LIST=\$\(node --input-type=module -e '/);
  assert.match(jobs.contracts, /mapfile -t TESTS <<<"\$LIST"/);
  assert.match(jobs.contracts, /test "\$\{#TESTS\[@\]\}" -gt 0/);
  assert.match(jobs.contracts, /test -n "\$\{TESTS\[0\]\}"/);
  assert.doesNotMatch(jobs.contracts, /< <\(/, 'no process substitution, whose exit status is lost');
  assert.match(jobs.contracts, /set -euo pipefail/);
  assert.match(jobs.contracts, /test "\$\(cat \/tmp\/runner-copy\/SOURCE_COMMIT\)" = "\$\{GITHUB_SHA\}"/);
  // Provenance and the API package's own lockfile dependencies.
  assert.match(jobs.package, /printf '%s\\n' "\$\{SHA\}" > \/tmp\/pkg\/src\/SOURCE_COMMIT/);
  assert.match(jobs.package, /echo "TARBALL_SHA256 \$\{SUM\}/);
  assert.match(jobs.package, /npm ci --prefix \/tmp\/pkg\/src\/aws\/functions\/api --ignore-scripts --omit=dev/);
  assert.ok(jobs.package.indexOf('tar -czf') < jobs.package.indexOf('upload-artifact'), 'hashed before hand-off');
  assert.doesNotMatch(jobs.package, /node --test/, 'no tests run in the job that builds and hashes');
  for (const line of text.split('\n').filter((row) => /^\s*-?\s*uses: /.test(row))) {
    assert.match(line, /@[0-9a-f]{40}(?:\s|$)/, `action pinned by SHA: ${line.trim()}`);
  }
});

// --- second review: cached index, realpath, exceptions ---------------------------------------

function fixtureRunnerTree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'one-shot-swap-'));
  const src = path.join(base, 'src');
  const pin = executePin('sql80');
  for (const [rel, text] of [
    [pin.filename, fs.readFileSync(path.join(ROOT, pin.filename), 'utf8')],
    ['SOURCE_COMMIT', `${COMMIT}\n`],
    ['t.test.mjs', "import { test } from 'node:test';\ntest('ok', () => {});\n"],
  ]) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), text);
  }
  const tarball = path.join(base, `source-${COMMIT}.tar.gz`);
  const pack = (dir) => {
    assert.equal(spawnSync('tar', ['-czf', tarball, '-C', dir, '.']).status, 0);
    const sha = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
    fs.writeFileSync(`${tarball}.sha256`, `${sha}  source-${COMMIT}.tar.gz\n`);
    return sha;
  };
  const sha = pack(src);
  const x = path.join(base, 'x');
  fs.mkdirSync(x);
  assert.equal(spawnSync('tar', ['-xzf', tarball, '-C', x]).status, 0);
  return { pin, tarball, sha, x, pack };
}

const FIXTURE_REGISTRY = { contracts: [{ id: 'c', accepted: true, enabled: true, environments: ['production'], components: ['*'], deployment_types: ['sql-apply'], test: 't.test.mjs' }] };

test('re-checks compare against the index cached from the verified bytes, so swapping tarball and tree together is caught', async () => {
  const { pin, tarball, sha, x, pack } = fixtureRunnerTree();
  const runner = fakeRunner('sql80', pin, {
    contract: () => ({ status: 0, stdout: tap(1), stderr: '' }),
    preflight: () => ({ status: 0, stdout: json({ ok: true, details: { receipt: path.join(receiptDir(x), 'production::production-sql.json') } }), stderr: '' }),
    evaluate: () => {
      // An attacker changes the tree and re-packs a matching tarball and sidecar on disk.
      fs.writeFileSync(path.join(x, 't.test.mjs'), 'planted\n');
      pack(x);
      return { status: 0, stdout: json({ ok: true, details: { migration: 'sql80', sql80_production_apply_allowed: true } }), stderr: '' };
    },
  });
  const result = await runProductionSqlOneShot(opts('sql80', { 'source-tarball': tarball, 'expected-tarball-sha256': sha }), {
    root: x, env: { PATH: '/usr/bin' }, run: runner.run, nodePath: '/usr/bin/node', pin, registry: FIXTURE_REGISTRY,
    tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'one-shot-manifest-')),
  });
  assert.equal(result.ok, false);
  assert.equal(result.details.stopped_at, 'source-recheck-before-apply');
  assert.deepEqual(result.details.error.details.differing, ['t.test.mjs']);
  assert.ok(!runner.steps().includes('apply'));
  // Re-reading the swapped tarball from disk would have passed.
  assert.equal((await compareTreeToTarball(x, tarball)).ok, true);
});

test('the same fixture passes every real source check when nothing is swapped', async () => {
  const { pin, tarball, sha, x } = fixtureRunnerTree();
  const runner = fakeRunner('sql80', pin, {
    contract: () => ({ status: 0, stdout: tap(1), stderr: '' }),
    preflight: () => ({ status: 0, stdout: json({ ok: true, details: { receipt: path.join(receiptDir(x), 'production::production-sql.json') } }), stderr: '' }),
  });
  const result = await runProductionSqlOneShot(opts('sql80', { 'source-tarball': tarball, 'expected-tarball-sha256': sha }), {
    root: x, env: { PATH: '/usr/bin' }, run: runner.run, nodePath: '/usr/bin/node', pin, registry: FIXTURE_REGISTRY,
    tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'one-shot-manifest-')),
  });
  assert.equal(result.ok, true, JSON.stringify(result.details.error));
  assert.equal(result.details.source.tarball_sha256, sha);
  assert.equal(result.details.source.index, undefined, 'the cached index is not printed');
  assert.ok(result.details.steps.some((s) => s.step === 'source-recheck-before-apply' && s.ok));
});

test('symlinks are also resolved with realpath: s -> . plus t -> s/.. is refused', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'one-shot-realpath-'));
  const src = path.join(base, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'a.txt'), 'a');
  fs.symlinkSync('.', path.join(src, 's'));
  fs.symlinkSync('s/..', path.join(src, 't'));
  const tarball = path.join(base, `source-${COMMIT}.tar.gz`);
  assert.equal(spawnSync('tar', ['-czf', tarball, '-C', src, '.']).status, 0);
  const x = path.join(base, 'x');
  fs.mkdirSync(x);
  assert.equal(spawnSync('tar', ['-xzf', tarball, '-C', x]).status, 0);
  assert.equal(fs.realpathSync.native(path.join(x, 't')), fs.realpathSync.native(base), 'lexically inside, really the parent');
  const res = await compareTreeToTarball(x, tarball);
  assert.equal(res.ok, false);
  assert.deepEqual(res.details.escaping_symlinks, ['t']);

  // A dangling link is refused too (it cannot be shown to stay inside).
  fs.rmSync(path.join(src, 't'));
  fs.symlinkSync('missing-target', path.join(src, 't'));
  assert.equal(spawnSync('tar', ['-czf', tarball, '-C', src, '.']).status, 0);
  const y = path.join(base, 'y');
  fs.mkdirSync(y);
  assert.equal(spawnSync('tar', ['-xzf', tarball, '-C', y]).status, 0);
  assert.deepEqual((await compareTreeToTarball(y, tarball)).details.escaping_symlinks, ['t']);
});

test('OpenSSL, ICU and compile-cache variables are refused like the other loader variables', async () => {
  for (const key of ['OPENSSL_CONF', 'OPENSSL_MODULES', 'NODE_ICU_DATA', 'NODE_COMPILE_CACHE']) {
    assert.ok(LOADER_ENV_KEYS.includes(key), key);
    const { result, runner } = await oneShot({ env: { PATH: '/usr/bin', [key]: '/tmp/x' } });
    assert.equal(result.ok, false, key);
    assert.equal(result.code, CODES.DEPLOYMENT_GUARD_REQUIRED, key);
    assert.equal(runner.calls.length, 0, key);
  }
});

test('an exception in any step still returns one failure summary', async () => {
  const boom = () => { throw new Error('runner crashed'); };
  let { result, runner, tmpDir } = await oneShot({ responses: { evaluate: boom } });
  assert.equal(result.ok, false);
  assert.equal(result.code, ONE_SHOT_EXCEPTION);
  assert.equal(result.details.stopped_at, 'preflight (exception)');
  assert.match(result.details.error.message, /runner crashed/);
  assert.equal(result.details.manifest_deleted, true);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
  assert.equal(result.details.warning, undefined);
  assert.ok(!runner.steps().includes('apply'));

  ({ result } = await oneShot({ responses: { apply: boom } }));
  assert.equal(result.code, ONE_SHOT_EXCEPTION);
  assert.equal(result.details.apply_child_started, true);
  assert.match(result.details.warning, /read-only --inspect before anything else/);

  ({ result } = await oneShot({ responses: { inspect: boom } }));
  assert.equal(result.details.stopped_at, 'source (exception)');

  const writes = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  let code;
  try {
    code = await oneShotMain([
      '--migration', 'sql80', '--approval-scope', 'sql80', '--commit', COMMIT, '--workstream-id', WORKSTREAM,
      '--operator', 'michaelcarletta-cmd', '--approval-statement', STATEMENT, '--source-tarball', TARBALL,
      '--expected-tarball-sha256', TARBALL_SHA, '--phase', 'inspect',
    ], { PATH: '/usr/bin' }, {
      root: ROOT, run: boom, execArgv: [], pin: executePin('sql80'), readSourceCommit: () => `${COMMIT}\n`,
      readTarball: async () => ({ sha256: TARBALL_SHA, index: new Map() }), compareTreeToIndex: async () => ({ ok: true, details: { tarball_files: 1 } }),
    });
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(code, 1);
  const printed = JSON.parse(writes.join(''));
  assert.equal(printed.code, ONE_SHOT_EXCEPTION);
  assert.equal(printed.details.stopped_at, 'source (exception)');
});

// --- recorded inspect results carry no check ids ---------------------------------

const DUP_CHECK_ID = '0b8f6f1e-2f0c-4c7e-9a51-6a3f1d2e4b5c';
const DUPLICATES = { readable: true, groups: 1, extra_events: 1, check_ids: [DUP_CHECK_ID] };

test('a failed pre-apply inspect records only picked fields, never check_ids', async () => {
  const pin = executePin('sql80');
  const { result } = await oneShot({
    responses: { inspect: () => ({ status: 1, stdout: '', stderr: json({ ok: false, code: 'SQL_COLLISION', message: 'x', details: inspectDetails('sql80', pin, { billing_duplicates: DUPLICATES }) }) }) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.details.stopped_at, 'inspect');
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, new RegExp(`${DUP_CHECK_ID}|check_ids|not copied`));
  assert.match(text, /"groups":1/);
});

test('a post-apply inspect that does not show the intended state records only picked fields', async () => {
  const pin = executePin('sql80');
  const { result } = await oneShot({
    responses: { 'post-apply-inspect': () => ({ status: 0, stdout: json({ ok: true, details: inspectDetails('sql80', pin, { billing_duplicates: DUPLICATES }) }), stderr: '' }) },
  });
  assert.equal(result.details.stopped_at, 'post-apply-inspect');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${DUP_CHECK_ID}|check_ids|not copied`));
});

test('a failing post-apply inspect after a failed apply records only picked fields', async () => {
  const pin = executePin('sql80');
  const { result } = await oneShot({
    responses: {
      apply: () => ({ status: 1, stdout: '', stderr: json({ ok: false, code: 'SQL_COLLISION', message: 'COMMIT outcome is unknown', details: {} }) }),
      'post-apply-inspect': () => ({ status: 1, stdout: '', stderr: json({ ok: false, code: 'SQL_COLLISION', message: 'y', details: inspectDetails('sql80', pin, { billing_duplicates: DUPLICATES }) }) }),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.details.post_apply_inspect.error.ok, false);
  assert.deepEqual(result.details.post_apply_inspect.error.details.billing_duplicates, { readable: true, groups: 1, extra_events: 1 });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${DUP_CHECK_ID}|check_ids|not copied`));
});

// --- SQL 29 and SQL 30 (ops/production-sql-29-30-apply.md) -------------------------------

const LIBRARY_KEYS = Object.freeze(['sql29', 'sql30']);

test('SQL 29 and SQL 30 are registered with their own tools, pins and allowed keys', () => {
  const expected = {
    sql29: 'scripts/deployment-guard/sql29-mortgage-ops-library-parity-production-apply.mjs',
    sql30: 'scripts/deployment-guard/sql30-tenant-documents-doc-type-production-apply.mjs',
  };
  for (const key of LIBRARY_KEYS) {
    const tool = ONE_SHOT_TOOLS[key];
    assert.equal(tool.key, key);
    assert.equal(tool.script, expected[key]);
    assert.deepEqual([...tool.args], []);
    assert.equal(tool.pin_rel, LIBRARY_PRODUCTION[key].pin_rel);
    assert.equal(tool.allowed_key, `${key}_production_apply_allowed`);
    assert.equal(tool.allowed_key, LIBRARY_PRODUCTION[key].allowed_key);
    // The CLI entry runs the shared library tool for this key (--inspect / --input / --apply --input).
    const cli = fs.readFileSync(path.join(ROOT, tool.script), 'utf8');
    assert.match(cli, new RegExp(`runLibraryProductionTool\\(\\s*\\{ key: '${key}'`));
    // No hash is hard-coded in the registry: source_sha256 and the fingerprints come from the pin.
    assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
    const pin = realPin(key);
    assert.equal(pin.migration, key);
    assert.equal(pin.target_environment, 'production');
    assert.equal(pin.target_component, 'production-sql');
    assert.equal(pin.deployment_type, 'sql-apply');
  }
});

test('the SQL 29 and SQL 30 pre-authorization copies (execute false) are refused before any child, in both phases', async () => {
  // SQL 29's and SQL 30's committed pins were execute-authorized (owner approved 2026-10-19) and
  // are applied and retired (execute false) since their 2026-10-19 applies; their
  // pre-authorization state is an explicit copy here.
  assert.equal(realPin('sql29').execute, false);
  assert.equal(realPin('sql29').expected_live_definition_sha256, 'd8247ab9a31a7c1c57a464a768a650397059e67519f9e1522f881293e28e0079');
  assert.equal(realPin('sql30').execute, false);
  assert.equal(realPin('sql30').expected_live_definition_sha256, '37f22340383b1a5e1b1350fc602b2953c2bb72d32234456888616fd749cbf504');
  const preAuthorization = (key) => (['sql29', 'sql30'].includes(key)
    ? { ...realPin(key), execute: false, authorization: 'pending', expected_live_definition_sha256: null, staging_acceptance: { ok: false, reference: null, basis: 'Pending' } }
    : realPin(key));
  for (const key of LIBRARY_KEYS) {
    assert.equal(preAuthorization(key).execute, false, key);
    for (const phase of ['inspect', 'apply']) {
      const { result, runner } = await oneShot({ key, pin: ['sql29', 'sql30'].includes(key) ? preAuthorization(key) : null, o: { phase, 'workstream-id': `prod-${key}-committed-pin-test` } });
      assert.equal(result.ok, false, key);
      assert.equal(result.code, CODES.GUARD_APPLY_FORBIDDEN, key);
      assert.equal(result.details.stopped_at, 'pin', key);
      assert.equal(runner.calls.length, 0, key);
    }
    // Pending authorization and no staging acceptance stop at the pin even with execute flipped.
    const flipped = { ...preAuthorization(key), execute: true };
    const stopped = await oneShot({ key, pin: flipped, o: { 'workstream-id': `prod-${key}-pending-test` } });
    assert.equal(stopped.result.code, CODES.PRODUCTION_APPROVAL_REQUIRED, key);
    assert.equal(stopped.result.details.stopped_at, 'pin', key);
    assert.equal(stopped.runner.calls.length, 0, key);
    // The tool's evaluator still refuses the unrecorded pre-state and the pending authorization.
    const pending = preAuthorization(key);
    const noPre = await EVALUATORS[key]({ ...pending, live_definition_sha256: null, staging_acceptance: FIXTURE_STAGING_ACCEPTANCE }, { root: ROOT, pin: { ...pending, execute: true, staging_acceptance: FIXTURE_STAGING_ACCEPTANCE } });
    assert.equal(noPre.code, CODES.SQL_COLLISION, key);
    const withPre = { ...pending, execute: true, expected_live_definition_sha256: FIXTURE_EXPECTED_LIVE, staging_acceptance: FIXTURE_STAGING_ACCEPTANCE };
    const notApproved = await EVALUATORS[key]({ ...withPre, live_definition_sha256: FIXTURE_EXPECTED_LIVE }, { root: ROOT, pin: withPre });
    assert.equal(notApproved.code, CODES.PRODUCTION_APPROVAL_REQUIRED, key);
  }
});

test('the committed SQL 29 pin is applied and retired (execute false); it and its execute-authorized copy with execute false are refused before any child, in both phases', async () => {
  const committed = realPin('sql29');
  assert.equal(committed.execute, false);
  assert.match(committed.authorization, /^Applied to production on 2026-10-19; execute is false again/);
  assert.equal(committed.expected_live_definition_sha256, 'd8247ab9a31a7c1c57a464a768a650397059e67519f9e1522f881293e28e0079');
  assert.equal(committed.staging_acceptance.reference, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39188780526');
  assert.equal(committed.applied.apply_ssm_command_id, '64604f67-e7f0-4152-a9a8-208543d41937');
  assert.equal(committed.applied.one_use_id, 'sql29-prod-238d917c-fdc1-4f3b-8909-a89cf8d74e8f');
  assert.deepEqual(committed.applied.receipt.before_hash, committed.expected_live_definition_sha256);
  assert.deepEqual(committed.applied.receipt.after_hash, committed.intended_replacement_sha256);
  // SQL 30's pin is applied and retired by its own record-and-retire change (asserted below).
  assert.equal(realPin('sql30').execute, false);
  assert.equal(realPin('sql30').applied.workstream_id, 'prod-sql30-tenant-documents-doc-type-20261019');
  // The execute-authorized state before the record-and-retire change, with execute false again.
  const executeFalse = { ...committed, authorization: 'Owner approved 2026-10-19 (test copy of the execute-authorized pin before its record-and-retire change)', execute: false };
  for (const pin of [null, executeFalse]) {
    for (const phase of ['inspect', 'apply']) {
      const { result, runner } = await oneShot({ key: 'sql29', pin, o: { phase, 'workstream-id': 'prod-sql29-execute-false-test' } });
      assert.equal(result.ok, false);
      assert.equal(result.code, CODES.GUARD_APPLY_FORBIDDEN);
      assert.equal(result.details.stopped_at, 'pin');
      assert.equal(runner.calls.length, 0);
    }
  }
});

test('the committed SQL 30 pin is applied and retired (execute false); it and its execute-authorized copy with execute false are refused before any child, in both phases', async () => {
  const committed = realPin('sql30');
  assert.equal(committed.execute, false);
  assert.match(committed.authorization, /^Applied to production on 2026-10-19; execute is false again/);
  assert.equal(committed.expected_live_definition_sha256, '37f22340383b1a5e1b1350fc602b2953c2bb72d32234456888616fd749cbf504');
  assert.equal(committed.staging_acceptance.reference, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39188780526');
  assert.equal(committed.applied.apply_ssm_command_id, '84f9be05-e363-4f08-900a-c13abacda916');
  assert.equal(committed.applied.one_use_id, 'sql30-prod-f8b43a96-8a7a-418f-aaae-caf95176b964');
  assert.deepEqual(committed.applied.receipt.before_hash, committed.expected_live_definition_sha256);
  assert.deepEqual(committed.applied.receipt.after_hash, committed.intended_replacement_sha256);
  // The execute-authorized state before the record-and-retire change, with execute false again.
  const executeFalse = { ...committed, authorization: 'Owner approved 2026-10-19 (test copy of the execute-authorized pin before its record-and-retire change)', execute: false };
  for (const pin of [null, executeFalse]) {
    for (const phase of ['inspect', 'apply']) {
      const { result, runner } = await oneShot({ key: 'sql30', pin, o: { phase, 'workstream-id': 'prod-sql30-execute-false-test' } });
      assert.equal(result.ok, false);
      assert.equal(result.code, CODES.GUARD_APPLY_FORBIDDEN);
      assert.equal(result.details.stopped_at, 'pin');
      assert.equal(runner.calls.length, 0);
    }
  }
});

test('SQL 29 / SQL 30 inspect phase runs the tool --inspect, records its report and writes nothing', async () => {
  for (const key of LIBRARY_KEYS) {
    const { result, runner, tmpDir } = await oneShot({ key, o: { phase: 'inspect', 'workstream-id': `prod-${key}-inspect-test` } });
    assert.equal(result.ok, true, `${key}: ${JSON.stringify(result.details.error)}`);
    assert.deepEqual(runner.steps(), ['inspect', ...CONTRACT_STEPS]);
    assert.deepEqual(runner.calls[0].args, [ONE_SHOT_TOOLS[key].script, '--inspect']);
    assert.deepEqual(fs.readdirSync(tmpDir), []);
    const recorded = result.details.pre_apply_inspect;
    assert.equal(recorded.sql90_applied, false);
    assert.deepEqual(recorded.prerequisites_missing, []);
    assert.equal(recorded.sql29.functions_present, 0);
    assert.equal(recorded.sql30.check_shape, 'predecessor_6');
    assert.equal(recorded.counts.rows_outside_sql30_values, 0);
    assert.equal(recorded.admin_login, undefined, 'only the picked fields are recorded');
  }
});

test('SQL 29 / SQL 30 apply phase: evaluate, apply and post-apply inspect use the tool flags and the pin hashes', async () => {
  for (const key of LIBRARY_KEYS) {
    const pin = executePin(key);
    const { result, runner } = await oneShot({ key, o: { 'workstream-id': `prod-${key}-apply-test` } });
    assert.equal(result.ok, true, `${key}: ${JSON.stringify(result.details.error)}`);
    assert.deepEqual(runner.steps(), FULL);
    const script = ONE_SHOT_TOOLS[key].script;
    const byStep = Object.fromEntries(runner.calls.map((c) => [c.step, c]));
    assert.deepEqual(byStep.evaluate.args.slice(0, 2), [script, '--input']);
    assert.deepEqual(byStep.apply.args.slice(0, 3), [script, '--apply', '--input']);
    assert.deepEqual(byStep['post-apply-inspect'].args, [script, '--inspect']);
    assert.equal(result.details.applied.receipt.before_hash, pin.expected_live_definition_sha256);
    assert.equal(result.details.applied.receipt.after_hash, pin.intended_replacement_sha256);
    assert.match(result.details.one_use_id, new RegExp(`^${key}-prod-`));
  }
});

test('SQL 29 / SQL 30 source_sha256 is read from the pin: a changed pin hash is a reconciliation stop', async () => {
  for (const key of LIBRARY_KEYS) {
    const { result, runner } = await oneShot({ key, pin: executePin(key, { source_sha256: 'f'.repeat(64) }), o: { 'workstream-id': `prod-${key}-source-test` } });
    assert.equal(result.code, CODES.SOURCE_RECONCILIATION_REQUIRED, key);
    assert.equal(result.details.stopped_at, 'source', key);
    assert.equal(runner.calls.length, 0, key);
    assert.equal(result.details.error.details.pinned_source_sha256, 'f'.repeat(64));
  }
});

test('ordering: SQL 29 stops at the inspect once SQL 90 is applied (or the marker is missing)', async () => {
  const pin = executePin('sql29');
  const cases = [
    [{ sql90_applied: true, precondition_failures: ['sql90_not_applied'], apply_preconditions_met: false }, ['sql90_applied', 'precondition_failures', 'apply_preconditions_met']],
    // The one-shot's own gate holds even if a tool output claimed preconditions met.
    [{ sql90_applied: true }, ['sql90_applied']],
    [{ sql90_applied: undefined }, ['sql90_applied']],
  ];
  for (const [overrides, failed] of cases) {
    const { result, runner } = await oneShot({
      key: 'sql29',
      o: { 'workstream-id': 'prod-sql29-order-test' },
      responses: { inspect: () => ({ status: 0, stdout: json({ ok: true, details: libraryInspectDetails('sql29', pin, overrides) }), stderr: '' }) },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
    assert.equal(result.details.stopped_at, 'inspect');
    for (const name of failed) assert.ok(result.details.error.details.failed.includes(name), `${name}: ${result.details.error.details.failed}`);
    assert.deepEqual(runner.steps(), ['inspect']);
  }
  // SQL 30 has no SQL 90 gate: its order against SQL 94 is the tool's check_is_supported_predecessor.
  assert.equal(ONE_SHOT_TOOLS.sql30.inspect_requires, undefined);
  const sql30 = executePin('sql30');
  const { result } = await oneShot({
    key: 'sql30',
    o: { 'workstream-id': 'prod-sql30-order-test' },
    responses: { inspect: () => ({ status: 0, stdout: json({ ok: true, details: libraryInspectDetails('sql30', sql30, { precondition_failures: ['check_is_supported_predecessor'], apply_preconditions_met: false }) }), stderr: '' }) },
  });
  assert.equal(result.details.stopped_at, 'inspect');
  assert.ok(result.details.error.details.failed.includes('precondition_failures'));
});

test('ordering: SQL 29 and SQL 30 run before SQL 90 and SQL 94, which list them as predecessors', () => {
  for (const key of LIBRARY_KEYS) {
    assert.deepEqual([...ONE_SHOT_TOOLS[key].runs_before], ['sql90', 'sql94']);
    for (const successor of ONE_SHOT_TOOLS[key].runs_before) assert.ok(Object.hasOwn(ONE_SHOT_TOOLS, successor), successor);
  }
  assert.ok(realPin('sql90').predecessors.includes('sql29'));
  assert.ok(realPin('sql90').predecessors.includes('sql30'));
  assert.ok(realPin('sql94').predecessors.includes('sql29'));
  // SQL 30 is optional for SQL 94 (it accepts SQL 30's CHECK or the predecessors), but SQL 30 refuses SQL 94's.
  assert.match(realPin('sql94').order_note, /SQL 30 \(optional/);
  assert.match(realPin('sql29').order_note, /^Before SQL 90/);
  assert.match(realPin('sql30').order_note, /^Before SQL 94/);
});

// --- SQL 103 (ops/production-sql-103-apply.md) ----------------------------------------------

test('SQL 103 is registered with the release tool, its pin and allowed key, and runs before SQL 29', () => {
  const tool = ONE_SHOT_TOOLS.sql103;
  assert.equal(tool.key, 'sql103');
  assert.equal(tool.script, 'scripts/deployment-guard/sql103-share-library-trigger-acl-production-apply.mjs');
  assert.equal(tool.script, RELEASE_PRODUCTION.sql103.cli);
  assert.deepEqual([...tool.args], []);
  assert.equal(tool.pin_rel, RELEASE_PRODUCTION.sql103.pin_rel);
  assert.equal(tool.allowed_key, 'sql103_production_apply_allowed');
  assert.deepEqual([...tool.runs_before], ['sql29']);
  assert.ok(Object.hasOwn(ONE_SHOT_TOOLS, 'sql29'));
  assert.equal(tool.inspect_requires, undefined);
  assert.doesNotMatch(JSON.stringify(tool), /[0-9a-f]{64}/);
  const cli = fs.readFileSync(path.join(ROOT, tool.script), 'utf8');
  assert.match(cli, /runReleaseProductionTool\(\s*\{ key: 'sql103'/);
  const pin = realPin('sql103');
  assert.equal(pin.migration, 'sql103');
  assert.deepEqual(pin.predecessors, []);
  assert.match(pin.order_note, /^Immediately before SQL 29/);
  assert.match(realPin('sql29').order_note, /^Before SQL 90/);
});

test('the committed SQL 103 pin is applied and retired (execute false); it, its execute-authorized copy with execute false and its pre-authorization copy are refused before any child, in both phases', async () => {
  const committed = realPin('sql103');
  assert.equal(committed.execute, false);
  assert.match(committed.authorization, /^Applied to production on 2026-10-19; execute is false again/);
  assert.equal(committed.expected_live_definition_sha256, 'bade6813d689c91e3c8e39e33203e64eca23cc363f557062a7669407a01d5b9c');
  assert.equal(committed.staging_acceptance.reference, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39188618156');
  assert.equal(committed.applied.apply_ssm_command_id, '805556fa-9e70-45d3-b20b-5e68ce64db7d');
  assert.equal(committed.applied.one_use_id, 'sql103-prod-25bd6177-69b4-445c-bc10-686248723e0b');
  assert.deepEqual(committed.applied.receipt.before_hash, committed.expected_live_definition_sha256);
  assert.deepEqual(committed.applied.receipt.after_hash, committed.intended_replacement_sha256);
  // The execute-authorized state before the record-and-retire change, with execute false again.
  const executeFalse = { ...committed, authorization: 'Owner approved 2026-10-19 (test copy of the execute-authorized pin before its record-and-retire change)', execute: false };
  for (const pin of [null, executeFalse]) {
    for (const phase of ['inspect', 'apply']) {
      const { result, runner } = await oneShot({ key: 'sql103', pin, o: { phase, 'workstream-id': 'prod-sql103-execute-false-test' } });
      assert.equal(result.ok, false);
      assert.equal(result.code, CODES.GUARD_APPLY_FORBIDDEN);
      assert.equal(result.details.stopped_at, 'pin');
      assert.equal(runner.calls.length, 0);
    }
  }
  const preAuthorization = { ...committed, execute: true, authorization: 'pending', staging_acceptance: { ok: false, reference: null, basis: 'Pending' } };
  const stopped = await oneShot({ key: 'sql103', pin: preAuthorization, o: { 'workstream-id': 'prod-sql103-pending-test' } });
  assert.equal(stopped.result.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal(stopped.runner.calls.length, 0);
});

test('SQL 103 apply phase: evaluate, apply and post-apply inspect use the tool flags and the pin hashes', async () => {
  const pin = executePin('sql103');
  const { result, runner } = await oneShot({ key: 'sql103', o: { 'workstream-id': 'prod-sql103-apply-test' } });
  assert.equal(result.ok, true, JSON.stringify(result.details.error));
  assert.deepEqual(runner.steps(), FULL);
  const script = ONE_SHOT_TOOLS.sql103.script;
  const byStep = Object.fromEntries(runner.calls.map((c) => [c.step, c]));
  assert.deepEqual(byStep.inspect.args, [script, '--inspect']);
  assert.deepEqual(byStep.evaluate.args.slice(0, 2), [script, '--input']);
  assert.deepEqual(byStep.apply.args.slice(0, 3), [script, '--apply', '--input']);
  assert.equal(result.details.applied.receipt.before_hash, pin.expected_live_definition_sha256);
  assert.equal(result.details.applied.receipt.after_hash, pin.intended_replacement_sha256);
  assert.equal(pin.intended_replacement_sha256, '4b909c5929f0357ef442a1b2ebcb6bf8312e93be257010ed8a32072accf02aae');
  assert.match(result.details.one_use_id, /^sql103-prod-/);
});
