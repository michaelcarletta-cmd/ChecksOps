import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const yaml = fs.readFileSync(path.join(ROOT, 'aws/production/api-execution-role.yaml'), 'utf8');
const bankVerify = fs.readFileSync(
  path.join(ROOT, 'aws/production/bank-verify-state-lambda-policy.json'),
  'utf8',
);
const ocrAzure = fs.readFileSync(
  path.join(ROOT, 'aws/production/ocr-azure-production-access.json'),
  'utf8',
);
const inviteCognito = fs.readFileSync(
  path.join(ROOT, 'aws/production/tenant-invite-user-production-cognito.json'),
  'utf8',
);

const PRODUCTION_SECRET = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-production/checksops/1790081257144-A2Z4bw';
const STAGING_SECRET = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials/checksops-staging/checksops/1788286468693-b4U0Rn';
const PRODUCTION_BUCKET = 'checksops-production-privatefiles-806168576068';
const STAGING_BUCKET = 'checksops-staging-privatefilesbucket-erzqsolpucjp';
const PRODUCTION_POOL_ARN = 'arn:aws:cognito-idp:us-east-1:806168576068:userpool/us-east-1_h00WorYMT';
const STAGING_POOL_ID = 'us-east-1_vPmQ7cL1F';
const PROVIDER_SECRET = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/provider-At4ZFR';
const TOTP_SECRET = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/financial-totp-wrap-key-81bFID';
const AZURE_SECRET_PREFIX = 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/providers/azure-document-intelligence-';
const DDB_TABLE = 'arn:aws:dynamodb:us-east-1:806168576068:table/checksops-recipient-bank-verify-state';
const COGNITO_ACTIONS = [
  'cognito-idp:AdminCreateUser',
  'cognito-idp:AdminGetUser',
  'cognito-idp:AdminSetUserPassword',
];

const policyBlock = (name) => {
  const start = yaml.indexOf(`PolicyName: ${name}`);
  assert.notEqual(start, -1, `missing PolicyName ${name}`);
  const next = yaml.indexOf('\n        - PolicyName:', start + 1);
  const end = yaml.indexOf('\n      Tags:', start + 1);
  const cut = [next, end].filter((n) => n > start).sort((a, b) => a - b)[0] ?? yaml.length;
  return yaml.slice(start, cut);
};

const cognitoBlock = policyBlock('TenantInviteUserProductionCognito');
const listedCognitoActions = [...cognitoBlock.matchAll(/cognito-idp:[A-Za-z*]+/g)].map((m) => m[0]);

test('production API execution role keeps the live named role and Lambda-only trust', () => {
  assert.match(yaml, /RoleName:\n    Type: String\n    Default: checksops-production-api-execution/);
  assert.match(yaml, /AllowedValues:\n      - checksops-production-api-execution/);
  assert.match(yaml, /AWSLambdaVPCAccessExecutionRole/);
  assert.match(yaml, /AWSXrayWriteOnlyAccess/);
  assert.match(yaml, /Service: lambda\.amazonaws\.com/);
  assert.match(yaml, /Action: sts:AssumeRole/);
  assert.doesNotMatch(yaml, /events\.amazonaws\.com|edgelambda\.amazonaws\.com|ec2\.amazonaws\.com|states\.amazonaws\.com/);
});

test('production API execution role contains no staging RDS or staging S3 ARNs', () => {
  assert.match(yaml, new RegExp(PRODUCTION_SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(yaml, new RegExp(PRODUCTION_BUCKET));
  assert.doesNotMatch(yaml, new RegExp(STAGING_SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(yaml, new RegExp(STAGING_BUCKET));
  assert.doesNotMatch(yaml, /rds-db-credentials\/checksops-staging\//);
  assert.doesNotMatch(yaml, /checksops-staging-privatefiles/);
  assert.match(yaml, /AllowedPattern: '\^arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials\/checksops-production\/checksops\/\.\+'/);
  assert.match(yaml, /AllowedPattern: '\^checksops-production-privatefiles-806168576068\$'/);
});

test('production API execution role represents all five live inline policies', () => {
  assert.match(yaml, /PolicyName: ProductionApiLeastPrivilege/);
  assert.match(yaml, /PolicyName: ProductionApiSesSend/);
  assert.match(yaml, /PolicyName: RecipientBankVerifyStateLeastPrivilege/);
  assert.match(yaml, /PolicyName: OcrAzureProductionAccess/);
  assert.match(yaml, /PolicyName: TenantInviteUserProductionCognito/);
});

test('Cognito invite actions are exactly the three approved actions on the production pool', () => {
  assert.deepEqual(listedCognitoActions, COGNITO_ACTIONS);
  assert.match(yaml, new RegExp(PRODUCTION_POOL_ARN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(cognitoBlock, /Resource: !Ref ProductionUserPoolArn/);
  assert.doesNotMatch(yaml, /cognito-idp:\*/);
  assert.doesNotMatch(yaml, /cognito-idp:AdminDisableUser|cognito-idp:AdminDeleteUser|cognito-idp:AdminUpdateUserAttributes/);
  assert.doesNotMatch(yaml, new RegExp(STAGING_POOL_ID));
  assert.doesNotMatch(cognitoBlock, /Resource: '\*'/);
  const isolated = JSON.parse(inviteCognito);
  assert.deepEqual(isolated.Statement[0].Action, COGNITO_ACTIONS);
  assert.equal(isolated.Statement[0].Resource, PRODUCTION_POOL_ARN);
});

test('SES production permissions remain represented and SendRawEmail stays denied', () => {
  const ses = policyBlock('ProductionApiSesSend');
  assert.match(ses, /ses:SendEmail/);
  assert.doesNotMatch(ses, /ses:SendRawEmail|ses:\*/);
  assert.match(ses, /identity\/checksops\.com/);
  assert.match(ses, /identity\/Support@checksops\.com/);
  assert.doesNotMatch(ses, /identity\/ses-gate\.staging\.checksops\.com/);
});

test('DynamoDB recipient verification permissions remain represented', () => {
  const ddb = policyBlock('RecipientBankVerifyStateLeastPrivilege');
  assert.match(ddb, /dynamodb:GetItem/);
  assert.match(ddb, /dynamodb:PutItem/);
  assert.match(ddb, /dynamodb:UpdateItem/);
  assert.match(ddb, /dynamodb:DescribeTable/);
  assert.match(yaml, new RegExp(DDB_TABLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(ddb, /Resource: !Ref RecipientBankVerifyStateTableArn/);
  assert.doesNotMatch(ddb, /dynamodb:Scan|dynamodb:Query|dynamodb:DeleteItem|dynamodb:CreateTable/);
  const isolated = JSON.parse(bankVerify);
  assert.deepEqual(isolated.Statement[0].Action, [
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:UpdateItem',
    'dynamodb:DescribeTable',
  ]);
  assert.equal(isolated.Statement[0].Resource, DDB_TABLE);
});

test('OCR production permissions remain represented without broadening provider secrets', () => {
  const ocr = policyBlock('OcrAzureProductionAccess');
  assert.match(ocr, /textract:AnalyzeDocument/);
  assert.match(ocr, /textract:DetectDocumentText/);
  assert.doesNotMatch(ocr, /textract:AnalyzeExpense|textract:AnalyzeID|textract:\*/);
  assert.match(yaml, new RegExp(AZURE_SECRET_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(ocr, /Resource: !Ref AzureDiSecretArn/);
  assert.doesNotMatch(ocr, /checksops\/staging\/providers/);
  assert.doesNotMatch(ocr, /checksops\/isolated\//);
  const isolated = JSON.parse(ocrAzure);
  assert.equal(
    isolated.Statement[0].Resource,
    `${AZURE_SECRET_PREFIX}*`,
  );
  assert.deepEqual(isolated.Statement[1].Action, [
    'textract:AnalyzeDocument',
    'textract:DetectDocumentText',
  ]);
});

test('provider and TOTP secret access stay exact production ARNs', () => {
  const least = policyBlock('ProductionApiLeastPrivilege');
  assert.match(yaml, new RegExp(PROVIDER_SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(yaml, new RegExp(TOTP_SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(least, /Resource: !Ref ProductionProviderSecretArn/);
  assert.match(least, /Resource: !Ref FinancialTotpWrapKeyArn/);
  assert.doesNotMatch(yaml, /checksops\/staging\/providers/);
  assert.doesNotMatch(yaml, /checksops\/production\/provider-\*/);
  assert.doesNotMatch(least, /checksops\/production\/providers\/azure-document-intelligence/);
  assert.doesNotMatch(yaml, /checksops_admin/);
  assert.doesNotMatch(yaml, /moov-webhook/);
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
