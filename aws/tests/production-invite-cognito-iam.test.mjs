import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  PRODUCTION_POOL_ARN,
  STAGING_POOL_ID,
  REQUIRED_ACTIONS,
  INVITE_COGNITO_STATEMENT,
  mergeInviteCognitoStatement,
  verifyInviteCognitoPolicy,
  verifyNonCognitoPreserved,
  hasExactInviteCognitoStatement,
} from '../production/lib/production-invite-cognito-iam.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

const liveLike = () => ({
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'AppDatabaseSecretRead',
      Effect: 'Allow',
      Action: ['secretsmanager:GetSecretValue'],
      Resource: 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops/1790081257144-A2Z4bw',
    },
    {
      Sid: 'PrivateCheckImageBucket',
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
      Resource: [
        'arn:aws:s3:::checksops-production-privatefiles-806168576068',
        'arn:aws:s3:::checksops-production-privatefiles-806168576068/*',
      ],
    },
    {
      Sid: 'SesInviteDelivery',
      Effect: 'Allow',
      Action: ['ses:SendEmail', 'ses:SendRawEmail'],
      Resource: 'arn:aws:ses:us-east-1:806168576068:identity/support@checksops.com',
    },
  ],
});

test('merge appends only the three production-pool invite actions', () => {
  const before = liveLike();
  const { document, changed, reason } = mergeInviteCognitoStatement(before);
  assert.equal(changed, true);
  assert.equal(reason, 'appended');
  assert.equal(verifyNonCognitoPreserved(before, document), true);
  assert.deepEqual(document.Statement.slice(0, 3), before.Statement);
  const check = verifyInviteCognitoPolicy(document);
  assert.equal(check.ok, true);
  assert.deepEqual(check.missing, []);
  assert.deepEqual(check.extra, []);
  assert.equal(check.hasWildcard, false);
  assert.equal(check.resourceExact, true);
  assert.equal(document.Statement.at(-1).Resource, PRODUCTION_POOL_ARN);
  assert.deepEqual(document.Statement.at(-1).Action, [...REQUIRED_ACTIONS]);
});

test('merge is idempotent when the exact invite statement already exists', () => {
  const before = liveLike();
  before.Statement.push({ ...INVITE_COGNITO_STATEMENT, Action: [...REQUIRED_ACTIONS] });
  const { document, changed, reason } = mergeInviteCognitoStatement(before);
  assert.equal(changed, false);
  assert.equal(reason, 'already_present');
  assert.equal(hasExactInviteCognitoStatement(document), true);
  assert.equal(JSON.stringify(document), JSON.stringify(before));
});

test('merge refuses cognito-idp:* and unrelated admin actions', () => {
  const wildcard = liveLike();
  wildcard.Statement.push({
    Sid: 'TooBroad',
    Effect: 'Allow',
    Action: 'cognito-idp:*',
    Resource: PRODUCTION_POOL_ARN,
  });
  assert.throws(() => mergeInviteCognitoStatement(wildcard), /forbidden Cognito/);

  const extra = liveLike();
  extra.Statement.push({
    Sid: 'TenantInviteUserProductionCognito',
    Effect: 'Allow',
    Action: [...REQUIRED_ACTIONS, 'cognito-idp:AdminDisableUser'],
    Resource: PRODUCTION_POOL_ARN,
  });
  assert.throws(() => mergeInviteCognitoStatement(extra), /forbidden Cognito|does not match/);
});

test('merge refuses another user pool or unexpected Cognito statements', () => {
  const staging = liveLike();
  staging.Statement.push({
    Sid: 'OtherPool',
    Effect: 'Allow',
    Action: REQUIRED_ACTIONS,
    Resource: `arn:aws:cognito-idp:us-east-1:806168576068:userpool/${STAGING_POOL_ID}`,
  });
  assert.throws(() => mergeInviteCognitoStatement(staging), /forbidden Cognito|unexpected Cognito/);
});

test('verify requires the exact production pool and no extras', () => {
  const ok = liveLike();
  ok.Statement.push({ ...INVITE_COGNITO_STATEMENT, Action: [...REQUIRED_ACTIONS] });
  assert.equal(verifyInviteCognitoPolicy(ok).ok, true);

  const missing = liveLike();
  assert.equal(verifyInviteCognitoPolicy(missing).ok, false);
  assert.deepEqual(verifyInviteCognitoPolicy(missing).missing, [...REQUIRED_ACTIONS]);
});

test('operator script and template do not CloudFormation-update the live stack', () => {
  const script = fs.readFileSync(
    path.join(ROOT, 'aws/production/scripts/apply-production-invite-cognito-iam.mjs'),
    'utf8',
  );
  const yaml = fs.readFileSync(path.join(ROOT, 'aws/production/api-execution-role.yaml'), 'utf8');
  const runbook = fs.readFileSync(
    path.join(ROOT, 'aws/cutover/OPERATOR_PRODUCTION_INVITE_COGNITO_IAM.md'),
    'utf8',
  );
  assert.match(runbook, /authorized production IAM operator/);
  assert.match(runbook, /Do \*\*not\*\* CloudFormation-update `checksops-production-api-role`/);
  assert.match(runbook, /CONFIRM=APPLY_PRODUCTION_INVITE_COGNITO_IAM/);
  assert.match(runbook, /prodonboard59ff/);
  assert.match(script, /Does NOT update CloudFormation stack/);
  assert.match(script, /put-role-policy/);
  assert.doesNotMatch(script, /cloudformation (update-stack|deploy)/);
  assert.match(yaml, /Do not CloudFormation-update/);
  assert.match(yaml, /checksops-production-privatefiles-806168576068/);
  assert.match(yaml, /rds-db-credentials\/checksops-production\/checksops\/1790081257144-A2Z4bw/);
  assert.doesNotMatch(yaml, /checksops-staging-privatefilesbucket-erzqsolpucjp/);
  assert.doesNotMatch(yaml, /rds-db-credentials\/checksops-staging\/checksops\/1788286468693-b4U0Rn/);
});
