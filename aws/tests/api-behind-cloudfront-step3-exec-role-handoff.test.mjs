import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const yaml = read('aws/production/cursor-api-perimeter-step3-execution-role.yaml');
const reviewed = read('aws/production/cursor-api-perimeter-step3-role.yaml');
const blocked = read('aws/cutover/API_PERIMETER_STEP3_GATE3A_EXEC_ROLE_BLOCKED.md');
const apply = read('aws/origin-verify/apply-gate3a.mjs');

test('execution-role-only YAML matches reviewed OriginVerifyExecutionRole', () => {
  assert.match(yaml, /DeployRole:\n    Type: String\n    Default: "false"/);
  assert.match(yaml, /RoleName: checksops-production-origin-verify/);
  assert.match(yaml, /PolicyName: origin-verify-secret-and-logs/);
  assert.match(yaml, /Service: lambda\.amazonaws\.com/);
  assert.match(yaml, /secretsmanager:GetSecretValue/);
  assert.match(yaml, /DO NOT\n {2}deploy Gate 3A-3C|Does NOT\n {2}deploy Gate 3A-3C/);
  assert.doesNotMatch(yaml, /RoleName: ChecksOpsCursorApiPerimeterStep3Temp/);
  assert.match(yaml, /Does NOT create ChecksOpsCursorApiPerimeterStep3Temp/);
  assert.doesNotMatch(yaml, /UpdateDistribution/);
  assert.doesNotMatch(yaml, /CreateSecret/);
  assert.match(reviewed, /OriginVerifyExecutionRole:/);
  const reviewedPolicy = reviewed.slice(
    reviewed.indexOf('PolicyName: origin-verify-secret-and-logs'),
    reviewed.indexOf('Tags:', reviewed.indexOf('OriginVerifyExecutionRole:')),
  );
  const yamlPolicy = yaml.slice(
    yaml.indexOf('PolicyName: origin-verify-secret-and-logs'),
    yaml.indexOf('Tags:'),
  );
  assert.equal(yamlPolicy.replace(/\s+/g, ' ').trim(), reviewedPolicy.replace(/\s+/g, ' ').trim());
});

test('Gate 3A is blocked without the execution role and does not deploy 3B-3D', () => {
  assert.match(blocked, /3A \| \*\*FAIL \/ BLOCKED\*\*/);
  assert.match(blocked, /3B \| \*\*NOT STARTED\*\*/);
  assert.match(blocked, /3C \| \*\*NOT STARTED\*\*/);
  assert.match(blocked, /NoSuchEntity/);
  assert.match(blocked, /checksops-cursor-api-perimeter-step3-execution-role/);
  assert.match(blocked, /CAPABILITY_NAMED_IAM/);
  assert.match(blocked, /holds\.ok/);
  assert.match(blocked, /productionExecution/);
  assert.match(blocked, /NOT_APPLIED/);
  assert.match(blocked, /AuthorizationType=NONE/);
  assert.doesNotMatch(blocked, /DisableExecuteApiEndpoint=true/);
  assert.doesNotMatch(blocked, /aws cloudfront update-distribution/);
  assert.doesNotMatch(blocked, /aws secretsmanager create-secret/);
  assert.match(apply, /execution_role_missing/);
  assert.match(apply, /Do not create the secret first/);
});
