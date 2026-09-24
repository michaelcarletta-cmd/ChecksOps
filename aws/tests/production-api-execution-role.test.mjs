import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const yaml = fs.readFileSync(path.join(ROOT, 'aws/production/api-execution-role.yaml'), 'utf8');

const PRODUCTION_POOL_ARN = 'arn:aws:cognito-idp:us-east-1:806168576068:userpool/us-east-1_h00WorYMT';
const STAGING_POOL_ID = 'us-east-1_vPmQ7cL1F';

test('production API execution role template is least-privilege and omits staging providers', () => {
  assert.match(yaml, /RoleName:\n    Type: String\n    Default: checksops-production-api-execution/);
  assert.match(yaml, /AWSLambdaVPCAccessExecutionRole/);
  assert.match(yaml, /AWSXrayWriteOnlyAccess/);
  assert.match(yaml, /secretsmanager:GetSecretValue/);
  assert.match(yaml, /rds-db-credentials\/checksops-staging\/checksops\/1788286468693-b4U0Rn/);
  assert.match(yaml, /checksops-staging-privatefilesbucket-erzqsolpucjp/);
  assert.match(yaml, /s3:GetObject/);
  assert.match(yaml, /s3:PutObject/);
  assert.match(yaml, /s3:DeleteObject/);
  assert.match(yaml, /s3:ListBucket/);
  assert.doesNotMatch(yaml, /checksops\/staging\/providers/);
  assert.doesNotMatch(yaml, /checksops_admin/);
  assert.doesNotMatch(yaml, /ses:SendEmail|ses:SendRawEmail|ses:/);
  assert.doesNotMatch(yaml, /textract:/);
  assert.doesNotMatch(yaml, /Resource: '\*'/);
  assert.doesNotMatch(yaml, /cognito-idp:\*/);
});

test('production API execution role grants only tenant-invite Cognito admin on the production pool', () => {
  assert.match(yaml, /Sid: TenantInviteUserProductionCognito/);
  assert.match(yaml, /cognito-idp:AdminCreateUser/);
  assert.match(yaml, /cognito-idp:AdminGetUser/);
  assert.match(yaml, /cognito-idp:AdminSetUserPassword/);
  assert.match(yaml, new RegExp(PRODUCTION_POOL_ARN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(yaml, /cognito-idp:AdminDisableUser/);
  assert.doesNotMatch(yaml, /cognito-idp:AdminDeleteUser/);
  assert.doesNotMatch(yaml, /cognito-idp:AdminUpdateUserAttributes/);
  assert.doesNotMatch(yaml, /cognito-idp:\*/);
  assert.doesNotMatch(yaml, new RegExp(STAGING_POOL_ID));
});
