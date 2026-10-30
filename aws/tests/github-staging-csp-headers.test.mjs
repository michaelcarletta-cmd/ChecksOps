/**
 * Guarded staging CSP headers (SPA CSP rollout step 1, ops/security/SPA_CSP_ROLLOUT.md): only
 * staging distribution E1CG52WRQZI7X1 and never the production policy; apply and rollback need the
 * exact phrase and the inspect's snapshot; the policy carries only a report-only CSP equal to
 * buildCsp of the live index.html; the distribution changes only in
 * DefaultCacheBehavior.ResponseHeadersPolicyId; rollback restores the previous value (none).
 * Runbook: ops/deployment-guard/STAGING_CSP_HEADERS.md.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEPLOYMENT_TYPE,
  DISTRIBUTION_ID,
  OWNED_COMPONENTS,
  POLICY_NAME,
  PREVIOUS_RESPONSE_HEADERS_POLICY_ID,
  PRODUCTION_DISTRIBUTION_ID,
  PRODUCTION_POLICY_ID,
  REPORT_ONLY_HEADER,
  TARGET_COMPONENT,
  actionFor,
  assertNotProductionPolicy,
  assertOnlyBehaviorDelta,
  assertStagingDistribution,
  awsClient,
  classify,
  desiredDistributionConfig,
  desiredPolicyConfig,
  loadTemplatePolicy,
  main as writer,
  normalizePolicyConfig,
  readState,
} from '../../scripts/deployment-guard/staging-csp-headers.mjs';
import { APPROVAL_PHRASES, run as preflight, validateChangeInputs } from '../../scripts/deployment-guard/github-staging-csp-headers.mjs';
import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { DEPLOYMENT_TYPES } from '../../scripts/deployment-guard/lib/identity.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import { buildCsp } from '../../scripts/deployment-guard/lib/spa-csp.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const INDEX = read('index.html');
const TEMPLATE = loadTemplatePolicy(REPO_ROOT);
const SHA = 'd'.repeat(40);
const ENV = { GITHUB_SHA: SHA, GITHUB_REF_NAME: 'main', GITHUB_ACTOR: 'owner', GITHUB_RUN_ID: '5151' };

// The live staging distribution config as read 2026-10-30 (shape only; no response headers policy).
const baseConfig = () => ({
  CallerReference: 'staging-spa',
  Aliases: { Quantity: 1, Items: ['staging.checksops.com'] },
  DefaultRootObject: 'index.html',
  Origins: { Quantity: 1, Items: [{ Id: 'StagingSpaS3', DomainName: 'checksops-staging-frontend-c48b.s3.us-east-1.amazonaws.com' }] },
  DefaultCacheBehavior: {
    TargetOriginId: 'StagingSpaS3',
    ViewerProtocolPolicy: 'redirect-to-https',
    CachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6',
    Compress: true,
  },
  CacheBehaviors: { Quantity: 0 },
  Enabled: true,
});

const productionPolicy = () => ({
  ETag: 'PRODETAG',
  config: { Name: 'checksops-production-browser-security-headers', Comment: 'prod', SecurityHeadersConfig: structuredClone(TEMPLATE.SecurityHeadersConfig) },
});

// How CloudFront echoes a stored policy (get-response-headers-policy, read 2026-10-30 for
// d3f84b15-c4db-481c-98cb-64eb541619fe after apply run 41067994638): every security header the
// policy does not set comes back as an empty object.
const awsEcho = (config) => {
  const echoed = structuredClone(config);
  echoed.SecurityHeadersConfig = { XSSProtection: {}, ContentSecurityPolicy: {}, ...echoed.SecurityHeadersConfig };
  return echoed;
};

// A fake CloudFront + S3 with ETags; counts every write. `echo` is how reads return a stored policy.
function fakeAws({ indexHtml = INDEX, attached = null, ours = null, mutate = null, echo = (config) => config } = {}) {
  let n = 0;
  const state = {
    indexHtml,
    dist: { Id: DISTRIBUTION_ID, Status: 'Deployed', ETag: 'DIST0', config: baseConfig() },
    policies: { [PRODUCTION_POLICY_ID]: productionPolicy() },
    writes: [],
  };
  if (ours) state.policies[ours.id] = { ETag: 'POL0', config: ours.config };
  if (attached) state.dist.config.DefaultCacheBehavior.ResponseHeadersPolicyId = attached;
  const client = {
    getDistribution: (id) => {
      assertStagingDistribution(id);
      return structuredClone({ ETag: state.dist.ETag, Distribution: { Id: state.dist.Id, Status: state.dist.Status, DistributionConfig: state.dist.config } });
    },
    listPolicies: () => structuredClone({ ResponseHeadersPolicyList: { Items: Object.entries(state.policies).map(([Id, p]) => ({ Type: 'custom', ResponseHeadersPolicy: { Id, ResponseHeadersPolicyConfig: echo(p.config) } })) } }),
    getPolicy: (id) => {
      assertNotProductionPolicy(id);
      const p = state.policies[id];
      return structuredClone({ ETag: p.ETag, ResponseHeadersPolicy: { Id: id, ResponseHeadersPolicyConfig: echo(p.config) } });
    },
    readIndexHtml: () => state.indexHtml,
    createPolicy: (config) => {
      state.writes.push({ op: 'createPolicy', config });
      const id = `stg-policy-${++n}`;
      state.policies[id] = { ETag: 'POL1', config: structuredClone(config) };
      return { ResponseHeadersPolicy: { Id: id } };
    },
    updatePolicy: (id, etag, config) => {
      assertNotProductionPolicy(id);
      if (state.policies[id].ETag !== etag) throw new Error('PreconditionFailed');
      state.writes.push({ op: 'updatePolicy', id, config });
      state.policies[id] = { ETag: `${etag}+`, config: structuredClone(config) };
      return {};
    },
    updateDistribution: (id, etag, config) => {
      assertStagingDistribution(id);
      if (state.dist.ETag !== etag) throw new Error('PreconditionFailed');
      state.writes.push({ op: 'updateDistribution', config });
      state.dist = { ...state.dist, ETag: `${etag}+`, Status: 'InProgress', config: structuredClone(config) };
      if (mutate) mutate(state);
      return {};
    },
  };
  return { state, client, readState: (env) => readState(env, client) };
}

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-staging-csp-'));
  fs.mkdirSync(path.join(root, 'ops/deployment-guard'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/accepted-contracts.json'), path.join(root, 'ops/deployment-guard/accepted-contracts.json'));
  return root;
}

async function inspect(aws, root = tmpRoot()) {
  return preflight({ ...ENV, CHECKSOPS_STAGING_CSP_MODE: 'inspect' }, { root, template: TEMPLATE, readState: aws.readState });
}

async function preflightChange(mode, root, aws, extra = {}) {
  const inspected = await inspect(aws, root);
  return preflight({
    ...ENV,
    CHECKSOPS_STAGING_CSP_MODE: mode,
    CHECKSOPS_EXPECTED_SNAPSHOT_SHA256: inspected.snapshot_sha256,
    CHECKSOPS_STAGING_CSP_APPROVAL: APPROVAL_PHRASES[mode],
    ...extra,
  }, { root, template: TEMPLATE, readState: aws.readState, signer: (unsigned) => unsigned });
}

const writerEnv = (result) => ({
  CHECKSOPS_STAGING_CSP_EXECUTE: '1',
  CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1',
  CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: result.authorization.receiptFile,
  CHECKSOPS_STAGING_CSP_INPUT: result.authorization.cspInput,
  CHECKSOPS_WORKSTREAM_ID: result.identity.workstreamId,
  CHECKSOPS_COMMIT: SHA,
});

function quiet(fn) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = write; }
}

const runWriter = (result, aws, root) => quiet(() => writer(writerEnv(result), { client: aws.client, guardRoot: root, template: TEMPLATE }));

test('the deployment type is registered and both scripts are in the bypass inventory', () => {
  assert.ok(DEPLOYMENT_TYPES.includes(DEPLOYMENT_TYPE));
  const rows = Object.fromEntries(JSON.parse(read('ops/deployment-guard/bypass-inventory.json')).scripts.map((row) => [row.path, row]));
  assert.equal(rows['scripts/deployment-guard/staging-csp-headers.mjs'].classification, 'GUARDED');
  assert.equal(rows['scripts/deployment-guard/github-staging-csp-headers.mjs'].classification, 'SAFE');
  assert.equal(TARGET_COMPONENT, 'staging-frontend');
});

test('the policy carries only a report-only CSP equal to buildCsp of the live index.html, never an enforcing one', () => {
  const desired = desiredPolicyConfig(INDEX, TEMPLATE);
  assert.equal(desired.Name, POLICY_NAME);
  assert.deepEqual(desired.CustomHeadersConfig, {
    Quantity: 1,
    Items: [{ Header: REPORT_ONLY_HEADER, Value: buildCsp({ environment: 'staging', indexHtml: INDEX }), Override: true }],
  });
  assert.equal(desired.SecurityHeadersConfig.ContentSecurityPolicy, undefined);
  assert.deepEqual(desired.SecurityHeadersConfig, TEMPLATE.SecurityHeadersConfig);
  // The CSP follows the served index.html: another inline script changes the hash it allows.
  const other = INDEX.replace('<script>', '<script>/* changed */');
  assert.notEqual(desiredPolicyConfig(other, TEMPLATE).CustomHeadersConfig.Items[0].Value, desired.CustomHeadersConfig.Items[0].Value);
  // The template itself is refused if it ever sets an enforcing CSP or another header.
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'aws/staging'), { recursive: true });
  const bad = read('aws/staging/cloudfront-security-headers.yaml').replace('        SecurityHeadersConfig:\n', '        SecurityHeadersConfig:\n          ContentSecurityPolicy:\n            ContentSecurityPolicy: "default-src \'self\'"\n            Override: true\n');
  fs.writeFileSync(path.join(root, 'aws/staging/cloudfront-security-headers.yaml'), bad);
  assert.throws(() => loadTemplatePolicy(root), /template_sets_enforcing_csp/);
});

test('staging only: the production distribution and the production policy are refused before any AWS call', () => {
  assert.throws(() => assertStagingDistribution(PRODUCTION_DISTRIBUTION_ID), /staging_only/);
  assert.throws(() => awsClient.getDistribution(PRODUCTION_DISTRIBUTION_ID, {}), /staging_only/);
  assert.throws(() => awsClient.updateDistribution(PRODUCTION_DISTRIBUTION_ID, 'E', {}, {}), /staging_only/);
  assert.throws(() => awsClient.updatePolicy(PRODUCTION_POLICY_ID, 'E', {}, {}), /staging_only/);
  assert.throws(() => awsClient.getPolicy(PRODUCTION_POLICY_ID, {}), /staging_only/);
  assert.throws(() => desiredDistributionConfig(baseConfig(), PRODUCTION_POLICY_ID), /staging_only/);
});

test('classify: READY with nothing attached, BLOCKED on another or the production policy, drift or a production host', () => {
  const desired = desiredPolicyConfig(INDEX, TEMPLATE);
  assert.equal(classify(fakeAws().readState({}).snapshot, desired).state, 'READY');
  assert.equal(PREVIOUS_RESPONSE_HEADERS_POLICY_ID, null);
  for (const [setup, problem] of [
    [{ attached: PRODUCTION_POLICY_ID }, 'production_policy_attached'],
    [{ attached: 'someone-elses-policy' }, 'other_policy_attached'],
  ]) {
    const result = classify(fakeAws(setup).readState({}).snapshot, desired);
    assert.equal(result.state, 'BLOCKED');
    assert.ok(result.problems.includes(problem), result.problems.join(','));
  }
  for (const [mutate, problem] of [
    [(s) => { s.distribution.Id = PRODUCTION_DISTRIBUTION_ID; }, 'distribution_not_staging'],
    [(s) => { s.distribution.Aliases = ['checksops.com']; }, 'aliases_drift'],
    [(s) => { s.distribution.Status = 'InProgress'; }, 'distribution_not_deployed'],
    [(s) => { s.distribution.CacheBehaviorCount = 1; }, 'cache_behaviors_drift'],
    [(s) => { s.policies_named = ['a', 'b']; }, 'duplicate_policy_name'],
  ]) {
    const snapshot = fakeAws().readState({}).snapshot;
    mutate(snapshot);
    const result = classify(snapshot, desired);
    assert.equal(result.state, 'BLOCKED');
    assert.ok(result.problems.includes(problem), problem);
  }
  assert.equal(actionFor('apply', 'READY'), 'attach');
  assert.equal(actionFor('apply', 'ATTACHED_CURRENT'), null);
  assert.equal(actionFor('apply', 'BLOCKED'), null);
  assert.equal(actionFor('rollback', 'READY'), null);
  assert.equal(actionFor('rollback', 'BLOCKED'), null);
});

test('inspect makes no writes and reports the CSP the apply would set', async () => {
  const aws = fakeAws();
  const result = await inspect(aws);
  assert.equal(result.state, 'READY');
  assert.equal(result.mutation, false);
  assert.equal(result.response_headers_policy_id, 'none');
  assert.equal(result.csp_report_only, buildCsp({ environment: 'staging', indexHtml: INDEX }));
  assert.match(result.snapshot_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(aws.state.writes, []);
  // The read-only inspect session in the workflow carries no write action.
  const workflow = read('.github/workflows/guarded-staging-csp-headers.yml');
  const inspectPolicy = workflow.split('Configure read-only staging AWS session (inspect)')[1].split('- name:')[0];
  assert.equal(/Update|Create|Delete|kms:Sign|PutObject/.test(inspectPolicy), false);
});

test('apply: the receipt lets the writer create the policy and change only the default behavior\'s ResponseHeadersPolicyId; single use', async () => {
  const root = tmpRoot();
  const aws = fakeAws();
  const before = structuredClone(aws.state.dist.config);
  const result = await preflightChange('apply', root, aws);
  assert.equal(result.action, 'attach');
  const receipt = JSON.parse(fs.readFileSync(result.authorization.receiptFile, 'utf8'));
  assert.equal(receipt.deployment_type, DEPLOYMENT_TYPE);
  assert.equal(receipt.target_environment, 'staging');
  assert.deepEqual(receipt.owned_components, OWNED_COMPONENTS.attach);
  assert.equal(runWriter(result, aws, root), 0);
  assert.deepEqual(aws.state.writes.map((w) => w.op), ['createPolicy', 'updateDistribution']);
  const created = aws.state.writes[0].config;
  assert.deepEqual(created, desiredPolicyConfig(INDEX, TEMPLATE));
  const policyId = aws.state.dist.config.DefaultCacheBehavior.ResponseHeadersPolicyId;
  assert.match(policyId, /^stg-policy-/);
  const expected = structuredClone(before);
  expected.DefaultCacheBehavior.ResponseHeadersPolicyId = policyId;
  assert.deepEqual(aws.state.dist.config, expected);
  assert.equal(aws.state.policies[PRODUCTION_POLICY_ID].ETag, 'PRODETAG');
  // Settled: verify finds it attached and current.
  aws.state.dist.Status = 'Deployed';
  const verified = await preflight({ ...ENV, CHECKSOPS_STAGING_CSP_MODE: 'verify', CHECKSOPS_STAGING_CSP_VERIFY_EXPECT: 'attached' }, { root, template: TEMPLATE, readState: aws.readState });
  assert.equal(verified.state, 'VERIFIED');
  // The same receipt cannot run again.
  assert.throws(() => runWriter(result, aws, root), /state_refused|guard_refused|receipt_consumption_failed/);
  assert.equal(aws.state.writes.length, 2);
});

test('apply updates only an attached policy that is out of date (a new inline script), not the distribution', async () => {
  const root = tmpRoot();
  const stale = desiredPolicyConfig(INDEX.replace('<script>', '<script>/* old */'), TEMPLATE);
  const aws = fakeAws({ attached: 'stg-existing', ours: { id: 'stg-existing', config: stale } });
  assert.equal((await inspect(aws)).state, 'ATTACHED_STALE');
  const result = await preflightChange('apply', root, aws);
  assert.equal(result.action, 'update-policy');
  assert.equal(runWriter(result, aws, root), 0);
  assert.deepEqual(aws.state.writes.map((w) => w.op), ['updatePolicy']);
  assert.deepEqual(normalizePolicyConfig(aws.state.policies['stg-existing'].config), normalizePolicyConfig(desiredPolicyConfig(INDEX, TEMPLATE)));
});

test('CloudFront\'s empty security-header sections are not drift: apply verifies and inspect then reports ATTACHED_CURRENT (run 41067994638)', async () => {
  const desired = desiredPolicyConfig(INDEX, TEMPLATE);
  const echoed = awsEcho(desired);
  // The shape run 41067994638 read back. Comparing the raw sections, as the writer did, differs:
  assert.deepEqual(echoed.SecurityHeadersConfig.XSSProtection, {});
  assert.deepEqual(echoed.SecurityHeadersConfig.ContentSecurityPolicy, {});
  assert.notDeepEqual(echoed.SecurityHeadersConfig, desired.SecurityHeadersConfig);
  // The owned parts are equal once an empty section, which sets nothing, is dropped.
  assert.deepEqual(normalizePolicyConfig(echoed), normalizePolicyConfig(desired));
  const root = tmpRoot();
  const aws = fakeAws({ echo: awsEcho });
  const result = await preflightChange('apply', root, aws);
  assert.equal(result.action, 'attach');
  assert.equal(runWriter(result, aws, root), 0);
  assert.deepEqual(aws.state.writes.map((w) => w.op), ['createPolicy', 'updateDistribution']);
  aws.state.dist.Status = 'Deployed';
  const after = await inspect(aws);
  assert.equal(after.state, 'ATTACHED_CURRENT');
  assert.deepEqual(after.problems, []);
  // The live case: our policy already attached, echoed with the empty sections. Apply has nothing to do.
  const live = fakeAws({ attached: 'd3f84b15-c4db-481c-98cb-64eb541619fe', ours: { id: 'd3f84b15-c4db-481c-98cb-64eb541619fe', config: desired }, echo: awsEcho });
  const inspected = await inspect(live);
  assert.equal(inspected.state, 'ATTACHED_CURRENT');
  assert.deepEqual(inspected.problems, []);
  assert.equal(actionFor('apply', inspected.state), null);
});

test('a real difference still counts: an enforcing CSP blocks, another CSP value is stale, and a changed read-back fails post-verify', async () => {
  const desired = desiredPolicyConfig(INDEX, TEMPLATE);
  const id = 'stg-existing';
  // A non-empty ContentSecurityPolicy is an enforcing CSP this tool never sets.
  const enforcing = (config) => {
    const echoed = awsEcho(config);
    echoed.SecurityHeadersConfig.ContentSecurityPolicy = { ContentSecurityPolicy: "default-src 'self'", Override: true };
    return echoed;
  };
  const blocked = await inspect(fakeAws({ attached: id, ours: { id, config: desired }, echo: enforcing }));
  assert.equal(blocked.state, 'BLOCKED');
  assert.ok(blocked.problems.includes('policy_has_unowned_settings'), blocked.problems.join(','));
  assert.notDeepEqual(normalizePolicyConfig(enforcing(desired)), normalizePolicyConfig(desired));
  // A section with a field that differs (here X-XSS-Protection set) is not dropped.
  const xss = awsEcho(desired);
  xss.SecurityHeadersConfig.XSSProtection = { Protection: true, ModeBlock: true, Override: true };
  assert.notDeepEqual(normalizePolicyConfig(xss), normalizePolicyConfig(desired));
  // Another report-only value is stale, not current.
  const otherCsp = awsEcho(desired);
  otherCsp.CustomHeadersConfig.Items[0].Value = "default-src 'self'";
  assert.equal((await inspect(fakeAws({ attached: id, ours: { id, config: otherCsp }, echo: awsEcho }))).state, 'ATTACHED_STALE');
  // The writer still fails when what CloudFront stored is not what it sent.
  const root = tmpRoot();
  const wrong = fakeAws({ echo: (config) => {
    const echoed = awsEcho(config);
    if (echoed.CustomHeadersConfig?.Items?.[0]) echoed.CustomHeadersConfig.Items[0].Value = "default-src *";
    return echoed;
  } });
  const result = await preflightChange('apply', root, wrong);
  assert.throws(() => runWriter(result, wrong, root), /policy_post_verify_failed/);
});

test('rollback restores the previous ResponseHeadersPolicyId (none) and leaves everything else as it was', async () => {
  const root = tmpRoot();
  const aws = fakeAws();
  const original = structuredClone(aws.state.dist.config);
  assert.equal(runWriter(await preflightChange('apply', root, aws), aws, root), 0);
  aws.state.dist.Status = 'Deployed';
  const root2 = tmpRoot();
  const result = await preflightChange('rollback', root2, aws);
  assert.equal(result.action, 'detach');
  assert.deepEqual(JSON.parse(fs.readFileSync(result.authorization.receiptFile, 'utf8')).owned_components, OWNED_COMPONENTS.detach);
  assert.equal(runWriter(result, aws, root2), 0);
  assert.deepEqual(aws.state.dist.config, original);
  assert.equal('ResponseHeadersPolicyId' in aws.state.dist.config.DefaultCacheBehavior, false);
  aws.state.dist.Status = 'Deployed';
  const verified = await preflight({ ...ENV, CHECKSOPS_STAGING_CSP_MODE: 'verify', CHECKSOPS_STAGING_CSP_VERIFY_EXPECT: 'detached' }, { root: root2, template: TEMPLATE, readState: aws.readState });
  assert.equal(verified.state, 'VERIFIED');
  // Nothing attached: rollback has nothing to do.
  await assert.rejects(preflightChange('rollback', tmpRoot(), aws), (e) => e.code === CODES.UNRELATED_MUTATION);
});

test('apply and rollback need their exact phrase; a near-miss or the other mode\'s phrase is refused', async () => {
  assert.equal(APPROVAL_PHRASES.apply, 'ATTACH REPORT-ONLY CSP TO STAGING');
  assert.equal(APPROVAL_PHRASES.rollback, 'DETACH CSP FROM STAGING');
  const fp = 'a'.repeat(64);
  for (const approval of ['attach report-only csp to staging', 'ATTACH REPORT-ONLY CSP TO STAGING ', ' REPORT-ONLY CSP TO STAGING', 'ATTACH CSP TO STAGING', 'DETACH CSP FROM STAGING', '', undefined]) {
    assert.throws(() => validateChangeInputs({ mode: 'apply', approval, expectedFingerprint: fp, liveFingerprint: fp }), (e) => e.code === CODES.INVALID_MANIFEST, String(approval));
  }
  assert.throws(() => validateChangeInputs({ mode: 'rollback', approval: APPROVAL_PHRASES.apply, expectedFingerprint: fp, liveFingerprint: fp }), (e) => e.code === CODES.INVALID_MANIFEST);
  assert.doesNotThrow(() => validateChangeInputs({ mode: 'apply', approval: APPROVAL_PHRASES.apply, expectedFingerprint: fp, liveFingerprint: fp }));
  const aws = fakeAws();
  await assert.rejects(preflightChange('apply', tmpRoot(), aws, { CHECKSOPS_STAGING_CSP_APPROVAL: 'ATTACH REPORT-ONLY CSP TO STAGIN' }), (e) => e.code === CODES.INVALID_MANIFEST);
  assert.deepEqual(aws.state.writes, []);
  // The workflow gate checks the same phrases before any AWS session.
  const workflow = read('.github/workflows/guarded-staging-csp-headers.yml');
  assert.match(workflow, /apply\) PHRASE="ATTACH REPORT-ONLY CSP TO STAGING"/);
  assert.match(workflow, /rollback\) PHRASE="DETACH CSP FROM STAGING"/);
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(workflow, /environment: staging/);
  assert.equal(/environment: production|E1B0ZWWO5559U5/.test(workflow), false);
});

test('drift refuses: a stale inspect hash before the receipt, and any move after it before any write', async () => {
  const aws = fakeAws();
  await assert.rejects(preflightChange('apply', tmpRoot(), aws, { CHECKSOPS_EXPECTED_SNAPSHOT_SHA256: 'b'.repeat(64) }), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  for (const move of [
    (s) => { s.dist.ETag = 'DIST-MOVED'; },
    (s) => { s.indexHtml = INDEX.replace('<script>', '<script>/* redeployed */'); },
    (s) => { s.dist.config.Comment = 'someone else'; },
  ]) {
    const root = tmpRoot();
    const moving = fakeAws();
    const result = await preflightChange('apply', root, moving);
    move(moving.state);
    assert.throws(() => runWriter(result, moving, root), /guard_refused/);
    assert.deepEqual(moving.state.writes, []);
  }
});

test('the writer fails closed if the distribution changed in anything but the response headers policy', async () => {
  const root = tmpRoot();
  const aws = fakeAws({ mutate: (s) => { s.dist.config.DefaultCacheBehavior.Compress = false; } });
  const result = await preflightChange('apply', root, aws);
  assert.throws(() => runWriter(result, aws, root), /post_write_distribution_drift/);
  const before = baseConfig();
  const after = desiredDistributionConfig(before, 'stg-1');
  assert.doesNotThrow(() => assertOnlyBehaviorDelta(before, after, 'stg-1'));
  assert.throws(() => assertOnlyBehaviorDelta(before, { ...after, Enabled: false }, 'stg-1'), /post_write_distribution_drift/);
});

test('the writer refuses plan-only runs, caller-supplied config, a receipt for another action or type, and no receipt', async () => {
  const aws = fakeAws();
  assert.equal(quiet(() => writer({}, { client: aws.client, template: TEMPLATE })), 2);
  const root = tmpRoot();
  const result = await preflightChange('apply', root, aws);
  const input = JSON.parse(fs.readFileSync(result.authorization.cspInput, 'utf8'));
  for (const extra of [{ policy_id: 'x' }, { policy_config: {} }, { distribution_config: {} }, { csp: "default-src *" }]) {
    fs.writeFileSync(result.authorization.cspInput, JSON.stringify({ ...input, ...extra }));
    assert.throws(() => runWriter(result, aws, root), /caller_supplied_config_forbidden/);
  }
  fs.writeFileSync(result.authorization.cspInput, JSON.stringify({ ...input, action: 'detach' }));
  assert.throws(() => runWriter(result, aws, root), /action_mismatch/);
  fs.writeFileSync(result.authorization.cspInput, JSON.stringify({ ...input, mode: 'rollback' }));
  assert.throws(() => runWriter(result, aws, root), /state_refused/);
  // A staging-frontend receipt of another deployment type (the SPA upload's) does not authorize this.
  const root2 = tmpRoot();
  const snapshot = aws.readState({}).snapshot;
  const lease = acquireLease(root2, { workstream_id: 'ws-spa', component: TARGET_COMPONENT, environment: 'staging', commit: SHA, operator: 'x' });
  const other = issueReceipt(root2, {
    workstream_id: 'ws-spa', branch: 'main', commit: SHA, target_environment: 'staging', target_component: TARGET_COMPONENT,
    deployment_type: 'spa-promote', owned_components: OWNED_COMPONENTS.attach, preflight_live_fingerprint: snapshot, lease: lease.details.lease,
  });
  assert.equal(other.ok, true, other.message);
  const otherInput = path.join(root2, 'input.json');
  fs.writeFileSync(otherInput, JSON.stringify({ mode: 'apply', action: 'attach', workstream_id: 'ws-spa', commit: SHA, receipt_path: other.details.file }));
  const env = { CHECKSOPS_STAGING_CSP_EXECUTE: '1', CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1', CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: other.details.file, CHECKSOPS_STAGING_CSP_INPUT: otherInput };
  assert.throws(() => quiet(() => writer(env, { client: aws.client, guardRoot: root2, template: TEMPLATE })), /guard_refused|receipt_type_mismatch/);
  // No receipt at all.
  const noReceipt = { CHECKSOPS_STAGING_CSP_EXECUTE: '1', CHECKSOPS_STAGING_CSP_INPUT: otherInput };
  assert.throws(() => quiet(() => writer(noReceipt, { client: aws.client, guardRoot: tmpRoot(), template: TEMPLATE })), /guard_refused/);
  assert.deepEqual(aws.state.writes, []);
});

test('the IAM source can change only the staging distribution and never the production policy or distribution', () => {
  const trust = JSON.parse(read('aws/staging-csp-headers/policies/trust-policy.json'));
  assert.equal(trust.Statement.length, 1);
  assert.deepEqual(trust.Statement[0].Condition.StringEquals, {
    'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    'token.actions.githubusercontent.com:sub': 'repo:michaelcarletta-cmd/ChecksOps:environment:staging',
  });
  const policy = JSON.parse(read('aws/staging-csp-headers/policies/permissions-policy.json'));
  const actions = policy.Statement.filter((s) => s.Effect === 'Allow').flatMap((s) => [].concat(s.Action));
  for (const action of actions) assert.equal(/^(iam|sts|organizations):|^\*$|s3:Put|s3:Delete|cloudfront:\*/.test(action), false, action);
  const updateDistribution = policy.Statement.find((s) => s.Effect === 'Allow' && [].concat(s.Action).includes('cloudfront:UpdateDistribution'));
  assert.equal(updateDistribution.Resource, `arn:aws:cloudfront::806168576068:distribution/${DISTRIBUTION_ID}`);
  const denies = policy.Statement.filter((s) => s.Effect === 'Deny').map((s) => s.Resource);
  assert.ok(denies.includes(`arn:aws:cloudfront::806168576068:response-headers-policy/${PRODUCTION_POLICY_ID}`));
  assert.ok(denies.includes(`arn:aws:cloudfront::806168576068:distribution/${PRODUCTION_DISTRIBUTION_ID}`));
});
