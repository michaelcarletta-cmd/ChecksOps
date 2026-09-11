import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const yaml = fs.readFileSync(path.join(ROOT, 'aws/production/api-execution-role.yaml'), 'utf8');

test('production API execution role template is least-privilege and omits staging providers', () => {
  assert.match(yaml, /RoleName:\n    Type: String\n    Default: checksops-production-api-execution/);
  assert.match(yaml, /AWSLambdaVPCAccessExecutionRole/);
  assert.match(yaml, /AWSXrayWriteOnlyAccess/);
  assert.match(yaml, /secretsmanager:GetSecretValue/);
  assert.match(yaml, /rds-db-credentials\/checksops-staging\/checksops\/1788286468693-b4U0Rn/);
  assert.match(yaml, /checksops\/production\/financial-totp-wrap-key-81bFID/);
  assert.match(yaml, /FinancialTotpWrapKeyRead/);
  assert.match(yaml, /checksops-staging-privatefilesbucket-erzqsolpucjp/);
  assert.match(yaml, /s3:GetObject/);
  assert.match(yaml, /s3:PutObject/);
  assert.match(yaml, /s3:DeleteObject/);
  assert.match(yaml, /s3:ListBucket/);
  assert.doesNotMatch(yaml, /checksops\/staging\/providers/);
  assert.doesNotMatch(yaml, /checksops_admin/);
  assert.doesNotMatch(yaml, /AdminCreateUser|AdminGetUser|AdminDisableUser|AdminSetUserPassword/);
  assert.doesNotMatch(yaml, /ses:SendEmail|ses:SendRawEmail|ses:/);
  assert.doesNotMatch(yaml, /textract:/);
  assert.doesNotMatch(yaml, /Resource: '\*'/);
});
