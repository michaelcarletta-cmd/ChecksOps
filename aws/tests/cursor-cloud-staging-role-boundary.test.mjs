import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The permissions boundary every checksops-staging-* role the Cursor staging role creates or changes
// must carry, and the statements on ChecksOpsDenyProduction that enforce it. See
// aws/cursor-cloud-staging/README.md ("Staging role boundary").
const read = (rel) => JSON.parse(fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));
const DIR = 'aws/cursor-cloud-staging/policies';
const TARGET = read(`${DIR}/deny-production.json`);
const LIVE = read(`${DIR}/deny-production.live-2026-10-29-after-a2.json`);
const BOUNDARY = read(`${DIR}/staging-role-boundary.json`);
const BOUNDARY_ARN = 'arn:aws:iam::806168576068:policy/ChecksOpsStagingRoleBoundary';
const STAGING_ROLES = 'arn:aws:iam::806168576068:role/checksops-staging-*';
const ENFORCE_SIDS = ['DenyRoleWritesWithoutStagingBoundary', 'DenyRemovingStagingBoundary', 'DenyEditingStagingBoundaryPolicy'];
const ROLE_WRITES = ['iam:CreateRole', 'iam:PutRolePolicy', 'iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:DeleteRolePolicy', 'iam:PutRolePermissionsBoundary'];
const arr = (v) => (Array.isArray(v) ? v : [v]);
const bySid = (doc, sid) => doc.Statement.find((s) => s.Sid === sid);

test('the Cursor role may write a role only when it carries the staging boundary', () => {
  const s = bySid(TARGET, 'DenyRoleWritesWithoutStagingBoundary');
  assert.equal(s.Effect, 'Deny');
  assert.deepEqual(arr(s.Action), ROLE_WRITES);
  assert.equal(s.Resource, '*');
  assert.deepEqual(s.Condition, { StringNotEquals: { 'iam:PermissionsBoundary': BOUNDARY_ARN } });
});

test('the Cursor role can neither remove a boundary nor edit the boundary policy', () => {
  assert.deepEqual(bySid(TARGET, 'DenyRemovingStagingBoundary'), { Sid: 'DenyRemovingStagingBoundary', Effect: 'Deny', Action: ['iam:DeleteRolePermissionsBoundary'], Resource: '*' });
  const edit = bySid(TARGET, 'DenyEditingStagingBoundaryPolicy');
  assert.equal(edit.Effect, 'Deny');
  assert.deepEqual(arr(edit.Resource), [BOUNDARY_ARN]);
  for (const a of ['iam:CreatePolicyVersion', 'iam:DeletePolicy', 'iam:DeletePolicyVersion', 'iam:SetDefaultPolicyVersion']) assert.ok(arr(edit.Action).includes(a), a);
});

test('only the three enforcement statements are added; every live deny is unchanged', () => {
  const { Statement, ...rest } = TARGET;
  const { Statement: liveStatements, ...liveRest } = LIVE;
  assert.deepEqual(rest, liveRest);
  assert.deepEqual(Statement.slice(0, liveStatements.length), liveStatements);
  assert.deepEqual(Statement.slice(liveStatements.length).map((s) => s.Sid), ENFORCE_SIDS);
  assert.ok(Statement.every((s) => s.Effect === 'Deny'));
  // Inline policies on a role share a 10,240-character limit.
  assert.ok(JSON.stringify(TARGET).length < 6000);
});

test('the boundary repeats every production deny and the enforcement, so a bounded role cannot escape either', () => {
  const denies = BOUNDARY.Statement.filter((s) => s.Effect === 'Deny');
  assert.deepEqual(denies, TARGET.Statement);
  // A managed policy is limited to 6,144 characters without whitespace.
  assert.ok(JSON.stringify(BOUNDARY).length < 6144);
});

test('the boundary allows only the services the Cursor role and its throwaway roles use', () => {
  const allows = BOUNDARY.Statement.filter((s) => s.Effect === 'Allow');
  const actions = allows.flatMap((s) => arr(s.Action));
  const services = [...new Set(actions.map((a) => a.split(':')[0]))].sort();
  assert.deepEqual(services, ['apigateway', 'cognito-idp', 'ec2', 'events', 'iam', 'lambda', 'logs', 's3', 'scheduler', 'secretsmanager', 'ses', 'textract', 'xray']);
  // Nothing that reaches another principal or a machine.
  for (const a of actions) assert.doesNotMatch(a, /^(sts|ssm|kms|rds|organizations):|^\*$|^iam:\*$|^ec2:\*$/, a);
  // EC2 only for a Lambda's VPC network interfaces and lookups.
  for (const a of actions.filter((x) => x.startsWith('ec2:'))) assert.match(a, /^ec2:(Create|Describe|Delete|Detach)NetworkInterfaces?$|^ec2:(Assign|Unassign)PrivateIpAddresses$|^ec2:Describe(Subnets|SecurityGroups|Vpcs)$/, a);
  // IAM: reads, plus role writes on checksops-staging-* roles only (and those still need the boundary).
  const iamWrites = allows.filter((s) => arr(s.Action).some((a) => a.startsWith('iam:') && !/^iam:(Get\*|List\*|SimulatePrincipalPolicy)$/.test(a)));
  assert.deepEqual(iamWrites.map((s) => s.Sid), ['AllowStagingRoleWrites']);
  assert.deepEqual(arr(iamWrites[0].Resource), [STAGING_ROLES]);
  for (const a of ['iam:CreateUser', 'iam:CreateAccessKey', 'iam:CreatePolicy', 'iam:UpdateAssumeRolePolicy']) assert.ok(!actions.includes(a), a);
});

test('the runbook records the read-only simulation and the apply steps', () => {
  const readme = fs.readFileSync(new URL('../../aws/cursor-cloud-staging/README.md', import.meta.url), 'utf8');
  assert.match(readme, /## Staging role boundary/);
  assert.match(readme, /aws iam create-policy[\s\S]*--policy-name ChecksOpsStagingRoleBoundary/);
  assert.match(readme, /deny-production\.live-2026-10-29-after-a2\.json/);
  assert.match(readme, /--permissions-boundary arn:aws:iam::806168576068:policy\/ChecksOpsStagingRoleBoundary/);
});
