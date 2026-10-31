/**
 * Guarded production CSP headers (SPA CSP rollout step 5, ops/deployment-guard/PRODUCTION_CSP_HEADERS.md):
 * only production distribution E1B0ZWWO5559U5 and its policy 756a8f23-…, updated in place (owner,
 * 2026-10-31: "build the production CSP tooling, in place"); never a staging id or host; the CSP is
 * buildCsp(production, the fetched live index.html, enforce); every other header is the SH-1 template
 * byte-for-byte; the distribution never changes; each change needs its exact phrase, the inspect's
 * snapshot and a staging acceptance reference; revert restores exactly the SH-1 baseline.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import {
  ATTACHED_BEHAVIORS,
  DEPLOYMENT_TYPE,
  DISTRIBUTION_ID,
  ENFORCING_COMMENT,
  OWNED_COMPONENTS,
  POLICY_ID,
  POLICY_NAME,
  PRODUCTION_WEB_ACL_ID,
  STAGING_DISTRIBUTION_ID,
  STAGING_POLICY_ID,
  TARGET_COMPONENT,
  TARGET_ENVIRONMENT,
  actionFor,
  assertDistributionUnchanged,
  assertNoStagingHost,
  assertProductionDistribution,
  assertProductionPolicy,
  awsClient,
  baselinePolicyConfig,
  classify,
  enforcingPolicyConfig,
  loadTemplatePolicy,
  main as writer,
  normalizePolicyConfig,
  productionCsp,
  readState,
} from '../../scripts/deployment-guard/production-csp-headers.mjs';
import { APPROVAL_PHRASES, STAGING_ENFORCE_RUN, run as preflight, validateChangeInputs, workflowIdentity } from '../../scripts/deployment-guard/github-production-csp-headers.mjs';
import { assertStagingDistribution, awsClient as stagingClient } from '../../scripts/deployment-guard/staging-csp-headers.mjs';
import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { DEPLOYMENT_TYPES } from '../../scripts/deployment-guard/lib/identity.mjs';
import { STAGING_API_ORIGIN, buildCsp, inlineScriptHashes } from '../../scripts/deployment-guard/lib/spa-csp.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const INDEX = read('index.html');
const TEMPLATE = loadTemplatePolicy(REPO_ROOT);
const BASELINE = baselinePolicyConfig(TEMPLATE);
const ENFORCING = enforcingPolicyConfig(INDEX, TEMPLATE);
const SHA = 'e'.repeat(40);
const ENV = { GITHUB_SHA: SHA, GITHUB_REF_NAME: 'main', GITHUB_ACTOR: 'owner', GITHUB_RUN_ID: '6262' };
const WORKFLOW = read('.github/workflows/guarded-production-csp-headers.yml');
const STAGING_HOSTS = ['psr19uhop4', 'staging.checksops.com', 'checksops-staging-frontend-c48b'];
const CFN_SCHEMA = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('!Ref', { kind: 'scalar', construct: (data) => ({ Ref: data }) })]);

// The production distribution's shape (SH1_ACCEPTED_PRODUCTION_BASELINE.md): the policy on the
// default behavior, /prep and /prep/*, the WAF attached.
const baseConfig = () => ({
  CallerReference: 'production-spa',
  Aliases: { Quantity: 2, Items: ['checksops.com', 'www.checksops.com'] },
  DefaultRootObject: 'index.html',
  WebACLId: PRODUCTION_WEB_ACL_ID,
  Origins: { Quantity: 2, Items: [{ Id: 'ProductionSpaS3', DomainName: 'checksops-production-frontend-806168576068.s3.us-east-1.amazonaws.com' }, { Id: 'PrepApi', DomainName: 'kiqojucc02.execute-api.us-east-1.amazonaws.com' }] },
  DefaultCacheBehavior: { TargetOriginId: 'ProductionSpaS3', ViewerProtocolPolicy: 'redirect-to-https', ResponseHeadersPolicyId: POLICY_ID },
  CacheBehaviors: {
    Quantity: 2,
    Items: [
      { PathPattern: '/prep', TargetOriginId: 'PrepApi', ResponseHeadersPolicyId: POLICY_ID },
      { PathPattern: '/prep/*', TargetOriginId: 'PrepApi', ResponseHeadersPolicyId: POLICY_ID },
    ],
  },
  Enabled: true,
});

// How CloudFront echoes a stored policy: unset security headers as empty objects
// (staging run 41067994638) and an empty CustomHeadersConfig.
const awsEcho = (config) => {
  const echoed = structuredClone(config);
  echoed.SecurityHeadersConfig = { XSSProtection: {}, ContentSecurityPolicy: {}, ...echoed.SecurityHeadersConfig };
  echoed.CustomHeadersConfig = { Quantity: 0 };
  return echoed;
};

// A fake CloudFront + S3 with ETags; counts every write.
function fakeAws({ indexHtml = INDEX, policy = BASELINE, mutate = null, echo = awsEcho, config = baseConfig() } = {}) {
  const state = {
    indexHtml,
    dist: { Id: DISTRIBUTION_ID, Status: 'Deployed', ETag: 'PDIST0', config },
    policy: { ETag: 'PPOL0', config: structuredClone(policy) },
    writes: [],
    reads: { index: 0 },
  };
  const client = {
    getDistribution: (id) => {
      assertProductionDistribution(id);
      return structuredClone({ ETag: state.dist.ETag, Distribution: { Id: state.dist.Id, Status: state.dist.Status, DistributionConfig: state.dist.config } });
    },
    getPolicy: (id) => {
      assertProductionPolicy(id);
      return structuredClone({ ETag: state.policy.ETag, ResponseHeadersPolicy: { Id: id, ResponseHeadersPolicyConfig: echo(state.policy.config) } });
    },
    readIndexHtml: () => { state.reads.index += 1; return state.indexHtml; },
    updatePolicy: (id, etag, next) => {
      assertProductionPolicy(id);
      if (state.policy.ETag !== etag) throw new Error('PreconditionFailed');
      state.writes.push({ op: 'updatePolicy', id, etag, config: structuredClone(next) });
      state.policy = { ETag: `${etag}+`, config: structuredClone(next) };
      if (mutate) mutate(state);
      return {};
    },
  };
  return { state, client, readState: (env) => readState(env, client) };
}

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-production-csp-'));
  fs.mkdirSync(path.join(root, 'ops/deployment-guard'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/accepted-contracts.json'), path.join(root, 'ops/deployment-guard/accepted-contracts.json'));
  return root;
}

const inspect = (aws, root = tmpRoot()) => preflight({ ...ENV, CHECKSOPS_PRODUCTION_CSP_MODE: 'inspect' }, { root, template: TEMPLATE, readState: aws.readState });
const verifyAs = (aws, root, expect) => preflight({ ...ENV, CHECKSOPS_PRODUCTION_CSP_MODE: 'verify', CHECKSOPS_PRODUCTION_CSP_VERIFY_EXPECT: expect }, { root, template: TEMPLATE, readState: aws.readState });

async function preflightChange(mode, root, aws, extra = {}) {
  const inspected = await inspect(aws, root);
  return preflight({
    ...ENV,
    CHECKSOPS_PRODUCTION_CSP_MODE: mode,
    CHECKSOPS_EXPECTED_SNAPSHOT_SHA256: inspected.snapshot_sha256,
    CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE: STAGING_ENFORCE_RUN,
    CHECKSOPS_PRODUCTION_CSP_APPROVAL: APPROVAL_PHRASES[mode],
    ...extra,
  }, { root, template: TEMPLATE, readState: aws.readState, signer: (unsigned) => unsigned });
}

const writerEnv = (result) => ({
  CHECKSOPS_PRODUCTION_CSP_EXECUTE: '1',
  CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1',
  CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: result.authorization.receiptFile,
  CHECKSOPS_PRODUCTION_CSP_INPUT: result.authorization.cspInput,
  CHECKSOPS_WORKSTREAM_ID: result.identity.workstreamId,
  CHECKSOPS_COMMIT: SHA,
});

function quiet(fn) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = write; }
}

const runWriter = (result, aws, root) => quiet(() => writer(writerEnv(result), { client: aws.client, guardRoot: root, template: TEMPLATE }));
const directive = (csp, name) => csp.split('; ').find((part) => part === name || part.startsWith(`${name} `));

test('the deployment type is registered, both scripts are in the bypass inventory, and the receipt is production/production-spa', () => {
  assert.ok(DEPLOYMENT_TYPES.includes(DEPLOYMENT_TYPE));
  const rows = Object.fromEntries(JSON.parse(read('ops/deployment-guard/bypass-inventory.json')).scripts.map((row) => [row.path, row]));
  assert.equal(rows['scripts/deployment-guard/production-csp-headers.mjs'].classification, 'GUARDED');
  assert.equal(rows['scripts/deployment-guard/github-production-csp-headers.mjs'].classification, 'SAFE');
  assert.equal(TARGET_ENVIRONMENT, 'production');
  assert.equal(TARGET_COMPONENT, 'production-spa');
  assert.deepEqual(OWNED_COMPONENTS, { enforce: [`response-headers-policy:${POLICY_ID}`], revert: [`response-headers-policy:${POLICY_ID}`] });
  assert.deepEqual(ATTACHED_BEHAVIORS, ['Default', '/prep', '/prep/*']);
});

test('production only: staging ids and any other id are refused before any AWS call; the staging tool still refuses production', () => {
  assert.throws(() => assertProductionDistribution(STAGING_DISTRIBUTION_ID), /production_only:staging_distribution/);
  assert.throws(() => assertProductionDistribution('EOTHER'), /production_only:distribution/);
  assert.throws(() => assertProductionPolicy(STAGING_POLICY_ID), /production_only:staging_policy/);
  assert.throws(() => assertProductionPolicy('other-policy'), /production_only:policy/);
  assert.throws(() => awsClient.getDistribution(STAGING_DISTRIBUTION_ID, {}), /production_only/);
  assert.throws(() => awsClient.getPolicy(STAGING_POLICY_ID, {}), /production_only/);
  assert.throws(() => awsClient.updatePolicy(STAGING_POLICY_ID, 'E', BASELINE, {}), /production_only/);
  assert.throws(() => awsClient.updatePolicy(POLICY_ID, '', BASELINE, {}), /policy_etag_missing/);
  // The staging writer (unchanged) refuses the production distribution and policy.
  assert.throws(() => assertStagingDistribution(DISTRIBUTION_ID), /staging_only/);
  assert.throws(() => stagingClient.updatePolicy(POLICY_ID, 'E', {}, {}), /staging_only/);
  // The writer has no distribution write and no policy create or delete at all.
  const source = read('scripts/deployment-guard/production-csp-headers.mjs');
  assert.equal(/update-distribution|create-response-headers-policy|delete-response-headers-policy|create-invalidation|put-object/.test(source), false);
  assert.deepEqual(Object.keys(awsClient).sort(), ['getDistribution', 'getPolicy', 'readIndexHtml', 'updatePolicy']);
});

test('the production CSP has no staging host and every required directive', () => {
  const csp = productionCsp(INDEX);
  assert.equal(csp, buildCsp({ environment: 'production', indexHtml: INDEX, enforce: true }));
  for (const host of [...STAGING_HOSTS, STAGING_API_ORIGIN]) assert.equal(csp.includes(host), false, host);
  assert.equal(/execute-api/.test(csp), false);
  for (const [name, value] of [
    ['default-src', "default-src 'self'"],
    ['object-src', "object-src 'none'"],
    ['base-uri', "base-uri 'self'"],
    ['form-action', "form-action 'self'"],
    ['frame-ancestors', "frame-ancestors 'self'"],
    ['worker-src', "worker-src 'self' blob:"],
    ['upgrade-insecure-requests', 'upgrade-insecure-requests'],
  ]) assert.equal(directive(csp, name), value, name);
  assert.equal(directive(csp, 'script-src'), `script-src 'self' ${inlineScriptHashes(INDEX).join(' ')}`);
  assert.equal(/'unsafe-eval'|unpkg\.com/.test(csp), false);
  assert.equal(/'unsafe-inline'/.test(directive(csp, 'script-src')), false);
  // A staging host can never reach a production policy.
  assert.throws(() => assertNoStagingHost(`${csp}; connect-src ${STAGING_API_ORIGIN}`), /staging_host_in_production_csp/);
  assert.throws(() => assertNoStagingHost('img-src https://staging.checksops.com'), /staging_host_in_production_csp/);
});

test('enforce keeps every non-CSP header of the SH-1 template byte-for-byte; revert is exactly the template', () => {
  const doc = yaml.load(read('aws/production/cloudfront-security-headers.yaml'), { schema: CFN_SCHEMA });
  const templateConfig = Object.values(doc.Resources)[0].Properties.ResponseHeadersPolicyConfig;
  const { ContentSecurityPolicy, ...others } = ENFORCING.SecurityHeadersConfig;
  assert.equal(JSON.stringify(others), JSON.stringify(templateConfig.SecurityHeadersConfig));
  assert.deepEqual(ContentSecurityPolicy, { ContentSecurityPolicy: productionCsp(INDEX), Override: true });
  assert.equal(ENFORCING.Name, POLICY_NAME);
  assert.equal(ENFORCING.Comment, ENFORCING_COMMENT);
  assert.ok(ENFORCING_COMMENT.length <= 128);
  assert.equal(ENFORCING.CustomHeadersConfig, undefined);
  assert.deepEqual(BASELINE, { Name: POLICY_NAME, Comment: templateConfig.Comment, SecurityHeadersConfig: templateConfig.SecurityHeadersConfig });
  assert.equal(templateConfig.Comment, 'Low-risk browser security headers; CSP intentionally deferred.');
  // The template is the revert target and never sets a CSP itself.
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, 'aws/production'), { recursive: true });
  const bad = read('aws/production/cloudfront-security-headers.yaml').replace('        SecurityHeadersConfig:\n', '        SecurityHeadersConfig:\n          ContentSecurityPolicy:\n            ContentSecurityPolicy: "default-src \'self\'"\n            Override: true\n');
  fs.writeFileSync(path.join(root, 'aws/production/cloudfront-security-headers.yaml'), bad);
  assert.throws(() => loadTemplatePolicy(root), /template_sets_csp/);
});

test('the CSP hash comes from the fetched live index.html, not from the repository copy', async () => {
  const live = INDEX.replace('<script>', '<script>/* live production build */');
  const aws = fakeAws({ indexHtml: live });
  const result = await inspect(aws);
  assert.equal(aws.state.reads.index, 1);
  assert.equal(result.csp_enforcing, buildCsp({ environment: 'production', indexHtml: live, enforce: true }));
  assert.notEqual(result.csp_enforcing, productionCsp(INDEX));
  for (const hash of inlineScriptHashes(live)) assert.ok(result.csp_enforcing.includes(hash));
  for (const hash of inlineScriptHashes(INDEX)) assert.equal(result.csp_enforcing.includes(hash), false);
  // The writer sends the CSP for the live file too.
  const root = tmpRoot();
  const change = await preflightChange('enforce', root, aws);
  assert.equal(runWriter(change, aws, root), 0);
  assert.equal(aws.state.writes[0].config.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy, result.csp_enforcing);
  // An unreadable index.html stops the read.
  assert.throws(() => fakeAws({ indexHtml: '' }).readState({}), /index_html_unreadable/);
});

test('classify: BASELINE, ENFORCING_CURRENT, ENFORCING_STALE, and BLOCKED on drift; which mode runs in each', async () => {
  const staleEnforcing = enforcingPolicyConfig(INDEX.replace('<script>', '<script>/* old */'), TEMPLATE);
  assert.equal((await inspect(fakeAws())).state, 'BASELINE');
  assert.equal((await inspect(fakeAws({ policy: ENFORCING }))).state, 'ENFORCING_CURRENT');
  assert.equal((await inspect(fakeAws({ policy: staleEnforcing }))).state, 'ENFORCING_STALE');
  const blocked = [
    [{ config: (() => { const c = baseConfig(); delete c.DefaultCacheBehavior.ResponseHeadersPolicyId; return c; })() }, 'policy_not_attached:Default'],
    [{ config: (() => { const c = baseConfig(); c.CacheBehaviors.Items[1].ResponseHeadersPolicyId = STAGING_POLICY_ID; return c; })() }, 'staging_policy_attached'],
    [{ config: (() => { const c = baseConfig(); c.CacheBehaviors.Items[0].ResponseHeadersPolicyId = 'other'; return c; })() }, 'policy_not_attached:/prep'],
    [{ config: { ...baseConfig(), WebACLId: '' } }, 'waf_drift'],
    [{ config: { ...baseConfig(), Aliases: { Quantity: 1, Items: ['staging.checksops.com'] } } }, 'aliases_drift'],
    [{ policy: { ...structuredClone(BASELINE), SecurityHeadersConfig: { ...structuredClone(BASELINE.SecurityHeadersConfig), FrameOptions: { FrameOption: 'DENY', Override: true } } } }, 'baseline_headers_drift'],
    [{ policy: { ...structuredClone(BASELINE), SecurityHeadersConfig: { ...structuredClone(BASELINE.SecurityHeadersConfig), ContentSecurityPolicy: { ContentSecurityPolicy: "default-src *", Override: true } } } }, 'foreign_csp'],
    [{ policy: { ...structuredClone(ENFORCING), SecurityHeadersConfig: { ...structuredClone(ENFORCING.SecurityHeadersConfig), ContentSecurityPolicy: { ...ENFORCING.SecurityHeadersConfig.ContentSecurityPolicy, Override: false } } } }, 'foreign_csp'],
    [{ policy: { ...structuredClone(BASELINE), CustomHeadersConfig: { Quantity: 1, Items: [{ Header: 'X-Extra', Value: '1', Override: true }] } }, echo: (c) => c }, 'policy_has_unowned_settings'],
    [{ policy: { ...structuredClone(BASELINE), CorsConfig: { AccessControlAllowOrigins: { Items: ['*'] } } } }, 'policy_has_unowned_settings'],
    [{ policy: { ...structuredClone(BASELINE), Comment: 'edited in the console' } }, 'comment_drift'],
    [{ policy: { ...structuredClone(BASELINE), Name: 'renamed' } }, 'policy_name_drift'],
  ];
  for (const [setup, problem] of blocked) {
    const result = await inspect(fakeAws(setup));
    assert.equal(result.state, 'BLOCKED', problem);
    assert.ok(result.problems.includes(problem), `${problem}: ${result.problems.join(',')}`);
  }
  const aws = fakeAws();
  aws.state.dist.Status = 'InProgress';
  assert.ok((await inspect(aws)).problems.includes('distribution_not_deployed'));
  const snapshot = fakeAws().readState({}).snapshot;
  snapshot.distribution.Id = STAGING_DISTRIBUTION_ID;
  assert.ok(classify(snapshot, BASELINE, ENFORCING).problems.includes('staging_distribution'));
  const table = {
    enforce: { BASELINE: 'enforce', ENFORCING_CURRENT: null, ENFORCING_STALE: 'enforce', BLOCKED: null },
    revert: { BASELINE: null, ENFORCING_CURRENT: 'revert', ENFORCING_STALE: 'revert', BLOCKED: null },
    apply: { BASELINE: null, ENFORCING_CURRENT: null, ENFORCING_STALE: null, BLOCKED: null },
    rollback: { BASELINE: null, ENFORCING_CURRENT: null, ENFORCING_STALE: null, BLOCKED: null },
  };
  for (const [mode, row] of Object.entries(table)) {
    for (const [state, action] of Object.entries(row)) assert.equal(actionFor(mode, state), action, `${mode} ${state}`);
  }
});

test('CloudFront\'s empty-section echo is not drift; a set field is', () => {
  assert.deepEqual(normalizePolicyConfig(awsEcho(ENFORCING)), normalizePolicyConfig(ENFORCING));
  assert.deepEqual(normalizePolicyConfig(awsEcho(BASELINE)), normalizePolicyConfig(BASELINE));
  assert.notDeepEqual(normalizePolicyConfig(ENFORCING), normalizePolicyConfig(BASELINE));
});

test('inspect makes no writes; the workflow\'s inspect session has no write or KMS action', async () => {
  const aws = fakeAws();
  const result = await inspect(aws);
  assert.equal(result.state, 'BASELINE');
  assert.equal(result.mutation, false);
  assert.equal(result.policy_id, POLICY_ID);
  assert.match(result.snapshot_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(aws.state.writes, []);
  const inspectPolicy = WORKFLOW.split('Configure read-only production AWS session (inspect)')[1].split('- name:')[0];
  assert.equal(/Update|Create|Delete|kms:|PutObject/.test(inspectPolicy), false);
});

test('enforce: one in-place UpdateResponseHeadersPolicy with If-Match; the distribution is unchanged; the receipt is single use', async () => {
  const root = tmpRoot();
  const aws = fakeAws();
  const before = structuredClone(aws.state.dist);
  const result = await preflightChange('enforce', root, aws);
  assert.equal(result.action, 'enforce');
  const receipt = JSON.parse(fs.readFileSync(result.authorization.receiptFile, 'utf8'));
  assert.equal(receipt.deployment_type, DEPLOYMENT_TYPE);
  assert.equal(receipt.target_environment, 'production');
  assert.equal(receipt.target_component, 'production-spa');
  assert.deepEqual(receipt.owned_components, OWNED_COMPONENTS.enforce);
  const input = JSON.parse(fs.readFileSync(result.authorization.cspInput, 'utf8'));
  assert.deepEqual(input.staging_acceptance, { ok: true, reference: STAGING_ENFORCE_RUN });
  assert.equal(input.approval.phrase, 'ENFORCE CSP ON PRODUCTION');
  assert.equal(runWriter(result, aws, root), 0);
  assert.deepEqual(aws.state.writes.map((w) => [w.op, w.id, w.etag]), [['updatePolicy', POLICY_ID, 'PPOL0']]);
  assert.deepEqual(aws.state.writes[0].config, ENFORCING);
  assert.deepEqual(aws.state.dist, before);
  assert.equal((await verifyAs(aws, root, 'enforcing')).state, 'VERIFIED');
  await assert.rejects(verifyAs(aws, root, 'baseline'), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  assert.equal((await inspect(aws)).state, 'ENFORCING_CURRENT');
  assert.throws(() => runWriter(result, aws, root), /state_refused|guard_refused|receipt_consumption_failed/);
  assert.equal(aws.state.writes.length, 1);
  // Nothing to enforce once current.
  await assert.rejects(preflightChange('enforce', tmpRoot(), aws), (e) => e.code === CODES.UNRELATED_MUTATION);
});

test('enforce refreshes a stale enforcing policy after an SPA upload changed the inline script', async () => {
  const root = tmpRoot();
  const aws = fakeAws({ policy: enforcingPolicyConfig(INDEX.replace('<script>', '<script>/* old */'), TEMPLATE) });
  const result = await preflightChange('enforce', root, aws);
  assert.equal(runWriter(result, aws, root), 0);
  assert.deepEqual(aws.state.writes[0].config, ENFORCING);
});

test('revert restores exactly the SH-1 baseline and leaves the distribution unchanged', async () => {
  const root = tmpRoot();
  const aws = fakeAws({ policy: ENFORCING });
  const before = structuredClone(aws.state.dist);
  const result = await preflightChange('revert', root, aws);
  assert.equal(result.action, 'revert');
  assert.equal(JSON.parse(fs.readFileSync(result.authorization.cspInput, 'utf8')).approval.phrase, 'REMOVE CSP FROM PRODUCTION');
  assert.equal(runWriter(result, aws, root), 0);
  assert.deepEqual(aws.state.writes.map((w) => w.op), ['updatePolicy']);
  assert.deepEqual(aws.state.writes[0].config, BASELINE);
  assert.equal(aws.state.writes[0].config.SecurityHeadersConfig.ContentSecurityPolicy, undefined);
  assert.deepEqual(aws.state.dist, before);
  assert.equal((await verifyAs(aws, root, 'baseline')).state, 'VERIFIED');
  assert.equal((await inspect(aws)).state, 'BASELINE');
  await assert.rejects(preflightChange('revert', tmpRoot(), aws), (e) => e.code === CODES.UNRELATED_MUTATION);
});

test('each change needs its exact phrase, a staging acceptance reference and the inspect snapshot', async () => {
  for (const [mode, approval] of [
    ['enforce', 'enforce csp on production'],
    ['enforce', 'ENFORCE CSP ON STAGING'],
    ['enforce', APPROVAL_PHRASES.revert],
    ['revert', APPROVAL_PHRASES.enforce],
    ['revert', 'REMOVE CSP FROM PRODUCTION '],
  ]) {
    const aws = fakeAws(mode === 'revert' ? { policy: ENFORCING } : {});
    await assert.rejects(preflightChange(mode, tmpRoot(), aws, { CHECKSOPS_PRODUCTION_CSP_APPROVAL: approval }), (e) => e.code === CODES.PRODUCTION_APPROVAL_REQUIRED, approval);
    assert.deepEqual(aws.state.writes, []);
  }
  for (const reference of ['', 'run 41086648035', 'https://github.com/someone-else/ChecksOps/actions/runs/1', 'https://example.com/actions/runs/41086648035']) {
    await assert.rejects(preflightChange('enforce', tmpRoot(), fakeAws(), { CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE: reference }), (e) => e.code === CODES.PRODUCTION_APPROVAL_REQUIRED, reference);
  }
  await assert.rejects(preflightChange('enforce', tmpRoot(), fakeAws(), { CHECKSOPS_EXPECTED_SNAPSHOT_SHA256: '' }), (e) => e.code === CODES.INVALID_MANIFEST);
  await assert.rejects(preflightChange('enforce', tmpRoot(), fakeAws(), { CHECKSOPS_EXPECTED_SNAPSHOT_SHA256: 'f'.repeat(64) }), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  assert.throws(() => validateChangeInputs({ mode: 'apply', approval: 'x', stagingAcceptance: STAGING_ENFORCE_RUN, expectedFingerprint: 'a'.repeat(64), liveFingerprint: 'a'.repeat(64) }), (e) => e.code === CODES.PRODUCTION_APPROVAL_REQUIRED);
  assert.equal(STAGING_ENFORCE_RUN, 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/41086648035');
  // Only from main, with a full workflow identity.
  assert.throws(() => workflowIdentity({ ...ENV, GITHUB_REF_NAME: 'claude/production-csp' }), (e) => e.code === CODES.UNRELATED_MUTATION);
  assert.throws(() => workflowIdentity({ ...ENV, GITHUB_SHA: 'abc' }), (e) => e.code === CODES.ANONYMOUS_DEPLOYMENT);
});

test('drift refuses: any move between the receipt and the write, and a distribution move after the write', async () => {
  // The index.html (new SPA upload) moves after the receipt: refused before any write.
  {
    const root = tmpRoot();
    const aws = fakeAws();
    const result = await preflightChange('enforce', root, aws);
    aws.state.indexHtml = INDEX.replace('<script>', '<script>/* new upload */');
    assert.throws(() => runWriter(result, aws, root), /state_refused|guard_refused|toctou_drift/);
    assert.deepEqual(aws.state.writes, []);
  }
  // The distribution config moves after the receipt.
  {
    const root = tmpRoot();
    const aws = fakeAws();
    const result = await preflightChange('enforce', root, aws);
    aws.state.dist.config.DefaultRootObject = 'other.html';
    assert.throws(() => runWriter(result, aws, root), /guard_refused|toctou_drift/);
    assert.deepEqual(aws.state.writes, []);
  }
  // The distribution changes during the write: the writer fails closed after it.
  {
    const root = tmpRoot();
    const aws = fakeAws({ mutate: (state) => { state.dist.config.CacheBehaviors.Items[0].TargetOriginId = 'Elsewhere'; } });
    const result = await preflightChange('enforce', root, aws);
    assert.throws(() => runWriter(result, aws, root), /post_write_distribution_drift/);
  }
  // The policy reads back differently: post-verify fails.
  {
    const root = tmpRoot();
    const aws = fakeAws({ mutate: (state) => { state.policy.config.Comment = 'changed'; } });
    const result = await preflightChange('enforce', root, aws);
    assert.throws(() => runWriter(result, aws, root), /policy_post_verify_failed/);
  }
  assert.throws(() => assertDistributionUnchanged(baseConfig(), { ...baseConfig(), Enabled: false }), /post_write_distribution_drift/);
});

test('the writer refuses plan-only runs, caller-supplied config or CSP, a receipt for another action, and no receipt', async () => {
  const aws = fakeAws();
  assert.equal(quiet(() => writer({}, { client: aws.client, template: TEMPLATE })), 2);
  const root = tmpRoot();
  const result = await preflightChange('enforce', root, aws);
  for (const extra of [{ csp: "default-src *" }, { policy_config: {} }, { index_html: '<html>' }, { policy_id: STAGING_POLICY_ID }]) {
    const file = path.join(root, `input-${Object.keys(extra)[0]}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(result.authorization.cspInput, 'utf8')), ...extra }));
    assert.throws(() => quiet(() => writer({ ...writerEnv(result), CHECKSOPS_PRODUCTION_CSP_INPUT: file }, { client: aws.client, guardRoot: root, template: TEMPLATE })), /caller_supplied_config_forbidden/);
  }
  const wrongMode = path.join(root, 'input-mode.json');
  fs.writeFileSync(wrongMode, JSON.stringify({ ...JSON.parse(fs.readFileSync(result.authorization.cspInput, 'utf8')), mode: 'revert', action: 'revert' }));
  assert.throws(() => quiet(() => writer({ ...writerEnv(result), CHECKSOPS_PRODUCTION_CSP_INPUT: wrongMode }, { client: aws.client, guardRoot: root, template: TEMPLATE })), /state_refused/);
  const noReceipt = { ...writerEnv(result), CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: path.join(root, 'missing.json') };
  const input = path.join(root, 'input-noreceipt.json');
  fs.writeFileSync(input, JSON.stringify({ ...JSON.parse(fs.readFileSync(result.authorization.cspInput, 'utf8')), receipt_path: path.join(root, 'missing.json') }));
  assert.throws(() => quiet(() => writer({ ...noReceipt, CHECKSOPS_PRODUCTION_CSP_INPUT: input }, { client: aws.client, guardRoot: tmpRoot(), template: TEMPLATE })), /guard_refused/);
  assert.deepEqual(aws.state.writes, []);
});

test('the workflow: main only, production environment, approved commit, exact phrases, staging reference, SPA concurrency, dedicated role', () => {
  assert.match(WORKFLOW, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(WORKFLOW, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
  assert.match(WORKFLOW, /test "\$INPUT_APPROVED_COMMIT" = "\$GITHUB_SHA"/);
  assert.match(WORKFLOW, /environment: production\n/);
  assert.match(WORKFLOW, /enforce\) PHRASE="ENFORCE CSP ON PRODUCTION" ;;/);
  assert.match(WORKFLOW, /revert\) PHRASE="REMOVE CSP FROM PRODUCTION" ;;/);
  assert.match(WORKFLOW, /test "\$INPUT_APPROVAL_PHRASE" = "\$PHRASE"/);
  assert.match(WORKFLOW, /\[\[ "\$INPUT_STAGING_ACCEPTANCE" =~ \^https:\/\/github\\\.com\/michaelcarletta-cmd\/ChecksOps\//);
  assert.match(WORKFLOW, /group: guarded-production-spa-upload\n\s+cancel-in-progress: false/);
  assert.match(WORKFLOW, /vars\.CHECKSOPS_PRODUCTION_CSP_HEADERS_ROLE_ARN/);
  assert.match(WORKFLOW, /arn:aws:sts::806168576068:assumed-role\/ChecksOpsGitHubProductionCspHeaders\/checksops-production-csp-\$GITHUB_RUN_ID/);
  assert.match(WORKFLOW, /inputs\.mode == 'enforce' && 'enforcing' \|\| 'baseline'/);
  assert.match(WORKFLOW, /https:\/\/checksops\.com\/\?csp=/);
  assert.match(WORKFLOW, /https:\/\/checksops\.com\/prep\/health/);
  // Inputs reach shell only through env.
  const gate = WORKFLOW.split('- name: Refuse non-main or incomplete change')[1].split('- name:')[0];
  assert.equal(/run:[\s\S]*\$\{\{ inputs\./.test(gate), false);
  // Never staging, never a distribution write, never another policy.
  assert.equal(/E1CG52WRQZI7X1|d3f84b15|staging\.checksops\.com|update-distribution|UpdateDistribution|CreateResponseHeadersPolicy/.test(WORKFLOW), false);
  const change = WORKFLOW.split('Configure production CSP headers session (enforce / revert)')[1].split('- name:')[0];
  const session = JSON.parse(change.split('inline-session-policy: >-')[1].trim());
  const updates = session.Statement.filter((s) => [].concat(s.Action).includes('cloudfront:UpdateResponseHeadersPolicy'));
  assert.deepEqual(updates.map((s) => s.Resource), [`arn:aws:cloudfront::806168576068:response-headers-policy/${POLICY_ID}`]);
});

test('the IAM source: trust pinned to this workflow on main in production; permissions only the one policy, the distribution read, the index and the guard key', () => {
  const dir = 'ops/deployment-guard/production-csp-headers';
  const trust = JSON.parse(read(`${dir}/trust-policy.json`));
  assert.equal(trust.Statement.length, 1);
  const [statement] = trust.Statement;
  assert.equal(statement.Effect, 'Allow');
  assert.equal(statement.Action, 'sts:AssumeRoleWithWebIdentity');
  assert.equal(statement.Principal.Federated, 'arn:aws:iam::806168576068:oidc-provider/token.actions.githubusercontent.com');
  assert.deepEqual(statement.Condition, {
    StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': 'repo:michaelcarletta-cmd/ChecksOps:environment:production',
      'token.actions.githubusercontent.com:repository_id': '1231339992',
      'token.actions.githubusercontent.com:repository_owner_id': '248244651',
      'token.actions.githubusercontent.com:environment': 'production',
      'token.actions.githubusercontent.com:ref': 'refs/heads/main',
      'token.actions.githubusercontent.com:job_workflow_ref': 'michaelcarletta-cmd/ChecksOps/.github/workflows/guarded-production-csp-headers.yml@refs/heads/main',
    },
  });
  assert.ok(fs.existsSync(path.join(REPO_ROOT, '.github/workflows/guarded-production-csp-headers.yml')));

  const policy = JSON.parse(read(`${dir}/permissions-policy.json`));
  const allows = policy.Statement.filter((s) => s.Effect === 'Allow');
  const granted = Object.fromEntries(allows.flatMap((s) => [].concat(s.Action).map((a) => [a, s.Resource])));
  assert.deepEqual(Object.keys(granted).sort(), ['cloudfront:GetDistribution', 'cloudfront:GetResponseHeadersPolicy', 'cloudfront:UpdateResponseHeadersPolicy', 'kms:GetPublicKey', 'kms:Sign', 's3:GetObject']);
  assert.equal(granted['cloudfront:GetDistribution'], `arn:aws:cloudfront::806168576068:distribution/${DISTRIBUTION_ID}`);
  assert.equal(granted['cloudfront:UpdateResponseHeadersPolicy'], `arn:aws:cloudfront::806168576068:response-headers-policy/${POLICY_ID}`);
  assert.equal(granted['cloudfront:GetResponseHeadersPolicy'], `arn:aws:cloudfront::806168576068:response-headers-policy/${POLICY_ID}`);
  assert.equal(granted['s3:GetObject'], 'arn:aws:s3:::checksops-production-frontend-806168576068/index.html');
  for (const s of allows.filter((row) => [].concat(row.Action).some((a) => a.startsWith('kms:')))) {
    assert.equal(s.Condition['ForAnyValue:StringEquals']['kms:ResourceAliases'], 'alias/checksops-production-deployment-guard');
  }
  const denied = policy.Statement.filter((s) => s.Effect === 'Deny').flatMap((s) => [].concat(s.Action));
  for (const action of ['cloudfront:UpdateDistribution', 'cloudfront:CreateResponseHeadersPolicy', 'cloudfront:DeleteResponseHeadersPolicy']) assert.ok(denied.includes(action), action);
  const stagingDeny = policy.Statement.find((s) => s.Sid === 'NeverTouchStaging');
  assert.deepEqual(stagingDeny.Resource, [`arn:aws:cloudfront::806168576068:distribution/${STAGING_DISTRIBUTION_ID}`, `arn:aws:cloudfront::806168576068:response-headers-policy/${STAGING_POLICY_ID}`]);
  for (const action of Object.keys(granted)) assert.equal(/^(iam|sts|organizations):|^\*$|s3:Put|s3:Delete|cloudfront:\*/.test(action), false, action);
  assert.match(read(`${dir}/README.md`), /CHECKSOPS_PRODUCTION_CSP_HEADERS_ROLE_ARN/);
});

test('the runbooks record the staging enforce run and the production phrases', () => {
  const production = read('ops/deployment-guard/PRODUCTION_CSP_HEADERS.md');
  assert.match(production, /ENFORCE CSP ON PRODUCTION/);
  assert.match(production, /REMOVE CSP FROM PRODUCTION/);
  assert.match(production, /actions\/runs\/41086648035/);
  assert.match(production, /build the production CSP tooling, in place/);
  for (const doc of ['ops/security/SPA_CSP_ROLLOUT.md', 'ops/deployment-guard/STAGING_CSP_HEADERS.md']) {
    const text = read(doc);
    assert.match(text, /41086648035/, doc);
    assert.match(text, /fec5d708b69825371db1f018ed37ce02599a17119b4ae8a534e31beac4f6ba7f/, doc);
    assert.match(text, /7a222f594b383ee3d07062f382e8f1fa8100af29c000c3157200a7e383e59d5d/, doc);
    assert.match(text, /VERIFIED/, doc);
  }
});
