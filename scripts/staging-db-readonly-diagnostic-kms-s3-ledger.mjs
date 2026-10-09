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
export const IAM_IDENTITY_POLICY_KEYS = Object.freeze(['Version', 'Id', 'Statement']);
export const WRITE_ONCE_NOT_DENIED = 'NotDeniedByThisPolicy';
export const WRITE_ONCE_DENY = 'Deny';
export const OWNER_ASSUME_ALLOW = 'Allow';
export const OWNER_ASSUME_DENY = 'Deny';
export const OWNER_PRINCIPAL_REQUIRED_INPUT = 'CHECKSOPS_STAGING_DB_DIAGNOSTIC_OWNER_IAM_USER_ARN';
export const EXAMPLE_OWNER_IAM_USER_ARN = `arn:aws:iam::${CREATE_APPROVAL_TARGET.account}:user/example-owner-not-live`;
export const ACCOUNT_ROOT_ARN = `arn:aws:iam::${CREATE_APPROVAL_TARGET.account}:root`;
export const GITHUB_OIDC_PROVIDER_ARN = `arn:aws:iam::${CREATE_APPROVAL_TARGET.account}:oidc-provider/token.actions.githubusercontent.com`;
export const OWNER_IAM_USER_ARN_RE = new RegExp(
  `^arn:aws:iam::${CREATE_APPROVAL_TARGET.account}:user/[A-Za-z0-9+=,.@_-]{1,64}$`,
);

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
    ownerTrust: JSON.parse(fs.readFileSync(path.join(dir, 'owner-approver-role-trust.json'), 'utf8')),
    ownerRequiredInput: JSON.parse(fs.readFileSync(path.join(dir, 'owner-approver-required-input.json'), 'utf8')),
  };
}

function statements(policy) {
  return Array.isArray(policy?.Statement) ? policy.Statement : [];
}

function jsonIncludes(value, needle) {
  return JSON.stringify(value).includes(needle);
}

function requireIamIdentityPolicyShape(policy) {
  const keys = Object.keys(policy || {});
  if (keys.some((key) => !IAM_IDENTITY_POLICY_KEYS.includes(key))) {
    fail(LEDGER_POLICY_INVALID, { reason: 'nonstandard_iam_identity_field', keys });
  }
  if (policy.Version !== '2012-10-17' || !Array.isArray(policy.Statement)) fail();
  if (statements(policy).some((row) => Object.hasOwn(row, 'Principal'))) {
    fail(LEDGER_POLICY_INVALID, { reason: 'identity_policy_has_principal' });
  }
  return true;
}

function consumedObjectArn(key) {
  return `arn:aws:s3:::${CREATE_APPROVAL_LEDGER.bucket}/${key}`;
}

function matchesConsumedResource(resource) {
  return resource === CONSUMED_OBJECT_ARN
    || (typeof resource === 'string'
      && resource.startsWith(`arn:aws:s3:::${CREATE_APPROVAL_LEDGER.bucket}/${CREATE_APPROVAL_LEDGER.prefix}/`));
}

// AWS IAM maps CopyObject, CreateMultipartUpload, UploadPart, UploadPartCopy,
// and CompleteMultipartUpload to s3:PutObject. Missing condition keys do not
// satisfy StringNotEquals, so a Null deny is required for absent If-None-Match.
export function evaluateWriteOnceRequest({
  action,
  key,
  resource,
  ifNoneMatch,
  copySource,
} = {}) {
  const objectResource = resource
    || (key ? consumedObjectArn(key) : undefined);
  if (action === 's3:PutBucketPolicy' && (resource === BUCKET_ARN || objectResource === BUCKET_ARN)) {
    return WRITE_ONCE_NOT_DENIED;
  }
  if (!matchesConsumedResource(objectResource) && objectResource !== CONSUMED_OBJECT_ARN) {
    return WRITE_ONCE_NOT_DENIED;
  }
  if (action === 's3:DeleteObject' || action === 's3:DeleteObjectVersion') return WRITE_ONCE_DENY;
  if (action !== 's3:PutObject') return WRITE_ONCE_NOT_DENIED;
  if (copySource) return WRITE_ONCE_DENY;
  if (ifNoneMatch == null || ifNoneMatch === '') return WRITE_ONCE_DENY;
  if (ifNoneMatch !== '*') return WRITE_ONCE_DENY;
  return WRITE_ONCE_NOT_DENIED;
}

export function namedOwnerIamUserArn(arn) {
  const value = String(arn || '');
  if (!OWNER_IAM_USER_ARN_RE.test(value)) return null;
  if (value === ACCOUNT_ROOT_ARN
      || value.includes(':role/')
      || value.includes(':assumed-role/')
      || value.includes('oidc-provider')
      || value.includes('*')) {
    return null;
  }
  return value;
}

function requireOwnerTrustDeniesDeployCfnOidc(policy) {
  const deny = statements(policy).find((row) => row.Sid === 'DenyGitHubOidcAndDiagnosticRoles');
  const denyArns = JSON.stringify(deny?.Condition?.StringLike?.['aws:PrincipalArn'] || []);
  if (deny?.Effect !== 'Deny'
      || deny.Action !== 'sts:AssumeRole'
      || !denyArns.includes(CREATE_APPROVAL_TARGET.deployRoleArn)
      || !denyArns.includes(CREATE_APPROVAL_TARGET.executionRoleArn)
      || !denyArns.includes('token.actions.githubusercontent.com')) {
    fail(LEDGER_POLICY_INVALID, { reason: 'owner_trust_deny' });
  }
  return deny;
}

function rejectBroadOwnerTrustPrincipals(policy) {
  for (const row of statements(policy)) {
    const principal = JSON.stringify(row.Principal || {});
    if (row.Effect !== 'Allow') continue;
    if (principal.includes(':root')
        || principal.includes('*')
        || principal.includes('"Federated"')
        || principal.includes('token.actions.githubusercontent.com')
        || principal.includes(CREATE_APPROVAL_TARGET.deployRoleArn)
        || principal.includes(CREATE_APPROVAL_TARGET.executionRoleArn)
        || principal.includes(':role/')) {
      fail(LEDGER_POLICY_INVALID, { reason: 'owner_trust_broad_or_oidc' });
    }
  }
  if (jsonIncludes(policy, 'token.actions.githubusercontent.com:sub')) {
    fail(LEDGER_POLICY_INVALID, { reason: 'owner_trust_oidc' });
  }
}

export function evaluateOwnerApproverTrust(policy) {
  const rows = statements(policy);
  const failClosed = rows.find((row) => row.Sid === 'FailClosedUntilNamedOwnerIamUserArn');
  const allow = rows.find((row) => row.Sid === 'NamedOwnerIamUserMfaAssumeOnly');
  requireOwnerTrustDeniesDeployCfnOidc(policy);
  rejectBroadOwnerTrustPrincipals(policy);

  const specified = namedOwnerIamUserArn(allow?.Principal?.AWS);
  if (!specified) {
    if (failClosed?.Effect !== 'Deny'
        || failClosed.Principal !== '*'
        || failClosed.Action !== 'sts:AssumeRole'
        || failClosed.Condition) {
      fail(LEDGER_POLICY_INVALID, { reason: 'owner_trust_not_fail_closed' });
    }
    if (rows.some((row) => row.Effect === 'Allow')) {
      fail(LEDGER_POLICY_INVALID, { reason: 'owner_trust_allow_without_named_user' });
    }
    return {
      ok: true,
      role_exists: false,
      operational: false,
      fail_closed: true,
      owner_principal_specified: false,
      required_input: OWNER_PRINCIPAL_REQUIRED_INPUT,
      proposed_role_arn: OWNER_SIGNER_ROLE_ARN,
    };
  }

  if (failClosed) fail(LEDGER_POLICY_INVALID, { reason: 'owner_trust_fail_closed_with_named_allow' });
  if (allow.Effect !== 'Allow'
      || allow.Action !== 'sts:AssumeRole'
      || allow.Condition?.Bool?.['aws:MultiFactorAuthPresent'] !== 'true') {
    fail(LEDGER_POLICY_INVALID, { reason: 'owner_trust_named_allow' });
  }
  return {
    ok: true,
    role_exists: false,
    operational: false,
    fail_closed: false,
    owner_principal_specified: true,
    owner_iam_user_arn: specified,
    required_input: OWNER_PRINCIPAL_REQUIRED_INPUT,
    proposed_role_arn: OWNER_SIGNER_ROLE_ARN,
  };
}

export function materializeOwnerApproverTrust({
  ownerIamUserArn,
  policy,
} = {}) {
  const named = namedOwnerIamUserArn(ownerIamUserArn);
  if (!named) fail(LEDGER_POLICY_INVALID, { reason: 'owner_iam_user_arn_required' });
  const base = policy ?? loadLedgerPolicies().ownerTrust;
  const closed = evaluateOwnerApproverTrust(base);
  if (!closed.fail_closed) fail(LEDGER_POLICY_INVALID, { reason: 'owner_trust_base_not_fail_closed' });
  const deny = requireOwnerTrustDeniesDeployCfnOidc(base);
  const materialized = {
    Version: '2012-10-17',
    Id: base.Id,
    Statement: [
      {
        Sid: 'NamedOwnerIamUserMfaAssumeOnly',
        Effect: 'Allow',
        Principal: { AWS: named },
        Action: 'sts:AssumeRole',
        Condition: {
          Bool: { 'aws:MultiFactorAuthPresent': 'true' },
        },
      },
      deny,
      {
        Sid: 'DenyNotNamedOwnerPrincipal',
        Effect: 'Deny',
        Principal: '*',
        Action: 'sts:AssumeRole',
        Condition: {
          StringNotEqualsIfExists: { 'aws:PrincipalArn': named },
        },
      },
      {
        Sid: 'DenyAssumeWithoutMfa',
        Effect: 'Deny',
        Principal: '*',
        Action: 'sts:AssumeRole',
        Condition: {
          BoolIfExists: { 'aws:MultiFactorAuthPresent': 'false' },
        },
      },
    ],
  };
  return {
    policy: materialized,
    evaluation: evaluateOwnerApproverTrust(materialized),
  };
}

export function evaluateOwnerAssumeRequest({
  policy,
  principalArn,
  mfaPresent = false,
  federatedIssuer,
} = {}) {
  const trust = evaluateOwnerApproverTrust(policy);
  if (trust.fail_closed || !trust.owner_principal_specified) return OWNER_ASSUME_DENY;
  if (String(federatedIssuer || '').includes('token.actions.githubusercontent.com')) {
    return OWNER_ASSUME_DENY;
  }
  const principal = String(principalArn || '');
  if (!principal
      || principal === ACCOUNT_ROOT_ARN
      || principal === GITHUB_OIDC_PROVIDER_ARN
      || principal === CREATE_APPROVAL_TARGET.deployRoleArn
      || principal === CREATE_APPROVAL_TARGET.executionRoleArn
      || principal.includes('ChecksOpsGitHubStagingDbReadonlyDiagnosticDeploy')
      || principal.includes('ChecksOpsStagingDbReadonlyDiagnosticCloudFormationExecution')) {
    return OWNER_ASSUME_DENY;
  }
  if (principal !== trust.owner_iam_user_arn) return OWNER_ASSUME_DENY;
  if (mfaPresent !== true) return OWNER_ASSUME_DENY;
  return OWNER_ASSUME_ALLOW;
}

export function remainingBlockers() {
  return Object.freeze([
    'owner_iam_user_arn_unspecified',
    'owner_approver_role_not_evidenced',
    'kms_create_approval_key_not_evidenced',
    'consumed_prefix_bucket_policy_absent',
    'workflow_disabled_no_id_token_write',
  ]);
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
  requireIamIdentityPolicyShape(policies.deployIam);
  requireIndependentKms(policies.kmsKey, policies.kmsPolicy);
  requireConsumedWriteOnce(policies.bucketPolicy, { allowPrincipalStar: true });
  requireConsumedWriteOnce(policies.deployIam);
  const ownerTrust = evaluateOwnerApproverTrust(policies.ownerTrust);
  if (policies.ownerRequiredInput
      && (policies.ownerRequiredInput.required_input !== OWNER_PRINCIPAL_REQUIRED_INPUT
        || policies.ownerRequiredInput.owner_iam_user_arn !== null
        || policies.ownerRequiredInput.status !== 'unspecified_fail_closed')) {
    fail(LEDGER_POLICY_INVALID, { reason: 'owner_required_input' });
  }
  return {
    ok: true,
    consumedObjectArn: CONSUMED_OBJECT_ARN,
    conditionKeys: AWS_CONDITION_KEYS,
    ownerSignerRoleArn: OWNER_SIGNER_ROLE_ARN,
    proposedKmsAlias: PROPOSED_KMS_ALIAS,
    ownerTrust,
    ownerRequiredInput: OWNER_PRINCIPAL_REQUIRED_INPUT,
    iam_put_object_covers: [
      'PutObject',
      'CopyObject',
      'CreateMultipartUpload',
      'UploadPart',
      'UploadPartCopy',
      'CompleteMultipartUpload',
    ],
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
    remaining_blockers: remainingBlockers(),
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
      owner_recovery: 'Principal * object Deny includes account root. Recover by s3:PutBucketPolicy on the bucket ARN (not denied here), then delete. Do not grant the deploy role PutBucketPolicy.',
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
    '4. Owner: separately create ChecksOpsOwnerDiagnosticCreateApprover (not evidenced live). Trust stays fail-closed until CHECKSOPS_STAGING_DB_DIAGNOSTIC_OWNER_IAM_USER_ARN names one IAM user. No account-root, deploy, CFN, OIDC, or unrelated users.',
    '5. Owner: create ECC_NIST_P256 SIGN_VERIFY key with the source key policy; only that owner role kms:Sign.',
    '6. Owner: publish SPKI public key and key ARN as staging env secrets jobs cannot change.',
    '7. Owner: put the consumed-prefix bucket policy; do not version the bucket in this change.',
    '8. Owner: add additive IAM Deny on the deploy role for delete/overwrite of consumed/*.',
    '9. Prove aws s3api put-object --body FILE --if-none-match * then replay 412; never delete-object.',
    '10. Recover consumed objects only by replacing the bucket policy, then deleting. Do not grant deploy PutBucketPolicy.',
    '11. Do not touch staging API, production, SQL, Cognito, CORS, or other workstreams.',
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
