#!/usr/bin/env node
/**
 * GitHub-hosted guarded full-package rebuild preflight for the shared API Lambdas
 * (checksops-staging-api, checksops-production-prep-api).
 *
 * inspect: build the candidate ZIP from this checkout (aws/functions/api plus the
 *          lockfile install the workflow ran), download the live package, and
 *          report every difference against ops/deployment-guard/lambda-rebuild-plan.json.
 *          Never writes AWS. A difference the plan does not list leaves the run
 *          BLOCKED with the list, which is what fills the plan.
 * apply:   same checks, then requires the live CodeSha256 from a prior inspect, the
 *          exact approval phrase (and for production a staging acceptance reference),
 *          takes the lease, issues a KMS-signed receipt owning the candidate ZIP's
 *          SHA-256 and writes the candidate for lambda-rebuild-apply.mjs, the only writer.
 * verify:  the live package equals the candidate member for member.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, GuardError } from './lib/errors.mjs';
import { acquireLease } from './lib/lease.mjs';
import { issueReceiptWithSigner } from './lib/receipt.mjs';
import { signReceiptWithKms } from './lib/kms-issuer.mjs';
import {
  API_PACKAGE_REL,
  REBUILD_DEPLOYMENT_TYPE,
  REBUILD_FUNCTIONS,
  buildCandidatePackage,
  evaluateRebuild,
  fullPackageComponent,
  loadRebuildPlan,
  readPackage,
} from './lib/lambda-rebuild.mjs';
import { LOCAL_STATE_DIR } from './lib/paths.mjs';

const REGION = 'us-east-1';
const STAGING_ACCEPTANCE_RE = /^https:\/\/github\.com\/michaelcarletta-cmd\/ChecksOps\/(actions\/runs\/\d+(\/job\/\d+)?|pull\/\d+)$/;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function approvalPhrase(environment) {
  return `DEPLOY FULL API PACKAGE TO ${String(environment).toUpperCase()}`;
}

export function resolveEnvironment(value) {
  const environment = String(value || '').trim();
  if (!REBUILD_FUNCTIONS[environment]) {
    throw new GuardError(CODES.INVALID_MANIFEST, 'rebuild environment must be staging or production', { environment });
  }
  return { environment, functionName: REBUILD_FUNCTIONS[environment] };
}

export function workflowIdentity(env = process.env, environment) {
  const commit = String(env.GITHUB_SHA || '').trim();
  const branch = String(env.GITHUB_REF_NAME || '').trim();
  const actor = String(env.GITHUB_ACTOR || '').trim();
  const runId = String(env.GITHUB_RUN_ID || '').trim();
  if (!/^[0-9a-f]{40}$/.test(commit) || !branch || !actor || !runId) {
    throw new GuardError(CODES.ANONYMOUS_DEPLOYMENT, 'GitHub workflow identity is incomplete');
  }
  if (branch !== 'main') {
    throw new GuardError(CODES.UNRELATED_MUTATION, 'guarded rebuild may only run from main', { branch });
  }
  return { commit, branch, operator: actor, workstreamId: `github-${environment}-rebuild-${runId}` };
}

export function validateApplyInputs({ environment, approval, stagingAcceptance, expectedLiveCodeSha256, liveCodeSha256 }) {
  if (approval !== approvalPhrase(environment)) {
    throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'rebuild apply requires the exact approval phrase', { expected: approvalPhrase(environment) });
  }
  if (environment === 'production' && !STAGING_ACCEPTANCE_RE.test(String(stagingAcceptance || ''))) {
    throw new GuardError(CODES.PRODUCTION_APPROVAL_REQUIRED, 'production rebuild requires a staging acceptance reference (a ChecksOps GitHub run or PR URL)');
  }
  const expected = String(expectedLiveCodeSha256 || '').trim();
  if (!expected) {
    throw new GuardError(CODES.INVALID_MANIFEST, 'rebuild apply requires expected_live_code_sha256 from a prior inspect run');
  }
  if (expected !== liveCodeSha256) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'live package changed since the inspect run', { expected_live_code_sha256: expected, actual_live_code_sha256: liveCodeSha256 });
  }
}

export async function inspectLive(functionName, { lambda = null, fetchImpl = fetch, loadSdk = (specifier) => import(specifier) } = {}) {
  let client = lambda;
  let command;
  if (!client) {
    const sdk = await loadSdk('@aws-sdk/client-lambda');
    client = new sdk.LambdaClient({ region: REGION });
    command = new sdk.GetFunctionCommand({ FunctionName: functionName });
  } else {
    command = { operation: 'GetFunction', input: { FunctionName: functionName } };
  }
  const live = await client.send(command);
  const codeSha256 = live?.Configuration?.CodeSha256 || null;
  const revisionId = live?.Configuration?.RevisionId || null;
  const location = live?.Code?.Location || null;
  if (!codeSha256 || !revisionId || !location) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'live Lambda fingerprint/code location is incomplete');
  }
  const response = await fetchImpl(location);
  if (!response?.ok) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'failed to download current live Lambda ZIP', { status: response?.status || null });
  }
  const pkg = readPackage(Buffer.from(await response.arrayBuffer()));
  return { functionName, codeSha256, revisionId, runtime: live?.Configuration?.Runtime || null, ...pkg };
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
  const mode = String(env.CHECKSOPS_REBUILD_MODE || 'inspect').trim();
  if (!['inspect', 'apply', 'verify'].includes(mode)) {
    throw new GuardError(CODES.INVALID_MANIFEST, 'mode must be inspect, apply or verify');
  }
  const { environment, functionName } = resolveEnvironment(env.CHECKSOPS_REBUILD_ENVIRONMENT);
  const identity = workflowIdentity(env, environment);
  const plan = { environments: { [environment]: deps.plan || loadRebuildPlan(root, environment) } };
  const candidate = (deps.buildCandidate || buildCandidatePackage)(path.join(root, API_PACKAGE_REL));
  const live = await (deps.inspectLive || inspectLive)(functionName, deps);

  const summary = {
    environment,
    function_name: functionName,
    live_code_sha256: live.codeSha256,
    live_revision_id: live.revisionId,
    live_member_count: live.memberCount,
    candidate_zip_sha256: candidate.zipSha256,
    candidate_member_count: candidate.fileCount,
  };

  if (mode === 'verify') {
    const names = new Set([...Object.keys(candidate.memberHashes), ...Object.keys(live.memberHashes)]);
    const mismatched = [...names].filter((name) => candidate.memberHashes[name] !== live.memberHashes[name]);
    if (mismatched.length) {
      throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'post-apply live package does not equal the candidate', { mismatched: mismatched.slice(0, 50), count: mismatched.length });
    }
    appendGithubOutput({ ...summary, state: 'VERIFIED' }, env);
    return { ok: true, mode, identity, ...summary, state: 'VERIFIED', mutation: false };
  }

  const evaluation = evaluateRebuild({
    plan,
    environment,
    liveMemberHashes: live.memberHashes,
    candidateMemberHashes: candidate.memberHashes,
    liveInventory: live.inventory,
    candidateInventory: candidate.inventory,
  });
  const diff = evaluation.ok ? evaluation.details.diff : evaluation.details.diff;
  const problems = evaluation.ok ? [] : evaluation.details.problems;
  const state = evaluation.ok ? evaluation.details.state : 'BLOCKED';
  const diffFile = writeState(root, `rebuild-diff-${environment}.json`, `${JSON.stringify({ ...summary, state, problems, diff }, null, 2)}\n`);
  appendGithubOutput({
    ...summary,
    state,
    diff_file: diffFile,
    changed_count: diff.changed.length,
    added_count: diff.added.length,
    removed_count: diff.removed.length,
    problem_count: problems.length,
  }, env);

  if (mode === 'inspect') {
    return { ok: true, mode, identity, ...summary, state, problems, diff, mutation: false };
  }
  if (!evaluation.ok) throw new GuardError(evaluation.code, evaluation.message, evaluation.details);
  if (state === 'ALREADY_ACCEPTED') {
    throw new GuardError(CODES.UNRELATED_MUTATION, 'live package already equals the candidate; nothing to apply');
  }

  validateApplyInputs({
    environment,
    approval: env.CHECKSOPS_REBUILD_APPROVAL,
    stagingAcceptance: env.CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE,
    expectedLiveCodeSha256: env.CHECKSOPS_EXPECTED_LIVE_CODE_SHA256,
    liveCodeSha256: live.codeSha256,
  });
  const fingerprint = { codeSha256: live.codeSha256, revisionId: live.revisionId };
  const approval = { approved: true, workstream_id: identity.workstreamId, phrase: approvalPhrase(environment), approver: identity.operator };
  const stagingAcceptance = environment === 'production'
    ? { ok: true, reference: String(env.CHECKSOPS_STAGING_ACCEPTANCE_REFERENCE) }
    : { ok: true, reference: 'staging-is-the-acceptance-environment' };

  const lease = (deps.acquireLease || acquireLease)(root, {
    workstream_id: identity.workstreamId,
    component: functionName,
    environment,
    commit: identity.commit,
    operator: identity.operator,
  });
  if (!lease.ok) throw new GuardError(lease.code, lease.message, lease.details || {});

  const component = fullPackageComponent(candidate.zipSha256);
  const issued = (deps.issueReceipt || issueReceiptWithSigner)(root, {
    workstream_id: identity.workstreamId,
    branch: identity.branch,
    commit: identity.commit,
    operator: identity.operator,
    target_environment: environment,
    target_component: functionName,
    deployment_type: REBUILD_DEPLOYMENT_TYPE,
    owned_components: [component],
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: stagingAcceptance,
    approval,
    lease: lease.details.lease,
  }, deps.signer || ((unsigned) => signReceiptWithKms(unsigned, { env })));
  if (!issued.ok) throw new GuardError(issued.code, issued.message, issued.details || {});

  const zipFile = writeState(root, `rebuild-candidate-${environment}.zip`, candidate.zip);
  const inputPath = writeState(root, `github-${environment}-rebuild-input.json`, JSON.stringify({
    workstream_id: identity.workstreamId,
    branch: identity.branch,
    commit: identity.commit,
    operator: identity.operator,
    target_environment: environment,
    target_component: functionName,
    function_name: functionName,
    receipt_path: issued.details.file,
    candidate_zip_path: zipFile,
    candidate_zip_sha256: candidate.zipSha256,
    staging_acceptance: stagingAcceptance,
    approval,
  }, null, 2));

  appendGithubOutput({ rebuild_input: inputPath, receipt_path: issued.details.file, workstream_id: identity.workstreamId }, env);
  return {
    ok: true,
    mode,
    identity,
    ...summary,
    state,
    diff,
    mutation: false,
    authorization: { lease: lease.details.lease, receiptFile: issued.details.file, rebuildInput: inputPath, candidateZip: zipFile },
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
