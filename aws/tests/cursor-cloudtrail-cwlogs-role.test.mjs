import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const trustPath = path.join(ROOT, 'aws/production/cursor-cloudtrail-cwlogs-role-trust.json');
const permsPath = path.join(ROOT, 'aws/production/cursor-cloudtrail-cwlogs-role-permissions.json');
const yamlPath = path.join(ROOT, 'aws/production/cursor-cloudtrail-cwlogs-role.yaml');
const runbookPath = path.join(ROOT, 'aws/cutover/OPERATOR_CLOUDTRAIL_CWLOGS_ROLE.md');
const assumePath = path.join(ROOT, 'aws/cutover/scripts/assume-and-run.mjs');
const hardeningYamlPath = path.join(ROOT, 'aws/production/cursor-security-hardening-role.yaml');
const hardeningPermsPath = path.join(ROOT, 'aws/production/cursor-security-hardening-role-permissions.json');

const ROLE_AGGREGATE_INLINE_LIMIT = 10240;
const CUSTOMER_MANAGED_POLICY_LIMIT = 6144;
const MANAGED_POLICY_FILES = [
  'cursor-cloudtrail-cwlogs-role-allow.json',
  'cursor-cloudtrail-cwlogs-role-deny-financial.json',
  'cursor-cloudtrail-cwlogs-role-deny-iam.json',
];
const MANAGED_POLICY_NAMES = [
  'ChecksOpsCursorCtCwLogsAllow',
  'ChecksOpsCursorCtCwLogsDenyFinancial',
  'ChecksOpsCursorCtCwLogsDenyIam',
];

const trust = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
const perms = JSON.parse(fs.readFileSync(permsPath, 'utf8'));
const managedPolicies = MANAGED_POLICY_FILES.map((name) => ({
  name,
  doc: JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/production', name), 'utf8')),
}));
const yaml = fs.readFileSync(yamlPath, 'utf8');
const runbook = fs.readFileSync(runbookPath, 'utf8');
const assume = fs.readFileSync(assumePath, 'utf8');
const hardeningYaml = fs.readFileSync(hardeningYamlPath, 'utf8');
const hardeningPerms = JSON.parse(fs.readFileSync(hardeningPermsPath, 'utf8'));

const extractJsonObjectsAfter = (text, label) => {
  const found = [];
  let searchFrom = 0;
  while (true) {
    const idx = text.indexOf(label, searchFrom);
    if (idx === -1) break;
    const prev = idx > 0 ? text[idx - 1] : '\n';
    if (label === 'PolicyDocument:' && /[A-Za-z]/.test(prev)) {
      searchFrom = idx + label.length;
      continue;
    }
    const start = text.indexOf('{', idx + label.length);
    if (start === -1) break;
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    found.push(text.slice(start, end + 1));
    searchFrom = end + 1;
  }
  return found;
};

const iamSize = (doc) => {
  const pretty = JSON.stringify(doc, null, 2);
  const compact = JSON.stringify(doc);
  const noWs = compact.replace(/\s+/g, '');
  return {
    pretty: pretty.length,
    compact: compact.length,
    noWs: noWs.length,
    utf8Pretty: Buffer.byteLength(pretty, 'utf8'),
    utf8Compact: Buffer.byteLength(compact, 'utf8'),
    utf8NoWs: Buffer.byteLength(noWs, 'utf8'),
  };
};

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
  'cloudfront:*',
  'cloudfront:UpdateDistribution',
  's3:DeleteBucket',
  's3:PutBucketPolicy',
  'cloudtrail:CreateTrail',
  'cloudtrail:DeleteTrail',
  'cloudtrail:StopLogging',
  'cloudtrail:PutEventSelectors',
  'cloudtrail:PutInsightSelectors',
];

test('temporary CW Logs role name, trust, and session match live Cursor OIDC', () => {
  assert.equal(trust.Statement.length, 1);
  const stmt = trust.Statement[0];
  assert.equal(stmt.Action, 'sts:AssumeRoleWithWebIdentity');
  assert.equal(
    stmt.Principal.Federated,
    'arn:aws:iam::806168576068:oidc-provider/api.cursor.com',
  );
  assert.equal(stmt.Condition.StringEquals['api.cursor.com:aud'], 'sts.amazonaws.com');
  assert.equal(stmt.Condition.StringEquals['api.cursor.com:sub'], 'user:325724407');
  assert.equal(stmt.Principal.AWS, undefined);
  assert.match(yaml, /RoleName: ChecksOpsCursorCloudTrailCwLogsTemp/);
  assert.match(yaml, /MaxSessionDuration: 3600/);
  assert.match(yaml, /stack\/checksops-cursor-cloudtrail-cwlogs-role/);
  assert.match(runbook, /ChecksOpsCursorCloudTrailCwLogsTemp/);
  assert.match(runbook, /checksops-cursor-cloudtrail-cwlogs-role/);
  assert.match(runbook, /CAPABILITY_NAMED_IAM/);
  assert.match(runbook, /CURSOR_AWS_CLOUDTRAIL_CWLOGS_ROLE_ARN/);
  assert.match(runbook, /checksops-ct-cwlogs/);
  assert.match(assume, /CURSOR_AWS_CLOUDTRAIL_CWLOGS_ROLE_ARN/);
  assert.match(assume, /checksops-ct-cwlogs/);
  assert.match(assume, /CURSOR_AWS_SECURITY_HARDENING_ROLE_ARN/);
  assert.match(assume, /CURSOR_AWS_ASSUME_IAM_ROLE_ARN/);
});

test('permissions cannot activate financial or provider functionality', () => {
  for (const action of forbiddenAllow) {
    assert.ok(!allowActions.includes(action), `Allow must not include ${action}`);
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

test('permissions are scoped to the CloudTrail CW Logs follow-up only', () => {
  const cfnMutate = perms.Statement.find((s) => s.Sid === 'CfnMutateOnlyTrailCwLogsStack');
  const stacks = cfnMutate.Resource.filter((r) => r.includes(':stack/'));
  assert.deepEqual(stacks, [
    'arn:aws:cloudformation:us-east-1:806168576068:stack/checksops-production-security-trail-cwlogs/*',
  ]);

  const denyStacks = perms.Statement.find((s) => s.Sid === 'DenyProtectedCloudFormationStacks').Resource;
  assert.ok(denyStacks.some((r) => r.includes('checksops-production-security-trail/')));
  assert.ok(denyStacks.some((r) => r.includes('checksops-cursor-security-hardening-role')));
  assert.ok(denyStacks.some((r) => r.includes('checksops-cursor-cloudtrail-cwlogs-role')));
  assert.ok(denyStacks.some((r) => r.includes('checksops-production-security-alarms')));

  const passRoleAllow = perms.Statement
    .filter((s) => s.Effect === 'Allow' && flattenActions(s).includes('iam:PassRole'));
  assert.equal(passRoleAllow.length, 1);
  assert.equal(
    passRoleAllow[0].Resource,
    'arn:aws:iam::806168576068:role/checksops-production-cloudtrail-cwlogs',
  );
  assert.equal(passRoleAllow[0].Condition.StringEquals['iam:PassedToService'], 'cloudtrail.amazonaws.com');

  const iamMutate = perms.Statement.find((s) => s.Sid === 'ManageCloudTrailCwLogsRole');
  assert.equal(
    iamMutate.Resource,
    'arn:aws:iam::806168576068:role/checksops-production-cloudtrail-cwlogs',
  );

  const updateTrail = perms.Statement.find((s) => s.Sid === 'UpdateTrailCwLogsOnly');
  assert.equal(updateTrail.Action, 'cloudtrail:UpdateTrail');
  assert.equal(
    updateTrail.Resource,
    'arn:aws:cloudtrail:us-east-1:806168576068:trail/checksops-production-mgmt-events',
  );

  const denyOtherTrails = perms.Statement.find((s) => s.Sid === 'DenyUpdateTrailExceptMgmtEvents');
  assert.equal(
    denyOtherTrails.NotResource,
    'arn:aws:cloudtrail:us-east-1:806168576068:trail/checksops-production-mgmt-events',
  );

  const logGroup = perms.Statement.find((s) => s.Sid === 'ManageCloudTrailLogGroup');
  assert.deepEqual(logGroup.Resource, [
    'arn:aws:logs:us-east-1:806168576068:log-group:/aws/cloudtrail/checksops-production-mgmt-events',
    'arn:aws:logs:us-east-1:806168576068:log-group:/aws/cloudtrail/checksops-production-mgmt-events:*',
  ]);
  assert.ok(flattenActions(logGroup).includes('logs:PutMetricFilter'));
  assert.ok(flattenActions(logGroup).includes('logs:PutRetentionPolicy'));

  assert.ok(denyActions.includes('cloudtrail:CreateTrail'));
  assert.ok(denyActions.includes('cloudtrail:DeleteTrail'));
  assert.ok(denyActions.includes('cloudtrail:StopLogging'));
  assert.ok(denyActions.includes('cloudtrail:PutEventSelectors'));
  assert.ok(denyActions.includes('cloudtrail:PutInsightSelectors'));
  assert.ok(!denyActions.includes('cloudtrail:UpdateTrail') || denyOtherTrails.Action === 'cloudtrail:UpdateTrail');

  assert.ok(allowActions.includes('cloudtrail:GetTrail'));
  assert.ok(allowActions.includes('cloudtrail:GetTrailStatus'));
  assert.ok(allowActions.includes('cloudtrail:GetEventSelectors'));
  assert.ok(allowActions.includes('cloudtrail:DescribeTrails'));
  assert.ok(allowActions.includes('lambda:GetFunctionConfiguration'));
  assert.ok(allowActions.includes('rds:DescribeDBInstances'));

  assert.ok(!allowResources.some((r) => String(r).includes('ChecksOpsCursorCloudStaging')));
  assert.ok(!allowResources.some((r) => String(r).includes('checksops-production-api-execution')));
  assert.ok(!allowResources.some((r) => String(r).includes('ChecksOpsCursorSecurityHardeningTemp')));
  assert.ok(!allowActions.includes('sns:CreateTopic'));
  assert.ok(!allowActions.includes('cloudwatch:PutMetricAlarm'));
  assert.ok(!allowActions.includes('config:PutConfigurationRecorder'));
  assert.ok(!allowActions.includes('ec2:CreateFlowLogs'));
});

test('does not modify ChecksOpsCursorSecurityHardeningTemp', () => {
  assert.match(yaml, /DoNotModifyHardeningRole/);
  assert.match(yaml, /ChecksOpsCursorSecurityHardeningTemp/);
  assert.match(runbook, /Do not modify `ChecksOpsCursorSecurityHardeningTemp`/);
  assert.doesNotMatch(hardeningYaml, /checksops-production-security-trail-cwlogs/);
  assert.doesNotMatch(hardeningYaml, /ChecksOpsCursorCloudTrailCwLogsTemp/);
  assert.doesNotMatch(JSON.stringify(hardeningPerms), /checksops-production-security-trail-cwlogs/);
  const hardeningDenyTrail = hardeningPerms.Statement.find((s) => flattenActions(s).includes('cloudtrail:UpdateTrail'));
  assert.equal(hardeningDenyTrail.Effect, 'Deny');
});

test('yaml uses stack-owned managed policies with zero inline', () => {
  for (const sid of perms.Statement.map((s) => s.Sid)) {
    assert.match(yaml, new RegExp(`"Sid": "${sid}"`));
  }
  for (const name of MANAGED_POLICY_NAMES) {
    assert.match(yaml, new RegExp(`ManagedPolicyName: ${name}`));
  }
  for (const ref of ['AllowCloudTrailCwLogsPolicy', 'DenyFinancialAppPolicy', 'DenyIamInfraPolicy']) {
    assert.match(yaml, new RegExp(`!Ref ${ref}`));
  }
  assert.match(yaml, /Type: AWS::IAM::ManagedPolicy/);
  assert.match(yaml, /ManagedPolicyArns:/);
  assert.doesNotMatch(yaml, /^\s+Policies:/m);
  assert.match(yaml, /RoleInlinePolicyCount:\s*\n\s+Value: '0'/);
  assert.match(yaml, /api\.cursor\.com:sub": "user:325724407"/);
  assert.match(yaml, /oidc-provider\/api\.cursor\.com/);
  assert.doesNotMatch(yaml, /oidc\.cursor\.sh/);
  assert.doesNotMatch(yaml, /checksops-production-management"/);
  assert.match(runbook, /STOP FOR REVIEW/);
  assert.match(runbook, /10,240|10240/);
  assert.match(runbook, /6,144|6144/);
  assert.match(runbook, /Do not deploy/);
  assert.match(runbook, /delete-stack/);
  assert.match(runbook, /ChecksOpsCursorCloudStaging/);
});

test('managed policies fit customer-managed 6144 and role aggregate inline stays 0/10240', () => {
  assert.equal(managedPolicies.length, 3);
  assert.ok(managedPolicies.length <= 10, 'default IAM quota is 10 managed policies per role');

  const splitSids = managedPolicies.flatMap((p) => p.doc.Statement.map((s) => s.Sid)).sort();
  const combinedSids = perms.Statement.map((s) => s.Sid).sort();
  assert.deepEqual(splitSids, combinedSids);

  const combinedSize = iamSize(perms);
  assert.ok(
    combinedSize.compact > ROLE_AGGREGATE_INLINE_LIMIT,
    `combined compact ${combinedSize.compact} should exceed inline quota so it must not be attached as one policy`,
  );

  let aggregateInline = 0;
  for (const policy of managedPolicies) {
    const size = iamSize(policy.doc);
    for (const [label, value] of Object.entries({
      pretty: size.pretty,
      compact: size.compact,
      noWs: size.noWs,
      utf8Pretty: size.utf8Pretty,
      utf8Compact: size.utf8Compact,
      utf8NoWs: size.utf8NoWs,
    })) {
      assert.ok(
        value <= CUSTOMER_MANAGED_POLICY_LIMIT,
        `${policy.name} ${label} ${value} exceeds managed-policy ${CUSTOMER_MANAGED_POLICY_LIMIT}`,
      );
    }
  }

  assert.equal(aggregateInline, 0);
  assert.ok(aggregateInline <= ROLE_AGGREGATE_INLINE_LIMIT);

  const yamlDocs = extractJsonObjectsAfter(yaml, 'PolicyDocument:');
  assert.equal(yamlDocs.length, 3);
  for (const [i, raw] of yamlDocs.entries()) {
    const doc = JSON.parse(raw);
    assert.deepEqual(doc, managedPolicies[i].doc);
    const size = iamSize(doc);
    assert.ok(size.pretty <= CUSTOMER_MANAGED_POLICY_LIMIT, `yaml managed pretty ${size.pretty}`);
    assert.ok(size.compact <= CUSTOMER_MANAGED_POLICY_LIMIT, `yaml managed compact ${size.compact}`);
    assert.ok(size.noWs <= CUSTOMER_MANAGED_POLICY_LIMIT, `yaml managed noWs ${size.noWs}`);
  }

  const trustDocs = extractJsonObjectsAfter(yaml, 'AssumeRolePolicyDocument:');
  assert.equal(trustDocs.length, 1);
  const trustDoc = JSON.parse(trustDocs[0]);
  assert.deepEqual(trustDoc, trust);
  assert.ok(iamSize(trustDoc).pretty < 2048);

  const denyDocs = managedPolicies.filter((p) => p.name.includes('deny-'));
  assert.equal(denyDocs.length, 2);
  for (const deny of denyDocs) {
    assert.ok(deny.doc.Statement.every((s) => s.Effect === 'Deny'));
  }
  assert.ok(
    denyDocs.some((p) => p.doc.Statement.some((s) => s.Sid === 'DenyFinancialAndAppMutation')),
  );
  assert.ok(
    denyDocs.some((p) => p.doc.Statement.some((s) => s.Sid === 'DenyCloudTrailCreateDeleteSelectors')),
  );
});
