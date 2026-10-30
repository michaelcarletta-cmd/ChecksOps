#!/usr/bin/env node
/**
 * GitHub-hosted guarded preflight for the staging browser security headers (SPA CSP rollout
 * step 1, ops/security/SPA_CSP_ROLLOUT.md). Staging distribution E1CG52WRQZI7X1 only.
 *
 * inspect:  read the distribution, the policy checksops-staging-browser-security-headers and the
 *           live staging index.html; report READY, ATTACHED_CURRENT, ATTACHED_STALE or BLOCKED and
 *           the exact report-only CSP the apply would set. Never writes AWS.
 * apply:    same read, then requires the snapshot SHA-256 from a prior inspect and the exact phrase
 *           ATTACH REPORT-ONLY CSP TO STAGING, takes the staging-frontend lease and issues a
 *           KMS-signed receipt whose preflight fingerprint is the whole snapshot, for
 *           staging-csp-headers.mjs, the only writer.
 * rollback: as apply with DETACH CSP FROM STAGING; the writer restores the previous
 *           ResponseHeadersPolicyId (none).
 * verify:   after apply the policy is attached and current; after rollback nothing is attached.
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
  POLICY_NAME,
  TARGET_COMPONENT,
  TARGET_ENVIRONMENT,
  actionFor,
  classify,
  desiredPolicyConfig,
  loadTemplatePolicy,
  readState,
} from './staging-csp-headers.mjs';

export const APPROVAL_PHRASES = Object.freeze({
  apply: 'ATTACH REPORT-ONLY CSP TO STAGING',
  rollback: 'DETACH CSP FROM STAGING',
});
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function workflowIdentity(env = process.env) {
  const commit = String(env.GITHUB_SHA || '').trim();
  const branch = String(env.GITHUB_REF_NAME || '').trim();
  const actor = String(env.GITHUB_ACTOR || '').trim();
  const runId = String(env.GITHUB_RUN_ID || '').trim();
  if (!/^[0-9a-f]{40}$/.test(commit) || !branch || !actor || !runId) {
    throw new GuardError(CODES.ANONYMOUS_DEPLOYMENT, 'GitHub workflow identity is incomplete');
  }
  if (branch !== 'main') throw new GuardError(CODES.UNRELATED_MUTATION, 'guarded staging CSP change may only run from main', { branch });
  return { commit, branch, operator: actor, workstreamId: `github-staging-csp-${runId}` };
}

export function validateChangeInputs({ mode, approval, expectedFingerprint, liveFingerprint }) {
  if (approval !== APPROVAL_PHRASES[mode]) {
    throw new GuardError(CODES.INVALID_MANIFEST, `staging CSP ${mode} requires the exact approval phrase`, { expected: APPROVAL_PHRASES[mode] });
  }
  const expected = String(expectedFingerprint || '').trim();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new GuardError(CODES.INVALID_MANIFEST, `staging CSP ${mode} requires expected_snapshot_sha256 from a prior inspect run`);
  if (expected !== liveFingerprint) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'live staging distribution, policy or index.html changed since the inspect run', { expected_snapshot_sha256: expected, actual_snapshot_sha256: liveFingerprint });
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
  const mode = String(env.CHECKSOPS_STAGING_CSP_MODE || 'inspect').trim();
  if (!['inspect', 'apply', 'rollback', 'verify'].includes(mode)) throw new GuardError(CODES.INVALID_MANIFEST, 'mode must be inspect, apply, rollback or verify');
  const identity = workflowIdentity(env);
  const template = deps.template || loadTemplatePolicy(root);
  const { raw, snapshot } = (deps.readState || readState)(env);
  const desired = desiredPolicyConfig(raw.indexHtml, template);
  const { state, problems, fingerprint } = classify(snapshot, desired);
  const summary = {
    distribution_id: DISTRIBUTION_ID,
    snapshot_sha256: fingerprint,
    distribution_etag: snapshot.distribution.ETag || '',
    response_headers_policy_id: snapshot.distribution.DefaultResponseHeadersPolicyId || 'none',
    policy_id: snapshot.policy?.Id || 'none',
    index_html_sha256: snapshot.index.sha256,
    csp_report_only: desired.CustomHeadersConfig.Items[0].Value,
  };

  if (mode === 'verify') {
    const expect = String(env.CHECKSOPS_STAGING_CSP_VERIFY_EXPECT || '').trim();
    const okState = { attached: state === 'ATTACHED_CURRENT', detached: state === 'READY' }[expect];
    if (!okState) throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'post-change staging state is not the expected one', { expect, state, problems });
    appendGithubOutput({ ...summary, state: 'VERIFIED' }, env);
    return { ok: true, mode, identity, ...summary, state: 'VERIFIED', mutation: false };
  }

  appendGithubOutput({ ...summary, state, problem_count: problems.length, problems: problems.join(',') }, env);
  if (mode === 'inspect') return { ok: true, mode, identity, ...summary, state, problems, mutation: false };

  const action = actionFor(mode, state);
  if (!action) throw new GuardError(state === 'BLOCKED' ? CODES.DEPLOYMENT_COLLISION : CODES.UNRELATED_MUTATION, `staging CSP ${mode} refused in state ${state}`, { state, problems });
  validateChangeInputs({ mode, approval: env.CHECKSOPS_STAGING_CSP_APPROVAL, expectedFingerprint: env.CHECKSOPS_EXPECTED_SNAPSHOT_SHA256, liveFingerprint: fingerprint });
  const approval = { approved: true, workstream_id: identity.workstreamId, phrase: APPROVAL_PHRASES[mode], approver: identity.operator };

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
    approval,
    lease: lease.details.lease,
  }, deps.signer || ((unsigned) => signReceiptWithKms(unsigned, { env })));
  if (!issued.ok) throw new GuardError(issued.code, issued.message, issued.details || {});

  const inputPath = writeState(root, 'github-staging-csp-input.json', JSON.stringify({
    mode,
    action,
    workstream_id: identity.workstreamId,
    commit: identity.commit,
    operator: identity.operator,
    receipt_path: issued.details.file,
    snapshot_sha256: fingerprint,
    policy_name: POLICY_NAME,
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
