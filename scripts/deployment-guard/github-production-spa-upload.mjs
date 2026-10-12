#!/usr/bin/env node
/**
 * GitHub Actions preflight for the guarded production SPA upload (checksops.com).
 *
 * inspect: reads the live production index.html fingerprint and compares it with the
 *          production-spa release lock. Never writes.
 * apply:   requires the live index.html SHA-256 from a prior inspect, live == release
 *          lock, the locked live source as an ancestor of this main commit (so the
 *          build composes every live frontend change), a fresh `vite build --mode aws`
 *          for checksops.com, every accepted contract passing, a staging acceptance
 *          reference verified on GitHub and the exact approval phrase. It then evaluates spa-promote,
 *          takes the production-spa lease, issues a receipt and writes the input for
 *          production-spa-upload.mjs. This script never writes S3 or CloudFront.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContractRegistry, relevantContracts } from './lib/contracts.mjs';
import { CODES, GuardError } from './lib/errors.mjs';
import { evaluateDeployment } from './lib/guard.mjs';
import { acquireLease } from './lib/lease.mjs';
import { distFingerprint } from './lib/production-spa-upload.mjs';
import { issueReceipt } from './lib/receipt.mjs';

export const PRODUCTION_APP_URL = 'https://checksops.com';
export const PRODUCTION_BUCKET = 'checksops-production-frontend-806168576068';
export const APPROVAL_PHRASE = 'DEPLOY WEBSITE TO PRODUCTION';
// Production Cognito values from .env.production.aws.example; the staging pool must never ship.
export const PRODUCTION_BUILD_ENV = Object.freeze({
  VITE_AUTH_PROVIDER: 'cognito',
  VITE_APP_URL: PRODUCTION_APP_URL,
  VITE_CHECKSOPS_API_URL: '/prep',
  VITE_AWS_REGION: 'us-east-1',
  VITE_COGNITO_USER_POOL_ID: 'us-east-1_h00WorYMT',
  VITE_COGNITO_USER_POOL_CLIENT_ID: '3ja9fqaq2fjkv3i6up2varcqpe',
});
const TARGET_ENVIRONMENT = 'production';
const TARGET_COMPONENT = 'production-spa';
const LOCK_REL = 'ops/release-locks/locked-components.json';
const HEX64 = /^[0-9a-f]{64}$/i;
const STAGING_ACCEPTANCE_RE = /^https:\/\/github\.com\/michaelcarletta-cmd\/ChecksOps\/(actions\/runs\/\d+(\/job\/\d+)?|pull\/\d+)$/;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const entryFromHtml = (html) => String(html || '').match(/\/assets\/index-[^"'\s]+\.js/)?.[0] || null;

export function workflowIdentity(env = process.env) {
  const commit = String(env.GITHUB_SHA || '').trim();
  const branch = String(env.GITHUB_REF_NAME || '').trim();
  const actor = String(env.GITHUB_ACTOR || '').trim();
  const runId = String(env.GITHUB_RUN_ID || '').trim();
  if (!/^[0-9a-f]{40}$/.test(commit) || !branch || !actor || !runId) {
    throw new GuardError(CODES.ANONYMOUS_DEPLOYMENT, 'GitHub workflow identity is incomplete');
  }
  if (branch !== 'main') {
    throw new GuardError(CODES.UNRELATED_MUTATION, 'guarded production SPA upload may only run from main', { branch });
  }
  return { commit, branch, operator: actor, workstreamId: `github-production-spa-${runId}` };
}

/** Live production index.html, read-only. */
export async function readLiveIndexFingerprint() {
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const res = await new S3Client({ region: 'us-east-1' }).send(new GetObjectCommand({ Bucket: PRODUCTION_BUCKET, Key: 'index.html' }));
  const html = await res.Body.transformToString('utf8');
  return {
    index_html_sha256: sha256(html),
    entry_bundle: entryFromHtml(html),
    etag: String(res.ETag || '').replaceAll('"', ''),
    last_modified: res.LastModified ? new Date(res.LastModified).toISOString() : null,
    s3_version_id: res.VersionId || null,
  };
}

export function loadProductionSpaLock(root = repoRoot) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, LOCK_REL), 'utf8')).components?.[TARGET_COMPONENT];
  const fp = lock?.deployment_fingerprint || {};
  if (!fp.spa_bundle || !HEX64.test(String(fp.config_hash || '')) || !/^[0-9a-f]{40}$/.test(String(lock?.source?.git_sha || ''))) {
    throw new GuardError(CODES.INVALID_MANIFEST, 'production-spa release lock is missing its live fingerprint or source');
  }
  return { spa_bundle: fp.spa_bundle, index_html_sha256: fp.config_hash, source_git_sha: lock.source.git_sha };
}

/** Production must still be the locked baseline; anything else is drift nobody reconciled. */
export function validateLiveMatchesLock(live, lock) {
  if (live.entry_bundle !== lock.spa_bundle || live.index_html_sha256 !== lock.index_html_sha256) {
    return {
      ok: false,
      code: CODES.DEPLOYMENT_COLLISION,
      message: 'live production index.html is not the release-locked baseline; stop and reconcile before deploying',
      details: { live_entry_bundle: live.entry_bundle, locked_entry_bundle: lock.spa_bundle },
    };
  }
  return { ok: true };
}

export function validateExpectedIndexHash(actual, expected) {
  if (!HEX64.test(String(expected || ''))) {
    return { ok: false, code: CODES.INVALID_MANIFEST, message: 'apply mode requires the 64-character live index.html SHA-256 from a prior inspect' };
  }
  if (String(actual || '').toLowerCase() !== String(expected).toLowerCase()) {
    return {
      ok: false,
      code: CODES.DEPLOYMENT_COLLISION,
      message: 'live production index.html changed since the reviewed inspect; stop',
      details: { expected_live_index_sha256: expected, actual_live_index_sha256: actual },
    };
  }
  return { ok: true };
}

export function validateApplyInputs({ approval, stagingAcceptance }) {
  if (approval !== APPROVAL_PHRASE) {
    throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production SPA apply requires the exact approval phrase', { expected: APPROVAL_PHRASE });
  }
  if (!STAGING_ACCEPTANCE_RE.test(String(stagingAcceptance || ''))) {
    throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production SPA apply requires a ChecksOps GitHub run or PR URL recording staging acceptance');
  }
}

export function validateProductionBuildEnv(env = process.env) {
  const errors = [];
  for (const [key, value] of Object.entries(PRODUCTION_BUILD_ENV)) {
    if (String(env[key] || '').trim() !== value) errors.push(`${key} must be exactly ${value}`);
  }
  for (const key of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY']) {
    if (String(env[key] || '').trim()) errors.push(`${key} must be unset for a production AWS build`);
  }
  if (errors.length) {
    return { ok: false, code: CODES.INVALID_MANIFEST, message: 'production SPA build environment is invalid', details: { errors } };
  }
  return { ok: true };
}

const defaultIsAncestor = (ancestor, commit) => spawnSync('git', ['merge-base', '--is-ancestor', ancestor, commit], { cwd: repoRoot }).status === 0;

/** The build must contain every change in the live source, so nothing on production is dropped. */
export function validateSourceComposition(lock, commit, { isAncestor = defaultIsAncestor } = {}) {
  if (!isAncestor(lock.source_git_sha, commit)) {
    return {
      ok: false,
      code: CODES.SOURCE_COMPOSITION_REQUIRED,
      message: 'the locked live production source is not an ancestor of this commit; combine the frontend sources first',
      details: { live_source: lock.source_git_sha, commit },
    };
  }
  return { ok: true, details: { live_source: lock.source_git_sha, commit, live_source_is_ancestor: true } };
}

/**
 * The staging acceptance reference must be real: a successful ChecksOps run or a merged
 * ChecksOps PR whose commit is this commit or one of its ancestors.
 */
export async function verifyStagingAcceptance(reference, commit, { fetchImpl = globalThis.fetch, token, isAncestor = defaultIsAncestor } = {}) {
  const match = String(reference || '').match(STAGING_ACCEPTANCE_RE);
  if (!match) throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'staging acceptance must be a ChecksOps GitHub run or PR URL');
  if (!token) throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'GITHUB_TOKEN is required to verify the staging acceptance reference');
  const api = 'https://api.github.com/repos/michaelcarletta-cmd/ChecksOps';
  const runId = reference.match(/\/actions\/runs\/(\d+)/)?.[1];
  const prNumber = reference.match(/\/pull\/(\d+)$/)?.[1];
  const res = await fetchImpl(runId ? `${api}/actions/runs/${runId}` : `${api}/pulls/${prNumber}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  });
  if (!res?.ok) {
    throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'staging acceptance reference could not be read from GitHub', { status: res?.status ?? null });
  }
  const body = await res.json();
  let sha;
  if (runId) {
    if (body.status !== 'completed' || body.conclusion !== 'success') {
      throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'staging acceptance run did not succeed', { status: body.status, conclusion: body.conclusion });
    }
    sha = body.head_sha;
  } else {
    if (body.merged !== true) throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'staging acceptance PR is not merged');
    sha = body.merge_commit_sha;
  }
  if (!/^[0-9a-f]{40}$/.test(String(sha || '')) || !isAncestor(sha, commit)) {
    throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'staging acceptance is not for this commit or one of its ancestors', { accepted_sha: sha || null, commit });
  }
  return { ok: true, reference, accepted_sha: sha, kind: runId ? 'run' : 'pull' };
}

const defaultContractRunner = (testPath) => {
  const args = testPath.endsWith('.test.mjs') ? ['--experimental-strip-types', '--test', testPath] : [testPath];
  return spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8', stdio: 'inherit' }).status === 0;
};

/** Execute every accepted contract that applies to a production SPA promote; a missing test fails. */
export function runContractTests(registry, { runner = defaultContractRunner } = {}) {
  const results = {};
  for (const contract of relevantContracts(registry, {
    environment: TARGET_ENVIRONMENT,
    component: TARGET_COMPONENT,
    deployment_type: 'spa-promote',
  })) {
    if (contract.accepted !== true) continue;
    const testPath = String(contract.test || '');
    if (!testPath || !fs.existsSync(path.join(repoRoot, testPath))) {
      results[contract.id] = { ok: false, reason: 'contract test file is missing', test: testPath || null };
      continue;
    }
    results[contract.id] = runner(testPath) === true ? { ok: true, test: testPath } : { ok: false, test: testPath };
  }
  return results;
}

function appendGithubOutput(values, env = process.env) {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, `${Object.entries(values).map(([key, value]) => `${key}=${String(value)}`).join('\n')}\n`);
}

export async function run(env = process.env, deps = {}) {
  const mode = String(env.CHECKSOPS_PRODUCTION_DEPLOY_MODE || 'inspect').trim();
  if (!['inspect', 'apply'].includes(mode)) throw new GuardError(CODES.INVALID_MANIFEST, 'mode must be inspect or apply');
  const identity = workflowIdentity(env);
  // Lease, receipt, writer input and dist live under `root`; tests pass a temporary one.
  const root = deps.root || repoRoot;
  const live = await (deps.readLive || readLiveIndexFingerprint)();
  if (!HEX64.test(String(live?.index_html_sha256 || '')) || !live?.entry_bundle) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'live production index.html fingerprint is incomplete');
  }
  const lock = deps.lock || loadProductionSpaLock(repoRoot);
  const lockMatch = validateLiveMatchesLock(live, lock);
  appendGithubOutput({
    live_index_html_sha256: live.index_html_sha256,
    live_entry_bundle: live.entry_bundle,
    live_last_modified: live.last_modified || '',
    live_matches_lock: lockMatch.ok,
  }, env);
  if (mode === 'inspect') {
    return { ok: true, mode, identity, live, live_matches_lock: lockMatch.ok, mutation: false };
  }

  const expected = validateExpectedIndexHash(live.index_html_sha256, env.CHECKSOPS_EXPECTED_LIVE_INDEX_SHA256);
  if (!expected.ok) throw new GuardError(expected.code, expected.message, expected.details || {});
  if (!lockMatch.ok) throw new GuardError(lockMatch.code, lockMatch.message, lockMatch.details);
  validateApplyInputs({ approval: env.CHECKSOPS_PRODUCTION_APPROVAL, stagingAcceptance: env.CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE });
  const accepted = await verifyStagingAcceptance(env.CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE, identity.commit, {
    fetchImpl: deps.fetchImpl,
    token: env.GITHUB_TOKEN,
    isAncestor: deps.isAncestor,
  });
  const composition = validateSourceComposition(lock, identity.commit, { isAncestor: deps.isAncestor });
  if (!composition.ok) throw new GuardError(composition.code, composition.message, composition.details);
  const buildEnv = validateProductionBuildEnv(deps.buildEnv || env);
  if (!buildEnv.ok) throw new GuardError(buildEnv.code, buildEnv.message, buildEnv.details);
  const distDir = path.resolve(root, 'dist');
  const candidate = distFingerprint(distDir);
  if (!candidate.ok) throw new GuardError(candidate.code, candidate.message, candidate.details || {});
  if (candidate.details.entry_bundle === live.entry_bundle) {
    throw new GuardError(CODES.STALE_PACKAGE, 'candidate entry bundle equals the live entry; refuse redeploying the same build');
  }

  const registry = deps.registry || loadContractRegistry(repoRoot);
  const contractResults = runContractTests(registry, { runner: deps.contractRunner });
  const fingerprint = { index_html_sha256: live.index_html_sha256, entry_bundle: live.entry_bundle };
  const approval = { approved: true, workstream_id: identity.workstreamId, phrase: APPROVAL_PHRASE, approver: identity.operator };
  const stagingAcceptance = { ok: true, reference: accepted.reference, accepted_sha: accepted.accepted_sha };
  const buildTimestamp = env.CHECKSOPS_BUILD_TIMESTAMP || new Date().toISOString();
  const shared = {
    workstream_id: identity.workstreamId,
    branch: identity.branch,
    commit: identity.commit,
    operator: identity.operator,
    target_environment: TARGET_ENVIRONMENT,
    target_component: TARGET_COMPONENT,
    deployment_type: 'spa-promote',
    owned_components: ['index.html'],
    staging_acceptance: stagingAcceptance,
    approval,
    accepted_source_composition: true,
    source_composition_manifest: { source: 'main', ...composition.details },
    frontend_workstreams: [identity.workstreamId],
    contract_results: contractResults,
    build_timestamp: buildTimestamp,
  };
  const evaluated = evaluateDeployment({
    ...shared,
    preflight: fingerprint,
    preflight_live_fingerprint: fingerprint,
    immediately_before: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    dist: { clean_build: true, entry_bundle: candidate.details.entry_bundle },
    clean_build: true,
    apply: false,
  }, { root: repoRoot, env, registry });
  if (!evaluated.ok) {
    throw new GuardError(evaluated.code || CODES.DEPLOYMENT_GUARD_REQUIRED, evaluated.message || 'production spa-promote evaluation failed', {
      errors: evaluated.errors || [],
    });
  }

  const lease = (deps.acquireLease || acquireLease)(root, {
    workstream_id: identity.workstreamId,
    component: TARGET_COMPONENT,
    environment: TARGET_ENVIRONMENT,
    commit: identity.commit,
    operator: identity.operator,
  });
  if (!lease.ok) throw new GuardError(lease.code, lease.message, lease.details || {});
  // HMAC receipt: issued and consumed inside this one job; the writer re-validates it.
  const issued = (deps.issueReceipt || issueReceipt)(root, {
    workstream_id: identity.workstreamId,
    branch: identity.branch,
    commit: identity.commit,
    operator: identity.operator,
    target_environment: TARGET_ENVIRONMENT,
    target_component: TARGET_COMPONENT,
    deployment_type: 'spa-promote',
    owned_components: ['index.html'],
    preflight_live_fingerprint: fingerprint,
    lease: lease.details.lease,
  });
  if (!issued.ok) throw new GuardError(issued.code, issued.message, issued.details || {});

  const inputPath = path.join(root, '.deployment-guard', 'github-production-spa-input.json');
  fs.mkdirSync(path.dirname(inputPath), { recursive: true });
  fs.writeFileSync(inputPath, JSON.stringify({
    ...shared,
    deploy_mode: 'per_object_put',
    dist_dir: distDir,
    receipt_path: issued.details.file,
  }, null, 2));
  appendGithubOutput({
    receipt_path: issued.details.file,
    workstream_id: identity.workstreamId,
    spa_input: inputPath,
    candidate_entry_bundle: candidate.details.entry_bundle,
    candidate_index_html_sha256: candidate.details.index_html_sha256,
  }, env);
  return {
    ok: true,
    mode,
    identity,
    live,
    candidate: candidate.details,
    contracts: contractResults,
    mutation: false,
    authorization: { lease: lease.details.lease, receiptFile: issued.details.file, spaInput: inputPath },
  };
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  run().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: error?.code || CODES.DEPLOYMENT_COLLISION,
      message: error?.message || String(error),
      details: error?.details || {},
    }, null, 2)}\n`);
    process.exitCode = 2;
  });
}
