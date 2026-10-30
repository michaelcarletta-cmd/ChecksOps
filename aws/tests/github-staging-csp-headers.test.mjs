/**
 * Guarded staging CSP headers (SPA CSP rollout steps 1 and 3, ops/security/SPA_CSP_ROLLOUT.md):
 * only staging distribution E1CG52WRQZI7X1 and never the production policy; every change needs its
 * exact phrase and the inspect's snapshot; the policy carries a report-only CSP equal to buildCsp of
 * the live index.html, or after enforce only the enforcing one equal to buildCsp(enforce); the
 * distribution changes only in DefaultCacheBehavior.ResponseHeadersPolicyId (enforce and revert not
 * at all); revert restores the report-only config; rollback restores the previous value (none).
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
  ENFORCING_COMMENT,
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
      if (mutate) mutate(state);
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

test('the default (report-only) policy carries only a report-only CSP equal to buildCsp of the live index.html, never an enforcing one', () => {
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

// --- Rollout step 3: enforce, revert (ops/security/SPA_CSP_ROLLOUT.md) ---

const OURS = 'd3f84b15-c4db-481c-98cb-64eb541619fe';
const REPORT_ONLY = desiredPolicyConfig(INDEX, TEMPLATE);
const ENFORCING = desiredPolicyConfig(INDEX, TEMPLATE, { enforce: true });
// CloudFront also echoes a policy without custom headers as CustomHeadersConfig { Quantity: 0 }.
const awsEchoNoCustom = (config) => {
  const echoed = awsEcho(config);
  if (!echoed.CustomHeadersConfig) echoed.CustomHeadersConfig = { Quantity: 0 };
  return echoed;
};
const attachedWith = (config, extra = {}) => fakeAws({ attached: OURS, ours: { id: OURS, config }, echo: awsEchoNoCustom, ...extra });
const verifyAs = (aws, root, expect) => preflight({ ...ENV, CHECKSOPS_STAGING_CSP_MODE: 'verify', CHECKSOPS_STAGING_CSP_VERIFY_EXPECT: expect }, { root, template: TEMPLATE, readState: aws.readState });

test('the enforce payload: ContentSecurityPolicy is buildCsp(staging, live index.html, enforce), Override true, and no report-only header', () => {
  assert.deepEqual(ENFORCING.SecurityHeadersConfig.ContentSecurityPolicy, {
    ContentSecurityPolicy: buildCsp({ environment: 'staging', indexHtml: INDEX, enforce: true }),
    Override: true,
  });
  assert.equal(ENFORCING.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy, `${REPORT_ONLY.CustomHeadersConfig.Items[0].Value}; upgrade-insecure-requests`);
  assert.equal(ENFORCING.CustomHeadersConfig, undefined);
  assert.deepEqual(normalizePolicyConfig(ENFORCING).CustomHeaders, []);
  const { ContentSecurityPolicy, ...rest } = ENFORCING.SecurityHeadersConfig;
  assert.deepEqual(rest, TEMPLATE.SecurityHeadersConfig);
  assert.equal(ENFORCING.Name, POLICY_NAME);
  assert.equal(ENFORCING.Comment, ENFORCING_COMMENT);
  // Follows the served index.html like the report-only one.
  const other = INDEX.replace('<script>', '<script>/* changed */');
  assert.notEqual(desiredPolicyConfig(other, TEMPLATE, { enforce: true }).SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy, ENFORCING.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy);
  // The template stays the report-only source and documents how the enforcing variant is derived.
  assert.equal(TEMPLATE.SecurityHeadersConfig.ContentSecurityPolicy, undefined);
  assert.match(read('aws/staging/cloudfront-security-headers.yaml'), /desiredPolicyConfig\(indexHtml, template, \{ enforce: true \}\)/);
});

test('classify: the four attached states, and which mode may run in each', async () => {
  const stale = (enforce) => desiredPolicyConfig(INDEX.replace('<script>', '<script>/* old */'), TEMPLATE, { enforce });
  const states = {
    ATTACHED_CURRENT: attachedWith(REPORT_ONLY),
    ATTACHED_STALE: attachedWith(stale(false)),
    ENFORCING_CURRENT: attachedWith(ENFORCING),
    ENFORCING_STALE: attachedWith(stale(true)),
  };
  for (const [state, aws] of Object.entries(states)) {
    const result = await inspect(aws);
    assert.equal(result.state, state);
    assert.deepEqual(result.problems, []);
    assert.equal(result.csp_enforcing, buildCsp({ environment: 'staging', indexHtml: INDEX, enforce: true }));
  }
  // Ours with both the enforcing CSP and a leftover report-only header: enforcing, stale.
  const mixed = { ...structuredClone(ENFORCING), CustomHeadersConfig: structuredClone(REPORT_ONLY.CustomHeadersConfig) };
  assert.equal((await inspect(attachedWith(mixed))).state, 'ENFORCING_STALE');
  const table = {
    apply: { READY: 'attach', ATTACHED_CURRENT: null, ATTACHED_STALE: 'update-policy', ENFORCING_CURRENT: null, ENFORCING_STALE: null, BLOCKED: null },
    enforce: { READY: null, ATTACHED_CURRENT: 'enforce', ATTACHED_STALE: null, ENFORCING_CURRENT: null, ENFORCING_STALE: 'enforce', BLOCKED: null },
    revert: { READY: null, ATTACHED_CURRENT: null, ATTACHED_STALE: null, ENFORCING_CURRENT: 'revert', ENFORCING_STALE: 'revert', BLOCKED: null },
    rollback: { READY: null, ATTACHED_CURRENT: 'detach', ATTACHED_STALE: 'detach', ENFORCING_CURRENT: 'detach', ENFORCING_STALE: 'detach', BLOCKED: null },
  };
  for (const [mode, row] of Object.entries(table)) {
    for (const [state, action] of Object.entries(row)) assert.equal(actionFor(mode, state), action, `${mode} ${state}`);
  }
  assert.deepEqual(OWNED_COMPONENTS.enforce, OWNED_COMPONENTS['update-policy']);
  assert.deepEqual(OWNED_COMPONENTS.revert, OWNED_COMPONENTS['update-policy']);
});

test('enforce: updates only the attached policy to the enforcing config; the distribution is unchanged; apply is then refused', async () => {
  const root = tmpRoot();
  const aws = attachedWith(REPORT_ONLY);
  const before = structuredClone(aws.state.dist);
  const result = await preflightChange('enforce', root, aws);
  assert.equal(result.action, 'enforce');
  const receipt = JSON.parse(fs.readFileSync(result.authorization.receiptFile, 'utf8'));
  assert.deepEqual(receipt.owned_components, OWNED_COMPONENTS.enforce);
  assert.equal(JSON.parse(fs.readFileSync(result.authorization.cspInput, 'utf8')).approval.phrase, 'ENFORCE CSP ON STAGING');
  assert.equal(runWriter(result, aws, root), 0);
  assert.deepEqual(aws.state.writes.map((w) => w.op), ['updatePolicy']);
  assert.equal(aws.state.writes[0].id, OURS);
  assert.deepEqual(aws.state.writes[0].config, ENFORCING);
  assert.equal(aws.state.writes[0].config.CustomHeadersConfig, undefined);
  assert.deepEqual(aws.state.dist, before);
  assert.equal(aws.state.policies[PRODUCTION_POLICY_ID].ETag, 'PRODETAG');
  assert.equal((await verifyAs(aws, root, 'enforcing')).state, 'VERIFIED');
  await assert.rejects(verifyAs(aws, root, 'attached'), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  assert.equal((await inspect(aws)).state, 'ENFORCING_CURRENT');
  // A report-only apply never overwrites an enforcing policy; revert is the explicit way back.
  await assert.rejects(preflightChange('apply', tmpRoot(), aws), (e) => e.code === CODES.UNRELATED_MUTATION);
  await assert.rejects(preflightChange('enforce', tmpRoot(), aws), (e) => e.code === CODES.UNRELATED_MUTATION);
  // The same receipt cannot run again.
  assert.throws(() => runWriter(result, aws, root), /state_refused|guard_refused|receipt_consumption_failed/);
  assert.equal(aws.state.writes.length, 1);
});

test('enforce refuses unless the report-only policy is attached and current', async () => {
  await assert.rejects(preflightChange('enforce', tmpRoot(), fakeAws()), (e) => e.code === CODES.UNRELATED_MUTATION);
  const stale = desiredPolicyConfig(INDEX.replace('<script>', '<script>/* old */'), TEMPLATE);
  const aws = attachedWith(stale);
  await assert.rejects(preflightChange('enforce', tmpRoot(), aws), (e) => e.code === CODES.UNRELATED_MUTATION);
  assert.deepEqual(aws.state.writes, []);
});

test('enforce refreshes a stale enforcing policy (a new inline script) to the live index.html', async () => {
  const root = tmpRoot();
  const aws = attachedWith(desiredPolicyConfig(INDEX.replace('<script>', '<script>/* old */'), TEMPLATE, { enforce: true }));
  const result = await preflightChange('enforce', root, aws);
  assert.equal(result.action, 'enforce');
  assert.equal(runWriter(result, aws, root), 0);
  assert.deepEqual(aws.state.writes.map((w) => w.op), ['updatePolicy']);
  assert.equal((await inspect(aws)).state, 'ENFORCING_CURRENT');
});

test('revert restores exactly the report-only config and leaves the distribution unchanged; rollback still detaches from enforcing', async () => {
  const root = tmpRoot();
  const aws = attachedWith(REPORT_ONLY);
  const reportOnlyStored = structuredClone(aws.state.policies[OURS].config);
  const distBefore = structuredClone(aws.state.dist);
  assert.equal(runWriter(await preflightChange('enforce', root, aws), aws, root), 0);
  const root2 = tmpRoot();
  const result = await preflightChange('revert', root2, aws);
  assert.equal(result.action, 'revert');
  assert.deepEqual(JSON.parse(fs.readFileSync(result.authorization.receiptFile, 'utf8')).owned_components, OWNED_COMPONENTS.revert);
  assert.equal(runWriter(result, aws, root2), 0);
  assert.deepEqual(aws.state.writes.map((w) => w.op), ['updatePolicy', 'updatePolicy']);
  assert.deepEqual(aws.state.policies[OURS].config, reportOnlyStored);
  assert.deepEqual(aws.state.policies[OURS].config, REPORT_ONLY);
  assert.deepEqual(aws.state.dist, distBefore);
  assert.equal((await verifyAs(aws, root2, 'attached')).state, 'VERIFIED');
  await assert.rejects(preflightChange('revert', tmpRoot(), aws), (e) => e.code === CODES.UNRELATED_MUTATION);
  // From enforcing, DETACH CSP FROM STAGING removes the policy from the behavior entirely.
  const enforced = attachedWith(ENFORCING);
  const original = structuredClone(enforced.state.dist.config);
  delete original.DefaultCacheBehavior.ResponseHeadersPolicyId;
  const root3 = tmpRoot();
  const detach = await preflightChange('rollback', root3, enforced);
  assert.equal(detach.action, 'detach');
  assert.equal(runWriter(detach, enforced, root3), 0);
  assert.deepEqual(enforced.state.dist.config, original);
});

test('a foreign enforcing CSP is still BLOCKED: another value, a wider source, Override false, or an extra field', async () => {
  const value = ENFORCING.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy;
  for (const csp of [
    { ContentSecurityPolicy: "default-src 'self'", Override: true },
    { ContentSecurityPolicy: value.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"), Override: true },
    { ContentSecurityPolicy: value.replace('; upgrade-insecure-requests', ''), Override: true },
    { ContentSecurityPolicy: `${value}; report-uri https://example.com`, Override: true },
    { ContentSecurityPolicy: value, Override: false },
  ]) {
    const config = structuredClone(ENFORCING);
    config.SecurityHeadersConfig.ContentSecurityPolicy = csp;
    const aws = attachedWith(config);
    const result = await inspect(aws);
    assert.equal(result.state, 'BLOCKED', csp.ContentSecurityPolicy);
    assert.ok(result.problems.includes('policy_has_unowned_settings'), result.problems.join(','));
    for (const mode of ['enforce', 'revert', 'apply', 'rollback']) {
      await assert.rejects(preflightChange(mode, tmpRoot(), aws), (e) => e.code === CODES.DEPLOYMENT_COLLISION, mode);
    }
    assert.deepEqual(aws.state.writes, []);
  }
});

test('enforce and revert need their exact phrase; near-misses and the other modes\' phrases are refused', async () => {
  assert.equal(APPROVAL_PHRASES.enforce, 'ENFORCE CSP ON STAGING');
  assert.equal(APPROVAL_PHRASES.revert, 'REVERT CSP TO REPORT-ONLY ON STAGING');
  const fp = 'a'.repeat(64);
  const nearMisses = {
    enforce: ['enforce csp on staging', 'ENFORCE CSP ON STAGING ', ' ENFORCE CSP ON STAGING', 'ENFORCE CSP', 'ENFORCE CSP ON PRODUCTION', 'ENFORCE  CSP ON STAGING', APPROVAL_PHRASES.apply, APPROVAL_PHRASES.revert, APPROVAL_PHRASES.rollback, '', undefined],
    revert: ['revert csp to report-only on staging', 'REVERT CSP TO REPORT-ONLY ON STAGING.', 'REVERT CSP TO REPORT ONLY ON STAGING', 'REVERT CSP ON STAGING', APPROVAL_PHRASES.enforce, APPROVAL_PHRASES.apply, APPROVAL_PHRASES.rollback, '', undefined],
  };
  for (const [mode, phrases] of Object.entries(nearMisses)) {
    for (const approval of phrases) {
      assert.throws(() => validateChangeInputs({ mode, approval, expectedFingerprint: fp, liveFingerprint: fp }), (e) => e.code === CODES.INVALID_MANIFEST, `${mode} ${approval}`);
    }
    assert.doesNotThrow(() => validateChangeInputs({ mode, approval: APPROVAL_PHRASES[mode], expectedFingerprint: fp, liveFingerprint: fp }));
  }
  // No phrase for a mode that does not exist.
  assert.throws(() => validateChangeInputs({ mode: 'toString', approval: undefined, expectedFingerprint: fp, liveFingerprint: fp }), (e) => e.code === CODES.INVALID_MANIFEST);
  const aws = attachedWith(REPORT_ONLY);
  await assert.rejects(preflightChange('enforce', tmpRoot(), aws, { CHECKSOPS_STAGING_CSP_APPROVAL: undefined }), (e) => e.code === CODES.INVALID_MANIFEST);
  await assert.rejects(preflightChange('enforce', tmpRoot(), aws, { CHECKSOPS_STAGING_CSP_APPROVAL: 'ENFORCE CSP ON STAGIN' }), (e) => e.code === CODES.INVALID_MANIFEST);
  assert.deepEqual(aws.state.writes, []);
  const workflow = read('.github/workflows/guarded-staging-csp-headers.yml');
  assert.match(workflow, /enforce\) PHRASE="ENFORCE CSP ON STAGING"/);
  assert.match(workflow, /revert\) PHRASE="REVERT CSP TO REPORT-ONLY ON STAGING"/);
  assert.match(workflow, /inputs\.mode == 'enforce' && 'enforcing'/);
  // The public check compares the served enforcing header with the preflight's exact value.
  assert.match(workflow, /EXPECTED_ENFORCING: \$\{\{ steps\.preflight\.outputs\.csp_enforcing \}\}/);
  assert.match(workflow, /enforce\) WANT_REPORT_ONLY=0; WANT_ENFORCING=1 ;;/);
});

test('enforce drift refuses: a stale inspect hash before the receipt, any move after it before any write, and a distribution move after the write', async () => {
  const aws = attachedWith(REPORT_ONLY);
  await assert.rejects(preflightChange('enforce', tmpRoot(), aws, { CHECKSOPS_EXPECTED_SNAPSHOT_SHA256: 'b'.repeat(64) }), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  for (const move of [
    (s) => { s.dist.ETag = 'DIST-MOVED'; },
    (s) => { s.indexHtml = INDEX.replace('<script>', '<script>/* redeployed */'); },
    (s) => { s.policies[OURS].ETag = 'POL-MOVED'; },
  ]) {
    const root = tmpRoot();
    const moving = attachedWith(REPORT_ONLY);
    const result = await preflightChange('enforce', root, moving);
    move(moving.state);
    assert.throws(() => runWriter(result, moving, root), /guard_refused|state_refused/);
    assert.deepEqual(moving.state.writes, []);
  }
  const root = tmpRoot();
  const drifting = attachedWith(REPORT_ONLY, { mutate: (s) => { s.dist.config.DefaultCacheBehavior.Compress = false; } });
  const result = await preflightChange('enforce', root, drifting);
  assert.throws(() => runWriter(result, drifting, root), /post_write_distribution_drift/);
  // And a stored value that is not what was sent fails post-verify.
  const root2 = tmpRoot();
  const wrong = attachedWith(REPORT_ONLY, { echo: (config) => {
    const echoed = awsEchoNoCustom(config);
    if (echoed.SecurityHeadersConfig.ContentSecurityPolicy?.ContentSecurityPolicy) echoed.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy += ' ';
    return echoed;
  } });
  const wrongResult = await preflightChange('enforce', root2, wrong);
  assert.throws(() => runWriter(wrongResult, wrong, root2), /policy_post_verify_failed/);
});

test('enforce never reaches production: the production policy under our name blocks, and the writer refuses it', async () => {
  const aws = fakeAws({ attached: OURS, ours: { id: OURS, config: REPORT_ONLY }, echo: awsEchoNoCustom });
  aws.state.policies[PRODUCTION_POLICY_ID].config = structuredClone(REPORT_ONLY);
  const result = await inspect(aws);
  assert.equal(result.state, 'BLOCKED');
  assert.ok(result.problems.includes('production_policy'), result.problems.join(','));
  await assert.rejects(preflightChange('enforce', tmpRoot(), aws), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  assert.throws(() => awsClient.updatePolicy(PRODUCTION_POLICY_ID, 'E', ENFORCING, {}), /staging_only/);
  assert.deepEqual(aws.state.writes, []);
});

test('CloudFront\'s empty-section echo on an enforcing policy is not drift (XSSProtection {}, CustomHeadersConfig { Quantity: 0 })', () => {
  const echoed = awsEchoNoCustom(ENFORCING);
  assert.deepEqual(echoed.SecurityHeadersConfig.XSSProtection, {});
  assert.deepEqual(echoed.CustomHeadersConfig, { Quantity: 0 });
  assert.deepEqual(normalizePolicyConfig(echoed), normalizePolicyConfig(ENFORCING));
});

test('the IAM source already allows enforce and revert: UpdateResponseHeadersPolicy on response-headers-policy/* minus production', () => {
  const policy = JSON.parse(read('aws/staging-csp-headers/policies/permissions-policy.json'));
  const update = policy.Statement.find((s) => s.Effect === 'Allow' && [].concat(s.Action).includes('cloudfront:UpdateResponseHeadersPolicy'));
  assert.equal(update.Resource, 'arn:aws:cloudfront::806168576068:response-headers-policy/*');
  const deny = policy.Statement.find((s) => s.Effect === 'Deny' && [].concat(s.Action).includes('cloudfront:UpdateResponseHeadersPolicy'));
  assert.equal(deny.Resource, `arn:aws:cloudfront::806168576068:response-headers-policy/${PRODUCTION_POLICY_ID}`);
  // The workflow's change session carries the same grant and deny.
  const workflow = read('.github/workflows/guarded-staging-csp-headers.yml');
  const session = workflow.split('Configure staging CSP headers session (apply / enforce / revert / rollback)')[1].split('- name:')[0];
  assert.match(session, /"cloudfront:GetResponseHeadersPolicy","cloudfront:UpdateResponseHeadersPolicy"\],"Resource":"arn:aws:cloudfront::806168576068:response-headers-policy\/\*"/);
  assert.match(session, /"Effect":"Deny","Action":\["cloudfront:UpdateResponseHeadersPolicy","cloudfront:DeleteResponseHeadersPolicy"\],"Resource":"arn:aws:cloudfront::806168576068:response-headers-policy\/756a8f23-68dd-4f8a-8293-5a2fd08f919a"/);
});
