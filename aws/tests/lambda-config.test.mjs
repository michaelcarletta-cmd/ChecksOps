import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  planSection,
  targetVariables,
  valueSha256,
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

test('the committed plan keeps the Moov onboarding flag applies (runs 39594167097, 39594352935) in history', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, CONFIG_PLAN_REL), 'utf8'));
  const expected = {
    staging: { inspect: '39592453966', run: '39594167097', before: '8503779d-4d63-4448-b8d5-9ad258cd7475', after: 'b9c2981e-51f7-432b-a8e2-286e4bdaa9af', from: 'false' },
    production: { inspect: '39592458904', run: '39594352935', before: 'e7d6c9ec-d4f8-4f93-bdff-fb51c3284497', after: '58733b08-ef0a-4ab9-a47a-30fc15ebeafb', from: null },
  };
  for (const [environment, want] of Object.entries(expected)) {
    const row = raw.environments[environment].history[0];
    assert.equal(row.inspect.run_id, want.inspect);
    assert.equal(row.applied.run_id, want.run);
    assert.equal(row.applied.state, 'VERIFIED');
    assert.equal(row.applied.revision_id_before, row.inspect.live_revision_id);
    assert.equal(row.applied.revision_id_before, want.before);
    assert.equal(row.applied.revision_id_after, want.after);
    assert.equal(row.applied.code_sha256, row.inspect.live_code_sha256);
    const applied = { function_name: raw.environments[environment].function_name, ...row.applied.applied_change };
    assert.deepEqual(applied.set, { AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: { from: want.from, to: 'true' } });
    // The recorded change hash is the one the run's receipt owned.
    assert.equal(changeSha256(applied), row.applied.change_sha256);
  }
  assert.equal(raw.environments.production.history[0].applied.staging_acceptance, raw.environments.staging.history[0].applied.run_url);
});

test('the committed plan records the remaining-features applies (runs 39616453836, 39617806126) and starts the next change empty', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, CONFIG_PLAN_REL), 'utf8'));
  const on = (from) => ({ from, to: 'true' });
  const providerFlags = { AWS_PLAID_ENABLED: 'false', AWS_ACTUM_ENABLED: 'false', AWS_QUICKBOOKS_ENABLED: 'false' };
  const expected = {
    staging: {
      inspect: '39613470170',
      run: '39616453836',
      revision: 'b9c2981e-51f7-432b-a8e2-286e4bdaa9af',
      after: 'b2e6a162-79ad-4c8e-9177-6f33080a9ded',
      set: {
        AWS_ENDORSEMENT_RESEND_ENABLED: on(null),
        AWS_CHECKALT_STATUS_RECONCILE_ENABLED: on(null),
        AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED: on(null),
        AWS_MOOV_MONTHLY_BILLING_ENABLED: on(null),
      },
      unset: providerFlags,
    },
    production: {
      inspect: '39613475228',
      run: '39617806126',
      revision: '58733b08-ef0a-4ab9-a47a-30fc15ebeafb',
      after: '6cb46f3a-e10d-4645-b18d-6e5b156d65d9',
      set: {
        AWS_ENDORSEMENT_RESEND_ENABLED: on('false'),
        AWS_CHECKALT_STATUS_RECONCILE_ENABLED: on('false'),
        AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED: on('false'),
        AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST: on('false'),
        AWS_TENANT_FEE_INVOICE_EMAIL_ENABLED: on(null),
      },
      unset: {
        AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED: 'false',
        AWS_PROVIDER_RECIPIENT_KYC_TOS_WRITES_ENABLED: 'false',
        ...providerFlags,
      },
    },
  };
  for (const [environment, want] of Object.entries(expected)) {
    const section = loadConfigPlan(REPO_ROOT, environment);
    assert.equal(section.status, 'applied');
    assert.deepEqual(section.set, {});
    assert.deepEqual(section.unset, {});
    const row = raw.environments[environment];
    assert.equal(row.inspect.run_id, want.inspect);
    assert.equal(row.inspect.live_revision_id, want.revision);
    // The revision the change starts from is the one the previous apply left behind.
    assert.equal(row.inspect.live_revision_id, row.history[0].applied.revision_id_after);
    assert.equal(row.applied.run_id, want.run);
    assert.equal(row.applied.state, 'VERIFIED');
    assert.equal(row.applied.revision_id_before, row.inspect.live_revision_id);
    assert.equal(row.applied.revision_id_after, want.after);
    assert.equal(row.applied.code_sha256, row.inspect.live_code_sha256);
    assert.deepEqual(row.applied.applied_change, { set: want.set, unset: want.unset });
    // The recorded change hash is the one the run's receipt owned.
    assert.equal(changeSha256({ function_name: row.function_name, ...row.applied.applied_change }), row.applied.change_sha256);
    // Safety guards are not features: the change never opened them.
    for (const key of ['AWS_ENDORSEMENT_RESEND_ALLOW_ANY_RECIPIENT', 'AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED', 'AWS_FINANCIAL_SANDBOX_SIMULATION_ENABLED', 'AWS_PROVIDER_WEBHOOK_DRY_RUN']) {
      assert.equal(Object.hasOwn(want.set, key), false, key);
      assert.equal(Object.hasOwn(want.unset, key), false, key);
    }
  }
  assert.equal(raw.environments.production.applied.staging_acceptance, raw.environments.staging.applied.run_url);
});

test('the plan refuses credential-like keys in set or as a plain unset value, invalid keys, non-string values and no-op entries', () => {
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

// ---- Credential-like removal: the plan and every output carry hashes only. ----

const SECRET_VALUE = 'sekret-VALUE-123';
const OTHER_SECRET = 'other-KEEP-secret-456';
const SECRET_SHA = createHash('sha256').update(Buffer.from(SECRET_VALUE, 'utf8')).digest('hex');
const SECRET_LIVE = { ...LIVE_VARS, CHECKSOPS_DB_BRIDGE_TOKEN: SECRET_VALUE, OTHER_API_KEY: OTHER_SECRET };
const SECRET_PLAN = {
  function_name: 'checksops-staging-api',
  status: 'accepted',
  set: { AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED: { from: 'false', to: 'true' } },
  unset: { OLD_FLAG: 'yes', CHECKSOPS_DB_BRIDGE_TOKEN: { from_sha256: SECRET_SHA } },
};
const leaks = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.includes(SECRET_VALUE) || text.includes(OTHER_SECRET);
};
const CREDENTIAL_ROW_KEYS = ['credential', 'from_sha256', 'key', 'live_sha256', 'op', 'status'];

test('a credential-like unset with from_sha256 is READY on a matching live hash, ALREADY_ACCEPTED when absent, and a hash-only collision otherwise', () => {
  assert.equal(valueSha256(SECRET_VALUE), SECRET_SHA);
  const ready = evaluateConfigChange({ plan: planFor(SECRET_PLAN), environment: 'staging', liveVariables: SECRET_LIVE });
  assert.equal(ready.ok, true, ready.message);
  assert.equal(ready.details.state, 'READY');
  const row = ready.details.changes.find((change) => change.key === 'CHECKSOPS_DB_BRIDGE_TOKEN');
  assert.deepEqual(Object.keys(row).sort(), CREDENTIAL_ROW_KEYS);
  assert.deepEqual(row, { key: 'CHECKSOPS_DB_BRIDGE_TOKEN', op: 'unset', credential: true, from_sha256: SECRET_SHA, live_sha256: SECRET_SHA, status: 'ready' });
  // The writer still gets the full intended map: the token is gone, the unrelated credential is carried over.
  assert.equal(Object.hasOwn(ready.details.target, 'CHECKSOPS_DB_BRIDGE_TOKEN'), false);
  assert.equal(ready.details.target.OTHER_API_KEY, OTHER_SECRET);
  assert.deepEqual(ready.details.target, targetVariables(SECRET_LIVE, planSection(planFor(SECRET_PLAN), 'staging')));
  // ...but the map is not enumerable, so no serialization of the evaluation carries it.
  assert.equal(leaks(ready), false);
  assert.equal(leaks({ ...ready.details }), false);

  const done = evaluateConfigChange({ plan: planFor(SECRET_PLAN), environment: 'staging', liveVariables: ready.details.target });
  assert.equal(done.ok, true, done.message);
  assert.equal(done.details.state, 'ALREADY_ACCEPTED');
  assert.deepEqual(done.details.changes.find((change) => change.key === 'CHECKSOPS_DB_BRIDGE_TOKEN'),
    { key: 'CHECKSOPS_DB_BRIDGE_TOKEN', op: 'unset', credential: true, from_sha256: SECRET_SHA, live_sha256: null, status: 'already_accepted' });
  assert.equal(leaks(done), false);

  const rotated = evaluateConfigChange({ plan: planFor(SECRET_PLAN), environment: 'staging', liveVariables: { ...SECRET_LIVE, CHECKSOPS_DB_BRIDGE_TOKEN: 'sekret-ROTATED-999' } });
  assert.equal(rotated.code, CODES.DEPLOYMENT_COLLISION);
  assert.deepEqual(rotated.details.problems, [{
    code: CODES.DEPLOYMENT_COLLISION, reason: 'live_value_mismatch', key: 'CHECKSOPS_DB_BRIDGE_TOKEN', credential: true,
    expected_live_sha256: SECRET_SHA, live_sha256: valueSha256('sekret-ROTATED-999'),
  }]);
  assert.ok(!JSON.stringify(rotated).includes('sekret-ROTATED-999'));
  assert.equal(leaks(rotated), false);
});

test('a credential-like unset must be exactly { from_sha256 }: a plain value is refused without echoing it', () => {
  const evaluate = (unset) => evaluateConfigChange({ plan: planFor({ ...EMPTY, unset }), environment: 'staging', liveVariables: SECRET_LIVE });
  const plain = evaluate({ CHECKSOPS_DB_BRIDGE_TOKEN: SECRET_VALUE });
  assert.equal(plain.code, CODES.UNRELATED_MUTATION);
  assert.match(plain.message, /from_sha256/);
  assert.deepEqual(plain.details, { environment: 'staging', key: 'CHECKSOPS_DB_BRIDGE_TOKEN' });
  assert.equal(leaks(plain), false);
  assert.throws(() => planSection(planFor({ ...EMPTY, unset: { AWS_PLAID_WEBHOOK_SECRET: 'whsec' } }), 'staging'), (error) => error.code === CODES.UNRELATED_MUTATION && !JSON.stringify(error.details).includes('whsec'));
  for (const entry of [{ from_sha256: 'abc' }, { from_sha256: SECRET_SHA.toUpperCase() }, { from_sha256: SECRET_SHA, from: SECRET_VALUE }, {}, null, [SECRET_SHA], 7]) {
    const result = evaluate({ CHECKSOPS_DB_BRIDGE_TOKEN: entry });
    assert.equal(result.code, CODES.INVALID_MANIFEST, JSON.stringify(entry));
    assert.equal(leaks(result), false);
  }
  // The hashed form is for credential-like keys only; ordinary keys keep the exact string.
  assert.equal(evaluate({ OLD_FLAG: { from_sha256: SECRET_SHA } }).code, CODES.INVALID_MANIFEST);
  // set still refuses credential-like keys, with or without a hash.
  assert.equal(evaluateConfigChange({ plan: planFor({ ...EMPTY, set: { CHECKSOPS_DB_BRIDGE_TOKEN: { from: null, to: 'x' } } }), environment: 'staging', liveVariables: SECRET_LIVE }).code, CODES.UNRELATED_MUTATION);
});

test('the change SHA-256 the receipt owns covers from_sha256; ordinary unsets keep their exact-value form and hash', () => {
  const base = changeSha256(planSection(planFor(SECRET_PLAN), 'staging'));
  const other = { ...SECRET_PLAN, unset: { ...SECRET_PLAN.unset, CHECKSOPS_DB_BRIDGE_TOKEN: { from_sha256: 'f'.repeat(64) } } };
  assert.notEqual(changeSha256(planSection(planFor(other), 'staging')), base);
  const without = { ...SECRET_PLAN, unset: { OLD_FLAG: 'yes' } };
  assert.notEqual(changeSha256(planSection(planFor(without), 'staging')), base);
  // An ordinary unset row is unchanged: exact from and live, compared as strings.
  const plainRow = evaluateConfigChange({ plan: planFor(PLAN), environment: 'staging', liveVariables: LIVE_VARS }).details.changes.find((change) => change.key === 'OLD_FLAG');
  assert.deepEqual(plainRow, { key: 'OLD_FLAG', op: 'unset', from: 'yes', to: null, live: 'yes', status: 'ready' });
  assert.deepEqual(planSection(planFor(PLAN), 'staging').unset, { OLD_FLAG: 'yes' });
});

test('with a credential in the live environment, no inspect, diff file, apply, writer or verify output carries its value', async () => {
  // Empty plan: names, plus a SHA-256 per credential-like key for the plan author to copy.
  const emptyRoot = tmpRepo(EMPTY);
  const pending = await preflight({ ...ENV, CHECKSOPS_CONFIG_MODE: 'inspect' }, { root: emptyRoot, ...liveDeps(SECRET_LIVE) });
  assert.equal(pending.state, 'PENDING_PLAN');
  assert.deepEqual(pending.live_credential_sha256, { CHECKSOPS_DB_BRIDGE_TOKEN: SECRET_SHA, OTHER_API_KEY: valueSha256(OTHER_SECRET) });
  const pendingDiff = fs.readFileSync(path.join(emptyRoot, '.deployment-guard/config-diff-staging.json'), 'utf8');
  assert.ok(pendingDiff.includes(SECRET_SHA));
  assert.equal(leaks(pending), false);
  assert.equal(leaks(pendingDiff), false);

  // Filled plan: inspect READY, the diff file and the result carry hashes only.
  const root = tmpRepo(SECRET_PLAN);
  const inspected = await preflight({ ...ENV, CHECKSOPS_CONFIG_MODE: 'inspect' }, { root, ...liveDeps(SECRET_LIVE) });
  assert.equal(inspected.state, 'READY');
  assert.equal(inspected.live_credential_sha256.CHECKSOPS_DB_BRIDGE_TOKEN, SECRET_SHA);
  assert.deepEqual(Object.keys(inspected.changes.find((change) => change.key === 'CHECKSOPS_DB_BRIDGE_TOKEN')).sort(), CREDENTIAL_ROW_KEYS);
  assert.equal(leaks(inspected), false);
  assert.equal(leaks(fs.readFileSync(path.join(root, '.deployment-guard/config-diff-staging.json'), 'utf8')), false);

  // Drift: BLOCKED inspect and the collision diff carry hashes only.
  const drifted = await preflight({ ...ENV, CHECKSOPS_CONFIG_MODE: 'inspect' }, { root, ...liveDeps({ ...SECRET_LIVE, CHECKSOPS_DB_BRIDGE_TOKEN: 'sekret-VALUE-1234' }) });
  assert.equal(drifted.state, 'BLOCKED');
  assert.ok(!JSON.stringify(drifted).includes('sekret-VALUE-1234'));
  assert.equal(leaks(drifted), false);

  // Verify before the change: the thrown error's details are hash-only.
  await assert.rejects(preflight({ ...ENV, CHECKSOPS_CONFIG_MODE: 'verify' }, { root, ...liveDeps(SECRET_LIVE) }), (error) => {
    assert.equal(error.code, CODES.DEPLOYMENT_COLLISION);
    assert.equal(leaks({ message: error.message, details: error.details }), false);
    return true;
  });

  // Apply: receipt, config input and the writer's result never carry the value.
  const authorized = await preflight({ ...ENV, CHECKSOPS_CONFIG_MODE: 'apply', CHECKSOPS_EXPECTED_LIVE_REVISION_ID: 'rev-1', CHECKSOPS_CONFIG_APPROVAL: approvalPhrase('staging') }, { root, ...liveDeps(SECRET_LIVE) });
  assert.equal(authorized.state, 'READY');
  assert.equal(leaks(authorized), false);
  const input = JSON.parse(fs.readFileSync(authorized.authorization.configInput, 'utf8'));
  assert.equal(leaks(input), false);
  assert.equal(leaks(fs.readFileSync(authorized.authorization.receiptFile, 'utf8')), false);
  const aws = fakeLambda({ variables: SECRET_LIVE });
  const applied = await applyLambdaConfig({ ...input, apply: true }, { ...applyCtx(root, aws, input.receipt_path), now: Date.now() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(Object.hasOwn(aws.state.variables, 'CHECKSOPS_DB_BRIDGE_TOKEN'), false);
  assert.equal(aws.state.variables.OTHER_API_KEY, OTHER_SECRET);
  assert.deepEqual(applied.details.changes.map((row) => [row.key, row.op, row.status]), [
    ['AWS_MOOV_ONBOARDING_PRODUCTION_ENABLED', 'set', 'ready'], ['OLD_FLAG', 'unset', 'ready'], ['CHECKSOPS_DB_BRIDGE_TOKEN', 'unset', 'ready'],
  ]);
  assert.equal(leaks(applied), false);

  // Verify after the change passes and carries hashes only.
  const verified = await preflight({ ...ENV, CHECKSOPS_CONFIG_MODE: 'verify' }, { root, ...liveDeps(aws.state.variables) });
  assert.equal(verified.state, 'VERIFIED');
  assert.equal(leaks(verified), false);
});

test('the writer refuses a credential that changed since the plan, and its failure carries hashes only', async () => {
  const root = tmpRepo(SECRET_PLAN);
  const receipt = issueConfigReceipt(root, { section: planSection(planFor(SECRET_PLAN), 'staging') });
  const aws = fakeLambda({ variables: { ...SECRET_LIVE, CHECKSOPS_DB_BRIDGE_TOKEN: 'sekret-ROTATED-999' } });
  const result = await applyLambdaConfig(applyInput(receipt), applyCtx(root, aws, receipt.file));
  assert.equal(result.code, CODES.DEPLOYMENT_COLLISION);
  assert.ok(!JSON.stringify(result).includes('sekret-ROTATED-999'));
  assert.equal(leaks(result), false);
  assert.equal(aws.state.calls.some(([name]) => name === 'updateFunctionConfiguration'), false);
  // A hand-built plan that carries the plain value is refused before anything is read or written.
  const plain = { ...SECRET_PLAN, unset: { ...SECRET_PLAN.unset, CHECKSOPS_DB_BRIDGE_TOKEN: SECRET_VALUE } };
  const plainResult = await applyLambdaConfig(applyInput(receipt, { plan: plain }), applyCtx(root, fakeLambda({ variables: SECRET_LIVE }), receipt.file));
  assert.equal(plainResult.code, CODES.UNRELATED_MUTATION);
  assert.equal(leaks(plainResult), false);
});
