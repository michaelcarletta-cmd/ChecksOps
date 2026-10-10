import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PERMS = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/production/sql53-config-writer-permissions.json'), 'utf8'));
const FAIL_CLOSED = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/production/sql53-config-writer-trust-fail-closed.json'), 'utf8'));
const USER_TEMPLATE = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/production/sql53-config-writer-trust-owner-iam-user.template.json'), 'utf8'));
const CURSOR_OIDC = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/production/sql53-config-writer-trust-cursor-oidc-owner.json'), 'utf8'));
const IDENTITY = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/production-sql53-config-writer-iam.json'), 'utf8'));
const RUNBOOK = fs.readFileSync(path.join(ROOT, 'ops/production-sql53-config-writer-iam.md'), 'utf8');
const WRITER = fs.readFileSync(path.join(ROOT, 'scripts/deployment-guard/lib/sql53-temporary-lambda-config.mjs'), 'utf8');

const FUNCTION_ARN = 'arn:aws:lambda:us-east-1:806168576068:function:checksops-production-prep-api';
const ROLE_ARN = 'arn:aws:iam::806168576068:role/ChecksOpsProductionSql53ConfigWriter';
const REQUIRED_ACTIONS = [
  'lambda:GetFunctionConfiguration',
  'lambda:UpdateFunctionConfiguration',
  'lambda:InvokeFunction',
];
const REJECTED = [
  'ChecksOpsCursorCloudStaging',
  'ChecksOpsGitHubProductionReadOnlyInspect',
  'ChecksOpsGitHubStaging',
  'checksops-production-api-execution',
  'token.actions.githubusercontent.com',
  'arn:aws:iam::806168576068:root',
];

function jsonText(value) {
  return JSON.stringify(value);
}

test('SQL53 writer permission policy is exactly the three pinned Lambda actions', () => {
  assert.equal(PERMS.Statement.length, 1);
  const statement = PERMS.Statement[0];
  assert.equal(statement.Effect, 'Allow');
  assert.deepEqual(statement.Action, REQUIRED_ACTIONS);
  assert.equal(statement.Resource, FUNCTION_ARN);
  assert.equal(IDENTITY.permission_resource, FUNCTION_ARN);
  assert.deepEqual(IDENTITY.permission_actions, REQUIRED_ACTIONS);
  assert.match(WRITER, /SQL53_CONFIG_ROLE_ARN = 'arn:aws:iam::806168576068:role\/ChecksOpsProductionSql53ConfigWriter'/);
});

test('SQL53 writer policies refuse wildcards, extra actions, and unselected trust', () => {
  const allowDocs = [PERMS, USER_TEMPLATE.Statement.filter((row) => row.Effect === 'Allow'), CURSOR_OIDC.Statement.filter((row) => row.Effect === 'Allow')];
  const allowBlob = jsonText(allowDocs);
  assert.doesNotMatch(jsonText(PERMS), /\*/);
  assert.doesNotMatch(allowBlob, /AdministratorAccess|lambda:UpdateFunctionCode|iam:PassRole|secretsmanager:|rds:|cloudformation:/);
  assert.equal(IDENTITY.selected_trust, null);
  assert.equal(IDENTITY.iam_create_authorized, false);
  assert.equal(IDENTITY.iam_mutation_authorized, false);
  assert.equal(IDENTITY.administrator_identity.verified, false);
  assert.equal(IDENTITY.administrator_identity.aws_iam_principal_arn, null);
});

test('fail-closed trust denies every assume and is the committed default', () => {
  assert.equal(FAIL_CLOSED.Statement.length, 1);
  assert.equal(FAIL_CLOSED.Statement[0].Effect, 'Deny');
  assert.deepEqual(FAIL_CLOSED.Statement[0].Principal, '*');
  assert.ok(FAIL_CLOSED.Statement[0].Action.includes('sts:AssumeRole'));
  assert.ok(FAIL_CLOSED.Statement[0].Action.includes('sts:AssumeRoleWithWebIdentity'));
  assert.equal(IDENTITY.selected_trust, null);
  assert.match(RUNBOOK, /trust-fail-closed\.json/);
  assert.match(RUNBOOK, /Do not create a usable role from it/);
});

test('owner IAM user template stays unusable until the owner names a real user', () => {
  const allow = USER_TEMPLATE.Statement.find((row) => row.Sid === 'AllowNamedOwnerIamUserWithMfaOnly');
  assert.equal(allow.Principal.AWS, 'arn:aws:iam::806168576068:user/OWNER_IAM_USER_ARN_REQUIRED');
  assert.equal(allow.Condition.Bool['aws:MultiFactorAuthPresent'], 'true');
  const ownerCandidate = IDENTITY.owner_controlled_candidates.find((row) => row.id === 'owner-iam-user');
  assert.equal(ownerCandidate.verified, false);
  assert.equal(ownerCandidate.arn, null);
  assert.equal(ownerCandidate.recommended, true);
  assert.match(RUNBOOK, /Do not apply the placeholder/);
});

test('Cursor OIDC trust is pinned to the owner subject and rejects staging and GitHub', () => {
  const allow = CURSOR_OIDC.Statement.find((row) => row.Sid === 'AllowOwnerCursorCloudOidcOnly');
  assert.equal(allow.Action, 'sts:AssumeRoleWithWebIdentity');
  assert.equal(allow.Principal.Federated, 'arn:aws:iam::806168576068:oidc-provider/api.cursor.com');
  assert.deepEqual(allow.Condition.StringEquals, {
    'api.cursor.com:aud': 'sts.amazonaws.com',
    'api.cursor.com:sub': 'user:325724407',
  });
  const denied = jsonText(CURSOR_OIDC.Statement.find((row) => row.Sid === 'DenyRejectedIdentities'));
  for (const value of REJECTED) {
    assert.match(denied, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(jsonText(IDENTITY.rejected_principals), new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const oidcCandidate = IDENTITY.owner_controlled_candidates.find((row) => row.id === 'cursor-oidc-owner');
  assert.equal(oidcCandidate.recommended, false);
  assert.equal(oidcCandidate.requires_explicit_owner_approval, true);
  assert.equal(oidcCandidate.verified, 'cursor_cloud_owner_subject_only');
});

test('create procedure forbids Cursor staging, GitHub inspect, and immediate invoke', () => {
  assert.match(RUNBOOK, /Do not run from\n`ChecksOpsCursorCloudStaging`/);
  assert.match(RUNBOOK, /aws iam create-role/);
  assert.match(RUNBOOK, /ChecksOpsProductionSql53ConfigWriterInline/);
  assert.match(RUNBOOK, /--fingerprint-only/);
  assert.match(RUNBOOK, /Stop again before receipt, apply, or invoke/);
  assert.equal(IDENTITY.role_arn, ROLE_ARN);
});
