#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CREATE_APPROVAL_LEDGER,
  CREATE_APPROVAL_TARGET,
  OWNER_EVIDENCE,
} from './staging-db-readonly-diagnostic-independent-approval.mjs';

export const SOURCE_ONLY_APPLY_REFUSED = 'source_only_kms_s3_ledger_apply_refused';
export const LEDGER_POLICY_INVALID = 'ledger_policy_invalid';

export const OWNER_SIGNER_ROLE_ARN = 'arn:aws:iam::806168576068:role/ChecksOpsOwnerDiagnosticCreateApprover';
export const PROPOSED_KMS_ALIAS = 'alias/checksops-staging-db-readonly-diagnostic-create-approval';

// Real AWS IAM condition keys (S3 conditional writes, Nov 2024; KMS Sign).
export const AWS_CONDITION_KEYS = Object.freeze({
  s3IfNoneMatch: 's3:if-none-match',
  s3CopySource: 's3:x-amz-copy-source',
  kmsSigningAlgorithm: 'kms:SigningAlgorithm',
});

export const CONSUMED_OBJECT_ARN = `arn:aws:s3:::${CREATE_APPROVAL_LEDGER.bucket}/${CREATE_APPROVAL_LEDGER.prefix}/*`;
export const ARTIFACT_OBJECT_ARN = `arn:aws:s3:::${CREATE_APPROVAL_LEDGER.bucket}/${CREATE_APPROVAL_TARGET.stackName}/*`;
export const BUCKET_ARN = `arn:aws:s3:::${CREATE_APPROVAL_LEDGER.bucket}`;

const POLICIES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../aws/staging-db-readonly-diagnostic/policies',
);

const FORBIDDEN_AWS_MUTATIONS = Object.freeze([
  's3api put-bucket-policy',
  's3api put-bucket-versioning',
  'kms create-key',
  'kms put-key-policy',
  'kms create-alias',
  'iam put-role-policy',
  'iam attach-role-policy',
  'iam update-assume-role-policy',
  'cloudformation create',
  'cloudformation update',
  's3api delete-object',
  'kms sign',
]);

function fail(code = LEDGER_POLICY_INVALID, details) {
  const error = new Error(code);
  if (details) error.details = details;
  throw error;
}

export function loadLedgerPolicies({ dir = POLICIES_DIR } = {}) {
  return {
    kmsKey: JSON.parse(fs.readFileSync(path.join(dir, 'kms-create-approval-key.json'), 'utf8')),
    kmsPolicy: JSON.parse(fs.readFileSync(path.join(dir, 'kms-create-approval-key-policy.json'), 'utf8')),
    bucketPolicy: JSON.parse(fs.readFileSync(path.join(dir, 's3-consumed-approvals-bucket-policy.json'), 'utf8')),
    deployIam: JSON.parse(fs.readFileSync(path.join(dir, 'deploy-role-consumed-ledger-iam.json'), 'utf8')),
  };
}

function statements(policy) {
  return Array.isArray(policy?.Statement) ? policy.Statement : [];
}

function jsonIncludes(value, needle) {
  return JSON.stringify(value).includes(needle);
}

function requireConsumedWriteOnce(policy, { allowPrincipalStar = false } = {}) {
  const rows = statements(policy);
  if (!rows.length) fail();
  const consumedOnly = rows.every((row) => row.Resource === CONSUMED_OBJECT_ARN);
  if (!consumedOnly) fail(LEDGER_POLICY_INVALID, { reason: 'resource_not_consumed_prefix' });
  if (rows.some((row) => row.Resource === ARTIFACT_OBJECT_ARN || row.Resource === `${BUCKET_ARN}/*`)) {
    fail(LEDGER_POLICY_INVALID, { reason: 'artifact_prefix_in_scope' });
  }
  if (allowPrincipalStar && rows.some((row) => row.Principal !== '*')) fail();

  const denyDelete = rows.some((row) => (
    row.Effect === 'Deny'
    && jsonIncludes(row.Action, 's3:DeleteObject')
    && jsonIncludes(row.Action, 's3:DeleteObjectVersion')
  ));
  const denyIfNoneMatchAbsent = rows.some((row) => (
    row.Effect === 'Deny'
    && jsonIncludes(row.Action, 's3:PutObject')
    && row.Condition?.Null?.[AWS_CONDITION_KEYS.s3IfNoneMatch] === 'true'
  ));
  const denyIfNoneMatchNotStar = rows.some((row) => (
    row.Effect === 'Deny'
    && jsonIncludes(row.Action, 's3:PutObject')
    && row.Condition?.StringNotEquals?.[AWS_CONDITION_KEYS.s3IfNoneMatch] === '*'
  ));
  const denyCopy = rows.some((row) => (
    row.Effect === 'Deny'
    && jsonIncludes(row.Action, 's3:PutObject')
    && row.Condition?.Null?.[AWS_CONDITION_KEYS.s3CopySource] === 'false'
  ));
  if (!denyDelete || !denyIfNoneMatchAbsent || !denyIfNoneMatchNotStar || !denyCopy) {
    fail(LEDGER_POLICY_INVALID, { reason: 'write_once_statements_missing' });
  }
  if (jsonIncludes(policy, 's3:IfNoneMatch') || jsonIncludes(policy, 's3:if-none-match-star')) {
    fail(LEDGER_POLICY_INVALID, { reason: 'non_aws_condition_key' });
  }
  return true;
}

function requireIndependentKms(kmsKey, kmsPolicy) {
  if (kmsKey.KeyUsage !== 'SIGN_VERIFY'
      || kmsKey.KeySpec !== 'ECC_NIST_P256'
      || kmsKey.SigningAlgorithm !== 'ECDSA_SHA_256'
      || kmsKey.ProposedAlias !== PROPOSED_KMS_ALIAS
      || kmsKey.Account !== CREATE_APPROVAL_TARGET.account
      || kmsKey.Region !== CREATE_APPROVAL_TARGET.region
      || kmsKey.SourceOnly !== true
      || kmsKey.DoNotCreateFromThisRepository !== true
      || kmsKey.MultiRegion !== false) {
    fail(LEDGER_POLICY_INVALID, { reason: 'kms_key_spec' });
  }
  const rows = statements(kmsPolicy);
  const ownerSign = rows.find((row) => row.Sid === 'OwnerSignEcdsaSha256Only');
  if (!ownerSign
      || ownerSign.Effect !== 'Allow'
      || ownerSign.Principal?.AWS !== OWNER_SIGNER_ROLE_ARN
      || !jsonIncludes(ownerSign.Action, 'kms:Sign')
      || ownerSign.Condition?.StringEquals?.[AWS_CONDITION_KEYS.kmsSigningAlgorithm] !== 'ECDSA_SHA_256') {
    fail(LEDGER_POLICY_INVALID, { reason: 'owner_sign' });
  }
  const deny = rows.find((row) => row.Sid === 'DenyDeployAndCloudFormationSignAndAdmin');
  const denied = new Set(deny?.Principal?.AWS || []);
  if (deny?.Effect !== 'Deny'
      || !denied.has(CREATE_APPROVAL_TARGET.deployRoleArn)
      || !denied.has(CREATE_APPROVAL_TARGET.executionRoleArn)
      || !jsonIncludes(deny.Action, 'kms:Sign')
      || !jsonIncludes(deny.Action, 'kms:PutKeyPolicy')) {
    fail(LEDGER_POLICY_INVALID, { reason: 'deny_deploy_cfn_sign' });
  }
  for (const row of rows) {
    const principal = JSON.stringify(row.Principal || {});
    if (row.Effect === 'Allow'
        && jsonIncludes(row.Action, 'kms:Sign')
        && (principal.includes(CREATE_APPROVAL_TARGET.deployRoleArn)
          || principal.includes(CREATE_APPROVAL_TARGET.executionRoleArn))) {
      fail(LEDGER_POLICY_INVALID, { reason: 'deploy_or_cfn_can_sign' });
    }
  }
  if (jsonIncludes(kmsPolicy, 'kms:*')) fail(LEDGER_POLICY_INVALID, { reason: 'wildcard_kms' });
  return true;
}

export function packagingPrefixFor({ sha, runId, runAttempt } = {}) {
  if (!/^[0-9a-f]{40}$/.test(String(sha || ''))
      || !/^[1-9][0-9]*$/.test(String(runId || ''))
      || !/^[1-9][0-9]*$/.test(String(runAttempt || ''))) {
    fail(LEDGER_POLICY_INVALID, { reason: 'packaging_identity' });
  }
  return `${CREATE_APPROVAL_TARGET.stackName}/${sha}/${runId}-${runAttempt}`;
}

export function evaluatePackagingIsolation({ sha, runId, runAttempt } = {}) {
  const prefix = packagingPrefixFor({ sha, runId, runAttempt });
  if (prefix === CREATE_APPROVAL_LEDGER.prefix
      || prefix.startsWith(`${CREATE_APPROVAL_LEDGER.prefix}/`)
      || CREATE_APPROVAL_LEDGER.prefix.startsWith(`${prefix}/`)) {
    fail(LEDGER_POLICY_INVALID, { reason: 'packaging_overlaps_consumed' });
  }
  return { ok: true, packagingPrefix: prefix, consumedPrefix: CREATE_APPROVAL_LEDGER.prefix };
}

export function evaluateLedgerPolicies(policies = loadLedgerPolicies()) {
  requireIndependentKms(policies.kmsKey, policies.kmsPolicy);
  requireConsumedWriteOnce(policies.bucketPolicy, { allowPrincipalStar: true });
  requireConsumedWriteOnce(policies.deployIam);
  return {
    ok: true,
    consumedObjectArn: CONSUMED_OBJECT_ARN,
    conditionKeys: AWS_CONDITION_KEYS,
    ownerSignerRoleArn: OWNER_SIGNER_ROLE_ARN,
    proposedKmsAlias: PROPOSED_KMS_ALIAS,
  };
}

export function githubOidcContract({ workflowText } = {}) {
  const text = workflowText ?? fs.readFileSync(new URL('../.github/workflows/staging-db-readonly-diagnostic-deploy.yml', import.meta.url), 'utf8');
  const disabled = /if: \$\{\{ false \}\}/.test(text);
  const idTokenWrite = /id-token:\s*write/.test(text);
  const contentsRead = /permissions:\s*\n\s*contents: read/.test(text);
  const sessionDenyDelete = /s3:DeleteObject/.test(text) && /create-approvals\/consumed/.test(text);
  const sessionIfNoneMatch = text.includes(AWS_CONDITION_KEYS.s3IfNoneMatch);
  if (!disabled || idTokenWrite || !contentsRead || !sessionDenyDelete || !sessionIfNoneMatch) {
    fail(LEDGER_POLICY_INVALID, {
      reason: 'oidc_workflow_contract',
      disabled,
      idTokenWrite,
      contentsRead,
      sessionDenyDelete,
      sessionIfNoneMatch,
    });
  }
  return {
    ok: true,
    disabled: true,
    idTokenWrite: false,
    contentsRead: true,
    sessionDenyDelete,
    sessionIfNoneMatch,
    note: 'id-token:write remains absent intentionally; do not enable OIDC until a later reviewed authorization.',
  };
}

export function readOnlyPreflight({
  policies = loadLedgerPolicies(),
  workflowText,
  sha = 'a'.repeat(40),
  runId = '100',
  runAttempt = '1',
} = {}) {
  const evaluated = evaluateLedgerPolicies(policies);
  const packaging = evaluatePackagingIsolation({ sha, runId, runAttempt });
  const oidc = githubOidcContract({ workflowText });
  return {
    ok: true,
    mode: 'evaluate',
    source_only: true,
    aws_writes: false,
    apply_authorized: false,
    workflow_enabled: false,
    id_token_write: false,
    live_evidence: OWNER_EVIDENCE,
    evaluated,
    packaging,
    oidc,
    blast_radius: {
      kms: 'new unused SIGN_VERIFY key; no existing workload signs with it',
      s3: 'Deny statements limited to create-approvals/consumed/*; CloudFormation package PutObject stays on SHA/run prefix',
      iam: 'additive Deny on deploy role consumed prefix only; DiagnosticOnly Allow unchanged',
      out_of_scope: [
        'checksops-staging-api',
        'production',
        'SQL',
        'Cognito',
        'CORS',
        'workflow enablement',
      ],
    },
    rollback: {
      bucket_policy: 'owner deletes the new bucket policy; live Oct 9 state had none',
      kms: 'owner cancels alias and schedules key deletion; public key secret is not written by this PR',
      iam: 'owner removes only the additive consumed-prefix Deny statements',
      workflow: 'leave disabled; do not add id-token:write as rollback',
    },
  };
}

export function guardedApplyPlan(env = process.env) {
  return {
    ok: false,
    code: SOURCE_ONLY_APPLY_REFUSED,
    source_only: true,
    aws_writes: false,
    apply_authorized: false,
    refused_env: [
      'CHECKSOPS_DEPLOYMENT_GUARD_APPLY',
      'CHECKSOPS_DEPLOYMENT_GUARD_BYPASS',
      'AWS_WRITES_ENABLED',
    ].filter((name) => Boolean(env?.[name])),
    message: 'Owner-reviewed KMS/S3 ledger apply is source-only. This script never creates keys, puts bucket or IAM policy, or enables the workflow.',
    forbidden: FORBIDDEN_AWS_MUTATIONS,
    next: 'Owner applies outside this PR after recording evidence. Keep this workflow if: false.',
  };
}

export function phoneFriendlyChecklist() {
  return [
    '1. Do not merge, deploy, or enable the diagnostic workflow.',
    '2. Confirm jobs.deploy.if is false and permissions have contents:read only (no id-token:write).',
    '3. Confirm artifact uploads use SHA/run prefix, not create-approvals/consumed/.',
    '4. Owner: create ECC_NIST_P256 SIGN_VERIFY key with the source key policy; only owner role kms:Sign.',
    '5. Owner: publish SPKI public key and key ARN as staging env secrets jobs cannot change.',
    '6. Owner: put the consumed-prefix bucket policy; do not version the bucket in this change.',
    '7. Owner: add additive IAM Deny on the deploy role for delete/overwrite of consumed/*.',
    '8. Prove aws s3api put-object --body FILE --if-none-match * then replay 412; never delete-object.',
    '9. Do not touch staging API, production, SQL, Cognito, CORS, or other workstreams.',
  ];
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const apply = argv.includes('--apply') || env.CHECKSOPS_DEPLOYMENT_GUARD_APPLY === '1';
  if (apply) {
    const refused = guardedApplyPlan(env);
    console.error(JSON.stringify(refused));
    return 2;
  }
  const result = readOnlyPreflight();
  console.log(JSON.stringify({ ...result, checklist: phoneFriendlyChecklist() }, null, 2));
  return 0;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) process.exitCode = main();
