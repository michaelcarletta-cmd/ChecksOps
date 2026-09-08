import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Gate 3A KMS block record does not leak or deploy', () => {
  const blocked = read('aws/cutover/API_PERIMETER_STEP3_GATE3A_KMS_BLOCKED.md');
  const apply = read('aws/origin-verify/apply-gate3a.mjs');
  assert.match(blocked, /3A \| \*\*FAIL \/ BLOCKED\*\*/);
  assert.match(blocked, /3B \| \*\*NOT STARTED\*\*/);
  assert.match(blocked, /3C \| \*\*NOT STARTED\*\*/);
  assert.match(blocked, /Access to KMS is not allowed/);
  assert.match(blocked, /DenyKmsAndRoleChaining/);
  assert.match(blocked, /holds\.ok/);
  assert.match(blocked, /productionExecution/);
  assert.match(blocked, /NOT_APPLIED/);
  assert.match(blocked, /AuthorizationType=NONE|still `NONE`/);
  assert.match(blocked, /create-secret/);
  assert.doesNotMatch(blocked, /DisableExecuteApiEndpoint=true/);
  assert.doesNotMatch(blocked, /aws cloudfront update-distribution/);
  assert.match(blocked, /Do not set\s*`ORIGIN_VERIFY_REQUIRE=true`/);
  assert.match(apply, /create_secret_kms_denied/);
});
