#!/usr/bin/env node
/**
 * GitHub-hosted guarded preflight for the production CloudFront Function
 * checksops-production-spa-fallback (ops/deployment-guard/PRODUCTION_SPA_FALLBACK.md). The function
 * on the default behavior of E1B0ZWWO5559U5 only; the distribution is never changed.
 *
 * inspect: read both function stages, the distribution and the marketing page objects in the
 *          production bucket; report BASELINE, CURRENT or BLOCKED, the snapshot SHA-256, the code
 *          SHA-256s and any page problems. Never writes AWS.
 * publish: same read, then requires the snapshot SHA-256 from a prior inspect, the exact phrase
 *          PUBLISH SPA FALLBACK TO PRODUCTION and a staging acceptance reference, takes the
 *          production-spa lease and issues a KMS-signed receipt whose preflight fingerprint is the
 *          whole snapshot, for production-spa-fallback.mjs, the only writer.
 * revert:  as publish with REVERT SPA FALLBACK ON PRODUCTION; the writer puts the baseline back.
 * verify:  after publish LIVE runs the repo function and every page object is served as HTML;
 *          after revert LIVE runs the baseline.
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
  FUNCTION_NAME,
  OWNED_COMPONENTS,
  TARGET_COMPONENT,
  TARGET_ENVIRONMENT,
  actionFor,
  classify,
  loadFunctionSources,
  readState,
} from './production-spa-fallback.mjs';

export const APPROVAL_PHRASES = Object.freeze({
  publish: 'PUBLISH SPA FALLBACK TO PRODUCTION',
  revert: 'REVERT SPA FALLBACK ON PRODUCTION',
});
const STAGING_ACCEPTANCE_RE = /^https:\/\/github\.com\/michaelcarletta-cmd\/ChecksOps\/(actions\/runs\/\d+(\/job\/\d+)?|pull\/\d+)$/;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function workflowIdentity(env = process.env) {
  const commit = String(env.GITHUB_SHA || '').trim();
  const branch = String(env.GITHUB_REF_NAME || '').trim();
  const actor = String(env.GITHUB_ACTOR || '').trim();
  const runId = String(env.GITHUB_RUN_ID || '').trim();
  if (!/^[0-9a-f]{40}$/.test(commit) || !branch || !actor || !runId) {
    throw new GuardError(CODES.ANONYMOUS_DEPLOYMENT, 'GitHub workflow identity is incomplete');
  }
  if (branch !== 'main') throw new GuardError(CODES.UNRELATED_MUTATION, 'guarded production SPA fallback change may only run from main', { branch });
  return { commit, branch, operator: actor, workstreamId: `github-production-spa-fallback-${runId}` };
}

export function validateChangeInputs({ mode, approval, stagingAcceptance, expectedFingerprint, liveFingerprint }) {
  if (!Object.hasOwn(APPROVAL_PHRASES, mode) || approval !== APPROVAL_PHRASES[mode]) {
    throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, `production SPA fallback ${mode} requires the exact approval phrase`, { expected: APPROVAL_PHRASES[mode] });
  }
  if (!STAGING_ACCEPTANCE_RE.test(String(stagingAcceptance || ''))) {
    throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production SPA fallback change requires a staging acceptance reference (a ChecksOps GitHub run or PR URL)');
  }
  const expected = String(expectedFingerprint || '').trim();
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new GuardError(CODES.INVALID_MANIFEST, `production SPA fallback ${mode} requires expected_snapshot_sha256 from a prior inspect run`);
  if (expected !== liveFingerprint) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'live production function, distribution or page objects changed since the inspect run', { expected_snapshot_sha256: expected, actual_snapshot_sha256: liveFingerprint });
  }
}

/** verify: current = LIVE runs the repo function and every page object is HTML; baseline = LIVE runs the baseline. */
export function verifyState(expect, checked) {
  if (expect === 'current') return checked.state === 'CURRENT' && checked.page_problems.length === 0;
  if (expect === 'baseline') return checked.live_version === 'BASELINE' && checked.drift_problems.length === 0;
  return false;
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
  const mode = String(env.CHECKSOPS_PRODUCTION_SPA_FALLBACK_MODE || 'inspect').trim();
  if (!['inspect', 'publish', 'revert', 'verify'].includes(mode)) throw new GuardError(CODES.INVALID_MANIFEST, 'mode must be inspect, publish, revert or verify');
  const identity = workflowIdentity(env);
  const sources = deps.sources || loadFunctionSources(root);
  const { snapshot } = (deps.readState || readState)(env);
  const checked = classify(snapshot, sources);
  const { state, problems, fingerprint } = checked;
  const summary = {
    distribution_id: DISTRIBUTION_ID,
    function_name: FUNCTION_NAME,
    snapshot_sha256: fingerprint,
    distribution_etag: snapshot.distribution.ETag || '',
    live_etag: snapshot.function.live?.etag || '',
    development_etag: snapshot.function.development?.etag || '',
    live_code_sha256: snapshot.function.live?.code_sha256 || '',
    development_code_sha256: snapshot.function.development?.code_sha256 || '',
    baseline_code_sha256: sources.baseline_sha256,
    current_code_sha256: sources.current_sha256,
  };

  if (mode === 'verify') {
    const expect = String(env.CHECKSOPS_PRODUCTION_SPA_FALLBACK_VERIFY_EXPECT || '').trim();
    if (!verifyState(expect, checked)) throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'post-change production state is not the expected one', { expect, state, problems });
    appendGithubOutput({ ...summary, state: 'VERIFIED' }, env);
    return { ok: true, mode, identity, ...summary, state: 'VERIFIED', mutation: false };
  }

  appendGithubOutput({ ...summary, state, problem_count: problems.length, problems: problems.join(','), page_problems: checked.page_problems.join(',') }, env);
  if (mode === 'inspect') return { ok: true, mode, identity, ...summary, state, problems, page_problems: checked.page_problems, mutation: false };

  const action = actionFor(mode, state);
  if (!action) throw new GuardError(state === 'BLOCKED' ? CODES.DEPLOYMENT_COLLISION : CODES.UNRELATED_MUTATION, `production SPA fallback ${mode} refused in state ${state}`, { state, problems });
  validateChangeInputs({
    mode,
    approval: env.CHECKSOPS_PRODUCTION_SPA_FALLBACK_APPROVAL,
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

  const inputPath = writeState(root, 'github-production-spa-fallback-input.json', JSON.stringify({
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
  appendGithubOutput({ fallback_input: inputPath, receipt_path: issued.details.file, workstream_id: identity.workstreamId, action }, env);
  return { ok: true, mode, identity, ...summary, state, action, mutation: false, authorization: { lease: lease.details.lease, receiptFile: issued.details.file, fallbackInput: inputPath } };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  run().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || CODES.DEPLOYMENT_COLLISION, message: error?.message || String(error), details: error?.details || {} }, null, 2)}\n`);
    process.exitCode = 2;
  });
}
