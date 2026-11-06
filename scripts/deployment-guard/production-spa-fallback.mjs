#!/usr/bin/env node
/**
 * Receipt-gated writer for the production CloudFront Function checksops-production-spa-fallback
 * (viewer-request on the default behavior of distribution E1B0ZWWO5559U5, checksops.com; runbook
 * ops/deployment-guard/PRODUCTION_SPA_FALLBACK.md). The function rewrites extensionless URIs to
 * /index.html; the repo version (aws/cloudfront/spa-fallback.js) passes the public marketing
 * pages through unchanged, so CloudFront serves the extensionless S3 object of the same name that
 * the production SPA upload writes (src/pages/marketing/marketingStaticHead.ts staticPageKey).
 *
 * Exact permitted mutations, all on that one function, never the distribution:
 *   publish: BASELINE -> CURRENT. update-function (DEVELOPMENT stage, If-Match, the LIVE runtime and
 *            comment, code = aws/cloudfront/spa-fallback.js bytes), test-function on DEVELOPMENT for
 *            every sample URI, then publish-function (If-Match the new ETag).
 *   revert:  CURRENT -> BASELINE, the same three calls with aws/cloudfront/spa-fallback.baseline.js
 *            (byte-for-byte the code that was LIVE before this tool).
 * The caller never supplies code: it comes only from those two repository files.
 *
 * The function (both stages), the distribution and the marketing S3 objects are pinned through the
 * receipt: the signed preflight fingerprint is the whole snapshot, the writer re-reads it before
 * and immediately before the first write, and afterwards the distribution config must be
 * byte-for-byte what it was. Staging (E1CG52WRQZI7X1, which has no function and maps 403/404 to
 * /index.html, and its bucket) is refused at every read and write.
 *
 * Run only from guarded-production-spa-fallback.yml after github-production-spa-fallback.mjs
 * issued the receipt.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { refuseUnguardedDeploy, resolveGuardRoot } from './require-guard.mjs';
import { consumeReceiptOnce } from './lib/consumed-receipts.mjs';
import { evaluateProductionGate } from './lib/production.mjs';

const AWS = process.env.AWS_CLI || process.env.AWS || 'aws';
const REGION = process.env.AWS_REGION || 'us-east-1';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DISTRIBUTION_ID = 'E1B0ZWWO5559U5';
export const PRODUCTION_ALIAS = 'checksops.com';
export const PRODUCTION_BUCKET = 'checksops-production-frontend-806168576068';
// SH1_ACCEPTED_PRODUCTION_BASELINE.md: the WAF on the production distribution.
export const PRODUCTION_WEB_ACL_ID = 'arn:aws:wafv2:us-east-1:806168576068:global/webacl/checksops-production-cloudfront-waf/cc8aadde-2bab-4d5e-8144-7d8981f44ad7';
// aws/cloudfront/step1-constants.json (how the function was created and associated).
export const FUNCTION_NAME = 'checksops-production-spa-fallback';
export const FUNCTION_ARN = 'arn:aws:cloudfront::806168576068:function/checksops-production-spa-fallback';
export const FUNCTION_RUNTIME = 'cloudfront-js-2.0';
export const FUNCTION_EVENT_TYPE = 'viewer-request';
export const PREP_BEHAVIORS = Object.freeze(['/prep', '/prep/*']);
export const STAGING_DISTRIBUTION_ID = 'E1CG52WRQZI7X1';
export const STAGING_BUCKET = 'checksops-staging-frontend-c48b';
export const CURRENT_SOURCE = 'aws/cloudfront/spa-fallback.js';
export const BASELINE_SOURCE = 'aws/cloudfront/spa-fallback.baseline.js';
// CloudFront Functions: at most 10 KB of code.
export const MAX_FUNCTION_BYTES = 10240;

// Every MARKETING_PAGES path but "/" (src/pages/marketing/marketingPages.ts). The S3 key is the
// path without its leading slash (staticPageKey). aws/tests/github-production-spa-fallback.test.mjs
// keeps this list, the function's allowlist and MARKETING_PAGES equal.
export const MARKETING_PATHS = Object.freeze([
  '/pricing',
  '/vs/checksops-vs-iink-payments',
  '/vs/checksops-vs-snapsheet',
  '/vs/checksops-vs-guidewire-claimcenter',
  '/claim-check-tracking',
]);
export const MARKETING_KEYS = Object.freeze(MARKETING_PATHS.map((p) => p.slice(1)));
export const INDEX_KEY = 'index.html';
export const OBJECT_KEYS = Object.freeze([...MARKETING_KEYS, INDEX_KEY]);
export const PAGE_CONTENT_TYPE = 'text/html; charset=utf-8';
// The URIs test-function runs on DEVELOPMENT before every publish.
export const SAMPLE_URIS = Object.freeze([...MARKETING_PATHS, '/', '/login', '/pricing/', '/assets/index-x.js', '/prep/health']);

export const DEPLOYMENT_TYPE = 'cloudfront-function';
export const TARGET_ENVIRONMENT = 'production';
// The same lease component as the production SPA upload: both change what checksops.com serves,
// and the pages this function passes through are the objects that upload writes.
export const TARGET_COMPONENT = 'production-spa';
export const OWNED_FUNCTION = `cloudfront-function:${FUNCTION_NAME}`;
export const OWNED_COMPONENTS = Object.freeze({ publish: [OWNED_FUNCTION], revert: [OWNED_FUNCTION] });

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hashJson = (value) => sha256(JSON.stringify(value));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

export function assertProductionDistribution(id) {
  if (id === STAGING_DISTRIBUTION_ID) throw new Error('production_only:staging_distribution');
  if (id !== DISTRIBUTION_ID) throw new Error(`production_only:distribution:${id}`);
}

export function assertProductionFunction(name) {
  if (/staging/i.test(String(name))) throw new Error('production_only:staging_function');
  if (name !== FUNCTION_NAME) throw new Error(`production_only:function:${name}`);
}

export function assertProductionObject(bucket, key) {
  if (bucket === STAGING_BUCKET) throw new Error('production_only:staging_bucket');
  if (bucket !== PRODUCTION_BUCKET) throw new Error(`production_only:bucket:${bucket}`);
  if (!OBJECT_KEYS.includes(key)) throw new Error(`production_only:key:${key}`);
}

/**
 * What a version of the function must do to a URI. An oracle written from the rules, not from the
 * code: the local source and the DEVELOPMENT stage are both checked against it before a publish.
 */
export function expectedUri(version, uri) {
  if (!['baseline', 'current'].includes(version)) throw new Error(`version_invalid:${version}`);
  if (uri === '/prep' || uri.startsWith('/prep/')) return uri;
  if (version === 'current' && MARKETING_PATHS.includes(uri)) return uri;
  const last = uri.slice(uri.lastIndexOf('/') + 1);
  if (last.includes('.')) return uri;
  return '/index.html';
}

export function viewerRequestEvent(uri) {
  return {
    version: '1.0',
    context: { eventType: FUNCTION_EVENT_TYPE },
    viewer: { ip: '198.51.100.10' },
    request: { method: 'GET', uri, querystring: {}, headers: { host: { value: PRODUCTION_ALIAS } }, cookies: {} },
  };
}

/** Runs CloudFront Function source locally (node:vm) on one viewer-request URI. */
export function runFunctionSource(code, uri) {
  const context = vm.createContext({});
  vm.runInContext(String(code), context, { timeout: 1000 });
  if (typeof context.handler !== 'function') throw new Error('function_source_has_no_handler');
  const result = context.handler(structuredClone(viewerRequestEvent(uri)));
  return result?.uri;
}

export function assertSourceBehaves(code, version) {
  for (const uri of SAMPLE_URIS) {
    const got = runFunctionSource(code, uri);
    if (got !== expectedUri(version, uri)) throw new Error(`function_source_behavior:${version}:${uri}:${got}`);
  }
}

/** The two versions this tool may write, from repository bytes only. */
export function loadFunctionSources(root = repoRoot) {
  const current = fs.readFileSync(path.join(root, CURRENT_SOURCE));
  const baseline = fs.readFileSync(path.join(root, BASELINE_SOURCE));
  for (const [name, code] of [['current', current], ['baseline', baseline]]) {
    if (code.length === 0 || code.length > MAX_FUNCTION_BYTES) throw new Error(`function_source_size:${name}:${code.length}`);
    if (code.includes(0x0d)) throw new Error(`function_source_crlf:${name}`);
  }
  if (current.equals(baseline)) throw new Error('function_sources_identical');
  assertSourceBehaves(current, 'current');
  assertSourceBehaves(baseline, 'baseline');
  return { current, baseline, current_sha256: sha256(current), baseline_sha256: sha256(baseline) };
}

const functionAssociations = (behavior) => (behavior?.FunctionAssociations?.Items || [])
  .map((row) => ({ EventType: row.EventType, FunctionARN: row.FunctionARN }));

function normalizeFunctionStage(described, code, getEtag) {
  if (!described) return null;
  const summary = described.FunctionSummary || {};
  const config = summary.FunctionConfig || {};
  return {
    name: summary.Name || null,
    status: summary.Status || null,
    stage: summary.FunctionMetadata?.Stage || null,
    arn: summary.FunctionMetadata?.FunctionARN || null,
    runtime: config.Runtime || null,
    comment: config.Comment || '',
    key_value_stores: (config.KeyValueStoreAssociations?.Items || []).map((row) => row.KeyValueStoreARN),
    etag: described.ETag || null,
    code_etag: getEtag || null,
    code_sha256: code ? sha256(code) : null,
    code_bytes: code ? code.length : 0,
  };
}

const normalizeObject = (key, head) => (head ? {
  key,
  exists: true,
  ContentType: head.ContentType || null,
  CacheControl: head.CacheControl || null,
  ContentLength: head.ContentLength ?? null,
  ETag: head.ETag || null,
} : { key, exists: false });

export function normalizeSnapshot({ distribution, live, development, objects }) {
  const dist = distribution.Distribution || {};
  const config = dist.DistributionConfig || {};
  return {
    function: {
      live: normalizeFunctionStage(live?.described, live?.code, live?.etag),
      development: normalizeFunctionStage(development?.described, development?.code, development?.etag),
    },
    distribution: {
      Id: dist.Id,
      Status: dist.Status,
      ETag: distribution.ETag,
      Aliases: config.Aliases?.Items || [],
      WebACLId: config.WebACLId || null,
      Functions: [
        { PathPattern: 'Default', Functions: functionAssociations(config.DefaultCacheBehavior) },
        ...(config.CacheBehaviors?.Items || []).map((row) => ({ PathPattern: row.PathPattern, Functions: functionAssociations(row) })),
      ],
      config_sha256: hashJson(config),
    },
    objects: OBJECT_KEYS.map((key) => normalizeObject(key, objects[key])),
  };
}

export const snapshotFingerprint = (snapshot) => hashJson(snapshot);

/**
 * BASELINE: LIVE runs exactly aws/cloudfront/spa-fallback.baseline.js; publish may run.
 * CURRENT:  LIVE runs exactly aws/cloudfront/spa-fallback.js; revert may run.
 * BLOCKED:  anything else (staging ids, LIVE code this tool did not write, foreign code on
 *   DEVELOPMENT, runtime or comment drift, a key value store, the function not the default
 *   behavior's only viewer-request function or on any other behavior, WAF or alias drift, the
 *   distribution not Deployed), and BASELINE while a marketing object is missing or not
 *   text/html: passing a path through to a missing key would serve an S3 error.
 * pageProblems are reported in every state; while CURRENT they leave revert available (that is
 * when it is needed) and make verify fail.
 */
export function classify(snapshot, sources) {
  const problems = [];
  const pageProblems = [];
  const d = snapshot.distribution;
  if (d.Id !== DISTRIBUTION_ID) problems.push(d.Id === STAGING_DISTRIBUTION_ID ? 'staging_distribution' : 'distribution_not_production');
  // Exact element match on the alias list (not a URL substring check).
  if (!d.Aliases.some((alias) => alias === PRODUCTION_ALIAS)) problems.push('aliases_drift');
  if (d.WebACLId !== PRODUCTION_WEB_ACL_ID) problems.push('waf_drift');
  if (d.Status !== 'Deployed') problems.push('distribution_not_deployed');
  if (!d.ETag) problems.push('distribution_etag_missing');
  const byPattern = Object.fromEntries(d.Functions.map((row) => [row.PathPattern, row.Functions]));
  if (!eq(byPattern.Default, [{ EventType: FUNCTION_EVENT_TYPE, FunctionARN: FUNCTION_ARN }])) problems.push('default_association_drift');
  for (const behavior of PREP_BEHAVIORS) if (!Object.hasOwn(byPattern, behavior)) problems.push(`prep_behavior_missing:${behavior}`);
  for (const row of d.Functions) {
    if (row.PathPattern !== 'Default' && row.Functions.length) problems.push(`function_on_behavior:${row.PathPattern}`);
  }

  const { live, development } = snapshot.function;
  for (const [stage, row] of [['live', live], ['development', development]]) {
    if (!row) { problems.push(`function_missing:${stage}`); continue; }
    if (row.name !== FUNCTION_NAME) problems.push(`function_name_drift:${stage}`);
    if (row.arn !== FUNCTION_ARN) problems.push(`function_arn_drift:${stage}`);
    if (row.runtime !== FUNCTION_RUNTIME) problems.push(`function_runtime_drift:${stage}`);
    if (row.key_value_stores.length) problems.push(`function_key_value_store:${stage}`);
    if (!row.etag) problems.push(`function_etag_missing:${stage}`);
    if (row.code_etag && row.etag && row.code_etag !== row.etag) problems.push(`function_etag_moved:${stage}`);
  }
  if (live && development && live.comment !== development.comment) problems.push('function_comment_drift');
  let liveVersion = 'UNKNOWN';
  if (live?.code_sha256 === sources.baseline_sha256) liveVersion = 'BASELINE';
  else if (live?.code_sha256 === sources.current_sha256) liveVersion = 'CURRENT';
  else problems.push('live_code_unknown');
  // DEVELOPMENT may hold either repository version (a run that stopped after update-function);
  // any other code means someone else is working on the function.
  if (development && ![sources.baseline_sha256, sources.current_sha256].includes(development.code_sha256)) problems.push('development_code_unknown');

  for (const row of snapshot.objects) {
    if (!row.exists) { pageProblems.push(`object_missing:${row.key}`); continue; }
    if (!row.ContentLength) pageProblems.push(`object_empty:${row.key}`);
    if (row.key === INDEX_KEY) {
      if (!String(row.ContentType || '').startsWith('text/html')) pageProblems.push(`object_content_type:${row.key}`);
    } else if (row.ContentType !== PAGE_CONTENT_TYPE) pageProblems.push(`object_content_type:${row.key}`);
  }

  let state;
  if (problems.length) state = 'BLOCKED';
  else if (liveVersion === 'BASELINE') state = pageProblems.length ? 'BLOCKED' : 'BASELINE';
  else state = 'CURRENT';
  return {
    state,
    live_version: liveVersion,
    problems: [...problems, ...pageProblems],
    drift_problems: problems,
    page_problems: pageProblems,
    fingerprint: snapshotFingerprint(snapshot),
  };
}

/** What a mode does in a state; null means the mode refuses. */
export function actionFor(mode, state) {
  if (mode === 'publish') return state === 'BASELINE' ? 'publish' : null;
  if (mode === 'revert') return state === 'CURRENT' ? 'revert' : null;
  return null;
}

export function assertDistributionUnchanged(before, after) {
  if (!eq(sortKeys(after), sortKeys(before))) throw new Error('post_write_distribution_drift');
}

/** The URI a test-function result rewrote the request to. */
export function testFunctionUri(result) {
  const test = result?.TestResult || {};
  if (test.FunctionErrorMessage) throw new Error(`development_test_error:${test.FunctionErrorMessage}`);
  let output;
  try { output = JSON.parse(test.FunctionOutput || ''); } catch { throw new Error('development_test_output_unreadable'); }
  return output?.request?.uri;
}

function awsJson(args, env = process.env) {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8', env, maxBuffer: 20 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : {};
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-spa-fallback-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const STAGES = Object.freeze(['LIVE', 'DEVELOPMENT']);
const assertStage = (stage) => { if (!STAGES.includes(stage)) throw new Error(`function_stage_invalid:${stage}`); };

export const awsClient = {
  getDistribution: (id, env) => { assertProductionDistribution(id); return awsJson(['cloudfront', 'get-distribution', '--id', id], env); },
  describeFunction: (name, stage, env) => {
    assertProductionFunction(name); assertStage(stage);
    return awsJson(['cloudfront', 'describe-function', '--name', name, '--stage', stage], env);
  },
  getFunctionCode: (name, stage, env) => {
    assertProductionFunction(name); assertStage(stage);
    return withTempDir((dir) => {
      const file = path.join(dir, 'code.js');
      const meta = awsJson(['cloudfront', 'get-function', '--name', name, '--stage', stage, file], env);
      return { etag: meta.ETag || null, code: fs.readFileSync(file) };
    });
  },
  headObject: (bucket, key, env) => {
    assertProductionObject(bucket, key);
    try {
      return awsJson(['s3api', 'head-object', '--bucket', bucket, '--key', key], env);
    } catch {
      return null; // 403/404: the object is not readable as served
    }
  },
  updateFunction: (name, etag, config, code, env) => {
    assertProductionFunction(name);
    if (!etag) throw new Error('function_etag_missing');
    return withTempDir((dir) => {
      const file = path.join(dir, 'code.js');
      fs.writeFileSync(file, code);
      return awsJson(['cloudfront', 'update-function', '--name', name, '--if-match', etag, '--function-config', JSON.stringify(config), '--function-code', `fileb://${file}`], env);
    });
  },
  testFunction: (name, etag, event, env) => {
    assertProductionFunction(name);
    if (!etag) throw new Error('function_etag_missing');
    return withTempDir((dir) => {
      const file = path.join(dir, 'event.json');
      fs.writeFileSync(file, JSON.stringify(event));
      return awsJson(['cloudfront', 'test-function', '--name', name, '--if-match', etag, '--stage', 'DEVELOPMENT', '--event-object', `fileb://${file}`], env);
    });
  },
  publishFunction: (name, etag, env) => {
    assertProductionFunction(name);
    if (!etag) throw new Error('function_etag_missing');
    return awsJson(['cloudfront', 'publish-function', '--name', name, '--if-match', etag], env);
  },
};

function readStage(client, stage, env) {
  const described = client.describeFunction(FUNCTION_NAME, stage, env);
  const { etag, code } = client.getFunctionCode(FUNCTION_NAME, stage, env);
  return { described, etag, code: Buffer.from(code) };
}

/** Reads both function stages, the distribution and the page objects. Never writes. */
export function readState(env = process.env, client = awsClient) {
  const distribution = client.getDistribution(DISTRIBUTION_ID, env);
  const live = readStage(client, 'LIVE', env);
  const development = readStage(client, 'DEVELOPMENT', env);
  const objects = Object.fromEntries(OBJECT_KEYS.map((key) => [key, client.headObject(PRODUCTION_BUCKET, key, env)]));
  return {
    raw: { distributionConfig: distribution.Distribution?.DistributionConfig, liveCode: live.code, developmentCode: development.code },
    snapshot: normalizeSnapshot({ distribution, live, development, objects }),
  };
}

function readInput(env) {
  const file = env.CHECKSOPS_PRODUCTION_SPA_FALLBACK_INPUT;
  if (!file) throw new Error('production_spa_fallback_input_missing');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const CALLER_FORBIDDEN = Object.freeze(['code', 'function_code', 'function_name', 'function_config', 'runtime', 'comment', 'distribution_id', 'distribution_config', 'bucket', 'keys', 'paths']);

export function main(env = process.env, deps = {}) {
  const client = deps.client || awsClient;
  const read = () => readState(env, client);
  if (env.CHECKSOPS_PRODUCTION_SPA_FALLBACK_EXECUTE !== '1') {
    process.stdout.write(`${JSON.stringify({ ok: false, plan_only: true, distribution_id: DISTRIBUTION_ID, function_name: FUNCTION_NAME, owned: OWNED_COMPONENTS })}\n`);
    return 2;
  }
  const input = readInput(env);
  if (CALLER_FORBIDDEN.some((key) => Object.hasOwn(input, key))) throw new Error('caller_supplied_config_forbidden');
  const mode = input.mode;
  if (!['publish', 'revert'].includes(mode)) throw new Error('mode_invalid');
  const sources = deps.sources || loadFunctionSources(deps.sourceRoot || repoRoot);

  const first = read();
  const checked = classify(first.snapshot, sources);
  const action = actionFor(mode, checked.state);
  if (!action) throw new Error(`state_refused:${checked.state}:${checked.problems.join(',')}`);
  if (action !== input.action) throw new Error('action_mismatch');
  const version = action === 'publish' ? 'current' : 'baseline';
  const desired = sources[version];
  const desiredSha = sources[`${version}_sha256`];

  const authorized = refuseUnguardedDeploy({
    target_environment: TARGET_ENVIRONMENT,
    target_component: TARGET_COMPONENT,
    deployment_type: DEPLOYMENT_TYPE,
    preflight_live_fingerprint: first.snapshot,
    workstream_id: input.workstream_id || env.CHECKSOPS_WORKSTREAM_ID,
    commit: input.commit || env.CHECKSOPS_COMMIT,
    receipt_path: input.receipt_path,
  }, { env, now: deps.now, root: deps.guardRoot });
  if (!authorized.ok) throw new Error(`guard_refused:${authorized.code || 'DEPLOYMENT_GUARD_REQUIRED'}`);
  const receipt = authorized.details.receipt;
  if (receipt.deployment_type !== DEPLOYMENT_TYPE) throw new Error('receipt_type_mismatch');
  if (receipt.target_environment !== TARGET_ENVIRONMENT) throw new Error('receipt_environment_mismatch');
  if (!eq(receipt.owned_components, OWNED_COMPONENTS[action]) || Object.hasOwn(receipt, 'owned_member_ops')) throw new Error('receipt_component_mismatch');

  // Mandatory TOCTOU read immediately before the first write.
  const second = read();
  const secondFingerprint = snapshotFingerprint(second.snapshot);
  if (secondFingerprint !== checked.fingerprint) throw new Error('toctou_drift');

  const gate = evaluateProductionGate({
    target_environment: TARGET_ENVIRONMENT,
    deployment_type: DEPLOYMENT_TYPE,
    workstream_id: receipt.workstream_id,
    production_fingerprint: { snapshot_sha256: checked.fingerprint },
    immediately_before_fingerprint: { snapshot_sha256: secondFingerprint },
    staging_acceptance: input.staging_acceptance,
    approval: input.approval,
  });
  if (!gate.ok) throw new Error(`production_gate:${gate.code || 'refused'}`);

  const consumed = consumeReceiptOnce(deps.guardRoot || resolveGuardRoot({}, env), receipt, {
    now: deps.now,
    actor: env.CHECKSOPS_OPERATOR || env.USER || null,
    script: 'production-spa-fallback',
  });
  if (!consumed.ok) throw new Error(`receipt_consumption_failed:${consumed.code || 'unknown'}`);

  // 1. DEVELOPMENT stage only; the LIVE runtime and comment are kept.
  const live = second.snapshot.function.live;
  const functionConfig = { Comment: live.comment, Runtime: live.runtime };
  const updated = client.updateFunction(FUNCTION_NAME, second.snapshot.function.development.etag, functionConfig, desired, env);
  const developmentEtag = updated.ETag;
  if (!developmentEtag) throw new Error('update_function_etag_missing');

  // 2. test-function on DEVELOPMENT: every sample URI must be what this version must do. A failure
  //    stops here: LIVE is untouched and DEVELOPMENT holds a repository version.
  const tested = SAMPLE_URIS.map((uri) => {
    const got = testFunctionUri(client.testFunction(FUNCTION_NAME, developmentEtag, viewerRequestEvent(uri), env));
    const want = expectedUri(version, uri);
    if (got !== want) throw new Error(`development_test_failed:${uri}:${got}:${want}`);
    return { uri, result: got };
  });

  // 3. publish: DEVELOPMENT -> LIVE.
  client.publishFunction(FUNCTION_NAME, developmentEtag, env);

  const after = read();
  assertDistributionUnchanged(second.raw.distributionConfig, after.raw.distributionConfig);
  const afterLive = after.snapshot.function.live;
  if (afterLive?.code_sha256 !== desiredSha || after.snapshot.function.development?.code_sha256 !== desiredSha) throw new Error('function_post_verify_failed');
  if (afterLive.runtime !== live.runtime || afterLive.comment !== live.comment) throw new Error('function_config_post_verify_failed');
  const afterState = classify(after.snapshot, sources);
  if (afterState.drift_problems.length) throw new Error(`post_write_drift:${afterState.drift_problems.join(',')}`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    action,
    distribution_id: DISTRIBUTION_ID,
    function_name: FUNCTION_NAME,
    code_sha256: desiredSha,
    tested,
    before_fingerprint: checked.fingerprint,
    after_fingerprint: afterState.fingerprint,
    after_state: afterState.state,
  })}\n`);
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try { process.exitCode = main(); } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, message: error?.message || String(error) })}\n`);
    process.exitCode = 2;
  }
}
