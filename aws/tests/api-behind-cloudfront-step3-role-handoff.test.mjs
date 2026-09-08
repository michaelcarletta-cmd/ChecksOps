import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const tempYaml = read('aws/production/cursor-api-perimeter-step3-temp-role-only.yaml');
const reviewedYaml = read('aws/production/cursor-api-perimeter-step3-role.yaml');
const handoff = read('aws/cutover/API_PERIMETER_STEP3_OPERATOR_HANDOFF.md');
const createRoles = read('aws/cutover/API_PERIMETER_STEP3_OPERATOR_CREATE_ROLES.md');
const gates = read('aws/cutover/API_PERIMETER_STEP3_GATES.md');
const allow = JSON.parse(read('aws/production/cursor-api-perimeter-step3-role-allow.json'));
const deny = JSON.parse(read('aws/production/cursor-api-perimeter-step3-role-deny.json'));
const trust = JSON.parse(read('aws/production/cursor-api-perimeter-step3-role-trust.json'));

test('reviewed Step 3 files still pin the execution-role definition', () => {
  assert.match(reviewedYaml, /OriginVerifyExecutionRole:/);
  assert.match(reviewedYaml, /RoleName: checksops-production-origin-verify/);
  assert.match(reviewedYaml, /PolicyName: origin-verify-secret-and-logs/);
  assert.match(reviewedYaml, /Service: lambda\.amazonaws\.com/);
  assert.match(reviewedYaml, /ChecksOpsCursorApiPerimeterStep3Temp/);
  assert.match(gates, /aws\/production\/cursor-api-perimeter-step3-role\.yaml/);
  assert.match(gates, /ORIGIN_VERIFY_REQUIRE=true/);
  assert.match(gates, /DO NOT DEPLOY STEP 3/);
});

test('Step3Temp-only YAML creates the OIDC role and not the leftover execution role', () => {
  assert.match(tempYaml, /DeployRole:\n    Type: String\n    Default: "false"/);
  assert.match(tempYaml, /ChecksOpsCursorApiPerimeterStep3Temp/);
  assert.match(tempYaml, /ChecksOpsCursorApiPerimeterStep3Allow/);
  assert.match(tempYaml, /ChecksOpsCursorApiPerimeterStep3Deny/);
  assert.match(tempYaml, /user:325724407/);
  assert.match(tempYaml, /DO NOT DEPLOY GATE 3A-3C/);
  assert.doesNotMatch(tempYaml, /OriginVerifyExecutionRole/);
  assert.doesNotMatch(tempYaml, /RoleName: checksops-production-origin-verify/);
  assert.doesNotMatch(tempYaml, /AuthorizerExecutionRoleArn/);
  assert.match(tempYaml, /arn:aws:iam::806168576068:role\/checksops-production-origin-verify/);
  assert.match(JSON.stringify(allow), /PassAuthorizerExecutionRole/);
  assert.match(JSON.stringify(deny), /DenyRds/);
  assert.equal(trust.Statement[0].Condition.StringEquals['api.cursor.com:sub'], 'user:325724407');
});

test('operator handoff is Step3Temp create only and does not deploy 3A-3C', () => {
  assert.match(handoff, /STOP FOR REVIEW\. DO NOT DEPLOY GATE 3A–3C/);
  assert.match(handoff, /checksops-cursor-api-perimeter-step3-temp-role/);
  assert.match(handoff, /CAPABILITY_NAMED_IAM/);
  assert.match(handoff, /ParameterKey=DeployRole,ParameterValue=true/);
  assert.match(handoff, /cursor-api-perimeter-step3-temp-role-only\.yaml/);
  assert.match(handoff, /c3a7ce822b1f32655d9a89c982d498e1004f0fff/);
  assert.match(handoff, /67243a1b2ac17ac31f0d85ce2289839cf72432a5/);
  assert.match(handoff, /cf1fc7e10c2309f5e35584b26f62fc97a2c5f757/);
  assert.match(handoff, /b14ca5e9652eca58bb163967ae6886accdd92eb4/);
  assert.match(handoff, /Do not change or delete this role this turn/);
  assert.match(handoff, /origin-verify-secret-and-logs/);
  assert.match(handoff, /holds\.ok=true/);
  assert.match(handoff, /productionExecution=false/);
  assert.match(handoff, /NOT_APPLIED/);
  assert.match(handoff, /AuthorizationType=NONE/);
  assert.doesNotMatch(handoff, /aws cloudfront update-distribution/);
  assert.doesNotMatch(handoff, /aws secretsmanager create-secret/);
  assert.doesNotMatch(handoff, /aws apigatewayv2 create-authorizer/);
  assert.doesNotMatch(handoff, /aws apigatewayv2 update-route/);
  assert.doesNotMatch(handoff, /DisableExecuteApiEndpoint=true/);
  assert.match(handoff, /Do not set `ORIGIN_VERIFY_REQUIRE=true`/);
  assert.match(handoff, /Do not set `CHECKSOPS_STEP3_EXECUTE=1`/);
  assert.match(createRoles, /cursor-api-perimeter-step3-temp-role-only\.yaml/);
  assert.match(createRoles, /Do not begin Gate 3A/);
  assert.doesNotMatch(createRoles, /--stack-name checksops-cursor-api-perimeter-step3-role \\/);
});
