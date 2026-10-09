import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CREATE_APPROVAL_KIND = 'checksops-staging-db-readonly-diagnostic-create-approval';
export const CREATE_APPROVAL_MAX_TTL_MS = 60 * 60 * 1000;
export const INDEPENDENT_APPROVAL_UNVERIFIED = 'independent_approval_unverified';
export const INDEPENDENT_APPROVAL_REUSED = 'independent_approval_reused';
export const INDEPENDENT_APPROVAL_BLOCKER = 'owner_controlled_aws_kms_approval_authority_unverified';

export const CREATE_APPROVAL_TARGET = Object.freeze({
  kind: CREATE_APPROVAL_KIND,
  account: '806168576068',
  region: 'us-east-1',
  environment: 'staging',
  workstreamId: 'staging-db-readonly-diagnostic',
  component: 'checksops-staging-db-readonly-diagnostic',
  stackName: 'checksops-staging-db-readonly-diagnostic',
  functionName: 'checksops-staging-db-readonly-diagnostic',
  deploymentType: 'cloudformation-create-only',
  deployRoleArn: 'arn:aws:iam::806168576068:role/ChecksOpsGitHubStagingDbReadonlyDiagnosticDeploy',
  executionRoleArn: 'arn:aws:iam::806168576068:role/ChecksOpsStagingDbReadonlyDiagnosticCloudFormationExecution',
});

// Live owner-controlled evidence. Do not treat these as verified from source.
export const OWNER_EVIDENCE = Object.freeze({
  diagnostic_lambda: 'absent_2026-10-09',
  diagnostic_stack: 'absent_2026-10-09',
  github_oidc_deploy_role: 'exists_create_stack_s3_get_put_no_delete_2026-10-09',
  github_oidc_trust: 'reported_repo_staging_aud_sts_2026-10-09',
  github_oidc_inline_policy: 'reported_diagnostic_only_create_describe_2026-10-09',
  cloudformation_execution_role_trust: 'reported_cfn_service_trust_2026-10-09',
  cloudformation_execution_role_policy: 'reported_diagnostic_only_2026-10-09',
  artifact_bucket_encryption: 'aes256_2026-10-09',
  artifact_bucket_public_access: 'full_block_2026-10-09',
  artifact_bucket_ownership: 'bucket_owner_enforced_2026-10-09',
  artifact_bucket_policy: 'none_2026-10-09',
  artifact_bucket_versioning: 'unset_2026-10-09',
  staging_environment_required_reviewers: 'unverified',
  staging_environment_prevent_self_review: 'unverified',
  exact_aws_role_permissions: 'pending_owner_evidence',
  diagnostic_package_dependencies: 'pending_owner_evidence',
  independent_approval_kms_key: 'unknown',
  independent_approval_kms_alias: 'none_found_does_not_prove_key_absence_2026-10-09',
  independent_approval_signer: 'unknown',
  independent_approval_public_key: 'unknown',
  independent_approval_consume_ledger: 'unknown',
  independent_approval_consume_ledger_delete_denied: 'iam_omits_delete_no_bucket_deny_2026-10-09',
  independent_approval_consume_if_none_match: 'unknown_no_bucket_policy_2026-10-09',
});

export const CREATE_APPROVAL_LEDGER = Object.freeze({
  bucket: 'checksops-staging-db-readonly-diagnostic-artifacts-806168576068',
  prefix: 'checksops-staging-db-readonly-diagnostic/create-approvals/consumed',
  region: 'us-east-1',
  account: '806168576068',
});

const FORBIDDEN_APPROVER_ARNS = new Set([
  CREATE_APPROVAL_TARGET.deployRoleArn,
  CREATE_APPROVAL_TARGET.executionRoleArn,
]);

const KMS_KEY_ARN_RE = /^arn:aws:kms:us-east-1:806168576068:key\/[0-9a-f-]+$/i;
const IAM_PRINCIPAL_RE = /^arn:aws:iam::806168576068:(user|role)\/[A-Za-z0-9+=,.@_-]+$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const ALLOWED_APPROVAL_KEYS = new Set([
  'kind',
  'commit',
  'workstream_id',
  'target_environment',
  'target_component',
  'stack_name',
  'function_name',
  'account',
  'region',
  'deployment_type',
  'nonce',
  'issued_at',
  'expiry',
  'approver',
  'approver_github',
  'kms_key_arn',
  'kms_signature',
]);

function fail(code = INDEPENDENT_APPROVAL_UNVERIFIED) {
  throw new Error(code);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalCreateApprovalPayload(approval) {
  const {
    kms_signature,
    signature,
    mac,
    ...rest
  } = approval || {};
  return canonicalJson(rest);
}

export function isCallerSuppliedCommitApproval(approval) {
  if (!approval || typeof approval !== 'object') return true;
  if (approval.source === 'github_environment' || approval.source === 'approved_commit') return true;
  if (approval.mac && !approval.kms_signature) return true;
  if (typeof approval.approved_commit === 'string' && !approval.kms_signature) return true;
  return false;
}

function requireExactBinding(approval, commit) {
  if (approval.kind !== CREATE_APPROVAL_KIND
      || approval.commit !== commit
      || !COMMIT_RE.test(String(commit || ''))
      || approval.workstream_id !== CREATE_APPROVAL_TARGET.workstreamId
      || approval.target_environment !== CREATE_APPROVAL_TARGET.environment
      || approval.target_component !== CREATE_APPROVAL_TARGET.component
      || approval.stack_name !== CREATE_APPROVAL_TARGET.stackName
      || approval.function_name !== CREATE_APPROVAL_TARGET.functionName
      || approval.account !== CREATE_APPROVAL_TARGET.account
      || approval.region !== CREATE_APPROVAL_TARGET.region
      || approval.deployment_type !== CREATE_APPROVAL_TARGET.deploymentType) {
    fail();
  }
}

function requireFreshExpiry(approval, now) {
  const issuedAt = Date.parse(approval.issued_at);
  const expiry = Date.parse(approval.expiry);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiry) || expiry <= issuedAt) fail();
  if (expiry <= now) fail();
  if (expiry - issuedAt > CREATE_APPROVAL_MAX_TTL_MS) fail();
  if (issuedAt - 60 * 1000 > now) fail();
}

function requireIndependentApprover(approval, actor) {
  const approver = String(approval.approver || '');
  if (!IAM_PRINCIPAL_RE.test(approver) || FORBIDDEN_APPROVER_ARNS.has(approver)) fail();
  if (actor && (approver === actor || approval.approver_github === actor)) fail();
}

function requireConfiguredAuthority(approval, env) {
  const expectedKeyArn = String(env.CHECKSOPS_STAGING_DB_DIAGNOSTIC_APPROVAL_KMS_KEY_ARN || '').trim();
  const publicKeyB64 = String(env.CHECKSOPS_STAGING_DB_DIAGNOSTIC_APPROVAL_PUBLIC_KEY_DER_B64 || '').trim();
  if (!KMS_KEY_ARN_RE.test(expectedKeyArn) || !publicKeyB64) fail();
  if (approval.kms_key_arn !== expectedKeyArn) fail();
  // Guard receipt KMS is a different authority and must not be reused here.
  const receiptKey = String(env.CHECKSOPS_DEPLOYMENT_GUARD_KMS_KEY_ARN || '').trim();
  if (receiptKey && receiptKey === expectedKeyArn) fail();
  return publicKeyB64;
}

function verifyKmsSignature(approval, publicKeyB64) {
  const signature = String(approval.kms_signature || '');
  if (!signature) fail();
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const ok = verifySignature(
      'sha256',
      Buffer.from(canonicalCreateApprovalPayload(approval)),
      key,
      Buffer.from(signature, 'base64'),
    );
    if (ok !== true) fail();
  } catch {
    fail();
  }
}

export function consumedCreateApprovalObjectKey(nonce) {
  if (!NONCE_RE.test(String(nonce || ''))) return null;
  return `${CREATE_APPROVAL_LEDGER.prefix}/${nonce}.json`;
}

export function writeCreateApprovalBodyFile(payload, { tmpDir = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'checksops-create-approval-'));
  const file = path.join(dir, 'body.json');
  const fd = fs.openSync(file, 'wx');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

function removeCreateApprovalBodyFile(file) {
  if (!file) return;
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

export function requireCreateOnlyLedgerPutObjectArgs(args = []) {
  const list = Array.isArray(args) ? args.map(String) : [];
  const bodyIndex = list.indexOf('--body');
  const matchIndex = list.indexOf('--if-none-match');
  const body = bodyIndex >= 0 ? list[bodyIndex + 1] : '';
  const match = matchIndex >= 0 ? list[matchIndex + 1] : '';
  const bucket = list[list.indexOf('--bucket') + 1] || '';
  const key = list[list.indexOf('--key') + 1] || '';
  if (list[0] !== 's3api'
      || list[1] !== 'put-object'
      || bucket !== CREATE_APPROVAL_LEDGER.bucket
      || !key.startsWith(`${CREATE_APPROVAL_LEDGER.prefix}/`)
      || !key.endsWith('.json')
      || !body
      || body.startsWith('{')
      || !fs.existsSync(body)
      || !fs.statSync(body).isFile()
      || match !== '*'
      || list.includes('delete-object')
      || list.includes('copy-object')
      || list.includes('--copy-source')) {
    fail();
  }
  return true;
}

function isPreconditionFailed(error) {
  const detail = `${error?.stderr || ''}\n${error?.message || ''}\n${error?.name || ''}\n${error?.Code || ''}`;
  return error?.$metadata?.httpStatusCode === 412
    || error?.name === 'PreconditionFailed'
    || error?.Code === 'PreconditionFailed'
    || /PreconditionFailed|412 Precondition Failed/i.test(detail);
}

export function createPersistentMemoryLedger(store = new Map()) {
  return function consumeOnce({ nonce } = {}) {
    if (!NONCE_RE.test(String(nonce || ''))) fail();
    if (store.has(nonce)) {
      return { ok: false, reused: true, persistent: true, ifNoneMatch: '*' };
    }
    store.set(nonce, true);
    return { ok: true, persistent: true, ifNoneMatch: '*' };
  };
}

export function createS3CreateApprovalLedger({
  execFile = execFileSync,
  bucket = CREATE_APPROVAL_LEDGER.bucket,
  prefix = CREATE_APPROVAL_LEDGER.prefix,
  region = CREATE_APPROVAL_LEDGER.region,
  tmpDir = os.tmpdir(),
} = {}) {
  if (bucket !== CREATE_APPROVAL_LEDGER.bucket
      || prefix !== CREATE_APPROVAL_LEDGER.prefix
      || region !== CREATE_APPROVAL_LEDGER.region) {
    fail();
  }
  return function consumeOnce({
    nonce,
    payload,
  } = {}) {
    const key = consumedCreateApprovalObjectKey(nonce);
    if (!key) fail();
    const bodyFile = writeCreateApprovalBodyFile(payload || { nonce }, { tmpDir });
    try {
      const args = [
        's3api', 'put-object',
        '--bucket', bucket,
        '--key', key,
        '--body', bodyFile,
        '--content-type', 'application/json',
        '--if-none-match', '*',
        '--region', region,
      ];
      requireCreateOnlyLedgerPutObjectArgs(args);
      execFile('aws', args, { encoding: 'utf8' });
      return {
        ok: true,
        persistent: true,
        ifNoneMatch: '*',
        bucket,
        key,
        bodyFile,
      };
    } catch (error) {
      if (error?.message === INDEPENDENT_APPROVAL_UNVERIFIED) throw error;
      if (isPreconditionFailed(error)) {
        return { ok: false, reused: true, persistent: true, ifNoneMatch: '*', bucket, key };
      }
      fail();
    } finally {
      removeCreateApprovalBodyFile(bodyFile);
    }
  };
}

function requireAtomicPersistentConsume(consumeOnce, approval, { now, actor } = {}) {
  if (typeof consumeOnce !== 'function') fail();
  const result = consumeOnce({
    nonce: approval.nonce,
    commit: approval.commit,
    workstream_id: approval.workstream_id,
    actor: actor || null,
    now,
    ifNoneMatch: '*',
    payload: {
      kind: CREATE_APPROVAL_KIND,
      nonce: approval.nonce,
      commit: approval.commit,
      workstream_id: approval.workstream_id,
      consumed_at: new Date(now).toISOString(),
      actor: actor || null,
    },
  });
  if (result?.reused === true) fail(INDEPENDENT_APPROVAL_REUSED);
  if (result?.ok !== true || result?.persistent !== true || result?.ifNoneMatch !== '*') fail();
  return true;
}

export function loadCreateApproval(env = process.env) {
  if (env.CHECKSOPS_STAGING_DB_DIAGNOSTIC_CREATE_APPROVAL) {
    try {
      const parsed = JSON.parse(env.CHECKSOPS_STAGING_DB_DIAGNOSTIC_CREATE_APPROVAL);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail();
      return parsed;
    } catch {
      fail();
    }
  }
  const file = env.CHECKSOPS_STAGING_DB_DIAGNOSTIC_CREATE_APPROVAL_PATH;
  if (!file) fail();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail();
    return parsed;
  } catch {
    fail();
  }
}

export function requireIndependentCreateApproval({
  approval,
  commit,
  actor,
  env = process.env,
  now = Date.now(),
  consumeOnce,
} = {}) {
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) fail();
  if (Object.keys(approval).some((key) => !ALLOWED_APPROVAL_KEYS.has(key))) fail();
  if (isCallerSuppliedCommitApproval(approval)) fail();
  if (!NONCE_RE.test(String(approval.nonce || ''))) fail();
  requireExactBinding(approval, commit);
  requireFreshExpiry(approval, now);
  requireIndependentApprover(approval, actor);
  const publicKeyB64 = requireConfiguredAuthority(approval, env);
  verifyKmsSignature(approval, publicKeyB64);
  requireAtomicPersistentConsume(consumeOnce, approval, { now, actor });
  return true;
}
