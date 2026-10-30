#!/usr/bin/env node
/**
 * Receipt-gated writer for the staging browser security headers (SPA CSP rollout step 1,
 * ops/security/SPA_CSP_ROLLOUT.md). Staging only: distribution E1CG52WRQZI7X1.
 *
 * Exact permitted mutations:
 *   attach: create or update the response headers policy
 *           checksops-staging-browser-security-headers (production baseline security headers
 *           plus a custom Content-Security-Policy-Report-Only header built by spa-csp.mjs from
 *           the live staging index.html), then set DefaultCacheBehavior.ResponseHeadersPolicyId
 *           to it.
 *   enforce: (rollout step 3) update that attached policy only: the same directives plus
 *           upgrade-insecure-requests in SecurityHeadersConfig.ContentSecurityPolicy (Override true),
 *           and no Content-Security-Policy-Report-Only header. The distribution is not changed.
 *   revert: update that attached policy only, back to exactly the report-only config attach sets.
 *   detach: restore DefaultCacheBehavior.ResponseHeadersPolicyId to its value before the first
 *           attach (none, read 2026-10-30). The policy object is left in place.
 *
 * The distribution config, the policy and the live index.html are pinned through the receipt:
 * the signed preflight fingerprint is the whole snapshot, the writer re-reads it before and
 * immediately before the first write, sends If-Match ETags, and the post-write distribution
 * config must differ from the pre-write one only in DefaultCacheBehavior.ResponseHeadersPolicyId
 * (and not at all for update-policy, enforce and revert).
 * Production (E1B0ZWWO5559U5 and its policy 756a8f23-…) is refused at every read and write.
 *
 * Run only from guarded-staging-csp-headers.yml after github-staging-csp-headers.mjs issued the
 * receipt.
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
import { buildCsp } from './lib/spa-csp.mjs';

const AWS = process.env.AWS_CLI || process.env.AWS || 'aws';
const REGION = process.env.AWS_REGION || 'us-east-1';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DISTRIBUTION_ID = 'E1CG52WRQZI7X1';
export const STAGING_ALIAS = 'staging.checksops.com';
export const STAGING_BUCKET = 'checksops-staging-frontend-c48b';
export const PRODUCTION_DISTRIBUTION_ID = 'E1B0ZWWO5559U5';
export const PRODUCTION_POLICY_ID = '756a8f23-68dd-4f8a-8293-5a2fd08f919a';
export const POLICY_NAME = 'checksops-staging-browser-security-headers';
export const REPORT_ONLY_HEADER = 'Content-Security-Policy-Report-Only';
// The enforcing policy's comment; the report-only one is the template's.
export const ENFORCING_COMMENT = 'Production baseline headers plus an enforcing CSP (staging step 3).';
// DefaultCacheBehavior.ResponseHeadersPolicyId before the first attach (read-only inspect,
// 2026-10-30, user/claude-code): absent. detach restores exactly this.
export const PREVIOUS_RESPONSE_HEADERS_POLICY_ID = null;
export const TEMPLATE_PATH = 'aws/staging/cloudfront-security-headers.yaml';

export const DEPLOYMENT_TYPE = 'cloudfront-response-headers-policy';
export const TARGET_ENVIRONMENT = 'staging';
export const TARGET_COMPONENT = 'staging-frontend';
export const OWNED_BEHAVIOR = `cloudfront:${DISTRIBUTION_ID}:DefaultCacheBehavior.ResponseHeadersPolicyId`;
export const OWNED_POLICY = `response-headers-policy:${POLICY_NAME}`;
export const OWNED_COMPONENTS = Object.freeze({
  attach: [OWNED_BEHAVIOR, OWNED_POLICY],
  'update-policy': [OWNED_POLICY],
  enforce: [OWNED_POLICY],
  revert: [OWNED_POLICY],
  detach: [OWNED_BEHAVIOR],
});
// Actions that change only the attached policy, never the distribution.
const POLICY_ONLY_ACTIONS = new Set(['update-policy', 'enforce', 'revert']);

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

export function assertStagingDistribution(id) {
  if (id !== DISTRIBUTION_ID) throw new Error(`staging_only:distribution:${id}`);
}

export function assertNotProductionPolicy(id) {
  if (id === PRODUCTION_POLICY_ID) throw new Error('staging_only:production_policy');
}

const CFN_SCHEMA = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('!Ref', { kind: 'scalar', construct: (data) => ({ Ref: data }) })]);

/** The template's policy (name and security headers), reviewed in source. */
export function loadTemplatePolicy(root = repoRoot) {
  const doc = yaml.load(fs.readFileSync(path.join(root, TEMPLATE_PATH), 'utf8'), { schema: CFN_SCHEMA });
  const resources = Object.values(doc.Resources || {});
  if (resources.length !== 1 || resources[0].Type !== 'AWS::CloudFront::ResponseHeadersPolicy') throw new Error('template_shape');
  const config = resources[0].Properties.ResponseHeadersPolicyConfig;
  if (config.Name !== POLICY_NAME) throw new Error('template_policy_name');
  if (config.SecurityHeadersConfig?.ContentSecurityPolicy) throw new Error('template_sets_enforcing_csp');
  const headers = (config.CustomHeadersConfig?.Items || []).map((item) => item.Header);
  if (!eq(headers, [REPORT_ONLY_HEADER])) throw new Error('template_custom_headers');
  return config;
}

/**
 * The exact policy config a change sends: template headers, CSP built from the live index.html.
 * Report-only (attach, update-policy, revert): the template's config. Enforcing (enforce): derived
 * from it, not a second template: the template's security headers plus ContentSecurityPolicy =
 * buildCsp(..., { enforce: true }), and no custom headers.
 */
export function desiredPolicyConfig(indexHtml, template = loadTemplatePolicy(), { enforce = false } = {}) {
  if (enforce) {
    return {
      Name: POLICY_NAME,
      Comment: ENFORCING_COMMENT,
      SecurityHeadersConfig: {
        ...structuredClone(template.SecurityHeadersConfig),
        ContentSecurityPolicy: { ContentSecurityPolicy: buildCsp({ environment: 'staging', indexHtml, enforce: true }), Override: true },
      },
    };
  }
  return {
    Name: POLICY_NAME,
    Comment: template.Comment,
    SecurityHeadersConfig: structuredClone(template.SecurityHeadersConfig),
    CustomHeadersConfig: {
      Quantity: 1,
      Items: [{ Header: REPORT_ONLY_HEADER, Value: buildCsp({ environment: 'staging', indexHtml }), Override: true }],
    },
  };
}

const isEmptyObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;

/**
 * CloudFront echoes headers a policy does not set as empty objects (`XSSProtection: {}`,
 * `ContentSecurityPolicy: {}`, run 41067994638); the template omits them. An empty section sets
 * nothing, so it is dropped; a section with any field (an enforcing CSP included) is kept.
 */
function normalizeSecurityHeaders(section) {
  if (!section) return null;
  const kept = Object.fromEntries(Object.entries(section).filter(([, value]) => !isEmptyObject(value)));
  return Object.keys(kept).length ? kept : null;
}

/** The parts of a policy config this tool owns; anything else set on the policy is drift. */
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

export function normalizeSnapshot({ distribution, policies, policy, indexHtml }) {
  const dist = distribution.Distribution || {};
  const config = dist.DistributionConfig || {};
  const named = (policies.ResponseHeadersPolicyList?.Items || [])
    .map((row) => row.ResponseHeadersPolicy)
    .filter((row) => row?.ResponseHeadersPolicyConfig?.Name === POLICY_NAME);
  return {
    distribution: {
      Id: dist.Id,
      Status: dist.Status,
      ETag: distribution.ETag,
      Aliases: config.Aliases?.Items || [],
      DefaultTargetOriginId: config.DefaultCacheBehavior?.TargetOriginId || null,
      DefaultResponseHeadersPolicyId: config.DefaultCacheBehavior?.ResponseHeadersPolicyId || null,
      CacheBehaviorCount: config.CacheBehaviors?.Quantity || 0,
      config_sha256: hashJson(config),
    },
    policies_named: named.map((row) => row.Id),
    policy: policy ? {
      Id: policy.ResponseHeadersPolicy?.Id,
      ETag: policy.ETag,
      config: normalizePolicyConfig(policy.ResponseHeadersPolicy?.ResponseHeadersPolicyConfig),
    } : null,
    index: { sha256: sha256(indexHtml), csp: buildCsp({ environment: 'staging', indexHtml }) },
  };
}

export const snapshotFingerprint = (snapshot) => hashJson(snapshot);

// An enforcing CSP is ours when it is buildCsp(enforce) up to the inline-script hashes: the
// same value for an older index.html is ours and stale; any other value is foreign.
const withoutScriptHashes = (csp) => String(csp).replace(/ 'sha256-[A-Za-z0-9+/=]+'/g, '');
export const isOwnEnforcingCsp = (value, enforcing) => typeof value === 'string'
  && withoutScriptHashes(value) === withoutScriptHashes(enforcing.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy);

/**
 * READY: nothing attached, attach creates/updates our policy and attaches it.
 * ATTACHED_STALE: our report-only policy attached but its headers differ from the template/live
 *   index.html; apply updates the policy only. ATTACHED_CURRENT: nothing to apply; enforce may run.
 * ENFORCING_CURRENT / ENFORCING_STALE: our policy attached with our enforcing CSP, equal to (or
 *   differing from) the enforcing config for the live index.html; revert or detach may run.
 * BLOCKED: anything else (another policy attached, production ids, duplicate names, a policy with
 *   settings this tool does not own, a foreign enforcing CSP, distribution not Deployed or not the
 *   staging host).
 */
export function classify(snapshot, desired, enforcing = null) {
  const problems = [];
  const d = snapshot.distribution;
  if (d.Id !== DISTRIBUTION_ID) problems.push('distribution_not_staging');
  if (!eq(d.Aliases, [STAGING_ALIAS])) problems.push('aliases_drift');
  if (d.Status !== 'Deployed') problems.push('distribution_not_deployed');
  if (!d.ETag) problems.push('distribution_etag_missing');
  if (d.CacheBehaviorCount !== 0) problems.push('cache_behaviors_drift');
  if (snapshot.policies_named.length > 1) problems.push('duplicate_policy_name');
  if (snapshot.policies_named.includes(PRODUCTION_POLICY_ID) || snapshot.policy?.Id === PRODUCTION_POLICY_ID) problems.push('production_policy');
  const attached = d.DefaultResponseHeadersPolicyId;
  if (attached === PRODUCTION_POLICY_ID) problems.push('production_policy_attached');
  const ours = snapshot.policy?.Id || null;
  const want = normalizePolicyConfig(desired);
  const enforcingCsp = snapshot.policy?.config.SecurityHeadersConfig?.ContentSecurityPolicy;
  const ownEnforcing = Boolean(enforcingCsp) && Boolean(enforcing) && enforcingCsp.Override === true
    && Object.keys(enforcingCsp).length === 2 && isOwnEnforcingCsp(enforcingCsp.ContentSecurityPolicy, enforcing);
  if (snapshot.policy) {
    const have = snapshot.policy.config;
    if (have.CorsConfig || have.RemoveHeaders || have.ServerTiming || (enforcingCsp && !ownEnforcing)) problems.push('policy_has_unowned_settings');
  }
  let state;
  if (problems.length) state = 'BLOCKED';
  else if (attached === PREVIOUS_RESPONSE_HEADERS_POLICY_ID) state = 'READY';
  else if (ours && attached === ours && ownEnforcing) state = eq(snapshot.policy.config, normalizePolicyConfig(enforcing)) ? 'ENFORCING_CURRENT' : 'ENFORCING_STALE';
  else if (ours && attached === ours) state = eq(snapshot.policy.config, want) ? 'ATTACHED_CURRENT' : 'ATTACHED_STALE';
  else { state = 'BLOCKED'; problems.push('other_policy_attached'); }
  return { state, problems, fingerprint: snapshotFingerprint(snapshot) };
}

/** What a given mode does in a given state; null means the mode refuses. */
// apply never touches an enforcing policy (revert is the explicit way back); enforce needs the
// report-only policy current first, so the enforcing hashes are the ones staging was observed with.
export function actionFor(mode, state) {
  if (mode === 'apply') return { READY: 'attach', ATTACHED_STALE: 'update-policy' }[state] || null;
  if (mode === 'enforce') return { ATTACHED_CURRENT: 'enforce', ENFORCING_STALE: 'enforce' }[state] || null;
  if (mode === 'revert') return { ENFORCING_CURRENT: 'revert', ENFORCING_STALE: 'revert' }[state] || null;
  if (mode === 'rollback') return { ATTACHED_CURRENT: 'detach', ATTACHED_STALE: 'detach', ENFORCING_CURRENT: 'detach', ENFORCING_STALE: 'detach' }[state] || null;
  return null;
}

/** The distribution config with only DefaultCacheBehavior.ResponseHeadersPolicyId changed. */
export function desiredDistributionConfig(config, policyId) {
  const next = structuredClone(config);
  if (policyId) {
    assertNotProductionPolicy(policyId);
    next.DefaultCacheBehavior.ResponseHeadersPolicyId = policyId;
  } else {
    delete next.DefaultCacheBehavior.ResponseHeadersPolicyId;
  }
  return next;
}

export function assertOnlyBehaviorDelta(before, after, policyId) {
  if (!eq(sortKeys(after), sortKeys(desiredDistributionConfig(before, policyId)))) throw new Error('post_write_distribution_drift');
}

function awsJson(args, env = process.env) {
  const out = execFileSync(AWS, ['--region', REGION, '--output', 'json', ...args], { encoding: 'utf8', env });
  return out.trim() ? JSON.parse(out) : {};
}

function readIndexHtml(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-csp-index-'));
  const file = path.join(dir, 'index.html');
  try {
    execFileSync(AWS, ['--region', REGION, 's3api', 'get-object', '--bucket', STAGING_BUCKET, '--key', 'index.html', file], { encoding: 'utf8', env });
    return fs.readFileSync(file, 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const awsClient = {
  getDistribution: (id, env) => { assertStagingDistribution(id); return awsJson(['cloudfront', 'get-distribution', '--id', id], env); },
  listPolicies: (env) => awsJson(['cloudfront', 'list-response-headers-policies', '--type', 'custom'], env),
  getPolicy: (id, env) => { assertNotProductionPolicy(id); return awsJson(['cloudfront', 'get-response-headers-policy', '--id', id], env); },
  readIndexHtml,
  createPolicy: (config, env) => awsJson(['cloudfront', 'create-response-headers-policy', '--response-headers-policy-config', JSON.stringify(config)], env),
  updatePolicy: (id, etag, config, env) => {
    assertNotProductionPolicy(id);
    return awsJson(['cloudfront', 'update-response-headers-policy', '--id', id, '--if-match', etag, '--response-headers-policy-config', JSON.stringify(config)], env);
  },
  updateDistribution: (id, etag, config, env) => {
    assertStagingDistribution(id);
    return awsJson(['cloudfront', 'update-distribution', '--id', id, '--if-match', etag, '--distribution-config', JSON.stringify(config)], env);
  },
};

/** Reads the distribution, our policy (by name), and the live index.html. Never writes. */
export function readState(env = process.env, client = awsClient) {
  const distribution = client.getDistribution(DISTRIBUTION_ID, env);
  const policies = client.listPolicies(env);
  const named = (policies.ResponseHeadersPolicyList?.Items || []).map((row) => row.ResponseHeadersPolicy)
    .filter((row) => row?.ResponseHeadersPolicyConfig?.Name === POLICY_NAME);
  const policy = named.length === 1 && named[0].Id !== PRODUCTION_POLICY_ID ? client.getPolicy(named[0].Id, env) : null;
  const indexHtml = client.readIndexHtml(env);
  return {
    raw: { distributionConfig: distribution.Distribution?.DistributionConfig, indexHtml },
    snapshot: normalizeSnapshot({ distribution, policies, policy, indexHtml }),
  };
}

function readInput(env) {
  const file = env.CHECKSOPS_STAGING_CSP_INPUT;
  if (!file) throw new Error('staging_csp_input_missing');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function main(env = process.env, deps = {}) {
  const client = deps.client || awsClient;
  const read = () => readState(env, client);
  if (env.CHECKSOPS_STAGING_CSP_EXECUTE !== '1') {
    process.stdout.write(`${JSON.stringify({ ok: false, plan_only: true, distribution_id: DISTRIBUTION_ID, policy_name: POLICY_NAME, owned: OWNED_COMPONENTS })}\n`);
    return 2;
  }
  const input = readInput(env);
  if (input.policy_id || input.policy_config || input.distribution_config || input.csp) throw new Error('caller_supplied_config_forbidden');
  const mode = input.mode;
  if (!['apply', 'enforce', 'revert', 'rollback'].includes(mode)) throw new Error('mode_invalid');
  const template = deps.template || loadTemplatePolicy(deps.templateRoot || repoRoot);

  const first = read();
  const reportOnly = desiredPolicyConfig(first.raw.indexHtml, template);
  const enforcing = desiredPolicyConfig(first.raw.indexHtml, template, { enforce: true });
  const checked = classify(first.snapshot, reportOnly, enforcing);
  const action = actionFor(mode, checked.state);
  if (!action) throw new Error(`state_refused:${checked.state}:${checked.problems.join(',')}`);
  if (action !== input.action) throw new Error('action_mismatch');
  const desired = action === 'enforce' ? enforcing : reportOnly;

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
  if (snapshotFingerprint(second.snapshot) !== checked.fingerprint) throw new Error('toctou_drift');

  const consumed = consumeReceiptOnce(deps.guardRoot || resolveGuardRoot({}, env), receipt, {
    now: deps.now,
    actor: env.CHECKSOPS_OPERATOR || env.USER || null,
    script: 'staging-csp-headers',
  });
  if (!consumed.ok) throw new Error(`receipt_consumption_failed:${consumed.code || 'unknown'}`);

  let policyId = second.snapshot.policy?.Id || null;
  if (action === 'attach' || POLICY_ONLY_ACTIONS.has(action)) {
    if (!policyId) {
      if (action !== 'attach') throw new Error('policy_missing');
      policyId = client.createPolicy(desired, env).ResponseHeadersPolicy?.Id;
      if (!policyId) throw new Error('policy_create_failed');
    } else if (!eq(second.snapshot.policy.config, normalizePolicyConfig(desired))) {
      client.updatePolicy(policyId, second.snapshot.policy.ETag, desired, env);
    }
    assertNotProductionPolicy(policyId);
  }
  const target = action === 'detach' ? PREVIOUS_RESPONSE_HEADERS_POLICY_ID : policyId;
  if (!POLICY_ONLY_ACTIONS.has(action)) {
    client.updateDistribution(DISTRIBUTION_ID, second.snapshot.distribution.ETag, desiredDistributionConfig(second.raw.distributionConfig, target), env);
  }

  const after = read();
  assertOnlyBehaviorDelta(second.raw.distributionConfig, after.raw.distributionConfig, POLICY_ONLY_ACTIONS.has(action) ? second.snapshot.distribution.DefaultResponseHeadersPolicyId : target);
  if (action !== 'detach' && !eq(after.snapshot.policy?.config, normalizePolicyConfig(desired))) throw new Error('policy_post_verify_failed');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    action,
    distribution_id: DISTRIBUTION_ID,
    response_headers_policy_id: after.snapshot.distribution.DefaultResponseHeadersPolicyId,
    policy_id: policyId,
    index_html_sha256: after.snapshot.index.sha256,
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
