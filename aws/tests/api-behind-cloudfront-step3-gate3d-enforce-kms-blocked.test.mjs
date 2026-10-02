import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Gate 3D enforce record is KMS-blocked and does not claim require-mode', () => {
  const doc = read('aws/cutover/API_PERIMETER_STEP3_GATE3D_ENFORCE_KMS_BLOCKED.md');
  assert.match(doc, /STOP FOR REVIEW/);
  assert.match(doc, /FAIL \/ BLOCKED/);
  assert.match(doc, /update_env_kms_denied/);
  assert.match(doc, /applied=false/);
  assert.match(doc, /ORIGIN_VERIFY_REQUIRE.*`<unset>` \/ false/);
  assert.match(doc, /holds\.ok.*\*\*true\*\*/);
  assert.match(doc, /productionExecution.*\*\*false\*\*/);
  assert.match(doc, /Rollback.*\*\*not needed\*\*/);
  assert.match(doc, /Do \*\*not\*\* broaden/);
  assert.match(doc, /Do \*\*not\*\* disable execute-api/);
  assert.doesNotMatch(doc, /DisableExecuteApiEndpoint=true/);
  assert.doesNotMatch(doc, /applied=true/);
  assert.doesNotMatch(doc, /HeaderValue\s*[:=]\s*["'][^"']{4,}/);
  assert.doesNotMatch(doc, /SecretString/);
  assert.doesNotMatch(doc, /eyJ[A-Za-z0-9_-]{10,}\./);
});
