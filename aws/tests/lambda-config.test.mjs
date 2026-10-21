import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { run as preflight, validateApplyInputs, approvalPhrase } from '../../scripts/deployment-guard/github-lambda-config.mjs';
import { createLiveAwsAdapter } from '../../scripts/deployment-guard/lib/aws-adapter.mjs';
import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { DEPLOYMENT_TYPES } from '../../scripts/deployment-guard/lib/identity.mjs';
import { applyLambdaConfig } from '../../scripts/deployment-guard/lib/lambda-config-apply.mjs';
import {
  CONFIG_DEPLOYMENT_TYPE,
  CONFIG_PLAN_REL,
  changeSha256,
  configurationSha256,
  environmentComponent,
  evaluateConfigChange,
  loadConfigPlan,
  parseEnvironmentComponent,
  targetVariables,
} from '../../scripts/deployment-guard/lib/lambda-config.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-10-21T12:00:00.000Z');

const LIVE_VARS = { KEEP: '1', AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: 'false', OLD_FLAG: 'yes' };
const PLAN = {
  function_name: 'checksops-staging-api',
  status: 'accepted',
  set: { AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: { from: 'false', to: 'true' }, NEW_KEY: { from: null, to: 'v1' } },
  unset: { OLD_FLAG: 'yes' },
};
const EMPTY = { function_name: 'checksops-staging-api', status: 'pending_inspect', set: {}, unset: {} };
const planFor = (section) => ({ environments: { staging: section } });

function tmpRepo(plan = PLAN) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-config-'));
  fs.mkdirSync(path.join(root, 'ops/deployment-guard'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/accepted-contracts.json'), path.join(root, 'ops/deployment-guard/accepted-contracts.json'));
  fs.writeFileSync(path.join(root, CONFIG_PLAN_REL), JSON.stringify({ environments: { staging: plan, production: { ...plan, function_name: 'checksops-production-prep-api' } } }));
  return root;
}

test('lambda-config is a registered deployment type and the component carries the change hash', () => {
  assert.ok(DEPLOYMENT_TYPES.includes(CONFIG_DEPLOYMENT_TYPE));
  const hash = changeSha256(PLAN);
  assert.equal(parseEnvironmentComponent(environmentComponent(hash)), hash);
  assert.equal(parseEnvironmentComponent('write.mjs'), null);
  assert.equal(parseEnvironmentComponent('full-package@sha256:' + hash), null);
  // The hash covers the function, every key and both values, so a different plan is a different component.
  assert.notEqual(changeSha256({ ...PLAN, set: { ...PLAN.set, NEW_KEY: { from: null, to: 'v2' } } }), hash);
});

test('the committed plan records the Moov onboarding flag change from inspect runs 39592453966 and 39592458904', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, CONFIG_PLAN_REL), 'utf8'));
  const expected = {
    staging: { run: '39592453966', revision: '8503779d-4d63-4448-b8d5-9ad258cd7475', from: 'false' },
    production: { run: '39592458904', revision: 'e7d6c9ec-d4f8-4f93-bdff-fb51c3284497', from: null },
  };
  for (const [environment, want] of Object.entries(expected)) {
    const section = loadConfigPlan(REPO_ROOT, environment);
    assert.ok(section.function_name.startsWith('checksops-'));
    assert.deepEqual(section.set, { AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: { from: want.from, to: 'true' } });
    assert.deepEqual(section.unset, {});
    assert.equal(raw.environments[environment].status, 'accepted');
    assert.equal(raw.environments[environment].inspect.run_id, want.run);
    assert.equal(raw.environments[environment].inspect.live_revision_id, want.revision);
    // The inspected live state (key absent in production, "false" in staging) makes the section READY.
    const live = want.from === null ? { OTHER: 'x' } : { OTHER: 'x', AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: want.from };
    const result = evaluateConfigChange({ plan: raw, environment, liveVariables: live });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.details.state, 'READY');
    assert.deepEqual(result.details.target, { OTHER: 'x', AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: 'true' });
    // Production's recorded live state ("false") would be a collision: the plan is pinned to the key being absent.
    if (want.from === null) {
      assert.equal(evaluateConfigChange({ plan: raw, environment, liveVariables: { AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: 'false' } }).code, CODES.DEPLOYMENT_COLLISION);
    }
  }
});

test('the plan refuses credential-like keys, invalid keys, non-string values and no-op entries', () => {
  const bad = (section) => evaluateConfigChange({ plan: planFor({ ...EMPTY, ...section }), environment: 'staging', liveVariables: LIVE_VARS });
  assert.equal(bad({ set: { AWS_MOOV_WEBHOOK_SECRET: { from: 'a', to: 'b' } } }).code, CODES.UNRELATED_MUTATION);
  assert.equal(bad({ set: { DB_PASSWORD: { from: null, to: 'x' } } }).code, CODES.UNRELATED_MUTATION);
  assert.equal(bad({ unset: { SOME_API_TOKEN: 'x' } }).code, CODES.UNRELATED_MUTATION);
  assert.equal(bad({ set: { 'bad-key': { from: null, to: 'x' } } }).code, CODES.INVALID_MANIFEST);
  assert.equal(bad({ set: { FLAG: { from: 1, to: '2' } } }).code, CODES.INVALID_MANIFEST);
  assert.equal(bad({ set: { FLAG: { from: 'x', to: 'x' } } }).code, CODES.INVALID_MANIFEST);
  assert.equal(bad({ set: { FLAG: { from: 'x', to: 'y' } }, unset: { FLAG: 'x' } }).code, CODES.INVALID_MANIFEST);
  assert.equal(bad({}).code, CODES.INVALID_MANIFEST);
});

test('a plan is READY when every listed key holds its recorded live value, ALREADY_ACCEPTED when every key holds the intended one, and a collision otherwise', () => {
  const ready = evaluateConfigChange({ plan: planFor(PLAN), environment: 'staging', liveVariables: LIVE_VARS });
  assert.equal(ready.ok, true, ready.message);
  assert.equal(ready.details.state, 'READY');
  assert.deepEqual(ready.details.target, { KEEP: '1', AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: 'true', NEW_KEY: 'v1' });
  assert.deepEqual(ready.details.target, targetVariables(LIVE_VARS, PLAN));

  const done = evaluateConfigChange({ plan: planFor(PLAN), environment: 'staging', liveVariables: ready.details.target });
  assert.equal(done.details.state, 'ALREADY_ACCEPTED');

  const partial = evaluateConfigChange({ plan: planFor(PLAN), environment: 'staging', liveVariables: { ...LIVE_VARS, NEW_KEY: 'v1' } });
  assert.equal(partial.details.state, 'READY');

  const drifted = evaluateConfigChange({ plan: planFor(PLAN), environment: 'staging', liveVariables: { ...LIVE_VARS, AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: 'maybe' } });
  assert.equal(drifted.code, CODES.DEPLOYMENT_COLLISION);
  assert.deepEqual(drifted.details.problems.map((row) => row.key), ['AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED']);
  const unsetDrift = evaluateConfigChange({ plan: planFor(PLAN), environment: 'staging', liveVariables: { ...LIVE_VARS, OLD_FLAG: 'no' } });
  assert.equal(unsetDrift.code, CODES.DEPLOYMENT_COLLISION);
  const absentFrom = evaluateConfigChange({ plan: planFor(PLAN), environment: 'staging', liveVariables: { KEEP: '1', OLD_FLAG: 'yes' } });
  assert.equal(absentFrom.code, CODES.DEPLOYMENT_COLLISION);
});

test('configurationSha256 ignores transient status fields and reacts to every other field', () => {
  const base = { FunctionName: 'f', Role: 'r', Runtime: 'nodejs22.x', Environment: { Variables: { A: '1' } }, RevisionId: 'x', LastModified: 't', LastUpdateStatus: 'Successful' };
  assert.equal(configurationSha256(base), configurationSha256({ ...base, RevisionId: 'y', LastModified: 'u', LastUpdateStatus: 'InProgress' }));
  assert.notEqual(configurationSha256(base), configurationSha256({ ...base, Environment: { Variables: { A: '2' } } }));
  assert.notEqual(configurationSha256(base), configurationSha256({ ...base, MemorySize: 2048 }));
});

function fakeLambda({ variables = LIVE_VARS, codeSha256 = 'live-code', revisionId = 'rev-1', updateStatus = 'Successful', mutateOnUpdate = null } = {}) {
  const state = { variables: { ...variables }, codeSha256, revisionId, memory: 1024, calls: [] };
  const configuration = () => ({
    FunctionName: 'checksops-staging-api', Role: 'arn:role', Runtime: 'nodejs22.x', Handler: 'index.handler', MemorySize: state.memory, Timeout: 30,
    Environment: { Variables: { ...state.variables } }, VpcConfig: { SubnetIds: ['a'], SecurityGroupIds: ['b'] },
    CodeSha256: state.codeSha256, RevisionId: state.revisionId, LastUpdateStatus: updateStatus, LastModified: 'now',
  });
  return {
    state,
    authorizeWrites: (details) => { state.calls.push(['authorizeWrites', details]); return { ok: true }; },
    getFunctionConfiguration: async () => ({ ok: true, details: { codeSha256: state.codeSha256, revisionId: state.revisionId, lastUpdateStatus: updateStatus, configuration: configuration() } }),
    updateFunctionConfiguration: async ({ environment, revisionId }) => {
      state.calls.push(['updateFunctionConfiguration', revisionId]);
      if (revisionId !== state.revisionId) return { ok: false, code: CODES.DEPLOYMENT_COLLISION, message: 'revision mismatch' };
      state.variables = { ...environment };
      state.revisionId = 'rev-2';
      if (mutateOnUpdate) mutateOnUpdate(state);
      return { ok: true, details: { codeSha256: state.codeSha256, revisionId: state.revisionId } };
    },
  };
}

function issueConfigReceipt(root, { section = PLAN, environment = 'staging', component = 'checksops-staging-api', fingerprint = { codeSha256: 'live-code', revisionId: 'rev-1' }, deployment_type = CONFIG_DEPLOYMENT_TYPE, owned = null }) {
  const lease = acquireLease(root, { workstream_id: 'ws-config', component, environment, commit: SHA, operator: 'tester' }, NOW);
  assert.equal(lease.ok, true, lease.message);
  const issued = issueReceipt(root, {
    workstream_id: 'ws-config',
    branch: 'main',
    commit: SHA,
    operator: 'tester',
    target_environment: environment,
    target_component: component,
    deployment_type,
    owned_components: owned || [environmentComponent(changeSha256(section))],
    preflight_live_fingerprint: fingerprint,
    lease: lease.details.lease,
  }, { now: NOW });
  assert.equal(issued.ok, true, issued.message);
  return issued.details;
}

const applyInput = (receipt, extra = {}) => ({
  apply: true,
  function_name: 'checksops-staging-api',
  target_environment: 'staging',
  workstream_id: 'ws-config',
  commit: SHA,
  receipt_path: receipt.file,
  ...extra,
});
const applyCtx = (root, aws, receiptFile = null) => ({
  env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1', ...(receiptFile ? { CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: receiptFile } : {}) },
  guardRoot: root,
  repoRoot: root,
  aws,
  now: NOW,
});

test('the writer applies only the planned keys, verifies the result and keeps everything else', async () => {
  const root = tmpRepo();
  const aws = fakeLambda();
  const receipt = issueConfigReceipt(root, {});
  const result = await applyLambdaConfig(applyInput(receipt), applyCtx(root, aws, receipt.file));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(aws.state.variables, { KEEP: '1', AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: 'true', NEW_KEY: 'v1' });
  assert.equal(result.details.after.fingerprint.revisionId, 'rev-2');
  assert.equal(result.details.after.fingerprint.codeSha256, 'live-code');
  assert.deepEqual(result.details.changes.map((row) => [row.key, row.op, row.status]), [
    ['AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED', 'set', 'ready'], ['NEW_KEY', 'set', 'ready'], ['OLD_FLAG', 'unset', 'ready'],
  ]);
  // The result never carries variable values, only key names.
  assert.ok(!JSON.stringify(result).includes('"v1"'));
  // The receipt is consumed: a second apply with the same receipt is refused.
  const again = await applyLambdaConfig(applyInput(receipt), applyCtx(root, fakeLambda(), receipt.file));
  assert.equal(again.ok, false);
});

test('the writer refuses a receipt for a different change, live drift, an already-applied plan, caller-supplied variables and a missing flag', async () => {
  const root = tmpRepo();
  const other = { ...PLAN, set: { AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: { from: 'false', to: 'TRUE' } } };
  const wrongReceipt = issueConfigReceipt(root, { section: other });
  const notOwned = await applyLambdaConfig(applyInput(wrongReceipt), applyCtx(root, fakeLambda(), wrongReceipt.file));
  assert.equal(notOwned.code, CODES.RECEIPT_MISMATCH);

  const receipt = issueConfigReceipt(root, {});
  const drifted = await applyLambdaConfig(applyInput(receipt), applyCtx(root, fakeLambda({ revisionId: 'rev-9' }), receipt.file));
  assert.equal(drifted.code, CODES.DEPLOYMENT_COLLISION);
  const valueDrift = await applyLambdaConfig(applyInput(receipt), applyCtx(root, fakeLambda({ variables: { ...LIVE_VARS, OLD_FLAG: 'no' } }), receipt.file));
  assert.equal(valueDrift.code, CODES.DEPLOYMENT_COLLISION);
  const done = await applyLambdaConfig(applyInput(receipt), applyCtx(root, fakeLambda({ variables: targetVariables(LIVE_VARS, PLAN) }), receipt.file));
  assert.equal(done.code, CODES.UNRELATED_MUTATION);
  const supplied = await applyLambdaConfig(applyInput(receipt, { variables: { X: '1' } }), applyCtx(root, fakeLambda(), receipt.file));
  assert.equal(supplied.code, CODES.UNRELATED_MUTATION);
  const noFlag = await applyLambdaConfig(applyInput(receipt), { ...applyCtx(root, fakeLambda(), receipt.file), env: { CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: receipt.file } });
  assert.equal(noFlag.code, CODES.GUARD_APPLY_FORBIDDEN);
  // A hand-built plan with a credential-like key cannot be slipped past the receipt.
  const secret = { ...PLAN, set: { ...PLAN.set, MOOV_SECRET: { from: null, to: 'x' } } };
  const secretReceipt = issueConfigReceipt(root, { section: secret });
  const leaked = await applyLambdaConfig(applyInput(secretReceipt, { plan: secret }), applyCtx(root, fakeLambda(), secretReceipt.file));
  assert.equal(leaked.code, CODES.UNRELATED_MUTATION);
});

test('the writer fails closed when the update changed something outside the environment or the code', async () => {
  const root = tmpRepo();
  const receipt = issueConfigReceipt(root, {});
  const memory = await applyLambdaConfig(applyInput(receipt), applyCtx(root, fakeLambda({ mutateOnUpdate: (state) => { state.memory = 2048; } }), receipt.file));
  assert.equal(memory.code, CODES.UNRELATED_MUTATION);
  const root2 = tmpRepo();
  const receipt2 = issueConfigReceipt(root2, {});
  const code = await applyLambdaConfig(applyInput(receipt2), applyCtx(root2, fakeLambda({ mutateOnUpdate: (state) => { state.codeSha256 = 'other'; } }), receipt2.file));
  assert.equal(code.code, CODES.DEPLOYMENT_COLLISION);
});

test('an overlay or rebuild receipt cannot authorize a configuration change', async () => {
  const root = tmpRepo();
  const overlay = issueConfigReceipt(root, { deployment_type: 'lambda-overlay', owned: ['write.mjs'] });
  const result = await applyLambdaConfig(applyInput(overlay), applyCtx(root, fakeLambda(), overlay.file));
  assert.equal(result.code, CODES.RECEIPT_MISMATCH);
  const root2 = tmpRepo();
  const rebuild = issueConfigReceipt(root2, { deployment_type: 'lambda-rebuild', owned: ['full-package@sha256:' + 'b'.repeat(64)] });
  const result2 = await applyLambdaConfig(applyInput(rebuild), applyCtx(root2, fakeLambda(), rebuild.file));
  assert.equal(result2.code, CODES.RECEIPT_MISMATCH);
});

test('the live adapter sends UpdateFunctionConfiguration only when opened for environment writes, with RevisionId and variables only', async () => {
  const sent = [];
  const lambda = { send: async ({ operation, input }) => { sent.push({ operation, input }); return { CodeSha256: 'c', RevisionId: 'r2', LastUpdateStatus: 'InProgress' }; } };
  const closed = createLiveAwsAdapter({ clients: { lambda }, authorized: true });
  const refused = await closed.updateFunctionConfiguration({ functionName: 'f', environment: { A: '1' }, revisionId: 'r1' });
  assert.equal(refused.code, CODES.UNRELATED_MUTATION);
  const open = createLiveAwsAdapter({ clients: { lambda }, environmentWrites: true });
  const unauthorized = await open.updateFunctionConfiguration({ functionName: 'f', environment: { A: '1' }, revisionId: 'r1' });
  assert.equal(unauthorized.code, CODES.GUARD_APPLY_FORBIDDEN);
  open.authorizeWrites({});
  assert.equal((await open.updateFunctionConfiguration({ functionName: 'f', environment: { A: '1' } })).code, CODES.DEPLOYMENT_COLLISION);
  assert.equal((await open.updateFunctionConfiguration({ functionName: 'f', environment: { A: 1 }, revisionId: 'r1' })).code, CODES.INVALID_MANIFEST);
  assert.equal((await open.updateFunctionConfiguration({ functionName: 'f', environment: { A: '1' }, revisionId: 'r1', memorySize: 2048 })).code, CODES.UNRELATED_MUTATION);
  assert.equal(sent.length, 0);
  const done = await open.updateFunctionConfiguration({ functionName: 'f', environment: { A: '1' }, revisionId: 'r1' });
  assert.equal(done.ok, true);
  assert.deepEqual(sent, [{ operation: 'UpdateFunctionConfiguration', input: { FunctionName: 'f', Environment: { Variables: { A: '1' } }, RevisionId: 'r1' } }]);
});

const ENV = { GITHUB_SHA: SHA, GITHUB_REF_NAME: 'main', GITHUB_ACTOR: 'owner', GITHUB_RUN_ID: '777', CHECKSOPS_CONFIG_ENVIRONMENT: 'staging' };
const liveDeps = (variables = LIVE_VARS, extra = {}) => ({
  inspectLive: async () => {
    const configuration = { FunctionName: 'checksops-staging-api', CodeSha256: 'live-code', RevisionId: 'rev-1', Environment: { Variables: { ...variables } } };
    return { functionName: 'checksops-staging-api', codeSha256: 'live-code', revisionId: 'rev-1', configuration, configurationSha256: configurationSha256(configuration), variables: { ...variables } };
  },
  signer: (unsigned) => unsigned,
  ...extra,
});

test('preflight inspect with an empty plan reports PENDING_PLAN with live key names only', async () => {
  const root = tmpRepo(EMPTY);
  const result = await preflight({ ...ENV, CHECKSOPS_CONFIG_MODE: 'inspect' }, { root, ...liveDeps() });
  assert.equal(result.state, 'PENDING_PLAN');
  assert.equal(result.mutation, false);
  assert.deepEqual(result.live_variable_names, ['AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED', 'KEEP', 'OLD_FLAG']);
  const diff = fs.readFileSync(path.join(root, '.deployment-guard/config-diff-staging.json'), 'utf8');
  assert.ok(!diff.includes('"false"') && !diff.includes('"yes"'));
  await assert.rejects(preflight({ ...ENV, CHECKSOPS_CONFIG_MODE: 'apply', CHECKSOPS_EXPECTED_LIVE_REVISION_ID: 'rev-1', CHECKSOPS_CONFIG_APPROVAL: approvalPhrase('staging') }, { root, ...liveDeps() }), (error) => error.code === CODES.INVALID_MANIFEST);
});

test('preflight inspect with a filled plan reports READY, BLOCKED on drift, and ALREADY_ACCEPTED after the change', async () => {
  const root = tmpRepo();
  const ready = await preflight({ ...ENV, CHECKSOPS_CONFIG_MODE: 'inspect' }, { root, ...liveDeps() });
  assert.equal(ready.state, 'READY');
  assert.equal(ready.change_sha256, changeSha256(PLAN));
  const blocked = await preflight({ ...ENV, CHECKSOPS_CONFIG_MODE: 'inspect' }, { root, ...liveDeps({ ...LIVE_VARS, OLD_FLAG: 'no' }) });
  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.problems.length, 1);
  const done = await preflight({ ...ENV, CHECKSOPS_CONFIG_MODE: 'inspect' }, { root, ...liveDeps(targetVariables(LIVE_VARS, PLAN)) });
  assert.equal(done.state, 'ALREADY_ACCEPTED');
  await assert.rejects(preflight({ ...ENV, CHECKSOPS_CONFIG_MODE: 'apply', CHECKSOPS_EXPECTED_LIVE_REVISION_ID: 'rev-1', CHECKSOPS_CONFIG_APPROVAL: approvalPhrase('staging') }, { root, ...liveDeps(targetVariables(LIVE_VARS, PLAN)) }), (error) => error.code === CODES.UNRELATED_MUTATION);
});

test('preflight apply needs the inspect RevisionId and the exact phrase, then issues a config receipt the writer accepts', async () => {
  const root = tmpRepo();
  await assert.rejects(
    preflight({ ...ENV, CHECKSOPS_CONFIG_MODE: 'apply', CHECKSOPS_EXPECTED_LIVE_REVISION_ID: 'rev-1', CHECKSOPS_CONFIG_APPROVAL: 'apply please' }, { root, ...liveDeps() }),
    (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED,
  );
  await assert.rejects(
    preflight({ ...ENV, CHECKSOPS_CONFIG_MODE: 'apply', CHECKSOPS_EXPECTED_LIVE_REVISION_ID: 'stale', CHECKSOPS_CONFIG_APPROVAL: approvalPhrase('staging') }, { root, ...liveDeps() }),
    (error) => error.code === CODES.DEPLOYMENT_COLLISION,
  );
  const result = await preflight({ ...ENV, CHECKSOPS_CONFIG_MODE: 'apply', CHECKSOPS_EXPECTED_LIVE_REVISION_ID: 'rev-1', CHECKSOPS_CONFIG_APPROVAL: approvalPhrase('staging') }, { root, ...liveDeps() });
  assert.equal(result.state, 'READY');
  const receipt = JSON.parse(fs.readFileSync(result.authorization.receiptFile, 'utf8'));
  assert.equal(receipt.deployment_type, CONFIG_DEPLOYMENT_TYPE);
  assert.deepEqual(receipt.owned_components, [environmentComponent(changeSha256(PLAN))]);
  const input = JSON.parse(fs.readFileSync(result.authorization.configInput, 'utf8'));
  assert.equal(input.change_sha256, changeSha256(PLAN));
  const aws = fakeLambda();
  const applied = await applyLambdaConfig({ ...input, apply: true }, { ...applyCtx(root, aws, input.receipt_path), now: Date.now() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.deepEqual(aws.state.variables, targetVariables(LIVE_VARS, PLAN));
});

test('production apply needs a staging acceptance reference; verify passes only after the change', async () => {
  assert.throws(() => validateApplyInputs({ environment: 'production', approval: approvalPhrase('production'), stagingAcceptance: '', expectedLiveRevisionId: 'x', liveRevisionId: 'x' }), (error) => error.code === CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.doesNotThrow(() => validateApplyInputs({ environment: 'production', approval: approvalPhrase('production'), stagingAcceptance: 'https://github.com/michaelcarletta-cmd/ChecksOps/pull/1', expectedLiveRevisionId: 'x', liveRevisionId: 'x' }));
  assert.equal(approvalPhrase('production'), 'APPLY API CONFIGURATION TO PRODUCTION');
  const root = tmpRepo();
  await assert.rejects(preflight({ ...ENV, CHECKSOPS_CONFIG_MODE: 'verify' }, { root, ...liveDeps() }), (error) => error.code === CODES.DEPLOYMENT_COLLISION);
  const verified = await preflight({ ...ENV, CHECKSOPS_CONFIG_MODE: 'verify' }, { root, ...liveDeps(targetVariables(LIVE_VARS, PLAN)) });
  assert.equal(verified.state, 'VERIFIED');
});
