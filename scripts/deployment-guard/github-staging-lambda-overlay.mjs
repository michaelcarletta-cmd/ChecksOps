#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, GuardError } from './lib/errors.mjs';
import { acquireLease } from './lib/lease.mjs';
import { issueReceiptWithSigner } from './lib/receipt.mjs';
import { signReceiptWithKms } from './lib/kms-issuer.mjs';
import { validateZipMemberName } from './lib/lambda-owned-members.mjs';
import { hashZipMembers } from './lib/zip-members.mjs';

const FUNCTION_NAME = 'checksops-staging-api';
const REGION = 'us-east-1';
const HEX64 = /^[0-9a-f]{64}$/i;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function validateRequestedMember(member) {
  const named = validateZipMemberName(member, 'staging overlay member');
  if (!named.ok) return named;
  const source = path.join(repoRoot, 'aws', 'functions', 'api', named.details.member);
  const rel = path.relative(path.join(repoRoot, 'aws', 'functions', 'api'), source).replace(/\\/g, '/');
  if (rel !== named.details.member || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, code: CODES.UNRELATED_MUTATION, message: 'overlay member escapes Lambda package root' };
  }
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    return { ok: false, code: CODES.STALE_PACKAGE, message: 'overlay source member is missing from repository', details: { member: named.details.member } };
  }
  return { ok: true, details: { member: named.details.member, source, sourceRelative: `aws/functions/api/${named.details.member}` } };
}

export function validateExpectedMemberHash(actual, expected) {
  if (!HEX64.test(String(expected || ''))) {
    return { ok: false, code: CODES.INVALID_MANIFEST, message: 'apply mode requires a 64-character expected live member SHA-256' };
  }
  if (String(actual || '').toLowerCase() !== String(expected).toLowerCase()) {
    return {
      ok: false,
      code: CODES.SOURCE_RECONCILIATION_REQUIRED,
      message: 'live owned member changed since review; refuse same-file overwrite',
      details: { expected_live_member_sha256: expected, actual_live_member_sha256: actual },
    };
  }
  return { ok: true, details: { member_sha256: actual } };
}

export function workflowIdentity(env = process.env) {
  const commit = String(env.GITHUB_SHA || '').trim();
  const branch = String(env.GITHUB_REF_NAME || '').trim();
  const actor = String(env.GITHUB_ACTOR || '').trim();
  const runId = String(env.GITHUB_RUN_ID || '').trim();
  if (!/^[0-9a-f]{40}$/.test(commit) || !branch || !actor || !runId) {
    throw new GuardError(CODES.ANONYMOUS_DEPLOYMENT, 'GitHub workflow identity is incomplete');
  }
  if (branch !== 'main') {
    throw new GuardError(CODES.UNRELATED_MUTATION, 'guarded staging deploy may only run from main', { branch });
  }
  return {
    commit,
    branch,
    operator: actor,
    workstreamId: `github-staging-overlay-${runId}`,
  };
}

export function buildOverlayReceiptInput(identity, live, operation, expectedMemberHash) {
  if (!['add', 'replace'].includes(operation)) {
    throw new GuardError(CODES.INVALID_MANIFEST, 'operation must be add or replace');
  }
  if (operation === 'add') {
    if (live.memberState !== 'ABSENT' || live.memberSha256 !== null) {
      throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'ADD requires the exact member to be absent from the current live staging Lambda ZIP', { member: live.member });
    }
  } else {
    const expected = validateExpectedMemberHash(live.memberSha256, expectedMemberHash);
    if (!expected.ok) {
      throw new GuardError(expected.code, expected.message, expected.details || {});
    }
  }
  return {
    workstream_id: identity.workstreamId,
    branch: identity.branch,
    commit: identity.commit,
    operator: identity.operator,
    target_environment: 'staging',
    target_component: FUNCTION_NAME,
    deployment_type: 'lambda-overlay',
    owned_components: [live.member],
    owned_member_ops: {
      replace: operation === 'replace' ? [live.member] : [],
      add: operation === 'add' ? [live.member] : [],
    },
    preflight_live_fingerprint: {
      codeSha256: live.codeSha256,
      revisionId: live.revisionId,
    },
  };
}

async function inspectLive(member, { lambda = null, fetchImpl = fetch, loadSdk = (specifier) => import(specifier) } = {}) {
  let client = lambda;
  let command;
  if (!client) {
    const sdk = await loadSdk('@aws-sdk/client-lambda');
    client = new sdk.LambdaClient({ region: REGION });
    command = new sdk.GetFunctionCommand({ FunctionName: FUNCTION_NAME });
  } else {
    command = { operation: 'GetFunction', input: { FunctionName: FUNCTION_NAME } };
  }
  const live = await client.send(command);
  const codeSha256 = live?.Configuration?.CodeSha256 || null;
  const revisionId = live?.Configuration?.RevisionId || null;
  const location = live?.Code?.Location || null;
  if (!codeSha256 || !revisionId || !location) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'live staging Lambda fingerprint/code location is incomplete');
  }
  const response = await fetchImpl(location);
  if (!response?.ok) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'failed to download current live staging Lambda ZIP', { status: response?.status || null });
  }
  const zip = Buffer.from(await response.arrayBuffer());
  const members = hashZipMembers(zip);
  const present = Object.hasOwn(members, member);
  const memberSha256 = present ? members[member] : null;
  return {
    functionName: FUNCTION_NAME,
    codeSha256,
    revisionId,
    member,
    memberState: present ? 'PRESENT' : 'ABSENT',
    memberSha256,
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

  const requested = validateRequestedMember(String(env.CHECKSOPS_STAGING_OVERLAY_MEMBER || 'index.mjs').trim());
  if (!requested.ok) {
    throw new GuardError(requested.code, requested.message, requested.details || {});
  }
  const identity = workflowIdentity(env);
  const live = await inspectLive(requested.details.member, deps);

  appendGithubOutput({
    live_code_sha256: live.codeSha256,
    live_revision_id: live.revisionId,
    live_member_state: live.memberState,
    live_member_sha256: live.memberSha256 || '',
    owned_member: live.member,
  }, env);

  if (mode === 'inspect') {
    return { ok: true, mode, identity, live, mutation: false };
  }

  const receiptInput = buildOverlayReceiptInput(
    identity,
    live,
    String(env.CHECKSOPS_STAGING_OVERLAY_OPERATION || 'replace').trim(),
    env.CHECKSOPS_EXPECTED_LIVE_MEMBER_SHA256,
  );

  const lease = acquireLease(repoRoot, {
    workstream_id: identity.workstreamId,
    component: FUNCTION_NAME,
    environment: 'staging',
    commit: identity.commit,
    operator: identity.operator,
  });
  if (!lease.ok) {
    throw new GuardError(lease.code, lease.message, lease.details || {});
  }

  const issued = issueReceiptWithSigner(repoRoot, {
    ...receiptInput,
    lease: lease.details.lease,
  }, (unsigned) => signReceiptWithKms(unsigned, { env }));
  if (!issued.ok) {
    throw new GuardError(issued.code, issued.message, issued.details || {});
  }

  const inputPath = path.join(repoRoot, '.deployment-guard', 'github-staging-overlay-input.json');
  fs.writeFileSync(inputPath, JSON.stringify({
    workstream_id: identity.workstreamId,
    branch: identity.branch,
    commit: identity.commit,
    operator: identity.operator,
    target_environment: 'staging',
    target_component: FUNCTION_NAME,
    function_name: FUNCTION_NAME,
    receipt_path: issued.details.file,
    member_sources: {
      [live.member]: requested.details.sourceRelative,
    },
  }, null, 2));

  appendGithubOutput({
    overlay_input: inputPath,
    receipt_path: issued.details.file,
    workstream_id: identity.workstreamId,
  }, env);

  return {
    ok: true,
    mode,
    identity,
    live,
    mutation: false,
    authorization: {
      lease: lease.details.lease,
      receiptFile: issued.details.file,
      overlayInput: inputPath,
    },
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
