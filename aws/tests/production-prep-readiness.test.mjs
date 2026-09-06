import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const FALSE_FLAGS = [
  'AWS_PROVIDER_EXECUTION_ENABLED',
  'AWS_MOOV_ENABLED',
  'AWS_CHECKALT_ENABLED',
  'AWS_PLAID_ENABLED',
  'AWS_FINANCIAL_PERMISSIONS_ACTIVATED',
  'AWS_COGNITO_MFA_PREFERRED',
];

test('production-prep API templates hard-code execution flags false', () => {
  for (const rel of ['aws/production/api-cfn.yaml', 'aws/production/api-template.yaml']) {
    const text = read(rel);
    for (const flag of FALSE_FLAGS) {
      assert.match(text, new RegExp(`${flag}: "false"`), `${rel} ${flag}`);
    }
    assert.match(text, /AllowedValues:\n(?:[ \t]+- production-prep\n)/);
    assert.doesNotMatch(text, /AllowedValues:\n(?:[ \t]+- .*\n)*[ \t]+- production\n/);
    assert.match(text, /Must not be us-east-1_vPmQ7cL1F|must not be the staging client/);
    assert.match(text, /Default: us-east-1_h00WorYMT/);
    assert.doesNotMatch(text, /Default: us-east-1_vPmQ7cL1F/);
  }
});

test('prep stack does not alias checksops.com and reuses leftover production pool', () => {
  const prep = read('aws/production/prep-stack.yaml');
  assert.match(prep, /ExistingUserPoolId/);
  assert.match(prep, /us-east-1_h00WorYMT/);
  assert.match(prep, /Aliases quantity 0|WITHOUT checksops.com aliases|no checksops.com aliases/i);
  assert.doesNotMatch(prep, /Aliases:\n\s+- checksops\.com/);
  assert.match(prep, /DoNotSwitchAuth/);
});

test('ACM validation doc lists exact CNAMEs and forbids agent DNS changes', () => {
  const acm = read('aws/production/ACM_DNS_VALIDATION.md');
  assert.match(acm, /Do not create Cloudflare records from the agent/);
  assert.match(acm, /_424da145c81cf0e7659ae4a2559d8f82\.checksops\.com/);
  assert.match(acm, /_6e2cf5fd041966fbe6c8925823deca17\.jkddzztszm\.acm-validations\.aws/);
  assert.match(acm, /_4ed6942e58099ae2ecedf7cf0da89c69\.www\.checksops\.com/);
  assert.match(acm, /_94d94bddd98b0b11148e9581801530c8\.jkddzztszm\.acm-validations\.aws/);
  assert.match(acm, /185\.158\.133\.1/);
});

test('CloudWatch alarm template is deployable and actions stay disabled', () => {
  const cw = read('aws/production/cloudwatch-alarms.yaml');
  assert.match(cw, /Type: AWS::CloudWatch::Alarm/);
  assert.match(cw, /ActionsEnabled: false/);
  assert.match(cw, /checksops-production-prep-api-errors/);
  assert.match(cw, /TreatMissingData: notBreaching/);
  const example = read('aws/cutover/production/cloudwatch-alarms.example.yaml');
  assert.match(example, /DO NOT DEPLOY/);
});

test('operator Lambda role doc isolates prep API from staging VPC/role', () => {
  const doc = read('aws/production/iam/OPERATOR_LAMBDA_ROLE.md');
  assert.match(doc, /checksops-production-prep-api-role/);
  assert.match(doc, /AWSLambdaBasicExecutionRole/);
  assert.match(doc, /AWSXRayDaemonWriteAccess/);
  assert.match(doc, /Do \*\*not\*\* attach `AWSLambdaVPCAccessExecutionRole`/);
  assert.match(doc, /checksops-staging-api/);
  assert.doesNotMatch(doc, /point production DNS/i);
  const cfn = read('aws/production/api-cfn.yaml');
  assert.match(cfn, /ProductionPrepRole:/);
  assert.match(cfn, /AWSLambdaBasicExecutionRole/);
  assert.match(cfn, /AWSXRayDaemonWriteAccess/);
  assert.doesNotMatch(cfn, /AWSLambdaVPCAccessExecutionRole/);
  assert.doesNotMatch(cfn, /VpcConfig:/);
});

test('operator CloudWatch inspect policy is scoped and not auto-attached', () => {
  const policy = JSON.parse(read('aws/production/iam/operator-cloudwatch-inspect.json'));
  const actions = policy.Statement.flatMap((s) => s.Action);
  assert.ok(actions.includes('cloudwatch:DescribeAlarms'));
  assert.ok(actions.includes('cloudwatch:GetMetricStatistics'));
  assert.ok(actions.includes('cloudwatch:PutMetricAlarm'));
  assert.equal(policy.Statement.some((s) => (s.Action || []).includes('route53:ChangeResourceRecordSets')), false);
  const iamDoc = read('aws/production/iam/OPERATOR_CLOUDWATCH_IAM.md');
  assert.match(iamDoc, /does not attach/i);
  assert.match(iamDoc, /Step 5/);
  assert.match(iamDoc, /ActionsEnabled=false/);
  assert.match(iamDoc, /checksops-production-prep-alarms/);
  assert.match(iamDoc, /ExistingExecutionRoleArn/);
});

test('SES OTP proof doc forbids auto user create and keeps Lovable DNS', () => {
  const doc = read('aws/production/SES_OTP_PROOF.md');
  assert.match(doc, /6A/);
  assert.match(doc, /MessageAction=SUPPRESS/);
  assert.match(doc, /AdminDeleteUser/);
  assert.match(doc, /us-east-1_h00WorYMT/);
  assert.match(doc, /does \*\*not\*\* switch production auth/);
  assert.match(doc, /Will not happen/);
  assert.match(doc, /Import of the eight production users/);
  assert.match(doc, /185\.158\.133\.1/);
  assert.match(doc, /EMAIL_OTP deliverability is \*\*READY\*\*/);
  assert.match(doc, /production pool \*\*0 users\*\*/);
});

test('validate-production-prep refuses --apply and passes static checks', () => {
  const script = path.join(ROOT, 'aws/production/scripts/validate-production-prep.mjs');
  const applied = spawnSync(process.execPath, [script, '--apply'], { encoding: 'utf8' });
  assert.equal(applied.status, 2);
  assert.match(applied.stderr, /refused/);

  const staticRun = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(staticRun.status, 0, staticRun.stdout + staticRun.stderr);
  const body = JSON.parse(staticRun.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.productionAuthSwitch, false);
  assert.equal(body.dnsChanged, false);
});

test('cutover matrix remains STOP / BLOCKED for executing cutover', () => {
  const matrix = read('aws/cutover/CUTOVER_READINESS_MATRIX.md');
  const acm = read('aws/production/ACM_DNS_VALIDATION.md');
  assert.match(matrix, /STOP FOR REVIEW/);
  assert.match(matrix, /ChecksOps AWS overall/);
  assert.match(matrix, /\*\*BLOCKED\*\*/);
  assert.match(matrix, /\*\*`ISSUED`\*\*/);
  assert.match(acm, /\*\*`ISSUED`\*\*/);
  assert.doesNotMatch(acm, /Status \(2026-09-05 20:23 UTC\) \| `PENDING_VALIDATION`/);
});
