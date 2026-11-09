/**
 * Guarded production SPA fallback (ops/deployment-guard/PRODUCTION_SPA_FALLBACK.md): the CloudFront
 * Function checksops-production-spa-fallback on the default behavior of E1B0ZWWO5559U5 only; code
 * only from aws/cloudfront/spa-fallback.js (publish) or spa-fallback.baseline.js (revert); the
 * allowlist is every MARKETING_PAGES path but "/", plus the retired paths whose key the build still
 * writes (RETIRED_MARKETING_PATHS); update on DEVELOPMENT, test-function against the
 * rules, then publish, each with If-Match; the distribution never changes; never a staging id;
 * each change needs its exact phrase, the inspect's snapshot and a staging acceptance reference.
 *
 * Run with: node --experimental-strip-types --test aws/tests/github-production-spa-fallback.test.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  BASELINE_SOURCE,
  CURRENT_SOURCE,
  DEPLOYMENT_TYPE,
  DISTRIBUTION_ID,
  FUNCTION_ARN,
  FUNCTION_NAME,
  FUNCTION_RUNTIME,
  MARKETING_KEYS,
  MARKETING_PATHS,
  OBJECT_KEYS,
  OWNED_COMPONENTS,
  PAGE_CONTENT_TYPE,
  PRODUCTION_BUCKET,
  PRODUCTION_WEB_ACL_ID,
  SAMPLE_URIS,
  STAGING_BUCKET,
  STAGING_DISTRIBUTION_ID,
  TARGET_COMPONENT,
  TARGET_ENVIRONMENT,
  actionFor,
  assertDistributionUnchanged,
  assertProductionDistribution,
  assertProductionFunction,
  assertProductionObject,
  assertSourceBehaves,
  awsClient,
  classify,
  expectedUri,
  loadFunctionSources,
  main as writer,
  readState,
  runFunctionSource,
  testFunctionUri,
} from '../../scripts/deployment-guard/production-spa-fallback.mjs';
import { APPROVAL_PHRASES, run as preflight, validateChangeInputs, verifyState, workflowIdentity } from '../../scripts/deployment-guard/github-production-spa-fallback.mjs';
import { checkPage, entryBundlePath, main as probeMain, ogTitleTag, pageExpectations, parseArgs, probeOnce } from '../../scripts/deployment-guard/spa-fallback-public-probe.mjs';
import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { DEPLOYMENT_TYPES } from '../../scripts/deployment-guard/lib/identity.mjs';
import { HOME_PAGE, MARKETING_PAGES, RETIRED_MARKETING_PATHS } from '../../src/pages/marketing/marketingPages.ts';
import { staticPageKey } from '../../src/pages/marketing/marketingStaticHead.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const readBytes = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const SOURCES = loadFunctionSources(REPO_ROOT);
const CURRENT = readBytes(CURRENT_SOURCE);
const BASELINE = readBytes(BASELINE_SOURCE);
const SHA = 'e'.repeat(40);
const ENV = { GITHUB_SHA: SHA, GITHUB_REF_NAME: 'main', GITHUB_ACTOR: 'owner', GITHUB_RUN_ID: '7373' };
const WORKFLOW = read('.github/workflows/guarded-production-spa-fallback.yml');
const STAGING_REFERENCE = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/42000000001';
const PAGE_PATHS = MARKETING_PAGES.filter((page) => page.path !== '/').map((page) => page.path);
// Every path the build writes as its own S3 key and the function passes through: the retired
// paths (a copy of the home page, so the guarded upload overwrites the old object) then the pages.
const SERVED_PATHS = [...RETIRED_MARKETING_PATHS, ...PAGE_PATHS];
const LIVE_COMMENT = 'SPA deep-link fallback for S3 default behavior only. Does not run on /prep.';
// The code LIVE before this tool: aws/cloudfront/spa-fallback.js as Step 1 (commit 2ba5c6fc1) uploaded it.
const BASELINE_SHA256 = '0cf839198b024b943b2834e6de414e2d0deea59d88c23373886561575f9269a1';

const association = () => ({ Quantity: 1, Items: [{ FunctionARN: FUNCTION_ARN, EventType: 'viewer-request' }] });
const baseConfig = () => ({
  CallerReference: 'production-spa',
  Aliases: { Quantity: 2, Items: ['checksops.com', 'www.checksops.com'] },
  DefaultRootObject: 'index.html',
  WebACLId: PRODUCTION_WEB_ACL_ID,
  Origins: { Quantity: 2, Items: [{ Id: 'ProductionSpaS3' }, { Id: 'ProductionPrepHttpApi' }] },
  DefaultCacheBehavior: { TargetOriginId: 'ProductionSpaS3', FunctionAssociations: association(), LambdaFunctionAssociations: { Quantity: 0 } },
  CacheBehaviors: {
    Quantity: 2,
    Items: [
      { PathPattern: '/prep', TargetOriginId: 'ProductionPrepHttpApi', FunctionAssociations: { Quantity: 0 } },
      { PathPattern: '/prep/*', TargetOriginId: 'ProductionPrepHttpApi', FunctionAssociations: { Quantity: 0 } },
    ],
  },
  Enabled: true,
});

const pageHead = (key) => ({ ContentType: key === 'index.html' ? 'text/html' : PAGE_CONTENT_TYPE, CacheControl: 'no-cache,no-store,must-revalidate', ContentLength: 4200, ETag: `"${key}"` });

// A fake CloudFront (two function stages with ETags) + S3 heads; counts every write.
function fakeAws({ live = BASELINE, development = null, config = baseConfig(), objects = null, mutate = null, testOverride = null } = {}) {
  const stage = (code, etag) => ({ etag, code: Buffer.from(code), config: { Comment: LIVE_COMMENT, Runtime: FUNCTION_RUNTIME } });
  const state = {
    dist: { Id: DISTRIBUTION_ID, Status: 'Deployed', ETag: 'EDIST0', config },
    stages: { LIVE: stage(live, 'ELIVE0'), DEVELOPMENT: stage(development || live, 'EDEV0') },
    objects: objects || Object.fromEntries(OBJECT_KEYS.map((key) => [key, pageHead(key)])),
    writes: [],
    counter: 0,
  };
  const describe = (name, stageName) => {
    const row = state.stages[stageName];
    return { ETag: row.etag, FunctionSummary: { Name: name, Status: 'DEPLOYED', FunctionConfig: structuredClone(row.config), FunctionMetadata: { FunctionARN: FUNCTION_ARN, Stage: stageName } } };
  };
  const client = {
    getDistribution: (id) => {
      assertProductionDistribution(id);
      return structuredClone({ ETag: state.dist.ETag, Distribution: { Id: state.dist.Id, Status: state.dist.Status, DistributionConfig: state.dist.config } });
    },
    describeFunction: (name, stageName) => { assertProductionFunction(name); return describe(name, stageName); },
    getFunctionCode: (name, stageName) => { assertProductionFunction(name); return { etag: state.stages[stageName].etag, code: Buffer.from(state.stages[stageName].code) }; },
    headObject: (bucket, key) => { assertProductionObject(bucket, key); return state.objects[key] ? structuredClone(state.objects[key]) : null; },
    updateFunction: (name, etag, cfg, code) => {
      assertProductionFunction(name);
      if (state.stages.DEVELOPMENT.etag !== etag) throw new Error('PreconditionFailed');
      state.counter += 1;
      state.writes.push({ op: 'updateFunction', etag, config: structuredClone(cfg), sha256: sha256(code) });
      state.stages.DEVELOPMENT = { etag: `EDEV${state.counter}`, code: Buffer.from(code), config: structuredClone(cfg) };
      return { ETag: state.stages.DEVELOPMENT.etag };
    },
    testFunction: (name, etag, event) => {
      assertProductionFunction(name);
      if (state.stages.DEVELOPMENT.etag !== etag) throw new Error('PreconditionFailed');
      state.writes.push({ op: 'testFunction', etag, uri: event.request.uri });
      const uri = testOverride ? testOverride(event.request.uri) : runFunctionSource(state.stages.DEVELOPMENT.code, event.request.uri);
      return { TestResult: { FunctionOutput: JSON.stringify({ request: { ...event.request, uri } }), FunctionErrorMessage: '' } };
    },
    publishFunction: (name, etag) => {
      assertProductionFunction(name);
      if (state.stages.DEVELOPMENT.etag !== etag) throw new Error('PreconditionFailed');
      state.counter += 1;
      state.writes.push({ op: 'publishFunction', etag });
      state.stages.LIVE = { ...structuredClone(state.stages.DEVELOPMENT), code: Buffer.from(state.stages.DEVELOPMENT.code), etag: `ELIVE${state.counter}` };
      if (mutate) mutate(state);
      return {};
    },
  };
  return { state, client, readState: (env) => readState(env, client) };
}

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-production-spa-fallback-'));
  fs.mkdirSync(path.join(root, 'ops/deployment-guard'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'ops/deployment-guard/accepted-contracts.json'), path.join(root, 'ops/deployment-guard/accepted-contracts.json'));
  return root;
}

const inspect = (aws, root = tmpRoot()) => preflight({ ...ENV, CHECKSOPS_PRODUCTION_SPA_FALLBACK_MODE: 'inspect' }, { root, sources: SOURCES, readState: aws.readState });
const verifyAs = (aws, root, expect) => preflight({ ...ENV, CHECKSOPS_PRODUCTION_SPA_FALLBACK_MODE: 'verify', CHECKSOPS_PRODUCTION_SPA_FALLBACK_VERIFY_EXPECT: expect }, { root, sources: SOURCES, readState: aws.readState });

async function preflightChange(mode, root, aws, extra = {}) {
  const inspected = await inspect(aws, root);
  return preflight({
    ...ENV,
    CHECKSOPS_PRODUCTION_SPA_FALLBACK_MODE: mode,
    CHECKSOPS_EXPECTED_SNAPSHOT_SHA256: inspected.snapshot_sha256,
    CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE: STAGING_REFERENCE,
    CHECKSOPS_PRODUCTION_SPA_FALLBACK_APPROVAL: APPROVAL_PHRASES[mode],
    ...extra,
  }, { root, sources: SOURCES, readState: aws.readState, signer: (unsigned) => unsigned });
}

const writerEnv = (result) => ({
  CHECKSOPS_PRODUCTION_SPA_FALLBACK_EXECUTE: '1',
  CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1',
  CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: result.authorization.receiptFile,
  CHECKSOPS_PRODUCTION_SPA_FALLBACK_INPUT: result.authorization.fallbackInput,
  CHECKSOPS_WORKSTREAM_ID: result.identity.workstreamId,
  CHECKSOPS_COMMIT: SHA,
});

function quiet(fn) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = write; }
}

const runWriter = (result, aws, root) => quiet(() => writer(writerEnv(result), { client: aws.client, guardRoot: root, sources: SOURCES }));

// The function source run the way CloudFront runs it: top-level declarations, then handler(event).
function functionContext(code) {
  const context = vm.createContext({});
  vm.runInContext(String(code), context);
  return context;
}
const rewrite = (code, uri) => functionContext(code).handler({ request: { method: 'GET', uri, querystring: {}, headers: {}, cookies: {} } }).uri;

test('the function allowlist is exactly every MARKETING_PAGES path but "/" plus the retired paths, and the writer, the role and the sessions agree', () => {
  const allowlist = Object.keys(functionContext(CURRENT).MARKETING_PAGES);
  assert.deepEqual(allowlist, SERVED_PATHS);
  assert.ok(Object.values(functionContext(CURRENT).MARKETING_PAGES).every((value) => value === true));
  assert.deepEqual([...MARKETING_PATHS], SERVED_PATHS);
  assert.deepEqual([...MARKETING_KEYS], SERVED_PATHS.map(staticPageKey));
  assert.deepEqual([...OBJECT_KEYS], [...SERVED_PATHS.map(staticPageKey), staticPageKey('/')]);
  assert.ok(SERVED_PATHS.length >= 5);
  const objectArns = OBJECT_KEYS.map((key) => `arn:aws:s3:::${PRODUCTION_BUCKET}/${key}`);
  const role = JSON.parse(read('ops/deployment-guard/production-spa-fallback/permissions-policy.json'));
  assert.deepEqual(role.Statement.find((s) => [].concat(s.Action).includes('s3:GetObject')).Resource, objectArns);
  for (const step of ['Configure read-only production AWS session (inspect)', 'Configure production SPA fallback session (publish / revert)']) {
    const session = JSON.parse(WORKFLOW.split(step)[1].split('- name:')[0].split('inline-session-policy: >-')[1].trim());
    assert.deepEqual(session.Statement.find((s) => s.Action.includes('s3:GetObject')).Resource, objectArns, step);
  }
});

test('the repo function: marketing paths unchanged, everything else extensionless to /index.html, /prep and files untouched', () => {
  for (const uri of SERVED_PATHS) assert.equal(rewrite(CURRENT, uri), uri, uri);
  for (const [uri, want] of [
    ['/', '/index.html'],
    ['/login', '/index.html'],
    ['/pricing/', '/index.html'],
    ['/vs', '/index.html'],
    ['/vs/checksops-vs-something-else', '/index.html'],
    ['/PRICING', '/index.html'],
    ['/constructor', '/index.html'],
    ['/__proto__', '/index.html'],
    ['/checks/123', '/index.html'],
    ['/assets/x.js', '/assets/x.js'],
    ['/assets/index-x.js', '/assets/index-x.js'],
    ['/favicon.ico', '/favicon.ico'],
    ['/prep', '/prep'],
    ['/prep/health', '/prep/health'],
    ['/prep/branding/logo/abc', '/prep/branding/logo/abc'],
  ]) assert.equal(rewrite(CURRENT, uri), want, uri);
  assert.ok(CURRENT.length < 10240);
  assert.equal(CURRENT.includes(0x0d), false);
  // CloudFront Functions: no imports, no require, no module syntax.
  assert.equal(/\bimport\b|\brequire\(|\bexport\b/.test(CURRENT.toString('utf8')), false);
});

test('the baseline file is byte-for-byte the pre-tool function and still rewrites every extensionless path', () => {
  assert.equal(sha256(BASELINE), BASELINE_SHA256);
  assert.equal(SOURCES.baseline_sha256, BASELINE_SHA256);
  assert.equal(SOURCES.current_sha256, sha256(CURRENT));
  assert.notEqual(SOURCES.current_sha256, SOURCES.baseline_sha256);
  for (const uri of [...SERVED_PATHS, '/', '/login', '/pricing/']) assert.equal(rewrite(BASELINE, uri), '/index.html', uri);
  for (const uri of ['/assets/x.js', '/prep', '/prep/health']) assert.equal(rewrite(BASELINE, uri), uri, uri);
  // The writer's oracle agrees with both files on every sample URI, and catches a wrong one.
  assertSourceBehaves(CURRENT, 'current');
  assertSourceBehaves(BASELINE, 'baseline');
  assert.throws(() => assertSourceBehaves(BASELINE, 'current'), /function_source_behavior:current:\/pricing/);
  assert.throws(() => assertSourceBehaves(CURRENT, 'baseline'), /function_source_behavior:baseline/);
  for (const uri of SAMPLE_URIS) assert.equal(expectedUri('current', uri), rewrite(CURRENT, uri), uri);
  assert.deepEqual([...SAMPLE_URIS], [...SERVED_PATHS, '/', '/login', '/pricing/', '/assets/index-x.js', '/prep/health']);
});

test('the deployment type is registered, the scripts are in the bypass inventory, and the receipt is production/production-spa', () => {
  assert.ok(DEPLOYMENT_TYPES.includes(DEPLOYMENT_TYPE));
  assert.equal(DEPLOYMENT_TYPE, 'cloudfront-function');
  const rows = Object.fromEntries(JSON.parse(read('ops/deployment-guard/bypass-inventory.json')).scripts.map((row) => [row.path, row]));
  assert.equal(rows['scripts/deployment-guard/production-spa-fallback.mjs'].classification, 'GUARDED');
  assert.deepEqual(rows['scripts/deployment-guard/production-spa-fallback.mjs'].capabilities, ['cloudfront-function']);
  assert.equal(rows['scripts/deployment-guard/github-production-spa-fallback.mjs'].classification, 'SAFE');
  assert.equal(rows['scripts/deployment-guard/spa-fallback-public-probe.mjs'].classification, 'SAFE');
  // The Step 1 script that created the function stays refuse-direct.
  assert.equal(rows['aws/cloudfront/apply-step1.mjs'].classification, 'MUST_REFUSE_DIRECT');
  assert.equal(TARGET_ENVIRONMENT, 'production');
  assert.equal(TARGET_COMPONENT, 'production-spa');
  assert.deepEqual(OWNED_COMPONENTS, { publish: [`cloudfront-function:${FUNCTION_NAME}`], revert: [`cloudfront-function:${FUNCTION_NAME}`] });
  const constants = JSON.parse(read('aws/cloudfront/step1-constants.json'));
  assert.equal(constants.functionName, FUNCTION_NAME);
  assert.equal(constants.functionArn, FUNCTION_ARN);
  assert.equal(constants.functionRuntime, FUNCTION_RUNTIME);
  assert.equal(constants.distributionId, DISTRIBUTION_ID);
});

test('production only: staging ids, other functions, buckets and keys are refused before any AWS call', () => {
  assert.throws(() => assertProductionDistribution(STAGING_DISTRIBUTION_ID), /production_only:staging_distribution/);
  assert.throws(() => assertProductionDistribution('EOTHER'), /production_only:distribution/);
  assert.throws(() => assertProductionFunction('checksops-staging-spa-fallback'), /production_only:staging_function/);
  assert.throws(() => assertProductionFunction('other-function'), /production_only:function/);
  assert.throws(() => assertProductionObject(STAGING_BUCKET, 'pricing'), /production_only:staging_bucket/);
  assert.throws(() => assertProductionObject('other-bucket', 'pricing'), /production_only:bucket/);
  assert.throws(() => assertProductionObject(PRODUCTION_BUCKET, 'assets/index-x.js'), /production_only:key/);
  assert.throws(() => awsClient.getDistribution(STAGING_DISTRIBUTION_ID, {}), /production_only/);
  assert.throws(() => awsClient.describeFunction('other', 'LIVE', {}), /production_only/);
  assert.throws(() => awsClient.describeFunction(FUNCTION_NAME, 'STAGING', {}), /function_stage_invalid/);
  assert.throws(() => awsClient.getFunctionCode('other', 'LIVE', {}), /production_only/);
  assert.throws(() => awsClient.headObject(STAGING_BUCKET, 'pricing', {}), /production_only/);
  assert.throws(() => awsClient.updateFunction('other', 'E', {}, CURRENT, {}), /production_only/);
  assert.throws(() => awsClient.updateFunction(FUNCTION_NAME, '', {}, CURRENT, {}), /function_etag_missing/);
  assert.throws(() => awsClient.testFunction(FUNCTION_NAME, '', {}, {}), /function_etag_missing/);
  assert.throws(() => awsClient.publishFunction('other', 'E', {}), /production_only/);
  assert.throws(() => awsClient.publishFunction(FUNCTION_NAME, '', {}), /function_etag_missing/);
  // No distribution write, no function create or delete, no invalidation, no S3 write.
  const source = read('scripts/deployment-guard/production-spa-fallback.mjs');
  assert.equal(/update-distribution|create-function|delete-function|create-invalidation|put-object|associate-alias/.test(source), false);
  assert.deepEqual(Object.keys(awsClient).sort(), ['describeFunction', 'getDistribution', 'getFunctionCode', 'headObject', 'publishFunction', 'testFunction', 'updateFunction']);
});

test('classify: BASELINE, CURRENT, and BLOCKED on drift; which mode runs in each', async () => {
  assert.equal((await inspect(fakeAws())).state, 'BASELINE');
  assert.equal((await inspect(fakeAws({ live: CURRENT }))).state, 'CURRENT');
  // DEVELOPMENT may hold the other repository version (a run that stopped after update-function).
  assert.equal((await inspect(fakeAws({ live: BASELINE, development: CURRENT }))).state, 'BASELINE');
  const withoutKey = (key) => { const objects = Object.fromEntries(OBJECT_KEYS.map((k) => [k, pageHead(k)])); delete objects[key]; return objects; };
  const wrongType = (key) => ({ ...Object.fromEntries(OBJECT_KEYS.map((k) => [k, pageHead(k)])), [key]: { ...pageHead(key), ContentType: 'binary/octet-stream' } });
  const blocked = [
    [{ live: Buffer.from(`${BASELINE}\n// edited in the console\n`) }, 'live_code_unknown'],
    [{ live: Buffer.from(BASELINE.toString('utf8').replace(/\n/g, '\r\n')) }, 'live_code_unknown'],
    [{ development: Buffer.from('function handler(e) { return e.request; }') }, 'development_code_unknown'],
    [{ config: (() => { const c = baseConfig(); c.DefaultCacheBehavior.FunctionAssociations = { Quantity: 0 }; return c; })() }, 'default_association_drift'],
    [{ config: (() => { const c = baseConfig(); c.DefaultCacheBehavior.FunctionAssociations.Items[0].EventType = 'viewer-response'; return c; })() }, 'default_association_drift'],
    [{ config: (() => { const c = baseConfig(); c.DefaultCacheBehavior.FunctionAssociations.Items[0].FunctionARN = 'arn:aws:cloudfront::806168576068:function/other'; return c; })() }, 'default_association_drift'],
    [{ config: (() => { const c = baseConfig(); c.CacheBehaviors.Items[1].FunctionAssociations = association(); return c; })() }, 'function_on_behavior:/prep/*'],
    [{ config: (() => { const c = baseConfig(); c.CacheBehaviors = { Quantity: 1, Items: [c.CacheBehaviors.Items[0]] }; return c; })() }, 'prep_behavior_missing:/prep/*'],
    [{ config: { ...baseConfig(), WebACLId: '' } }, 'waf_drift'],
    [{ config: { ...baseConfig(), Aliases: { Quantity: 1, Items: ['staging.checksops.com'] } } }, 'aliases_drift'],
    [{ objects: withoutKey('pricing') }, 'object_missing:pricing'],
    [{ objects: withoutKey('vs/checksops-vs-snapsheet') }, 'object_missing:vs/checksops-vs-snapsheet'],
    [{ objects: wrongType('claim-check-tracking') }, 'object_content_type:claim-check-tracking'],
    [{ objects: withoutKey('index.html') }, 'object_missing:index.html'],
  ];
  for (const [setup, problem] of blocked) {
    const result = await inspect(fakeAws(setup));
    assert.equal(result.state, 'BLOCKED', problem);
    assert.ok(result.problems.includes(problem), `${problem}: ${result.problems.join(',')}`);
  }
  {
    const aws = fakeAws();
    aws.state.dist.Status = 'InProgress';
    assert.ok((await inspect(aws)).problems.includes('distribution_not_deployed'));
  }
  {
    const aws = fakeAws();
    aws.state.stages.LIVE.config.Runtime = 'cloudfront-js-1.0';
    assert.ok((await inspect(aws)).problems.includes('function_runtime_drift:live'));
  }
  {
    const aws = fakeAws();
    aws.state.stages.DEVELOPMENT.config.Comment = 'other';
    assert.ok((await inspect(aws)).problems.includes('function_comment_drift'));
  }
  {
    const aws = fakeAws();
    aws.state.stages.LIVE.config.KeyValueStoreAssociations = { Quantity: 1, Items: [{ KeyValueStoreARN: 'arn:kvs' }] };
    assert.ok((await inspect(aws)).problems.includes('function_key_value_store:live'));
  }
  const snapshot = fakeAws().readState({}).snapshot;
  snapshot.distribution.Id = STAGING_DISTRIBUTION_ID;
  assert.ok(classify(snapshot, SOURCES).problems.includes('staging_distribution'));
  // CURRENT with a missing page stays CURRENT so revert can run, and verify current fails.
  const missing = await inspect(fakeAws({ live: CURRENT, objects: withoutKey('pricing') }));
  assert.equal(missing.state, 'CURRENT');
  assert.deepEqual(missing.page_problems, ['object_missing:pricing']);
  const table = {
    publish: { BASELINE: 'publish', CURRENT: null, BLOCKED: null },
    revert: { BASELINE: null, CURRENT: 'revert', BLOCKED: null },
    apply: { BASELINE: null, CURRENT: null, BLOCKED: null },
    enforce: { BASELINE: null, CURRENT: null, BLOCKED: null },
  };
  for (const [mode, row] of Object.entries(table)) {
    for (const [state, action] of Object.entries(row)) assert.equal(actionFor(mode, state), action, `${mode} ${state}`);
  }
});

test('inspect makes no writes; the workflow\'s inspect session has no write, test, publish or KMS action', async () => {
  const aws = fakeAws();
  const result = await inspect(aws);
  assert.equal(result.state, 'BASELINE');
  assert.equal(result.mutation, false);
  assert.equal(result.function_name, FUNCTION_NAME);
  assert.equal(result.live_code_sha256, BASELINE_SHA256);
  assert.equal(result.current_code_sha256, sha256(CURRENT));
  assert.match(result.snapshot_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(aws.state.writes, []);
  const inspectPolicy = WORKFLOW.split('Configure read-only production AWS session (inspect)')[1].split('- name:')[0];
  assert.equal(/Update|Create|Delete|Publish|TestFunction|kms:|PutObject/.test(inspectPolicy), false);
});

test('publish: update DEVELOPMENT with If-Match and the repo bytes, test every sample URI, publish with the new ETag; the distribution is unchanged; the receipt is single use', async () => {
  const root = tmpRoot();
  const aws = fakeAws();
  const before = structuredClone(aws.state.dist);
  const result = await preflightChange('publish', root, aws);
  assert.equal(result.action, 'publish');
  const receipt = JSON.parse(fs.readFileSync(result.authorization.receiptFile, 'utf8'));
  assert.equal(receipt.deployment_type, DEPLOYMENT_TYPE);
  assert.equal(receipt.target_environment, 'production');
  assert.equal(receipt.target_component, 'production-spa');
  assert.deepEqual(receipt.owned_components, OWNED_COMPONENTS.publish);
  const input = JSON.parse(fs.readFileSync(result.authorization.fallbackInput, 'utf8'));
  assert.deepEqual(input.staging_acceptance, { ok: true, reference: STAGING_REFERENCE });
  assert.equal(input.approval.phrase, 'PUBLISH SPA FALLBACK TO PRODUCTION');
  assert.equal(runWriter(result, aws, root), 0);
  const ops = aws.state.writes.map((w) => w.op);
  assert.deepEqual(ops, ['updateFunction', ...SAMPLE_URIS.map(() => 'testFunction'), 'publishFunction']);
  assert.equal(aws.state.writes[0].etag, 'EDEV0');
  assert.equal(aws.state.writes[0].sha256, sha256(CURRENT));
  assert.deepEqual(aws.state.writes[0].config, { Comment: LIVE_COMMENT, Runtime: FUNCTION_RUNTIME });
  assert.deepEqual(aws.state.writes.filter((w) => w.op === 'testFunction').map((w) => w.uri), [...SAMPLE_URIS]);
  assert.ok(aws.state.writes.slice(1).every((w) => w.etag === 'EDEV1'));
  assert.equal(sha256(aws.state.stages.LIVE.code), sha256(CURRENT));
  assert.deepEqual(aws.state.dist, before);
  assert.equal((await verifyAs(aws, root, 'current')).state, 'VERIFIED');
  await assert.rejects(verifyAs(aws, root, 'baseline'), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  assert.equal((await inspect(aws)).state, 'CURRENT');
  const writes = aws.state.writes.length;
  assert.throws(() => runWriter(result, aws, root), /state_refused|guard_refused|receipt_consumption_failed/);
  assert.equal(aws.state.writes.length, writes);
  // Nothing to publish once current.
  await assert.rejects(preflightChange('publish', tmpRoot(), aws), (e) => e.code === CODES.UNRELATED_MUTATION);
});

test('revert puts the baseline bytes back the same way and leaves the distribution unchanged', async () => {
  const root = tmpRoot();
  const aws = fakeAws({ live: CURRENT });
  const before = structuredClone(aws.state.dist);
  const result = await preflightChange('revert', root, aws);
  assert.equal(result.action, 'revert');
  assert.equal(JSON.parse(fs.readFileSync(result.authorization.fallbackInput, 'utf8')).approval.phrase, 'REVERT SPA FALLBACK ON PRODUCTION');
  assert.equal(runWriter(result, aws, root), 0);
  assert.equal(aws.state.writes[0].sha256, BASELINE_SHA256);
  assert.equal(aws.state.writes.at(-1).op, 'publishFunction');
  assert.equal(sha256(aws.state.stages.LIVE.code), BASELINE_SHA256);
  assert.deepEqual(aws.state.dist, before);
  assert.equal((await verifyAs(aws, root, 'baseline')).state, 'VERIFIED');
  assert.equal((await inspect(aws)).state, 'BASELINE');
  await assert.rejects(preflightChange('revert', tmpRoot(), aws), (e) => e.code === CODES.UNRELATED_MUTATION);
});

test('revert still runs while a page object is missing (that is when it is needed); publish does not', async () => {
  const objects = Object.fromEntries(OBJECT_KEYS.map((k) => [k, pageHead(k)]));
  delete objects.pricing;
  const root = tmpRoot();
  const aws = fakeAws({ live: CURRENT, objects });
  await assert.rejects(verifyAs(aws, root, 'current'), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  const result = await preflightChange('revert', root, aws);
  assert.equal(runWriter(result, aws, root), 0);
  assert.equal(sha256(aws.state.stages.LIVE.code), BASELINE_SHA256);
  assert.equal((await verifyAs(aws, root, 'baseline')).state, 'VERIFIED');
  assert.equal((await inspect(aws)).state, 'BLOCKED');
  await assert.rejects(preflightChange('publish', tmpRoot(), aws), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  assert.equal(verifyState('other', { state: 'CURRENT', page_problems: [] }), false);
});

test('a test-function result that differs from the rules stops before publish; LIVE is untouched', async () => {
  for (const testOverride of [
    (uri) => (uri === '/vs/checksops-vs-snapsheet' ? '/index.html' : expectedUri('current', uri)),
    (uri) => (uri === '/login' ? '/login' : expectedUri('current', uri)),
    (uri) => (uri === '/prep/health' ? '/index.html' : expectedUri('current', uri)),
  ]) {
    const root = tmpRoot();
    const aws = fakeAws({ testOverride });
    const result = await preflightChange('publish', root, aws);
    assert.throws(() => runWriter(result, aws, root), /development_test_failed/);
    assert.equal(aws.state.writes.some((w) => w.op === 'publishFunction'), false);
    assert.equal(sha256(aws.state.stages.LIVE.code), BASELINE_SHA256);
    // DEVELOPMENT holds a repository version: the next inspect is not blocked by it.
    assert.equal((await inspect(aws)).state, 'BASELINE');
  }
  assert.throws(() => testFunctionUri({ TestResult: { FunctionErrorMessage: 'TypeError' } }), /development_test_error/);
  assert.throws(() => testFunctionUri({ TestResult: { FunctionOutput: 'not json' } }), /development_test_output_unreadable/);
  assert.equal(testFunctionUri({ TestResult: { FunctionOutput: '{"request":{"uri":"/pricing"}}' } }), '/pricing');
});

test('each change needs its exact phrase, a staging acceptance reference and the inspect snapshot', async () => {
  for (const [mode, approval] of [
    ['publish', 'publish spa fallback to production'],
    ['publish', 'PUBLISH SPA FALLBACK TO STAGING'],
    ['publish', APPROVAL_PHRASES.revert],
    ['revert', APPROVAL_PHRASES.publish],
    ['revert', 'REVERT SPA FALLBACK ON PRODUCTION '],
  ]) {
    const aws = fakeAws(mode === 'revert' ? { live: CURRENT } : {});
    await assert.rejects(preflightChange(mode, tmpRoot(), aws, { CHECKSOPS_PRODUCTION_SPA_FALLBACK_APPROVAL: approval }), (e) => e.code === CODES.PRODUCTION_APPROVAL_REQUIRED, approval);
    assert.deepEqual(aws.state.writes, []);
  }
  for (const reference of ['', 'run 42000000001', 'https://github.com/someone-else/ChecksOps/actions/runs/1', 'https://example.com/actions/runs/42000000001']) {
    await assert.rejects(preflightChange('publish', tmpRoot(), fakeAws(), { CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE: reference }), (e) => e.code === CODES.PRODUCTION_APPROVAL_REQUIRED, reference);
  }
  await assert.rejects(preflightChange('publish', tmpRoot(), fakeAws(), { CHECKSOPS_EXPECTED_SNAPSHOT_SHA256: '' }), (e) => e.code === CODES.INVALID_MANIFEST);
  await assert.rejects(preflightChange('publish', tmpRoot(), fakeAws(), { CHECKSOPS_EXPECTED_SNAPSHOT_SHA256: 'f'.repeat(64) }), (e) => e.code === CODES.DEPLOYMENT_COLLISION);
  assert.throws(() => validateChangeInputs({ mode: 'apply', approval: 'x', stagingAcceptance: STAGING_REFERENCE, expectedFingerprint: 'a'.repeat(64), liveFingerprint: 'a'.repeat(64) }), (e) => e.code === CODES.PRODUCTION_APPROVAL_REQUIRED);
  await assert.rejects(preflight({ ...ENV, CHECKSOPS_PRODUCTION_SPA_FALLBACK_MODE: 'enforce' }, { root: tmpRoot(), sources: SOURCES, readState: fakeAws().readState }), (e) => e.code === CODES.INVALID_MANIFEST);
  // Only from main, with a full workflow identity.
  assert.throws(() => workflowIdentity({ ...ENV, GITHUB_REF_NAME: 'claude/spa-fallback' }), (e) => e.code === CODES.UNRELATED_MUTATION);
  assert.throws(() => workflowIdentity({ ...ENV, GITHUB_SHA: 'abc' }), (e) => e.code === CODES.ANONYMOUS_DEPLOYMENT);
});

test('drift refuses: any move between the receipt and the first write, and a distribution move after the write', async () => {
  const cases = [
    (state) => { state.stages.LIVE.etag = 'ELIVE-other'; },
    (state) => { state.stages.DEVELOPMENT.code = Buffer.from(CURRENT); state.stages.DEVELOPMENT.etag = 'EDEV-other'; },
    (state) => { state.dist.config.DefaultRootObject = 'other.html'; },
    (state) => { state.objects.pricing = { ...state.objects.pricing, ETag: '"new-upload"' }; },
  ];
  for (const move of cases) {
    const root = tmpRoot();
    const aws = fakeAws();
    const result = await preflightChange('publish', root, aws);
    move(aws.state);
    assert.throws(() => runWriter(result, aws, root), /state_refused|guard_refused|toctou_drift/);
    assert.deepEqual(aws.state.writes, []);
  }
  {
    const root = tmpRoot();
    const aws = fakeAws({ mutate: (state) => { state.dist.config.CacheBehaviors.Items[0].TargetOriginId = 'Elsewhere'; } });
    const result = await preflightChange('publish', root, aws);
    assert.throws(() => runWriter(result, aws, root), /post_write_distribution_drift/);
  }
  {
    const root = tmpRoot();
    const aws = fakeAws({ mutate: (state) => { state.stages.LIVE.code = Buffer.from(BASELINE); } });
    const result = await preflightChange('publish', root, aws);
    assert.throws(() => runWriter(result, aws, root), /function_post_verify_failed/);
  }
  {
    const root = tmpRoot();
    const aws = fakeAws({ mutate: (state) => { state.stages.LIVE.config = { ...state.stages.LIVE.config, Comment: 'changed' }; } });
    const result = await preflightChange('publish', root, aws);
    assert.throws(() => runWriter(result, aws, root), /function_config_post_verify_failed/);
  }
  assert.throws(() => assertDistributionUnchanged(baseConfig(), { ...baseConfig(), Enabled: false }), /post_write_distribution_drift/);
});

test('the writer refuses plan-only runs, caller-supplied code or config, a receipt for another action, and no receipt', async () => {
  const aws = fakeAws();
  assert.equal(quiet(() => writer({}, { client: aws.client, sources: SOURCES })), 2);
  const root = tmpRoot();
  const result = await preflightChange('publish', root, aws);
  const base = JSON.parse(fs.readFileSync(result.authorization.fallbackInput, 'utf8'));
  for (const extra of [{ code: 'function handler(e){return e.request}' }, { function_code: 'x' }, { function_name: 'other' }, { function_config: {} }, { runtime: 'cloudfront-js-1.0' }, { distribution_id: STAGING_DISTRIBUTION_ID }, { keys: ['other'] }]) {
    const file = path.join(root, `input-${Object.keys(extra)[0]}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...base, ...extra }));
    assert.throws(() => quiet(() => writer({ ...writerEnv(result), CHECKSOPS_PRODUCTION_SPA_FALLBACK_INPUT: file }, { client: aws.client, guardRoot: root, sources: SOURCES })), /caller_supplied_config_forbidden/);
  }
  const wrongMode = path.join(root, 'input-mode.json');
  fs.writeFileSync(wrongMode, JSON.stringify({ ...base, mode: 'revert', action: 'revert' }));
  assert.throws(() => quiet(() => writer({ ...writerEnv(result), CHECKSOPS_PRODUCTION_SPA_FALLBACK_INPUT: wrongMode }, { client: aws.client, guardRoot: root, sources: SOURCES })), /state_refused/);
  const badMode = path.join(root, 'input-badmode.json');
  fs.writeFileSync(badMode, JSON.stringify({ ...base, mode: 'enforce' }));
  assert.throws(() => quiet(() => writer({ ...writerEnv(result), CHECKSOPS_PRODUCTION_SPA_FALLBACK_INPUT: badMode }, { client: aws.client, guardRoot: root, sources: SOURCES })), /mode_invalid/);
  const input = path.join(root, 'input-noreceipt.json');
  fs.writeFileSync(input, JSON.stringify({ ...base, receipt_path: path.join(root, 'missing.json') }));
  assert.throws(() => quiet(() => writer({ ...writerEnv(result), CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT: path.join(root, 'missing.json'), CHECKSOPS_PRODUCTION_SPA_FALLBACK_INPUT: input }, { client: aws.client, guardRoot: tmpRoot(), sources: SOURCES })), /guard_refused/);
  assert.deepEqual(aws.state.writes, []);
});

test('the sources refuse identical, oversized, CRLF or misbehaving code', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checksops-spa-fallback-src-'));
  fs.mkdirSync(path.join(root, 'aws/cloudfront'), { recursive: true });
  const put = (current, baseline) => {
    fs.writeFileSync(path.join(root, CURRENT_SOURCE), current);
    fs.writeFileSync(path.join(root, BASELINE_SOURCE), baseline);
  };
  put(BASELINE, BASELINE);
  assert.throws(() => loadFunctionSources(root), /function_sources_identical/);
  put(CURRENT.toString('utf8').replace(/\n/g, '\r\n'), BASELINE);
  assert.throws(() => loadFunctionSources(root), /function_source_crlf:current/);
  put(`${CURRENT}${'/'.repeat(10240)}`, BASELINE);
  assert.throws(() => loadFunctionSources(root), /function_source_size:current/);
  put(CURRENT.toString('utf8').replace('"/claim-check-tracking": true', '"/claim-check-tracking": false'), BASELINE);
  assert.throws(() => loadFunctionSources(root), /function_source_behavior:current:\/claim-check-tracking/);
  put(CURRENT, BASELINE);
  assert.equal(loadFunctionSources(root).current_sha256, sha256(CURRENT));
});

test('the workflow: main only, production environment, approved commit, exact phrases, staging reference, SPA concurrency, dedicated role, public probes', () => {
  assert.match(WORKFLOW, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(WORKFLOW, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
  assert.match(WORKFLOW, /test "\$INPUT_APPROVED_COMMIT" = "\$GITHUB_SHA"/);
  assert.match(WORKFLOW, /environment: production\n/);
  assert.match(WORKFLOW, /publish\) PHRASE="PUBLISH SPA FALLBACK TO PRODUCTION" ;;/);
  assert.match(WORKFLOW, /revert\) PHRASE="REVERT SPA FALLBACK ON PRODUCTION" ;;/);
  assert.match(WORKFLOW, /test "\$INPUT_APPROVAL_PHRASE" = "\$PHRASE"/);
  assert.match(WORKFLOW, /\[\[ "\$INPUT_STAGING_ACCEPTANCE" =~ \^https:\/\/github\\\.com\/michaelcarletta-cmd\/ChecksOps\//);
  assert.match(WORKFLOW, /group: guarded-production-spa-upload\n\s+cancel-in-progress: false/);
  assert.match(WORKFLOW, /vars\.CHECKSOPS_PRODUCTION_SPA_FALLBACK_ROLE_ARN/);
  assert.match(WORKFLOW, /test "\$PRODUCTION_SPA_FALLBACK_ROLE_ARN" = "arn:aws:iam::806168576068:role\/ChecksOpsGitHubProductionSpaFallback"/);
  assert.match(WORKFLOW, /arn:aws:sts::806168576068:assumed-role\/ChecksOpsGitHubProductionSpaFallback\/checksops-production-spa-fallback-\$GITHUB_RUN_ID/);
  assert.match(WORKFLOW, /inputs\.mode == 'publish' && 'current' \|\| 'baseline'/);
  assert.match(WORKFLOW, /inputs\.mode == 'publish' && 'own' \|\| 'home'/);
  assert.match(WORKFLOW, /spa-fallback-public-probe\.mjs --origin https:\/\/staging\.checksops\.com --expect own/);
  assert.match(WORKFLOW, /spa-fallback-public-probe\.mjs --origin https:\/\/checksops\.com --expect "\$PROBE_EXPECT" --attempts 20 --delay 30/);
  assert.match(WORKFLOW, /node --experimental-strip-types --test aws\/tests\/github-production-spa-fallback\.test\.mjs/);
  // Inputs reach shell only through env.
  const gate = WORKFLOW.split('- name: Refuse non-main or incomplete change')[1].split('- name:')[0];
  assert.equal(/run:[\s\S]*\$\{\{ inputs\./.test(gate), false);
  // Never the staging distribution, never a distribution write, never a function create or delete.
  assert.equal(/E1CG52WRQZI7X1|checksops-staging-frontend|update-distribution|UpdateDistribution|CreateFunction|DeleteFunction|create-invalidation/.test(WORKFLOW), false);
  const change = WORKFLOW.split('Configure production SPA fallback session (publish / revert)')[1].split('- name:')[0];
  const session = JSON.parse(change.split('inline-session-policy: >-')[1].trim());
  const functionStatements = session.Statement.filter((s) => s.Action.some((a) => a.endsWith('Function')));
  assert.deepEqual(functionStatements.map((s) => s.Resource), [FUNCTION_ARN]);
  assert.deepEqual(functionStatements[0].Action, ['cloudfront:DescribeFunction', 'cloudfront:GetFunction', 'cloudfront:UpdateFunction', 'cloudfront:TestFunction', 'cloudfront:PublishFunction']);
});

test('the IAM source: trust pinned to this workflow on main in production; permissions only the one function, the distribution read, the page objects and the guard key', () => {
  const dir = 'ops/deployment-guard/production-spa-fallback';
  const trust = JSON.parse(read(`${dir}/trust-policy.json`));
  const csp = JSON.parse(read('ops/deployment-guard/production-csp-headers/trust-policy.json'));
  assert.equal(trust.Statement.length, 1);
  const [statement] = trust.Statement;
  assert.equal(statement.Effect, 'Allow');
  assert.equal(statement.Action, 'sts:AssumeRoleWithWebIdentity');
  assert.deepEqual(statement.Principal, csp.Statement[0].Principal);
  // The CSP role's conditions, with only the workflow file changed.
  assert.deepEqual(statement.Condition, {
    StringEquals: {
      ...csp.Statement[0].Condition.StringEquals,
      'token.actions.githubusercontent.com:job_workflow_ref': 'michaelcarletta-cmd/ChecksOps/.github/workflows/guarded-production-spa-fallback.yml@refs/heads/main',
    },
  });
  assert.equal(statement.Condition.StringEquals['token.actions.githubusercontent.com:ref'], 'refs/heads/main');
  assert.equal(statement.Condition.StringEquals['token.actions.githubusercontent.com:environment'], 'production');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, '.github/workflows/guarded-production-spa-fallback.yml')));

  const policy = JSON.parse(read(`${dir}/permissions-policy.json`));
  const allows = policy.Statement.filter((s) => s.Effect === 'Allow');
  const granted = Object.fromEntries(allows.flatMap((s) => [].concat(s.Action).map((a) => [a, s.Resource])));
  assert.deepEqual(Object.keys(granted).sort(), [
    'cloudfront:DescribeFunction', 'cloudfront:GetDistribution', 'cloudfront:GetFunction', 'cloudfront:PublishFunction',
    'cloudfront:TestFunction', 'cloudfront:UpdateFunction', 'kms:GetPublicKey', 'kms:Sign', 's3:GetObject',
  ]);
  assert.equal(granted['cloudfront:GetDistribution'], `arn:aws:cloudfront::806168576068:distribution/${DISTRIBUTION_ID}`);
  for (const action of ['DescribeFunction', 'GetFunction', 'UpdateFunction', 'TestFunction', 'PublishFunction']) assert.equal(granted[`cloudfront:${action}`], FUNCTION_ARN, action);
  for (const s of allows.filter((row) => [].concat(row.Action).some((a) => a.startsWith('kms:')))) {
    assert.equal(s.Condition['ForAnyValue:StringEquals']['kms:ResourceAliases'], 'alias/checksops-production-deployment-guard');
  }
  const denied = policy.Statement.filter((s) => s.Effect === 'Deny').flatMap((s) => [].concat(s.Action));
  for (const action of ['cloudfront:CreateFunction', 'cloudfront:DeleteFunction', 'cloudfront:UpdateDistribution', 'cloudfront:CreateInvalidation', 's3:PutObject', 's3:DeleteObject', 'iam:*']) assert.ok(denied.includes(action), action);
  const stagingDeny = policy.Statement.find((s) => s.Sid === 'NeverTouchStaging');
  assert.deepEqual(stagingDeny.Resource, [`arn:aws:cloudfront::806168576068:distribution/${STAGING_DISTRIBUTION_ID}`, `arn:aws:s3:::${STAGING_BUCKET}`, `arn:aws:s3:::${STAGING_BUCKET}/*`]);
  for (const action of Object.keys(granted)) assert.equal(/^(iam|sts|organizations):|^\*$|s3:Put|s3:Delete|s3:List|cloudfront:\*/.test(action), false, action);
  const readme = read(`${dir}/README.md`);
  assert.match(readme, /CHECKSOPS_PRODUCTION_SPA_FALLBACK_ROLE_ARN/);
  assert.match(readme, /aws iam create-role --role-name ChecksOpsGitHubProductionSpaFallback/);
});

test('the public probe: own og:title per marketing page, home og:title for / and /login, the entry bundle, /prep/health', async () => {
  const own = pageExpectations('own');
  assert.deepEqual(own.map((row) => row.path), [...PAGE_PATHS, '/', '/login']);
  assert.deepEqual(own.slice(0, PAGE_PATHS.length).map((row) => row.title), MARKETING_PAGES.filter((p) => p.path !== '/').map((p) => p.title));
  assert.ok(pageExpectations('home').every((row) => row.title === HOME_PAGE.title));
  assert.deepEqual(pageExpectations('own', { spaRoutes: false }).map((row) => row.path), PAGE_PATHS);
  assert.throws(() => pageExpectations('other'), /expect_invalid/);
  assert.equal(ogTitleTag('A & B "C"'), '<meta property="og:title" content="A &amp; B &quot;C&quot;">');
  assert.deepEqual(checkPage({ status: 200, contentType: 'text/html; charset=utf-8', body: ogTitleTag('T') }, 'T'), []);
  assert.equal(checkPage({ status: 404, contentType: 'application/xml', body: '' }, 'T').length, 3);
  assert.equal(entryBundlePath('<script type="module" crossorigin src="/assets/index-AbC123.js"></script>'), '/assets/index-AbC123.js');
  assert.equal(entryBundlePath('<script type="module" src="/src/main.tsx"></script>'), null);

  const pageFor = (title) => `<html><head>${ogTitleTag(title)}<script type="module" crossorigin src="/assets/index-AbC123.js"></script></head></html>`;
  const site = (mode) => async (url) => {
    const { pathname } = new URL(url);
    if (pathname === '/assets/index-AbC123.js') return { status: 200, contentType: 'application/javascript', body: '' };
    if (pathname === '/prep/health') return { status: 200, contentType: 'application/json', body: '{"status":"ok"}' };
    const page = MARKETING_PAGES.find((p) => p.path === pathname && p.path !== '/');
    return { status: 200, contentType: 'text/html; charset=utf-8', body: pageFor(page && mode === 'published' ? page.title : HOME_PAGE.title) };
  };
  const urls = [];
  const recording = (fetcher) => async (url) => { urls.push(url); return fetcher(url); };
  assert.equal((await probeOnce({ origin: 'https://checksops.com', expect: 'own', tag: 't', fetcher: recording(site('published')) })).ok, true);
  // Exact URLs the probe fetched (element equality, not a substring check).
  const fetched = (want) => urls.some((url) => url === want);
  assert.ok(fetched('https://checksops.com/prep/health'));
  assert.ok(fetched('https://checksops.com/assets/index-AbC123.js'));
  assert.ok(fetched('https://checksops.com/login?probe=t'));
  assert.equal((await probeOnce({ origin: 'https://checksops.com', expect: 'home', tag: 't', fetcher: site('baseline') })).ok, true);
  const notYet = await probeOnce({ origin: 'https://checksops.com', expect: 'own', tag: 't', fetcher: site('baseline') });
  assert.equal(notYet.ok, false);
  assert.equal(notYet.problems.length, PAGE_PATHS.length);
  // Staging: marketing pages only (no /login, no /prep/health on the staging host).
  urls.length = 0;
  assert.equal((await probeOnce({ origin: 'https://staging.checksops.com', expect: 'own', tag: 't', fetcher: recording(site('published')) })).ok, true);
  assert.deepEqual(urls, PAGE_PATHS.map((p) => `https://staging.checksops.com${p}?probe=t`));
  // Retries until the edges serve the new function, then succeeds.
  let calls = 0;
  const flipping = async (url) => { calls += 1; return site(calls > PAGE_PATHS.length + 4 ? 'published' : 'baseline')(url); };
  const code = await quietAsync(() => probeMain(['--origin', 'https://checksops.com', '--expect', 'own', '--attempts', '3', '--delay', '0', '--tag', 'run-1'], { fetcher: flipping, sleep: async () => {} }));
  assert.equal(code, 0);
  assert.equal(await quietAsync(() => probeMain(['--origin', 'https://checksops.com', '--expect', 'own', '--attempts', '2', '--delay', '0'], { fetcher: site('baseline'), sleep: async () => {} })), 2);
  assert.throws(() => parseArgs(['--origin', 'https://example.com', '--expect', 'own']), /origin_invalid/);
  assert.throws(() => parseArgs(['--origin', 'https://checksops.com', '--expect', 'own', '--tag', 'a;b']), /tag_invalid/);
});

async function quietAsync(fn) {
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try { return await fn(); } finally { process.stdout.write = out; process.stderr.write = err; }
}

test('the runbook records the phrases, the baseline hash and what was not done', () => {
  const runbook = read('ops/deployment-guard/PRODUCTION_SPA_FALLBACK.md');
  assert.match(runbook, /PUBLISH SPA FALLBACK TO PRODUCTION/);
  assert.match(runbook, /REVERT SPA FALLBACK ON PRODUCTION/);
  assert.ok(runbook.includes(BASELINE_SHA256));
  assert.match(runbook, /ChecksOpsGitHubProductionCspHeaders/);
  assert.match(runbook, /Nothing has been run against production/);
});
