#!/usr/bin/env node
/**
 * GitHub-hosted guarded preflight for the production HTTP API CORS allow-list
 * (kiqojucc02: AllowOrigins "*" -> https://checksops.com, https://www.checksops.com).
 *
 * inspect: read the live API, routes, authorizer, CloudFront and prep Lambda and report
 *          READY (baseline "*", everything else pinned), ALREADY_ACCEPTED (allow-list live)
 *          or BLOCKED (drift). Never writes AWS.
 * apply:   same read, then requires the snapshot SHA-256 from a prior inspect, the exact
 *          approval phrase and a staging acceptance reference, takes the production-http-api
 *          lease and issues a KMS-signed receipt whose preflight fingerprint is the whole
 *          snapshot, for production-cors-update.mjs, the only writer.
 * verify:  the allow-list is live and nothing else in the snapshot moved from the pinned shape.
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
  API_ID,
  CORS_DEPLOYMENT_TYPE,
  CORS_OWNED_COMPONENT,
  CORS_TARGET_COMPONENT,
  TARGET_ORIGINS,
  readSnapshot,
  snapshotFingerprint,
  validatePinnedSnapshot,
  validateTightenedSnapshot,
} from './production-cors-update.mjs';

export const APPROVAL_PHRASE = 'TIGHTEN PRODUCTION CORS';
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
  if (branch !== 'main') throw new GuardError(CODES.UNRELATED_MUTATION, 'guarded CORS change may only run from main', { branch });
  return { commit, branch, operator: actor, workstreamId: `github-production-cors-${runId}` };
}

export function classify(snapshot) {
  const pinned = validatePinnedSnapshot(snapshot);
  if (pinned.ok) return { state: 'READY', problems: [], fingerprint: pinned.fingerprint };
  const tightened = validateTightenedSnapshot(snapshot);
  if (tightened.ok) return { state: 'ALREADY_ACCEPTED', problems: [], fingerprint: tightened.fingerprint };
  return { state: 'BLOCKED', problems: pinned.errors, fingerprint: pinned.fingerprint };
}

export function validateApplyInputs({ approval, stagingAcceptance, expectedFingerprint, liveFingerprint }) {
  if (approval !== APPROVAL_PHRASE) {
    throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'CORS apply requires the exact approval phrase', { expected: APPROVAL_PHRASE });
  }
  if (!STAGING_ACCEPTANCE_RE.test(String(stagingAcceptance || ''))) {
    throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production CORS change requires a staging acceptance reference (a ChecksOps GitHub run or PR URL)');
  }
  const expected = String(expectedFingerprint || '').trim();
  if (!expected) throw new GuardError(CODES.INVALID_MANIFEST, 'CORS apply requires expected_snapshot_sha256 from a prior inspect run');
  if (expected !== liveFingerprint) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'live API, CloudFront or Lambda changed since the inspect run', { expected_snapshot_sha256: expected, actual_snapshot_sha256: liveFingerprint });
  }
}

function appendGithubOutput(values, env = process.env) {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, `${Object.entries(values).map(([key, value]) => `${key}=${String(value)}`).join('\n')}\n`);
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
  const mode = String(env.CHECKSOPS_CORS_MODE || 'inspect').trim();
  if (!['inspect', 'apply', 'verify'].includes(mode)) throw new GuardError(CODES.INVALID_MANIFEST, 'mode must be inspect, apply or verify');
  const identity = workflowIdentity(env);
  const snapshot = (deps.readSnapshot || readSnapshot)(env);
  const { state, problems, fingerprint } = classify(snapshot);
  const summary = {
    api_id: API_ID,
    snapshot_sha256: snapshotFingerprint(snapshot),
    allow_origins: JSON.stringify(snapshot.api?.CorsConfiguration?.AllowOrigins || null),
    lambda_revision_id: snapshot.lambda?.RevisionId || '',
    cloudfront_etag: snapshot.cloudfront?.ETag || '',
  };

  if (mode === 'verify') {
    if (state !== 'ALREADY_ACCEPTED') throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'post-apply snapshot does not hold the allow-list with the pinned shape', { state, problems });
    appendGithubOutput({ ...summary, state: 'VERIFIED' }, env);
    return { ok: true, mode, identity, ...summary, state: 'VERIFIED', mutation: false };
  }

  appendGithubOutput({ ...summary, state, problem_count: problems.length, problems: problems.join(',') }, env);
  if (mode === 'inspect') return { ok: true, mode, identity, ...summary, state, problems, mutation: false };

  if (state === 'ALREADY_ACCEPTED') throw new GuardError(CODES.UNRELATED_MUTATION, 'the allow-list is already live; nothing to apply');
  if (state !== 'READY') throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'live API drifted from the pinned shape', { problems });
  validateApplyInputs({
    approval: env.CHECKSOPS_CORS_APPROVAL,
    stagingAcceptance: env.CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE,
    expectedFingerprint: env.CHECKSOPS_EXPECTED_SNAPSHOT_SHA256,
    liveFingerprint: fingerprint,
  });
  const approval = { approved: true, workstream_id: identity.workstreamId, phrase: APPROVAL_PHRASE, approver: identity.operator };
  const stagingAcceptance = { ok: true, reference: String(env.CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE) };

  const lease = (deps.acquireLease || acquireLease)(root, {
    workstream_id: identity.workstreamId,
    component: CORS_TARGET_COMPONENT,
    environment: 'production',
    commit: identity.commit,
    operator: identity.operator,
  });
  if (!lease.ok) throw new GuardError(lease.code, lease.message, lease.details || {});

  const issued = (deps.issueReceipt || issueReceiptWithSigner)(root, {
    workstream_id: identity.workstreamId,
    branch: identity.branch,
    commit: identity.commit,
    operator: identity.operator,
    target_environment: 'production',
    target_component: CORS_TARGET_COMPONENT,
    deployment_type: CORS_DEPLOYMENT_TYPE,
    owned_components: [CORS_OWNED_COMPONENT],
    preflight_live_fingerprint: snapshot,
    production_fingerprint: { snapshot_sha256: fingerprint },
    immediately_before_fingerprint: { snapshot_sha256: fingerprint },
    staging_acceptance: stagingAcceptance,
    approval,
    lease: lease.details.lease,
  }, deps.signer || ((unsigned) => signReceiptWithKms(unsigned, { env })));
  if (!issued.ok) throw new GuardError(issued.code, issued.message, issued.details || {});

  const inputPath = writeState(root, 'github-production-cors-input.json', JSON.stringify({
    workstream_id: identity.workstreamId,
    commit: identity.commit,
    operator: identity.operator,
    receipt_path: issued.details.file,
    snapshot_sha256: fingerprint,
    target_origins: TARGET_ORIGINS,
    staging_acceptance: stagingAcceptance,
    approval,
  }, null, 2));
  appendGithubOutput({ cors_input: inputPath, receipt_path: issued.details.file, workstream_id: identity.workstreamId }, env);
  return { ok: true, mode, identity, ...summary, state, mutation: false, authorization: { lease: lease.details.lease, receiptFile: issued.details.file, corsInput: inputPath } };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  run().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || CODES.DEPLOYMENT_COLLISION, message: error?.message || String(error), details: error?.details || {} }, null, 2)}\n`);
    process.exitCode = 2;
  });
}
