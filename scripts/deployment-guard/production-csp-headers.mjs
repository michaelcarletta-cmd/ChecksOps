#!/usr/bin/env node
/**
 * Receipt-gated writer for the production SPA Content-Security-Policy (SPA CSP rollout step 5,
 * ops/security/SPA_CSP_ROLLOUT.md; runbook ops/deployment-guard/PRODUCTION_CSP_HEADERS.md).
 * Production only: distribution E1B0ZWWO5559U5 and its response headers policy
 * 756a8f23-68dd-4f8a-8293-5a2fd08f919a (checksops-production-browser-security-headers), which is
 * attached to the default behavior, /prep and /prep/*. Owner, 2026-10-31: "build the production
 * CSP tooling, in place": the existing policy is updated; no distribution change, no new policy.
 *
 * Exact permitted mutations (UpdateResponseHeadersPolicy on 756a8f23-… only, with If-Match):
 *   enforce: the SH-1 baseline (aws/production/cloudfront-security-headers.yaml) plus
 *            SecurityHeadersConfig.ContentSecurityPolicy = buildCsp({ environment: 'production',
 *            indexHtml: <live production index.html>, enforce: true }), Override true, and the
 *            comment ENFORCING_COMMENT. Every other header stays exactly the baseline.
 *   revert:  exactly the SH-1 baseline again (no ContentSecurityPolicy, the template comment).
 *
 * The distribution, the policy and the live index.html are pinned through the receipt: the signed
 * preflight fingerprint is the whole snapshot, the writer re-reads it before and immediately before
 * the write, and afterwards the distribution config must be byte-for-byte what it was.
 * Staging (E1CG52WRQZI7X1 and its policy d3f84b15-…) is refused at every read and write.
 *
 * Run only from guarded-production-csp-headers.yml after github-production-csp-headers.mjs issued
 * the receipt.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { refuseUnguardedDeploy, resolveGuardRoot } from './require-guard.mjs';
import { consumeReceiptOnce } from './lib/consumed-receipts.mjs';
import { evaluateProductionGate } from './lib/production.mjs';
import { STAGING_API_ORIGIN, buildCsp } from './lib/spa-csp.mjs';

const AWS = process.env.AWS_CLI || process.env.AWS || 'aws';
const REGION = process.env.AWS_REGION || 'us-east-1';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DISTRIBUTION_ID = 'E1B0ZWWO5559U5';
export const POLICY_ID = '756a8f23-68dd-4f8a-8293-5a2fd08f919a';
export const POLICY_NAME = 'checksops-production-browser-security-headers';
export const PRODUCTION_ALIAS = 'checksops.com';
export const PRODUCTION_BUCKET = 'checksops-production-frontend-806168576068';
// SH1_ACCEPTED_PRODUCTION_BASELINE.md: the WAF on the production distribution.
export const PRODUCTION_WEB_ACL_ID = 'arn:aws:wafv2:us-east-1:806168576068:global/webacl/checksops-production-cloudfront-waf/cc8aadde-2bab-4d5e-8144-7d8981f44ad7';
// The behaviors the policy is attached to (SH1_ACCEPTED_PRODUCTION_BASELINE.md, read again
// 2026-10-29 in ops/security/BRANDING_LOGO_ROUTE_HEADERS.md). All three must still carry it.
export const ATTACHED_BEHAVIORS = Object.freeze(['Default', '/prep', '/prep/*']);
export const STAGING_DISTRIBUTION_ID = 'E1CG52WRQZI7X1';
export const STAGING_POLICY_ID = 'd3f84b15-c4db-481c-98cb-64eb541619fe';
export const STAGING_BUCKET = 'checksops-staging-frontend-c48b';
// Never in a production policy (spa-csp.mjs gives production the same-origin /prep).
export const STAGING_HOSTS = Object.freeze([STAGING_API_ORIGIN.replace('https://', ''), 'staging.checksops.com', STAGING_BUCKET]);
export const ENFORCING_COMMENT = 'Low-risk browser security headers plus the enforcing SPA CSP (guarded-production-csp-headers.yml).';
export const TEMPLATE_PATH = 'aws/production/cloudfront-security-headers.yaml';

export const DEPLOYMENT_TYPE = 'cloudfront-response-headers-policy';
export const TARGET_ENVIRONMENT = 'production';
// The same lease component as the production SPA upload: both change what checksops.com serves,
// and the CSP's inline-script hash comes from the index.html that upload writes.
export const TARGET_COMPONENT = 'production-spa';
export const OWNED_POLICY = `response-headers-policy:${POLICY_ID}`;
export const OWNED_COMPONENTS = Object.freeze({ enforce: [OWNED_POLICY], revert: [OWNED_POLICY] });

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
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

export function assertProductionPolicy(id) {
  if (id === STAGING_POLICY_ID) throw new Error('production_only:staging_policy');
  if (id !== POLICY_ID) throw new Error(`production_only:policy:${id}`);
}

export function assertNoStagingHost(csp) {
  for (const host of STAGING_HOSTS) if (String(csp).includes(host)) throw new Error(`staging_host_in_production_csp:${host}`);
}

const CFN_SCHEMA = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('!Ref', { kind: 'scalar', construct: (data) => ({ Ref: data }) })]);

/** The SH-1 baseline policy (name, comment, the four security headers), reviewed in source. */
export function loadTemplatePolicy(root = repoRoot) {
  const doc = yaml.load(fs.readFileSync(path.join(root, TEMPLATE_PATH), 'utf8'), { schema: CFN_SCHEMA });
  const resources = Object.values(doc.Resources || {});
  if (resources.length !== 1 || resources[0].Type !== 'AWS::CloudFront::ResponseHeadersPolicy') throw new Error('template_shape');
  const config = resources[0].Properties.ResponseHeadersPolicyConfig;
  if (config.Name !== POLICY_NAME) throw new Error('template_policy_name');
  // The template is the revert target: the CSP is set only by this tool, never in the template.
  if (config.SecurityHeadersConfig?.ContentSecurityPolicy) throw new Error('template_sets_csp');
  if (config.CustomHeadersConfig || config.CorsConfig || config.RemoveHeadersConfig || config.ServerTimingHeadersConfig) throw new Error('template_extra_config');
  if (!eq(Object.keys(config.SecurityHeadersConfig || {}).sort(), ['ContentTypeOptions', 'FrameOptions', 'ReferrerPolicy', 'StrictTransportSecurity'])) throw new Error('template_security_headers');
  return config;
}

/** The enforcing CSP for a given live index.html; never a staging host. */
export function productionCsp(indexHtml) {
  const csp = buildCsp({ environment: 'production', indexHtml, enforce: true });
  assertNoStagingHost(csp);
  return csp;
}

/** baseline: exactly the template. enforcing: the template's headers plus our CSP. */
export function baselinePolicyConfig(template = loadTemplatePolicy()) {
  return { Name: POLICY_NAME, Comment: template.Comment, SecurityHeadersConfig: structuredClone(template.SecurityHeadersConfig) };
}

export function enforcingPolicyConfig(indexHtml, template = loadTemplatePolicy()) {
  return {
    Name: POLICY_NAME,
    Comment: ENFORCING_COMMENT,
    SecurityHeadersConfig: {
      ...structuredClone(template.SecurityHeadersConfig),
      ContentSecurityPolicy: { ContentSecurityPolicy: productionCsp(indexHtml), Override: true },
    },
  };
}

const isEmptyObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;

// CloudFront echoes headers a policy does not set as empty objects (XSSProtection: {},
// ContentSecurityPolicy: {}; staging run 41067994638). An empty section sets nothing.
function normalizeSecurityHeaders(section) {
  if (!section) return null;
  const kept = Object.fromEntries(Object.entries(section).filter(([, value]) => !isEmptyObject(value)));
  return Object.keys(kept).length ? kept : null;
}

/** Every part of a policy config; anything this tool does not set is drift. */
export function normalizePolicyConfig(config) {
  if (!config) return null;
  return sortKeys({
    Name: config.Name,
    Comment: config.Comment || '',
    SecurityHeadersConfig: normalizeSecurityHeaders(config.SecurityHeadersConfig),
    CustomHeaders: (config.CustomHeadersConfig?.Items || []).map((item) => ({ Header: item.Header, Value: item.Value, Override: item.Override })),
    CorsConfig: config.CorsConfig || null,
    RemoveHeaders: config.RemoveHeadersConfig?.Quantity || 0,
    ServerTiming: config.ServerTimingHeadersConfig?.Enabled === true,
  });
}

const behaviorPolicies = (config) => [
  { PathPattern: 'Default', ResponseHeadersPolicyId: config.DefaultCacheBehavior?.ResponseHeadersPolicyId || null },
  ...(config.CacheBehaviors?.Items || []).map((row) => ({ PathPattern: row.PathPattern, ResponseHeadersPolicyId: row.ResponseHeadersPolicyId || null })),
];

export function normalizeSnapshot({ distribution, policy, indexHtml }) {
  const dist = distribution.Distribution || {};
  const config = dist.DistributionConfig || {};
  return {
    distribution: {
      Id: dist.Id,
      Status: dist.Status,
      ETag: distribution.ETag,
      Aliases: config.Aliases?.Items || [],
      WebACLId: config.WebACLId || null,
      Behaviors: behaviorPolicies(config),
      config_sha256: hashJson(config),
    },
    policy: policy ? {
      Id: policy.ResponseHeadersPolicy?.Id,
      ETag: policy.ETag,
      config: normalizePolicyConfig(policy.ResponseHeadersPolicy?.ResponseHeadersPolicyConfig),
    } : null,
    index: { sha256: sha256(indexHtml), csp: productionCsp(indexHtml) },
  };
}

export const snapshotFingerprint = (snapshot) => hashJson(snapshot);

// An enforcing CSP is ours when it is productionCsp up to the inline-script hashes: the same value
// for an older index.html is ours and stale; any other value is foreign.
const withoutScriptHashes = (csp) => String(csp).replace(/ 'sha256-[A-Za-z0-9+/=]+'/g, '');
export const isOwnEnforcingCsp = (value, enforcing) => typeof value === 'string'
  && withoutScriptHashes(value) === withoutScriptHashes(enforcing.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy);

/**
 * BASELINE: the policy is exactly the SH-1 template (no CSP); enforce may run.
 * ENFORCING_CURRENT / ENFORCING_STALE: the template's headers plus our CSP, equal to (or, after a
 *   new index.html, differing from) the enforcing config for the live index.html; revert may run,
 *   enforce refreshes a stale one.
 * BLOCKED: anything else (staging ids, the policy detached from a behavior or another policy on
 *   one, WAF or alias drift, distribution not Deployed, a baseline header changed, a foreign CSP,
 *   custom headers, CORS, removed headers, server timing, a comment this tool does not set).
 */
export function classify(snapshot, baseline, enforcing) {
  const problems = [];
  const d = snapshot.distribution;
  if (d.Id !== DISTRIBUTION_ID) problems.push(d.Id === STAGING_DISTRIBUTION_ID ? 'staging_distribution' : 'distribution_not_production');
  if (!d.Aliases.includes(PRODUCTION_ALIAS)) problems.push('aliases_drift');
  if (d.WebACLId !== PRODUCTION_WEB_ACL_ID) problems.push('waf_drift');
  if (d.Status !== 'Deployed') problems.push('distribution_not_deployed');
  if (!d.ETag) problems.push('distribution_etag_missing');
  const attached = Object.fromEntries(d.Behaviors.map((row) => [row.PathPattern, row.ResponseHeadersPolicyId]));
  for (const behavior of ATTACHED_BEHAVIORS) if (attached[behavior] !== POLICY_ID) problems.push(`policy_not_attached:${behavior}`);
  if (d.Behaviors.some((row) => row.ResponseHeadersPolicyId === STAGING_POLICY_ID)) problems.push('staging_policy_attached');
  const policy = snapshot.policy;
  if (!policy) problems.push('policy_missing');
  else {
    if (policy.Id !== POLICY_ID) problems.push(policy.Id === STAGING_POLICY_ID ? 'staging_policy' : 'policy_not_production');
    if (!policy.ETag) problems.push('policy_etag_missing');
    const have = policy.config;
    if (have.Name !== POLICY_NAME) problems.push('policy_name_drift');
    if (have.CustomHeaders.length || have.CorsConfig || have.RemoveHeaders || have.ServerTiming) problems.push('policy_has_unowned_settings');
    const { ContentSecurityPolicy: csp, ...others } = have.SecurityHeadersConfig || {};
    if (!eq(sortKeys(others), normalizePolicyConfig(baseline).SecurityHeadersConfig)) problems.push('baseline_headers_drift');
    const ownCsp = Boolean(csp) && csp.Override === true && Object.keys(csp).length === 2 && isOwnEnforcingCsp(csp.ContentSecurityPolicy, enforcing);
    if (csp && !ownCsp) problems.push('foreign_csp');
    if (!csp && have.Comment !== baseline.Comment) problems.push('comment_drift');
  }
  let state;
  if (problems.length) state = 'BLOCKED';
  else if (eq(policy.config, normalizePolicyConfig(baseline))) state = 'BASELINE';
  else state = eq(policy.config, normalizePolicyConfig(enforcing)) ? 'ENFORCING_CURRENT' : 'ENFORCING_STALE';
  return { state, problems, fingerprint: snapshotFingerprint(snapshot) };
}

/** What a mode does in a state; null means the mode refuses. */
export function actionFor(mode, state) {
  if (mode === 'enforce') return { BASELINE: 'enforce', ENFORCING_STALE: 'enforce' }[state] || null;
  if (mode === 'revert') return { ENFORCING_CURRENT: 'revert', ENFORCING_STALE: 'revert' }[state] || null;
  return null;
}

export function assertDistributionUnchanged(before, after) {
  if (!eq(sortKeys(after), sortKeys(before))) throw new Error('post_write_distribution_drift');
}

function awsJson(args, env = process.env) {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8', env });
  return out.trim() ? JSON.parse(out) : {};
}

function readIndexHtml(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-csp-index-'));
  const file = path.join(dir, 'index.html');
  try {
    execFileSync(AWS, ['--region', REGION, 's3api', 'get-object', '--bucket', PRODUCTION_BUCKET, '--key', 'index.html', file], { encoding: 'utf8', env });
    return fs.readFileSync(file, 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const awsClient = {
  getDistribution: (id, env) => { assertProductionDistribution(id); return awsJson(['cloudfront', 'get-distribution', '--id', id], env); },
  getPolicy: (id, env) => { assertProductionPolicy(id); return awsJson(['cloudfront', 'get-response-headers-policy', '--id', id], env); },
  readIndexHtml,
  updatePolicy: (id, etag, config, env) => {
    assertProductionPolicy(id);
    if (!etag) throw new Error('policy_etag_missing');
    return awsJson(['cloudfront', 'update-response-headers-policy', '--id', id, '--if-match', etag, '--response-headers-policy-config', JSON.stringify(config)], env);
  },
};

/** Reads the distribution, the production policy and the live production index.html. Never writes. */
export function readState(env = process.env, client = awsClient) {
  const distribution = client.getDistribution(DISTRIBUTION_ID, env);
  const policy = client.getPolicy(POLICY_ID, env);
  const indexHtml = client.readIndexHtml(env);
  if (!/<html[\s>]/i.test(String(indexHtml))) throw new Error('index_html_unreadable');
  return {
    raw: { distributionConfig: distribution.Distribution?.DistributionConfig, indexHtml },
    snapshot: normalizeSnapshot({ distribution, policy, indexHtml }),
  };
}

function readInput(env) {
  const file = env.CHECKSOPS_PRODUCTION_CSP_INPUT;
  if (!file) throw new Error('production_csp_input_missing');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function main(env = process.env, deps = {}) {
  const client = deps.client || awsClient;
  const read = () => readState(env, client);
  if (env.CHECKSOPS_PRODUCTION_CSP_EXECUTE !== '1') {
    process.stdout.write(`${JSON.stringify({ ok: false, plan_only: true, distribution_id: DISTRIBUTION_ID, policy_id: POLICY_ID, owned: OWNED_COMPONENTS })}\n`);
    return 2;
  }
  const input = readInput(env);
  if (input.policy_id || input.policy_config || input.distribution_config || input.csp || input.index_html) throw new Error('caller_supplied_config_forbidden');
  const mode = input.mode;
  if (!['enforce', 'revert'].includes(mode)) throw new Error('mode_invalid');
  const template = deps.template || loadTemplatePolicy(deps.templateRoot || repoRoot);

  const first = read();
  const baseline = baselinePolicyConfig(template);
  const enforcing = enforcingPolicyConfig(first.raw.indexHtml, template);
  const checked = classify(first.snapshot, baseline, enforcing);
  const action = actionFor(mode, checked.state);
  if (!action) throw new Error(`state_refused:${checked.state}:${checked.problems.join(',')}`);
  if (action !== input.action) throw new Error('action_mismatch');
  const desired = action === 'enforce' ? enforcing : baseline;

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

  // Mandatory TOCTOU read immediately before the only write.
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
    script: 'production-csp-headers',
  });
  if (!consumed.ok) throw new Error(`receipt_consumption_failed:${consumed.code || 'unknown'}`);

  client.updatePolicy(POLICY_ID, second.snapshot.policy.ETag, desired, env);

  const after = read();
  assertDistributionUnchanged(second.raw.distributionConfig, after.raw.distributionConfig);
  if (!eq(after.snapshot.policy?.config, normalizePolicyConfig(desired))) throw new Error('policy_post_verify_failed');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    action,
    distribution_id: DISTRIBUTION_ID,
    policy_id: POLICY_ID,
    index_html_sha256: after.snapshot.index.sha256,
    content_security_policy: action === 'enforce' ? desired.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy : null,
    before_fingerprint: checked.fingerprint,
    after_fingerprint: snapshotFingerprint(after.snapshot),
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
