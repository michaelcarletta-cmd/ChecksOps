import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const trustPath = path.join(ROOT, 'aws/production/cursor-security-hardening-role-trust.json');
const permsPath = path.join(ROOT, 'aws/production/cursor-security-hardening-role-permissions.json');
const yamlPath = path.join(ROOT, 'aws/production/cursor-security-hardening-role.yaml');
const runbookPath = path.join(ROOT, 'aws/cutover/OPERATOR_TEMPORARY_ROLE.md');
const assumePath = path.join(ROOT, 'aws/cutover/scripts/assume-and-run.mjs');

const trust = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
const perms = JSON.parse(fs.readFileSync(permsPath, 'utf8'));
const yaml = fs.readFileSync(yamlPath, 'utf8');
const runbook = fs.readFileSync(runbookPath, 'utf8');
const assume = fs.readFileSync(assumePath, 'utf8');

const flattenActions = (statement) => {
  const raw = statement.Action;
  return Array.isArray(raw) ? raw : [raw];
};

const allowActions = perms.Statement
  .filter((s) => s.Effect === 'Allow')
  .flatMap(flattenActions);

const denyActions = perms.Statement
  .filter((s) => s.Effect === 'Deny')
  .flatMap(flattenActions);

const allowResources = perms.Statement
  .filter((s) => s.Effect === 'Allow')
  .flatMap((s) => {
    const raw = s.Resource;
    if (raw == null) return [];
    return Array.isArray(raw) ? raw : [raw];
  });

const forbiddenAllow = [
  'lambda:UpdateFunctionConfiguration',
  'lambda:UpdateFunctionCode',
  'lambda:*',
  'rds:ModifyDBInstance',
  'rds-data:ExecuteStatement',
  'secretsmanager:GetSecretValue',
  'iam:CreateAccessKey',
  'iam:CreateUser',
  'iam:AttachUserPolicy',
  'sts:AssumeRole',
  'wafv2:*',
  'cloudfront:UpdateDistribution',
  's3:DeleteBucket',
  's3:PutBucketPolicy',
  'cloudtrail:CreateTrail',
  'cloudtrail:DeleteTrail',
  'cloudtrail:StopLogging',
];

test('temporary hardening role name, trust, and session match staging OIDC', () => {
  assert.equal(trust.Statement.length, 1);
  const stmt = trust.Statement[0];
  assert.equal(stmt.Action, 'sts:AssumeRoleWithWebIdentity');
  assert.equal(
    stmt.Principal.Federated,
    'arn:aws:iam::806168576068:oidc-provider/oidc.cursor.sh',
  );
  assert.equal(stmt.Condition.StringEquals['oidc.cursor.sh:aud'], 'sts.amazonaws.com');
  assert.equal(
    stmt.Condition.StringEquals['oidc.cursor.sh:sub'],
    'repo:michaelcarletta-cmd/ChecksOps:environment:staging',
  );
  assert.equal(stmt.Principal.AWS, undefined);
  assert.match(yaml, /RoleName: ChecksOpsCursorSecurityHardeningTemp/);
  assert.match(yaml, /MaxSessionDuration: 3600/);
  assert.match(yaml, /stack\/checksops-cursor-security-hardening-role/);
  assert.match(runbook, /ChecksOpsCursorSecurityHardeningTemp/);
  assert.match(runbook, /checksops-cursor-security-hardening-role/);
  assert.match(runbook, /CAPABILITY_NAMED_IAM/);
  assert.match(runbook, /CURSOR_AWS_SECURITY_HARDENING_ROLE_ARN/);
  assert.match(assume, /CURSOR_AWS_SECURITY_HARDENING_ROLE_ARN/);
  assert.match(assume, /CURSOR_AWS_ASSUME_IAM_ROLE_ARN/);
  assert.match(assume, /checksops-sec-hard/);
});

test('permissions cannot activate financial or provider functionality', () => {
  for (const action of forbiddenAllow) {
    assert.ok(
      !allowActions.includes(action),
      `Allow must not include ${action}`,
    );
  }
  assert.ok(denyActions.includes('lambda:UpdateFunctionConfiguration'));
  assert.ok(denyActions.includes('lambda:UpdateFunctionCode'));
  assert.ok(denyActions.includes('secretsmanager:GetSecretValue'));
  assert.ok(denyActions.includes('rds-data:ExecuteStatement'));
  assert.ok(denyActions.includes('sts:AssumeRole'));
  assert.ok(denyActions.includes('iam:CreateAccessKey'));
  assert.match(yaml, /DoNotUseForFinancial/);
  assert.match(runbook, /cannot activate financial/);
  assert.match(runbook, /64_financial_activation_grants\.sql/);
  assert.doesNotMatch(yaml, /AWS_MOOV_ENABLED|AWS_CHECKALT_ENABLED|AWS_FINANCIAL_PERMISSIONS_ACTIVATED/);
  assert.doesNotMatch(runbook, /64_financial_activation_grants\.sql` is applied/);
});

test('permissions are scoped to reviewed #2-#6 stacks and leftover protections', () => {
  const cfnMutate = perms.Statement.find((s) => s.Sid === 'CfnMutateOnlyDeployments2to6');
  const stacks = cfnMutate.Resource.filter((r) => r.includes(':stack/'));
  assert.deepEqual(new Set(stacks), new Set([
    'arn:aws:cloudformation:us-east-1:806168576068:stack/checksops-production-security-sns/*',
    'arn:aws:cloudformation:us-east-1:806168576068:stack/checksops-production-security-config/*',
    'arn:aws:cloudformation:us-east-1:806168576068:stack/checksops-production-security-posture/*',
    'arn:aws:cloudformation:us-east-1:806168576068:stack/checksops-production-security-flow/*',
    'arn:aws:cloudformation:us-east-1:806168576068:stack/checksops-production-security-alarms/*',
  ]));
  assert.ok(!stacks.some((r) => r.includes('security-trail')));
  assert.ok(!stacks.some((r) => r.includes('prep-api')));

  const denyStacks = perms.Statement.find((s) => s.Sid === 'DenyProtectedCloudFormationStacks').Resource;
  assert.ok(denyStacks.some((r) => r.includes('checksops-production-security-trail')));
  assert.ok(denyStacks.some((r) => r.includes('checksops-cursor-security-hardening-role')));

  const passRoleAllow = perms.Statement
    .filter((s) => s.Effect === 'Allow' && flattenActions(s).includes('iam:PassRole'))
    .map((s) => s.Resource);
  assert.deepEqual(new Set(passRoleAllow), new Set([
    'arn:aws:iam::806168576068:role/checksops-production-config-recorder',
    'arn:aws:iam::806168576068:role/checksops-production-vpc-flow-logs',
  ]));
  assert.ok(!allowResources.some((r) => String(r).includes('ChecksOpsCursorCloudStaging')));
  assert.ok(!allowResources.some((r) => String(r).includes('checksops-production-api-execution')));

  assert.ok(denyActions.includes('s3:PutBucketPolicy'));
  assert.ok(denyActions.includes('s3:DeleteBucket'));
  assert.ok(denyActions.includes('cloudtrail:CreateTrail'));
  assert.ok(denyActions.includes('wafv2:*'));
  assert.ok(denyActions.includes('cloudfront:UpdateDistribution'));

  const slr = perms.Statement.find((s) => s.Sid === 'CreateDetectionServiceLinkedRoles');
  assert.deepEqual(slr.Condition.StringEquals['iam:AWSServiceName'], [
    'guardduty.amazonaws.com',
    'securityhub.amazonaws.com',
    'config.amazonaws.com',
  ]);

  assert.ok(allowActions.includes('sns:CreateTopic'));
  assert.ok(allowActions.includes('config:PutConfigurationRecorder'));
  assert.ok(allowActions.includes('guardduty:CreateDetector'));
  assert.ok(allowActions.includes('securityhub:EnableSecurityHub'));
  assert.ok(allowActions.includes('ec2:CreateFlowLogs'));
  assert.ok(allowActions.includes('cloudwatch:PutMetricAlarm'));
  assert.ok(allowActions.includes('cloudtrail:GetTrail'));
  assert.ok(allowActions.includes('lambda:GetFunctionConfiguration'));
  assert.ok(allowActions.includes('rds:DescribeDBInstances'));
});

test('yaml inlines the reviewed JSON documents and does not touch leftover trail stack', () => {
  for (const sid of perms.Statement.map((s) => s.Sid)) {
    assert.match(yaml, new RegExp(`"Sid": "${sid}"`));
  }
  assert.match(yaml, /oidc\.cursor\.sh:sub": "repo:michaelcarletta-cmd\/ChecksOps:environment:staging"/);
  assert.doesNotMatch(yaml, /checksops-production-management"/);
  assert.match(runbook, /STOP FOR REVIEW/);
  assert.match(runbook, /Do not create this role in AWS/);
  assert.match(runbook, /ChecksOpsCursorCloudStaging/);
  assert.match(runbook, /add it to `ChecksOpsCursorCloudStaging`/);
});
