import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  CREATE_APPROVAL_LEDGER,
  CREATE_APPROVAL_TARGET,
  OWNER_EVIDENCE,
  requireCreateOnlyLedgerPutObjectArgs,
  writeCreateApprovalBodyFile,
} from '../../scripts/staging-db-readonly-diagnostic-independent-approval.mjs';
import {
  ARTIFACT_OBJECT_ARN,
  AWS_CONDITION_KEYS,
  CONSUMED_OBJECT_ARN,
  OWNER_SIGNER_ROLE_ARN,
  PROPOSED_KMS_ALIAS,
  SOURCE_ONLY_APPLY_REFUSED,
  WRITE_ONCE_DENY,
  WRITE_ONCE_NOT_DENIED,
  evaluateLedgerPolicies,
  evaluateOwnerApproverTrust,
  evaluatePackagingIsolation,
  evaluateWriteOnceRequest,
  githubOidcContract,
  guardedApplyPlan,
  loadLedgerPolicies,
  main,
  packagingPrefixFor,
  phoneFriendlyChecklist,
  readOnlyPreflight,
  remainingBlockers,
} from '../../scripts/staging-db-readonly-diagnostic-kms-s3-ledger.mjs';

const policies = loadLedgerPolicies();

test('exact policies use real AWS condition keys and consumed-prefix only', () => {
  const evaluated = evaluateLedgerPolicies(policies);
  assert.equal(evaluated.ok, true);
  assert.equal(AWS_CONDITION_KEYS.s3IfNoneMatch, 's3:if-none-match');
  assert.equal(AWS_CONDITION_KEYS.s3CopySource, 's3:x-amz-copy-source');
  assert.equal(AWS_CONDITION_KEYS.kmsSigningAlgorithm, 'kms:SigningAlgorithm');
  assert.equal(evaluated.consumedObjectArn, CONSUMED_OBJECT_ARN);
  assert.match(CONSUMED_OBJECT_ARN, /create-approvals\/consumed\/\*$/);
  assert.doesNotMatch(JSON.stringify(policies.bucketPolicy), /s3:IfNoneMatch/);
  assert.equal(policies.kmsKey.KeySpec, 'ECC_NIST_P256');
  assert.equal(policies.kmsKey.KeyUsage, 'SIGN_VERIFY');
  assert.equal(policies.kmsKey.SigningAlgorithm, 'ECDSA_SHA_256');
  assert.equal(policies.kmsKey.ProposedAlias, PROPOSED_KMS_ALIAS);
  assert.equal(evaluated.ownerSignerRoleArn, OWNER_SIGNER_ROLE_ARN);
});

test('write-once statements cannot delete or overwrite via deploy role or alternate principal', () => {
  for (const policy of [policies.bucketPolicy, policies.deployIam]) {
    const text = JSON.stringify(policy);
    assert.match(text, /s3:DeleteObject/);
    assert.match(text, /s3:DeleteObjectVersion/);
    assert.match(text, /"s3:if-none-match":"\*"/);
    assert.match(text, /"s3:if-none-match":"true"/);
    assert.match(text, /s3:x-amz-copy-source/);
    assert.equal(policy.Statement.every((row) => row.Resource === CONSUMED_OBJECT_ARN), true);
    assert.equal(policy.Statement.some((row) => row.Resource === ARTIFACT_OBJECT_ARN), false);
  }
  assert.equal(policies.bucketPolicy.Statement.every((row) => row.Principal === '*'), true);
  assert.equal(Object.hasOwn(policies.deployIam, 'Note'), false);
  assert.deepEqual(Object.keys(policies.deployIam).sort(), ['Id', 'Statement', 'Version']);
  assert.equal(Object.hasOwn(policies.deployIam.Statement[0], 'Principal'), false);
});

test('AWS write-once semantics deny copy, delete, and unconditional put; recovery is PutBucketPolicy', () => {
  const consumed = {
    action: 's3:PutObject',
    key: `${CREATE_APPROVAL_LEDGER.prefix}/${'ab'.repeat(16)}.json`,
  };
  assert.equal(evaluateWriteOnceRequest({ ...consumed, ifNoneMatch: '*' }), WRITE_ONCE_NOT_DENIED);
  assert.equal(evaluateWriteOnceRequest({ ...consumed }), WRITE_ONCE_DENY);
  assert.equal(evaluateWriteOnceRequest({ ...consumed, ifNoneMatch: '"abc"' }), WRITE_ONCE_DENY);
  assert.equal(evaluateWriteOnceRequest({
    ...consumed,
    ifNoneMatch: '*',
    copySource: `${CREATE_APPROVAL_LEDGER.bucket}/other.json`,
  }), WRITE_ONCE_DENY);
  assert.equal(evaluateWriteOnceRequest({
    action: 's3:DeleteObject',
    key: consumed.key,
  }), WRITE_ONCE_DENY);
  assert.equal(evaluateWriteOnceRequest({
    action: 's3:DeleteObjectVersion',
    key: consumed.key,
  }), WRITE_ONCE_DENY);
  assert.equal(evaluateWriteOnceRequest({
    action: 's3:PutBucketPolicy',
    resource: `arn:aws:s3:::${CREATE_APPROVAL_LEDGER.bucket}`,
  }), WRITE_ONCE_NOT_DENIED);
  assert.equal(evaluateWriteOnceRequest({
    action: 's3:PutObject',
    resource: `arn:aws:s3:::${CREATE_APPROVAL_LEDGER.bucket}/${CREATE_APPROVAL_TARGET.stackName}/${'a'.repeat(40)}/1-1/template.yaml`,
  }), WRITE_ONCE_NOT_DENIED);
  assert.ok(evaluateLedgerPolicies(policies).iam_put_object_covers.includes('CompleteMultipartUpload'));
  assert.ok(evaluateLedgerPolicies(policies).iam_put_object_covers.includes('CopyObject'));
});

test('owner approver role is proposed only and cannot be GitHub OIDC', () => {
  const trust = evaluateOwnerApproverTrust(policies.ownerTrust);
  assert.equal(trust.ok, true);
  assert.equal(trust.role_exists, false);
  assert.equal(trust.operational, false);
  assert.equal(trust.proposed_role_arn, OWNER_SIGNER_ROLE_ARN);
  assert.equal(OWNER_EVIDENCE.independent_approval_signer_role, 'not_evidenced_2026-10-09');
  assert.doesNotMatch(JSON.stringify(policies.ownerTrust.Statement[0]), /token\.actions\.githubusercontent\.com:sub/);
});

test('KMS policy is owner-only Sign and denies deploy and CloudFormation roles', () => {
  const text = JSON.stringify(policies.kmsPolicy);
  assert.match(text, /kms:Sign/);
  assert.match(text, /ECDSA_SHA_256/);
  assert.match(text, new RegExp(OWNER_SIGNER_ROLE_ARN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(text, /DenyDeployAndCloudFormationSignAndAdmin/);
  assert.doesNotMatch(text, /kms:\*/);
  const allowSignPrincipals = policies.kmsPolicy.Statement
    .filter((row) => row.Effect === 'Allow' && JSON.stringify(row.Action).includes('kms:Sign'))
    .map((row) => row.Principal.AWS);
  assert.deepEqual(allowSignPrincipals, [OWNER_SIGNER_ROLE_ARN]);
  const deny = policies.kmsPolicy.Statement.find((row) => row.Sid === 'DenyDeployAndCloudFormationSignAndAdmin');
  assert.equal(deny.Effect, 'Deny');
  assert.ok(deny.Principal.AWS.includes(CREATE_APPROVAL_TARGET.deployRoleArn));
  assert.ok(deny.Principal.AWS.includes(CREATE_APPROVAL_TARGET.executionRoleArn));
  assert.ok(deny.Action.includes('kms:Sign'));
  assert.ok(deny.Action.includes('kms:PutKeyPolicy'));
});

test('CloudFormation package prefix stays disjoint from consumed approvals', () => {
  const sha = 'abc123def4567890abc123def4567890abc123de';
  const packaging = evaluatePackagingIsolation({ sha, runId: '77', runAttempt: '2' });
  assert.equal(packaging.ok, true);
  assert.equal(
    packaging.packagingPrefix,
    `checksops-staging-db-readonly-diagnostic/${sha}/77-2`,
  );
  assert.equal(packaging.consumedPrefix, CREATE_APPROVAL_LEDGER.prefix);
  assert.notEqual(packagingPrefixFor({ sha, runId: '77', runAttempt: '2' }), CREATE_APPROVAL_LEDGER.prefix);
  assert.throws(() => evaluatePackagingIsolation({ sha: 'create-approvals', runId: '1', runAttempt: '1' }));
});

test('PutObject consume command remains body file plus If-None-Match star', () => {
  const nonce = 'aa'.repeat(16);
  const body = writeCreateApprovalBodyFile({ nonce });
  try {
    assert.equal(requireCreateOnlyLedgerPutObjectArgs([
      's3api', 'put-object',
      '--bucket', CREATE_APPROVAL_LEDGER.bucket,
      '--key', `${CREATE_APPROVAL_LEDGER.prefix}/${nonce}.json`,
      '--body', body,
      '--if-none-match', '*',
    ]), true);
    assert.throws(() => requireCreateOnlyLedgerPutObjectArgs([
      's3api', 'put-object',
      '--bucket', CREATE_APPROVAL_LEDGER.bucket,
      '--key', `${CREATE_APPROVAL_TARGET.stackName}/${'a'.repeat(40)}/1-1/template.yaml`,
      '--body', body,
      '--if-none-match', '*',
    ]), /independent_approval_unverified/);
  } finally {
    fs.rmSync(path.dirname(body), { recursive: true, force: true });
  }
});

test('read-only preflight records Oct 9 evidence and does not authorize apply', () => {
  const result = readOnlyPreflight();
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'evaluate');
  assert.equal(result.source_only, true);
  assert.equal(result.aws_writes, false);
  assert.equal(result.apply_authorized, false);
  assert.equal(result.workflow_enabled, false);
  assert.equal(result.id_token_write, false);
  assert.equal(result.live_evidence, OWNER_EVIDENCE);
  assert.equal(OWNER_EVIDENCE.artifact_bucket_policy, 'none_2026-10-09');
  assert.equal(OWNER_EVIDENCE.independent_approval_kms_key, 'unknown');
  assert.deepEqual(result.remaining_blockers, remainingBlockers());
  assert.ok(result.remaining_blockers.includes('owner_approver_role_not_evidenced'));
  assert.ok(result.blast_radius.out_of_scope.includes('SQL'));
  assert.match(result.rollback.owner_recovery, /PutBucketPolicy/);
  assert.match(result.rollback.bucket_policy, /had none/);
  assert.equal(phoneFriendlyChecklist().length >= 8, true);
});

test('GitHub OIDC workflow stays disabled without id-token write', () => {
  const oidc = githubOidcContract();
  assert.equal(oidc.ok, true);
  assert.equal(oidc.disabled, true);
  assert.equal(oidc.idTokenWrite, false);
  assert.equal(oidc.contentsRead, true);
  assert.equal(oidc.sessionDenyDelete, true);
  assert.equal(oidc.sessionIfNoneMatch, true);
  const workflow = fs.readFileSync(new URL('../../.github/workflows/staging-db-readonly-diagnostic-deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /if: \$\{\{ false \}\}/);
  assert.doesNotMatch(workflow, /id-token:\s*write/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
});

test('guarded apply refuses even when apply env is set', () => {
  const refused = guardedApplyPlan({ CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, SOURCE_ONLY_APPLY_REFUSED);
  assert.equal(refused.aws_writes, false);
  assert.ok(refused.forbidden.includes('s3api put-bucket-policy'));
  assert.ok(refused.forbidden.includes('kms create-key'));
  assert.equal(main(['--apply'], { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }), 2);
});

test('widening write-once resources or allowing deploy Sign fails closed', () => {
  const widened = structuredClone(policies);
  widened.bucketPolicy.Statement[0].Resource = `${ARTIFACT_OBJECT_ARN}`;
  assert.throws(() => evaluateLedgerPolicies(widened), /ledger_policy_invalid/);
  const signingDeploy = structuredClone(policies);
  signingDeploy.kmsPolicy.Statement.push({
    Sid: 'BadDeploySign',
    Effect: 'Allow',
    Principal: { AWS: CREATE_APPROVAL_TARGET.deployRoleArn },
    Action: ['kms:Sign'],
    Resource: '*',
  });
  assert.throws(() => evaluateLedgerPolicies(signingDeploy), /ledger_policy_invalid/);
  const noted = structuredClone(policies);
  noted.deployIam.Note = 'not an IAM field';
  assert.throws(() => evaluateLedgerPolicies(noted), /ledger_policy_invalid/);
  const oidcTrust = structuredClone(policies);
  oidcTrust.ownerTrust.Statement[0].Principal = {
    Federated: 'arn:aws:iam::806168576068:oidc-provider/token.actions.githubusercontent.com',
  };
  assert.throws(() => evaluateLedgerPolicies(oidcTrust), /ledger_policy_invalid/);
});

test('CLI preflight is source-only and never invokes aws', () => {
  const script = new URL('../../scripts/staging-db-readonly-diagnostic-kms-s3-ledger.mjs', import.meta.url);
  const evaluate = spawnSync(process.execPath, [script.pathname], {
    encoding: 'utf8',
    env: { ...process.env, PATH: os.tmpdir() },
  });
  assert.equal(evaluate.status, 0, evaluate.stderr);
  const payload = JSON.parse(evaluate.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.aws_writes, false);
  const apply = spawnSync(process.execPath, [script.pathname, '--apply'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: os.tmpdir(), CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' },
  });
  assert.equal(apply.status, 2);
  assert.match(apply.stderr, /source_only_kms_s3_ledger_apply_refused/);
});
