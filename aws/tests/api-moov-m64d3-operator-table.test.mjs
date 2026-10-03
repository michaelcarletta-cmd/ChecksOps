import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const TABLE = readFileSync(new URL('../production/bank-verify-state-table.yaml', import.meta.url), 'utf8');
const LAMBDA_POLICY = JSON.parse(readFileSync(
  new URL('../production/bank-verify-state-lambda-policy.json', import.meta.url),
  'utf8',
));
const OPERATOR_POLICY = JSON.parse(readFileSync(
  new URL('../production/bank-verify-state-table-operator-policy.json', import.meta.url),
  'utf8',
));
const CFN = readFileSync(new URL('../production/api-cfn.yaml', import.meta.url), 'utf8');
const DOCS = readFileSync(new URL('../financial/M64D3_BANK_VERIFY_STORE.md', import.meta.url), 'utf8');

const TABLE_ARN = 'arn:aws:dynamodb:us-east-1:806168576068:table/checksops-recipient-bank-verify-state';
const LAMBDA_ACTIONS = [
  'dynamodb:GetItem',
  'dynamodb:PutItem',
  'dynamodb:UpdateItem',
  'dynamodb:DescribeTable',
];

test('standalone table template matches M6.4D.3 expected shape', () => {
  assert.match(TABLE, /TableName: checksops-recipient-bank-verify-state/);
  assert.match(TABLE, /AttributeName: pk/);
  assert.match(TABLE, /AttributeName: sk/);
  assert.match(TABLE, /KeyType: HASH/);
  assert.match(TABLE, /KeyType: RANGE/);
  assert.match(TABLE, /PAY_PER_REQUEST/);
  assert.match(TABLE, /SSEEnabled: true/);
  assert.match(TABLE, /PointInTimeRecoveryEnabled: true/);
  assert.match(TABLE, /DeletionProtectionEnabled: true/);
  assert.match(TABLE, /AttributeName: ttl/);
  assert.doesNotMatch(TABLE, /Principal:\s*\n\s+['"]?\*['"]?/);
  assert.doesNotMatch(TABLE, /dynamodb:Scan/);
  assert.doesNotMatch(TABLE, /Resource: '\*'/);
  assert.match(TABLE, /checksops-production-api-execution/);
  LAMBDA_ACTIONS.forEach((action) => assert.match(TABLE, new RegExp(action.replace(':', '\\:'))));
});

test('Lambda identity policy is four actions on one table ARN', () => {
  assert.equal(LAMBDA_POLICY.Statement.length, 1);
  const stmt = LAMBDA_POLICY.Statement[0];
  assert.deepEqual([...stmt.Action].sort(), [...LAMBDA_ACTIONS].sort());
  assert.equal(stmt.Resource, TABLE_ARN);
  assert.equal(stmt.Effect, 'Allow');
  assert.equal(JSON.stringify(LAMBDA_POLICY).includes('*'), false);
  assert.equal(stmt.Action.includes('dynamodb:Scan'), false);
  assert.equal(stmt.Action.includes('dynamodb:CreateTable'), false);
  assert.equal(stmt.Action.includes('dynamodb:DeleteItem'), false);
  assert.equal(stmt.Action.includes('dynamodb:DeleteTable'), false);
});

test('operator create policy is not the Lambda identity policy', () => {
  const actions = OPERATOR_POLICY.Statement[0].Action;
  assert.equal(actions.includes('dynamodb:CreateTable'), true);
  assert.equal(actions.includes('dynamodb:DeleteItem'), true);
  assert.equal(LAMBDA_POLICY.Statement[0].Action.includes('dynamodb:CreateTable'), false);
  assert.equal(LAMBDA_POLICY.Statement[0].Action.includes('dynamodb:DeleteItem'), false);
  assert.match(DOCS, /put-role-policy/);
  assert.match(DOCS, /checksops-recipient-bank-verify-state/);
  assert.match(DOCS, /Do not deploy `checksops-staging-api`/);
  assert.match(DOCS, /ChecksOpsCursorCloudStaging/);
});

test('prep API money and bank-verify write flags stay false in templates', () => {
  assert.match(CFN, /AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED: "false"/);
  assert.match(CFN, /AWS_MOOV_ENABLED: "false"/);
  assert.match(CFN, /AWS_PROVIDER_EXECUTION_ENABLED: "false"/);
  assert.match(CFN, /AWS_FINANCIAL_PERMISSIONS_ACTIVATED: "false"/);
  assert.match(CFN, /AWS_CHECKALT_ENABLED: "false"/);
});
