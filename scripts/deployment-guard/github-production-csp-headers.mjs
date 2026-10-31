#!/usr/bin/env node
/**
 * GitHub-hosted guarded preflight for the production SPA Content-Security-Policy (rollout step 5,
 * ops/deployment-guard/PRODUCTION_CSP_HEADERS.md). Distribution E1B0ZWWO5559U5 and its policy
 * 756a8f23-68dd-4f8a-8293-5a2fd08f919a only, updated in place.
 *
 * inspect: read the distribution, the policy and the live production index.html; report BASELINE,
 *          ENFORCING_CURRENT, ENFORCING_STALE or BLOCKED, the snapshot SHA-256 and the exact
 *          Content-Security-Policy an enforce would set. Never writes AWS.
 * enforce: same read, then requires the snapshot SHA-256 from a prior inspect, the exact phrase
 *          ENFORCE CSP ON PRODUCTION and a staging acceptance reference, takes the production-spa
 *          lease and issues a KMS-signed receipt whose preflight fingerprint is the whole snapshot,
 *          for production-csp-headers.mjs, the only writer.
 * revert:  as enforce with REMOVE CSP FROM PRODUCTION; the writer puts the SH-1 baseline back.
 * verify:  after enforce the enforcing policy is current; after revert the baseline is.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, GuardError } from './lib/errors.mjs';
import { acquireLease } from './lib/lease.mjs';
import { issueReceiptWithSigner } from './lib/receipt.mjs';
import { signReceiptWithKms } from './lib/kms-issuer.mjs';
import { LOCAL_STATE_DIR } from './lib/paths.mjs';
import {
  DEPLOYMENT_TYPE,
  DISTRIBUTION_ID,
  OWNED_COMPONENTS,
  POLICY_ID,
  TARGET_COMPONENT,
  TARGET_ENVIRONMENT,
  actionFor,
  baselinePolicyConfig,
  classify,
  enforcingPolicyConfig,
  loadTemplatePolicy,
  readState,
} from './production-csp-headers.mjs';

export const APPROVAL_PHRASES = Object.freeze({
  enforce: 'ENFORCE CSP ON PRODUCTION',
  revert: 'REMOVE CSP FROM PRODUCTION',
});
// Staging enforce (rollout step 3), VERIFIED: the reference the first production enforce cites.
export const STAGING_ENFORCE_RUN = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/41086648035';
const STAGING_ACCEPTANCE_RE = /^https:\/\/github\.com\/michaelcarletta-cmd\/ChecksOps\/(actions\/runs\/\d+(\/job\/\d+)?|pull\/\d+)$/;
const VERIFY_STATES = Object.freeze({ enforcing: 'ENFORCING_CURRENT', baseline: 'BASELINE' });
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function workflowIdentity(env = process.env) {
  const commit = String(env.GITHUB_SHA || '').trim();
  const branch = String(env.GITHUB_REF_NAME || '').trim();
  const actor = String(env.GITHUB_ACTOR || '').trim();
  const runId = String(env.GITHUB_RUN_ID || '').trim();
  if (!/^[0-9a-f]{40}$/.test(commit) || !branch || !actor || !runId) {
    throw new GuardError(CODES.ANONYMOUS_DEPLOYMENT, 'GitHub workflow identity is incomplete');
  }
  if (branch !== 'main') throw new GuardError(CODES.UNRELATED_MUTATION, 'guarded production CSP change may only run from main', { branch });
  return { commit, branch, operator: actor, workstreamId: `github-production-csp-${runId}` };
}

export function validateChangeInputs({ mode, approval, stagingAcceptance, expectedFingerprint, liveFingerprint }) {
  if (!Object.hasOwn(APPROVAL_PHRASES, mode) || approval !== APPROVAL_PHRASES[mode]) {
    throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, `production CSP ${mode} requires the exact approval phrase`, { expected: APPROVAL_PHRASES[mode] });
  }
  if (!STAGING_ACCEPTANCE_RE.test(String(stagingAcceptance || ''))) {
    throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production CSP change requires a staging acceptance reference (a ChecksOps GitHub run or PR URL)');
  }
  const expected = String(expectedFingerprint || '').trim();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new GuardError(CODES.INVALID_MANIFEST, `production CSP ${mode} requires expected_snapshot_sha256 from a prior inspect run`);
  if (expected !== liveFingerprint) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'live production distribution, policy or index.html changed since the inspect run', { expected_snapshot_sha256: expected, actual_snapshot_sha256: liveFingerprint });
  }
}

function appendGithubOutput(values, env = process.env) {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, `${Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/[\r\n]+/g, ' ')}`).join('\n')}\n`);
}

function writeState(root, name, data) {
  const dir = path.join(root, LOCAL_STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, data);
  return file;
}

export async function run(env = process.env, deps = {}) {
  const root = deps.root || repoRoot;
  const mode = String(env.CHECKSOPS_PRODUCTION_CSP_MODE || 'inspect').trim();
  if (!['inspect', 'enforce', 'revert', 'verify'].includes(mode)) throw new GuardError(CODES.INVALID_MANIFEST, 'mode must be inspect, enforce, revert or verify');
  const identity = workflowIdentity(env);
  const template = deps.template || loadTemplatePolicy(root);
  const { raw, snapshot } = (deps.readState || readState)(env);
  const baseline = baselinePolicyConfig(template);
  const enforcing = enforcingPolicyConfig(raw.indexHtml, template);
  const { state, problems, fingerprint } = classify(snapshot, baseline, enforcing);
  const summary = {
    distribution_id: DISTRIBUTION_ID,
    policy_id: POLICY_ID,
    snapshot_sha256: fingerprint,
    distribution_etag: snapshot.distribution.ETag || '',
    policy_etag: snapshot.policy?.ETag || '',
    index_html_sha256: snapshot.index.sha256,
    csp_enforcing: enforcing.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy,
  };

  if (mode === 'verify') {
    const expect = String(env.CHECKSOPS_PRODUCTION_CSP_VERIFY_EXPECT || '').trim();
    if (!Object.hasOwn(VERIFY_STATES, expect) || state !== VERIFY_STATES[expect]) throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'post-change production state is not the expected one', { expect, state, problems });
    appendGithubOutput({ ...summary, state: 'VERIFIED' }, env);
    return { ok: true, mode, identity, ...summary, state: 'VERIFIED', mutation: false };
  }

  appendGithubOutput({ ...summary, state, problem_count: problems.length, problems: problems.join(',') }, env);
  if (mode === 'inspect') return { ok: true, mode, identity, ...summary, state, problems, mutation: false };

  const action = actionFor(mode, state);
  if (!action) throw new GuardError(state === 'BLOCKED' ? CODES.DEPLOYMENT_COLLISION : CODES.UNRELATED_MUTATION, `production CSP ${mode} refused in state ${state}`, { state, problems });
  validateChangeInputs({
    mode,
    approval: env.CHECKSOPS_PRODUCTION_CSP_APPROVAL,
    stagingAcceptance: env.CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE,
    expectedFingerprint: env.CHECKSOPS_EXPECTED_SNAPSHOT_SHA256,
    liveFingerprint: fingerprint,
  });
  const approval = { approved: true, workstream_id: identity.workstreamId, phrase: APPROVAL_PHRASES[mode], approver: identity.operator };
  const stagingAcceptance = { ok: true, reference: String(env.CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE) };

  const lease = (deps.acquireLease || acquireLease)(root, {
    workstream_id: identity.workstreamId,
    component: TARGET_COMPONENT,
    environment: TARGET_ENVIRONMENT,
    commit: identity.commit,
    operator: identity.operator,
  });
  if (!lease.ok) throw new GuardError(lease.code, lease.message, lease.details || {});

  const issued = (deps.issueReceipt || issueReceiptWithSigner)(root, {
    workstream_id: identity.workstreamId,
    branch: identity.branch,
    commit: identity.commit,
    operator: identity.operator,
    target_environment: TARGET_ENVIRONMENT,
    target_component: TARGET_COMPONENT,
    deployment_type: DEPLOYMENT_TYPE,
    owned_components: [...OWNED_COMPONENTS[action]],
    preflight_live_fingerprint: snapshot,
    production_fingerprint: { snapshot_sha256: fingerprint },
    immediately_before_fingerprint: { snapshot_sha256: fingerprint },
    staging_acceptance: stagingAcceptance,
    approval,
    lease: lease.details.lease,
  }, deps.signer || ((unsigned) => signReceiptWithKms(unsigned, { env })));
  if (!issued.ok) throw new GuardError(issued.code, issued.message, issued.details || {});

  const inputPath = writeState(root, 'github-production-csp-input.json', JSON.stringify({
    mode,
    action,
    workstream_id: identity.workstreamId,
    commit: identity.commit,
    operator: identity.operator,
    receipt_path: issued.details.file,
    snapshot_sha256: fingerprint,
    staging_acceptance: stagingAcceptance,
    approval,
  }, null, 2));
  appendGithubOutput({ csp_input: inputPath, receipt_path: issued.details.file, workstream_id: identity.workstreamId, action }, env);
  return { ok: true, mode, identity, ...summary, state, action, mutation: false, authorization: { lease: lease.details.lease, receiptFile: issued.details.file, cspInput: inputPath } };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  run().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || CODES.DEPLOYMENT_COLLISION, message: error?.message || String(error), details: error?.details || {} }, null, 2)}\n`);
    process.exitCode = 2;
  });
}
