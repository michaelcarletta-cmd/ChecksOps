import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const yaml = fs.readFileSync(path.join(ROOT, 'aws/production/api-execution-role.yaml'), 'utf8');
const bankVerify = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'aws/production/bank-verify-state-lambda-policy.json'),
  'utf8',
));
const ocrAzure = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'aws/production/ocr-azure-production-access.json'),
  'utf8',
));
const inviteCognito = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'aws/production/tenant-invite-user-production-cognito.json'),
  'utf8',
));
const sesSend = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'aws/production/production-api-ses-send.json'),
  'utf8',
));

const PRODUCTION_SECRET = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops/1790081257144-A2Z4bw';
const STAGING_SECRET = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops/1788286468693-b4U0Rn';
const PRODUCTION_BUCKET = 'checksops-production-privatefiles-806168576068';
const STAGING_BUCKET = 'checksops-staging-privatefilesbucket-erzqsolpucjp';
const PRODUCTION_POOL_ARN = 'arn:aws:cognito-idp:us-east-1:806168576068:userpool/us-east-1_h00WorYMT';
const STAGING_POOL_ID = 'us-east-1_vPmQ7cL1F';
const PROVIDER_SECRET = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/provider-At4ZFR';
const TOTP_SECRET = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/financial-totp-wrap-key-81bFID';
const AZURE_SECRET = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/providers/azure-document-intelligence-*';
const DDB_TABLE = 'arn:aws:dynamodb:us-east-1:806168576068:table/checksops-recipient-bank-verify-state';
const COGNITO_ACTIONS = [
  'cognito-idp:AdminCreateUser',
  'cognito-idp:AdminGetUser',
  'cognito-idp:AdminSetUserPassword',
];
const S3_ACTIONS = [
  's3:GetObject',
  's3:GetObjectVersion',
  's3:GetBucketLocation',
  's3:ListBucket',
  's3:PutObject',
  's3:DeleteObject',
  's3:DeleteObjectVersion',
  's3:AbortMultipartUpload',
];

const policyBlock = (name) => {
  const start = yaml.indexOf(`PolicyName: ${name}`);
  assert.notEqual(start, -1, `missing PolicyName ${name}`);
  const next = yaml.indexOf('\n        - PolicyName:', start + 1);
  const end = yaml.indexOf('\n      Tags:', start + 1);
  const cut = [next, end].filter((n) => n > start).sort((a, b) => a - b)[0] ?? yaml.length;
  return yaml.slice(start, cut);
};

const listedActions = (block, prefix) => (
  [...block.matchAll(new RegExp(`- ${prefix}[A-Za-z*]+`, 'g'))].map((m) => m[0].slice(2))
);

test('production API execution role keeps the live named role, tags, managed policies, and Lambda-only trust', () => {
  assert.match(yaml, /RoleName:\n    Type: String\n    Default: checksops-production-api-execution/);
  assert.match(yaml, /AllowedValues:\n      - checksops-production-api-execution/);
  assert.match(yaml, /ProductionApiExecutionRole:\n    Type: AWS::IAM::Role/);
  assert.match(yaml, /AWSLambdaVPCAccessExecutionRole/);
  assert.match(yaml, /AWSXrayWriteOnlyAccess/);
  assert.match(yaml, /Service: lambda\.amazonaws\.com/);
  assert.match(yaml, /Action: sts:AssumeRole/);
  assert.match(yaml, /Key: HardeningBatch\n          Value: '1'/);
  assert.match(yaml, /Key: Environment\n          Value: production/);
  assert.match(yaml, /Key: DoNotGrantProviderSecrets\n          Value: 'true'/);
  assert.doesNotMatch(yaml, /events\.amazonaws\.com|edgelambda\.amazonaws\.com|ec2\.amazonaws\.com|states\.amazonaws\.com/);
  assert.equal((yaml.match(/arn:aws:iam::aws:policy\//g) || []).length, 2);
});

test('production API least-privilege uses the exact production RDS secret and S3 bucket only', () => {
  const least = policyBlock('ProductionApiLeastPrivilege');
  assert.match(yaml, new RegExp(PRODUCTION_SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(yaml, new RegExp(`Default: ${PRODUCTION_BUCKET}`));
  assert.match(least, /Sid: AppDatabaseSecretRead/);
  assert.match(least, /Sid: PrivateCheckImageBucket/);
  assert.match(least, /Resource: !Ref AppDatabaseSecretArn/);
  assert.match(least, /!Sub arn:aws:s3:::\${FilesBucketName}/);
  assert.match(least, /!Sub arn:aws:s3:::\${FilesBucketName}\/\*/);
  assert.deepEqual(listedActions(least, 'secretsmanager:'), ['secretsmanager:GetSecretValue']);
  assert.deepEqual(listedActions(least, 's3:'), S3_ACTIONS);
  assert.doesNotMatch(yaml, new RegExp(STAGING_SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(yaml, new RegExp(STAGING_BUCKET));
  assert.doesNotMatch(yaml, /rds-db-credentials\/checksops-staging\//);
  assert.doesNotMatch(yaml, /checksops-staging-privatefiles/);
  assert.equal((least.match(/Sid:/g) || []).length, 2);
});

test('production API execution role represents all five live inline policies and no others', () => {
  const names = [...yaml.matchAll(/PolicyName: ([A-Za-z]+)/g)].map((m) => m[1]);
  assert.deepEqual(names, [
    'ProductionApiLeastPrivilege',
    'ProductionApiSesSend',
    'RecipientBankVerifyStateLeastPrivilege',
    'OcrAzureProductionAccess',
    'TenantInviteUserProductionCognito',
  ]);
});

test('Cognito invite actions are exactly the three approved actions on the production pool', () => {
  const cognito = policyBlock('TenantInviteUserProductionCognito');
  assert.deepEqual(listedActions(cognito, 'cognito-idp:'), COGNITO_ACTIONS);
  assert.match(yaml, new RegExp(PRODUCTION_POOL_ARN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(cognito, /Resource: !Ref ProductionUserPoolArn/);
  assert.doesNotMatch(yaml, /cognito-idp:\*/);
  assert.doesNotMatch(yaml, /cognito-idp:AdminDisableUser|cognito-idp:AdminDeleteUser|cognito-idp:AdminUpdateUserAttributes/);
  assert.doesNotMatch(yaml, new RegExp(STAGING_POOL_ID));
  assert.doesNotMatch(cognito, /Resource: '\*'/);
  assert.deepEqual(inviteCognito.Statement[0].Action, COGNITO_ACTIONS);
  assert.equal(inviteCognito.Statement[0].Resource, PRODUCTION_POOL_ARN);
});

test('SES production permissions remain exactly ses:SendEmail on the two verified identities', () => {
  const ses = policyBlock('ProductionApiSesSend');
  assert.deepEqual(listedActions(ses, 'ses:'), ['ses:SendEmail']);
  assert.doesNotMatch(ses, /ses:SendRawEmail|ses:\*/);
  assert.match(ses, /identity\/checksops\.com/);
  assert.match(ses, /identity\/Support@checksops\.com/);
  assert.doesNotMatch(ses, /identity\/ses-gate\.staging\.checksops\.com/);
  assert.deepEqual(sesSend.Statement[0].Action, ['ses:SendEmail']);
  assert.deepEqual(sesSend.Statement[0].Resource, [
    'arn:aws:ses:us-east-1:806168576068:identity/checksops.com',
    'arn:aws:ses:us-east-1:806168576068:identity/Support@checksops.com',
  ]);
});

test('DynamoDB recipient verification permissions remain exactly the four live actions', () => {
  const ddb = policyBlock('RecipientBankVerifyStateLeastPrivilege');
  assert.deepEqual(listedActions(ddb, 'dynamodb:'), [
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:UpdateItem',
    'dynamodb:DescribeTable',
  ]);
  assert.match(yaml, new RegExp(DDB_TABLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(ddb, /Resource: !Ref RecipientBankVerifyStateTableArn/);
  assert.deepEqual(bankVerify.Statement[0].Action, [
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:UpdateItem',
    'dynamodb:DescribeTable',
  ]);
  assert.equal(bankVerify.Statement[0].Resource, DDB_TABLE);
});

test('OCR production permissions remain exactly Azure DI GetSecretValue plus two Textract actions', () => {
  const ocr = policyBlock('OcrAzureProductionAccess');
  assert.deepEqual(listedActions(ocr, 'textract:'), [
    'textract:AnalyzeDocument',
    'textract:DetectDocumentText',
  ]);
  assert.deepEqual(listedActions(ocr, 'secretsmanager:'), ['secretsmanager:GetSecretValue']);
  assert.match(yaml, new RegExp(AZURE_SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(ocr, /Resource: !Ref AzureDiSecretArn/);
  assert.doesNotMatch(ocr, /checksops\/staging\/providers/);
  assert.equal(ocrAzure.Statement[0].Resource, AZURE_SECRET);
  assert.deepEqual(ocrAzure.Statement[1].Action, [
    'textract:AnalyzeDocument',
    'textract:DetectDocumentText',
  ]);
});

test('candidate does not add TOTP, general provider-secret, Moov, or CheckAlt IAM', () => {
  const least = policyBlock('ProductionApiLeastPrivilege');
  assert.doesNotMatch(yaml, /FinancialTotpWrapKeyRead|ProductionProviderSecretRead/);
  assert.doesNotMatch(yaml, /financial-totp-wrap-key/);
  assert.doesNotMatch(yaml, new RegExp(TOTP_SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(yaml, new RegExp(PROVIDER_SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(yaml, /checksops\/production\/provider-/);
  assert.doesNotMatch(yaml, /checksops\/staging\/providers/);
  assert.doesNotMatch(least, /checksops\/production\/providers\/azure-document-intelligence/);
  assert.doesNotMatch(yaml, /checksops_admin/);
  assert.doesNotMatch(yaml, /moov-webhook/);
  assert.doesNotMatch(yaml, /AWS_MOOV_ENABLED|AWS_CHECKALT_ENABLED/);
});

test('star resources are limited to Textract OCR and never used for Cognito, SES, S3, or secrets', () => {
  const stars = [...yaml.matchAll(/Resource: '\*'/g)];
  assert.equal(stars.length, 1);
  const ocr = policyBlock('OcrAzureProductionAccess');
  assert.match(ocr, /Sid: ProductionTextractOcr[\s\S]*Resource: '\*'/);
  assert.doesNotMatch(policyBlock('ProductionApiLeastPrivilege'), /Resource: '\*'/);
  assert.doesNotMatch(policyBlock('ProductionApiSesSend'), /Resource: '\*'/);
  assert.doesNotMatch(policyBlock('RecipientBankVerifyStateLeastPrivilege'), /Resource: '\*'/);
  assert.doesNotMatch(policyBlock('TenantInviteUserProductionCognito'), /Resource: '\*'/);
});
