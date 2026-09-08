import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('3A pass / 3B KMS block record does not enable require-mode', () => {
  const results = read('aws/cutover/API_PERIMETER_STEP3_GATES_3ABC_RESULTS.md');
  const blocked = read('aws/cutover/API_PERIMETER_STEP3_GATE3B_KMS_BLOCKED.md');
  const applyA = read('aws/origin-verify/apply-gate3a.mjs');
  const applyB = read('aws/origin-verify/apply-gate3b.mjs');
  assert.match(results, /\*\*3A\*\* \| \*\*PASS\*\*/);
  assert.match(results, /\*\*3B\*\* \| \*\*FAIL \/ BLOCKED\*\*/);
  assert.match(results, /\*\*3C\*\* \| \*\*NOT STARTED\*\*/);
  assert.match(results, /0dwrwx/);
  assert.match(results, /AuthorizationType=NONE/);
  assert.match(results, /holds\.ok=true/);
  assert.match(results, /productionExecution=false/);
  assert.match(results, /NOT_APPLIED/);
  assert.match(results, /was not recreated or overwritten/);
  assert.doesNotMatch(results, /DisableExecuteApiEndpoint=true/);
  assert.doesNotMatch(results, /aws cloudfront update-distribution/);
  assert.match(blocked, /GetSecretValue/);
  assert.match(blocked, /Access to KMS is not allowed/);
  assert.match(blocked, /OPERATOR_GATE3B/);
  assert.match(applyA, /CHECKSOPS_STEP3_REUSE_SECRET/);
  assert.match(applyA, /Authorizer defaults/);
  assert.match(applyB, /get_secret_kms_denied/);
});
