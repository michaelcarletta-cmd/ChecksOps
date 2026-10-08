import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  DEPLOYMENT,
  isMissingStackError,
  safeVersionRecord,
  validateAwsIdentity,
  validateDeployContext,
} from '../../scripts/staging-db-readonly-diagnostic-deploy.mjs';
import { lookupSharedStack } from '../../scripts/deployment-guard/lib/shared-targets.mjs';

const SHA = 'a'.repeat(40);
const CODE_SHA256 = 'A'.repeat(43) + '=';
const validContext = (overrides = {}) => ({
  githubRef: 'refs/heads/main',
  githubSha: SHA,
  checkedOutSha: SHA,
  approvedSha: SHA,
  environment: 'staging',
  region: 'us-east-1',
  roleArn: DEPLOYMENT.roleArn,
  runId: '100',
  runAttempt: '1',
  ...overrides,
});

test('deployment allowlists only the fixed staging stack and diagnostic function', () => {
  assert.equal(validateDeployContext(validContext()), true);
  for (const target of [
    { targetStack: 'checksops-staging-api' },
    { targetFunction: 'checksops-staging-api' },
    { targetFunction: 'checksops-production-prep-api' },
    { targetStack: 'checksops-production-cloudtrail' },
  ]) {
    assert.throws(() => validateDeployContext(validContext(target)), /deployment_target_rejected/);
  }
  assert.equal(lookupSharedStack(DEPLOYMENT.stackName).target_environment, 'staging');
  assert.equal(lookupSharedStack('checksops-staging-api'), null);
});

test('production refs, accounts, regions, roles, and environments are hard-blocked', () => {
  for (const context of [
    { githubRef: 'refs/heads/production' },
    { githubRef: 'refs/heads/main', environment: 'production' },
    { region: 'us-west-2' },
    { roleArn: 'arn:aws:iam::806168576068:role/ChecksOpsGitHubStagingLambdaOverlay' },
  ]) {
    assert.throws(() => validateDeployContext(validContext(context)));
  }
  assert.throws(() => validateAwsIdentity({
    Account: '123456789012',
    Arn: 'arn:aws:sts::123456789012:assumed-role/ChecksOpsGitHubStagingDbReadonlyDiagnosticDeploy/run',
  }), /aws_account_or_role_rejected/);
  assert.throws(() => validateAwsIdentity({
    Account: DEPLOYMENT.account,
    Arn: 'arn:aws:sts::806168576068:assumed-role/ChecksOpsGitHubStagingLambdaOverlay/run',
  }), /aws_account_or_role_rejected/);
  assert.equal(validateAwsIdentity({
    Account: DEPLOYMENT.account,
    Arn: 'arn:aws:sts::806168576068:assumed-role/ChecksOpsGitHubStagingDbReadonlyDiagnosticDeploy/run',
  }), true);
});

test('deployment requires exact reviewed main and checked-out SHA', () => {
  for (const context of [
    { githubRef: 'refs/heads/copilot/change' },
    { githubSha: 'b'.repeat(40) },
    { checkedOutSha: 'b'.repeat(40) },
    { approvedSha: 'b'.repeat(40) },
    { githubSha: 'invalid-sha' },
  ]) {
    assert.throws(() => validateDeployContext(validContext(context)), /unreviewed_source/);
  }
});

test('only a missing new stack is accepted as deployment precondition', () => {
  assert.equal(isMissingStackError('ValidationError: Stack with id checksops-staging-db-readonly-diagnostic does not exist'), true);
  assert.equal(isMissingStackError('AccessDenied: not authorized to perform DescribeStacks'), false);
  assert.equal(isMissingStackError('Stack is UPDATE_IN_PROGRESS'), false);
});

test('deployment publishes and emits only the immutable version ARN and matching code fingerprint', () => {
  const record = safeVersionRecord({
    FunctionArn: `arn:aws:lambda:us-east-1:806168576068:function:${DEPLOYMENT.functionName}`,
    Version: '12',
    CodeSha256: CODE_SHA256,
  });
  assert.deepEqual(record, {
    version_arn: `arn:aws:lambda:us-east-1:806168576068:function:${DEPLOYMENT.functionName}:12`,
    code_sha256: CODE_SHA256,
  });
  for (const bad of [
    { FunctionArn: 'arn:aws:lambda:us-east-1:806168576068:function:checksops-staging-api', Version: '12', CodeSha256: CODE_SHA256 },
    { FunctionArn: `arn:aws:lambda:us-east-1:806168576068:function:${DEPLOYMENT.functionName}`, Version: '$LATEST', CodeSha256: CODE_SHA256 },
    { FunctionArn: `arn:aws:lambda:us-east-1:806168576068:function:${DEPLOYMENT.functionName}`, Version: '12', CodeSha256: 'raw payload' },
  ]) assert.throws(() => safeVersionRecord(bad), /published_version_contract_rejected/);
  assert.throws(() => safeVersionRecord({
    FunctionArn: `arn:aws:lambda:us-east-1:806168576068:function:${DEPLOYMENT.functionName}`,
    Version: '12',
    CodeSha256: 'B'.repeat(43) + '=',
  }, CODE_SHA256), /published_version_contract_rejected/);
});

test('workflow uses protected main-only staging OIDC and no API or production target', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/staging-db-readonly-diagnostic-deploy.yml', import.meta.url), 'utf8');
  const runner = fs.readFileSync(new URL('../../scripts/staging-db-readonly-diagnostic-deploy.mjs', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment: staging/);
  assert.match(workflow, /GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(workflow, /APPROVED_COMMIT" = "\$GITHUB_SHA"/);
  assert.match(workflow, /CHECKSOPS_STAGING_DB_DIAGNOSTIC_ROLE_ARN/);
  assert.match(workflow, /CHECKSOPS_DEPLOYMENT_GUARD_RECEIPT/);
  assert.match(workflow, /cloudformation:CreateStack/);
  assert.match(workflow, /lambda:PublishVersion/);
  assert.match(runner, /'create-stack'/);
  assert.match(runner, /'stack-create-complete'/);
  assert.doesNotMatch(runner, /cloudformation', 'deploy/);
  assert.doesNotMatch(workflow, /checksops-staging-api|checksops-production-prep-api|production-spa|arn:aws:lambda:us-east-1:[^"]*production/i);
  assert.match(runner, /enforceSharedStackTarget/);
  assert.match(runner, /--code-sha256/);
  assert.match(runner, /safeVersionRecord/);
  assert.match(runner, /GITHUB_RUN_ID.*GITHUB_RUN_ATTEMPT/);
  assert.doesNotMatch(runner, /checksops-staging-api|checksops-production-prep-api|checksops-production-cloudtrail/);
});
