#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, GuardError } from './lib/errors.mjs';
import { acquireLease } from './lib/lease.mjs';
import { issueReceiptWithSigner } from './lib/receipt.mjs';
import { signReceiptWithKms } from './lib/kms-issuer.mjs';
import { validateZipMemberName } from './lib/lambda-owned-members.mjs';
import { readZipMembers } from './lib/zip-members.mjs';

const FUNCTION_NAME = 'checksops-staging-api';
const REGION = 'us-east-1';
const HEX64 = /^[0-9a-f]{64}$/i;
export const DIAGNOSTIC_VALIDATOR_MEMBER = 'db-readonly-validate.mjs';
export const DIAGNOSTIC_VALIDATOR_OPERATION = 'replace';
export const DIAGNOSTIC_VALIDATOR_FUNCTION = FUNCTION_NAME;
const PUBLIC_VALIDATOR_UNHEALTHY_KEYS = Object.freeze(['readOnly', 'service', 'status']);

function parseExplicitBoolean(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false' || value == null || value === '') return false;
  return null;
}

export function validateAcceptPublicValidatorUnhealthy({
  accept,
  member,
  operation,
  functionName = FUNCTION_NAME,
} = {}) {
  const parsed = parseExplicitBoolean(accept);
  if (parsed === null) {
    return {
      ok: false,
      code: CODES.INVALID_MANIFEST,
      message: 'accept_public_validator_unhealthy must be an explicit boolean and is never inferred',
      details: { accept },
    };
  }
  if (parsed !== true) {
    return { ok: true, details: { accept: false } };
  }
  if (
    member !== DIAGNOSTIC_VALIDATOR_MEMBER
    || operation !== DIAGNOSTIC_VALIDATOR_OPERATION
    || functionName !== DIAGNOSTIC_VALIDATOR_FUNCTION
  ) {
    return {
      ok: false,
      code: CODES.UNRELATED_MUTATION,
      message: 'accept_public_validator_unhealthy is limited to replace db-readonly-validate.mjs on checksops-staging-api',
      details: { member: member || null, operation: operation || null, functionName },
    };
  }
  return {
    ok: true,
    details: {
      accept: true,
      member,
      operation,
      functionName,
    },
  };
}

export function isAcceptedPublicValidatorUnhealthy(httpStatus, body) {
  if (Number(httpStatus) !== 503 || body == null || typeof body !== 'object' || Array.isArray(body)) {
    return false;
  }
  const keys = Object.keys(body).sort();
  if (keys.length !== PUBLIC_VALIDATOR_UNHEALTHY_KEYS.length
    || keys.some((key, index) => key !== PUBLIC_VALIDATOR_UNHEALTHY_KEYS[index])) {
    return false;
  }
  return body.service === 'checksops-api' && body.status === 'unhealthy' && body.readOnly === true;
}

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

/**
 * The staging mirror of the production overlay's sql_before guard
 * (github-production-lambda-overlay.mjs classifyLive): a member whose production plan entry
 * names sql_before may be overlaid onto staging only once that SQL is recorded live in
 * staging (ops/deployment-guard/staging-sql-live.json, verified_live true). A file missing
 * from the record counts as not live; a member the plan does not list carries no hold.
 */
export const OVERLAY_PLAN_REL = 'ops/deployment-guard/production-api-overlay-plan.json';
export const STAGING_SQL_LIVE_REL = 'ops/deployment-guard/staging-sql-live.json';

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));

export function stagingSqlBefore(member, { plan, stagingSqlLive } = {}) {
  const thePlan = plan || readJson(OVERLAY_PLAN_REL);
  const sqlBefore = thePlan?.members?.[member]?.sql_before || null;
  if (!sqlBefore) return { sql_before: null, verified_live_in_staging: null, evidence: null };
  const record = (stagingSqlLive || readJson(STAGING_SQL_LIVE_REL))?.sql?.[sqlBefore];
  return {
    sql_before: sqlBefore,
    verified_live_in_staging: record?.verified_live === true,
    evidence: record?.verified_live === true ? (record.evidence || null) : null,
  };
}

export function assertStagingSqlBefore(member, deps = {}) {
  const hold = stagingSqlBefore(member, deps);
  if (hold.sql_before && hold.verified_live_in_staging !== true) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'required staging SQL is not recorded as verified live in staging', {
      member,
      sql_before: hold.sql_before,
      record: STAGING_SQL_LIVE_REL,
    });
  }
  return hold;
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
  const members = readZipMembers(zip);
  const present = Object.hasOwn(members, member);
  const memberBytes = present ? members[member] : null;
  const memberSha256 = present ? createHash('sha256').update(memberBytes).digest('hex') : null;
  return {
    memberBytes,
    functionName: FUNCTION_NAME,
    codeSha256,
    revisionId,
    member,
    memberState: present ? 'PRESENT' : 'ABSENT',
    memberSha256,
  };
}

/**
 * Inspect-only: writes the live member's exact bytes to `dir` so a reviewer can
 * reconcile against it. The file name flattens the member path; the bytes are
 * re-hashed and must equal the inspected live member SHA-256.
 */
const EXPORT_SECRET_RE = /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}/;

export function exportLiveMember(live, dir) {
  if (live.memberState !== 'PRESENT' || !live.memberBytes) {
    throw new GuardError(CODES.INVALID_MANIFEST, 'export_live_member requires a member that is present live', { member: live.member });
  }
  if (!/\.(mjs|js)$/.test(live.member)) {
    throw new GuardError(CODES.INVALID_MANIFEST, 'export_live_member is limited to .mjs and .js source members', { member: live.member });
  }
  const exported = createHash('sha256').update(live.memberBytes).digest('hex');
  if (exported !== live.memberSha256) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'exported bytes do not match the inspected live member hash');
  }
  // Same refusal as the SH-2 source reconciliation: never upload live source carrying key material.
  if (EXPORT_SECRET_RE.test(live.memberBytes.toString('utf8'))) {
    throw new GuardError(CODES.DEPLOYMENT_COLLISION, 'live member looks like it contains key material; export refused', { member: live.member });
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, live.member.replace(/[^A-Za-z0-9._-]/g, '__'));
  fs.writeFileSync(file, live.memberBytes);
  return { file, sha256: exported };
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
  const exportDir = String(env.CHECKSOPS_STAGING_EXPORT_LIVE_MEMBER_DIR || '').trim();
  if (exportDir && mode !== 'inspect') {
    throw new GuardError(CODES.INVALID_MANIFEST, 'export_live_member is inspect-only');
  }
  // sql_before: refused in apply before any AWS call, lease or receipt; reported by inspect.
  const sqlBefore = mode === 'apply'
    ? assertStagingSqlBefore(requested.details.member, deps)
    : stagingSqlBefore(requested.details.member, deps);
  const live = await inspectLive(requested.details.member, deps);

  appendGithubOutput({
    live_code_sha256: live.codeSha256,
    live_revision_id: live.revisionId,
    live_member_state: live.memberState,
    live_member_sha256: live.memberSha256 || '',
    owned_member: live.member,
  }, env);

  const { memberBytes, ...liveSummary } = live;
  if (mode === 'inspect') {
    let exported = null;
    if (exportDir) {
      exported = exportLiveMember(live, exportDir);
      appendGithubOutput({ exported_member_file: exported.file, exported_member_sha256: exported.sha256 }, env);
    }
    return { ok: true, mode, identity, live: liveSummary, sql_before: sqlBefore, exported, mutation: false };
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
    live: liveSummary,
    sql_before: sqlBefore,
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
