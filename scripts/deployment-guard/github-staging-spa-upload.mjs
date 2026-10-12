#!/usr/bin/env node
/**
 * GitHub Actions preflight for the guarded staging SPA upload.
 *
 * inspect: reads the live staging index.html fingerprint only.
 * apply:   requires the reviewed live index.html SHA-256 from a prior inspect,
 *          a fresh `vite build --mode aws` for staging.checksops.com, and
 *          passing accepted-contract tests; then evaluates spa-promote, takes
 *          the staging-frontend lease and issues a KMS-signed receipt for
 *          staging-spa-upload.mjs. This script never writes S3 or CloudFront.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContractRegistry, relevantContracts } from './lib/contracts.mjs';
import { CODES, GuardError } from './lib/errors.mjs';
import { evaluateDeployment } from './lib/guard.mjs';
import { signReceiptWithKms } from './lib/kms-issuer.mjs';
import { acquireLease } from './lib/lease.mjs';
import { issueReceiptWithSigner } from './lib/receipt.mjs';
import { readLiveIndexFingerprint } from './staging-spa-upload.mjs';

export const STAGING_APP_URL = 'https://staging.checksops.com';
const TARGET_ENVIRONMENT = 'staging';
const TARGET_COMPONENT = 'staging-frontend';
const HEX64 = /^[0-9a-f]{64}$/i;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function workflowIdentity(env = process.env) {
  const commit = String(env.GITHUB_SHA || '').trim();
  const branch = String(env.GITHUB_REF_NAME || '').trim();
  const actor = String(env.GITHUB_ACTOR || '').trim();
  const runId = String(env.GITHUB_RUN_ID || '').trim();
  if (!/^[0-9a-f]{40}$/.test(commit) || !branch || !actor || !runId) {
    throw new GuardError(CODES.ANONYMOUS_DEPLOYMENT, 'GitHub workflow identity is incomplete');
  }
  if (branch !== 'main') {
    throw new GuardError(CODES.UNRELATED_MUTATION, 'guarded staging SPA upload may only run from main', { branch });
  }
  return {
    commit,
    branch,
    operator: actor,
    workstreamId: `github-staging-spa-${runId}`,
  };
}

export function validateExpectedIndexHash(actual, expected) {
  if (!HEX64.test(String(expected || ''))) {
    return { ok: false, code: CODES.INVALID_MANIFEST, message: 'apply mode requires the 64-character live index.html SHA-256 from a prior inspect' };
  }
  if (String(actual || '').toLowerCase() !== String(expected).toLowerCase()) {
    return {
      ok: false,
      code: CODES.DEPLOYMENT_COLLISION,
      message: 'live staging index.html changed since the reviewed inspect; stop and never put an old index.html back',
      details: { expected_live_index_sha256: expected, actual_live_index_sha256: actual },
    };
  }
  return { ok: true, details: { index_html_sha256: actual } };
}

export function validateStagingBuildEnv(env = process.env) {
  const errors = [];
  if (String(env.VITE_APP_URL || '').trim() !== STAGING_APP_URL) {
    errors.push(`VITE_APP_URL must be exactly ${STAGING_APP_URL}`);
  }
  if (String(env.VITE_AUTH_PROVIDER || '').trim().toLowerCase() !== 'cognito') {
    errors.push('VITE_AUTH_PROVIDER must be cognito');
  }
  for (const key of ['VITE_CHECKSOPS_API_URL', 'VITE_AWS_REGION', 'VITE_COGNITO_USER_POOL_ID', 'VITE_COGNITO_USER_POOL_CLIENT_ID']) {
    if (!String(env[key] || '').trim()) errors.push(`${key} is required`);
  }
  for (const key of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']) {
    if (String(env[key] || '').trim()) errors.push(`${key} must be unset for a staging AWS build`);
  }
  if (errors.length) {
    return { ok: false, code: CODES.INVALID_MANIFEST, message: 'staging SPA build environment is invalid', details: { errors } };
  }
  return { ok: true, details: { app_url: STAGING_APP_URL } };
}

export function inspectCandidateDist(distDir) {
  const indexPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return { ok: false, code: CODES.STALE_PACKAGE, message: 'fresh dist/index.html is required' };
  }
  const html = fs.readFileSync(indexPath, 'utf8');
  const entry = html.match(/\/assets\/index-[^"'\s]+\.js/)?.[0] || null;
  if (!entry || !fs.existsSync(path.join(distDir, entry))) {
    return { ok: false, code: CODES.STALE_PACKAGE, message: 'candidate dist is missing its referenced entry bundle', details: { entry } };
  }
  return { ok: true, details: { entry_bundle: entry } };
}

const defaultContractRunner = (testPath) => {
  const args = testPath.endsWith('.test.mjs')
    ? ['--experimental-strip-types', '--test', testPath]
    : [testPath];
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8', stdio: 'inherit' });
  return result.status === 0;
};

/** Execute every accepted contract that applies to a staging SPA promote; a missing test fails. */
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

export function buildSpaPromoteInput(identity, live, candidate, contractResults, buildTimestamp) {
  const fingerprint = { index_html_sha256: live.index_html_sha256, entry_bundle: live.entry_bundle };
  return {
    workstream_id: identity.workstreamId,
    branch: identity.branch,
    commit: identity.commit,
    operator: identity.operator,
    target_environment: TARGET_ENVIRONMENT,
    target_component: TARGET_COMPONENT,
    deployment_type: 'spa-promote',
    owned_components: ['index.html'],
    preflight: fingerprint,
    preflight_live_fingerprint: fingerprint,
    immediately_before: fingerprint,
    dist: { clean_build: true, entry_bundle: candidate.entry_bundle },
    clean_build: true,
    build_timestamp: buildTimestamp,
    frontend_workstreams: [identity.workstreamId],
    source_composition_manifest: { source: 'main', commit: identity.commit },
    contract_results: contractResults,
    apply: false,
  };
}

function appendGithubOutput(values, env = process.env) {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value)}`).join('\n');
  fs.appendFileSync(file, `${lines}\n`);
}

export async function run(env = process.env, deps = {}) {
  const mode = String(env.CHECKSOPS_STAGING_DEPLOY_MODE || 'inspect').trim();
  if (!['inspect', 'apply'].includes(mode)) {
    throw new GuardError(CODES.INVALID_MANIFEST, 'mode must be inspect or apply');
  }
  const identity = workflowIdentity(env);
  // Lease, receipt and dist live under `root`; tests pass a temporary one.
  const root = deps.root || repoRoot;
  const readLive = deps.readLive || (() => readLiveIndexFingerprint(undefined, env));
  const live = readLive();
  if (!live?.index_html_sha256 || !live?.entry_bundle) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'live staging index.html fingerprint is incomplete');
  }
  appendGithubOutput({
    live_index_html_sha256: live.index_html_sha256,
    live_entry_bundle: live.entry_bundle,
    live_etag: live.etag || '',
    live_last_modified: live.last_modified || '',
  }, env);

  if (mode === 'inspect') {
    return { ok: true, mode, identity, live, mutation: false };
  }

  const expected = validateExpectedIndexHash(live.index_html_sha256, env.CHECKSOPS_EXPECTED_LIVE_INDEX_SHA256);
  if (!expected.ok) throw new GuardError(expected.code, expected.message, expected.details || {});
  const buildEnv = validateStagingBuildEnv(deps.buildEnv || env);
  if (!buildEnv.ok) throw new GuardError(buildEnv.code, buildEnv.message, buildEnv.details || {});
  const candidate = inspectCandidateDist(path.resolve(root, env.CHECKSOPS_STAGING_SPA_DIST || 'dist'));
  if (!candidate.ok) throw new GuardError(candidate.code, candidate.message, candidate.details || {});
  if (candidate.details.entry_bundle === live.entry_bundle) {
    throw new GuardError(CODES.STALE_PACKAGE, 'candidate entry bundle equals the live entry; refuse redeploying the same build');
  }

  const registry = deps.registry || loadContractRegistry(repoRoot);
  const contractResults = runContractTests(registry, { runner: deps.contractRunner });
  const input = buildSpaPromoteInput(
    identity,
    live,
    candidate.details,
    contractResults,
    env.CHECKSOPS_BUILD_TIMESTAMP || new Date().toISOString(),
  );
  const evaluated = evaluateDeployment(input, { root: repoRoot, env, registry });
  if (!evaluated.ok) {
    throw new GuardError(evaluated.code || CODES.DEPLOYMENT_GUARD_REQUIRED, evaluated.message || 'spa-promote evaluation failed', {
      errors: evaluated.errors || [],
    });
  }

  const lease = acquireLease(root, {
    workstream_id: identity.workstreamId,
    component: TARGET_COMPONENT,
    environment: TARGET_ENVIRONMENT,
    commit: identity.commit,
    operator: identity.operator,
  });
  if (!lease.ok) throw new GuardError(lease.code, lease.message, lease.details || {});

  const signer = deps.signer || ((unsigned) => signReceiptWithKms(unsigned, { env }));
  const issued = issueReceiptWithSigner(root, { ...input, lease: lease.details.lease }, signer);
  if (!issued.ok) throw new GuardError(issued.code, issued.message, issued.details || {});

  appendGithubOutput({
    receipt_path: issued.details.file,
    workstream_id: identity.workstreamId,
    candidate_entry_bundle: candidate.details.entry_bundle,
  }, env);

  return {
    ok: true,
    mode,
    identity,
    live,
    candidate: candidate.details,
    contracts: contractResults,
    mutation: false,
    authorization: { lease: lease.details.lease, receiptFile: issued.details.file },
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
