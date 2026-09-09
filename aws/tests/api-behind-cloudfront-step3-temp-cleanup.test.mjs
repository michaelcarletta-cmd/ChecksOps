import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const doc = fs.readFileSync(
  path.join(ROOT, 'aws/cutover/API_PERIMETER_STEP3_TEMP_CLEANUP.md'),
  'utf8',
);

test('Step 3 temp cleanup record is incomplete and does not touch runtime', () => {
  assert.match(doc, /STOP FOR REVIEW/);
  assert.match(doc, /DELETE_FAILED/);
  assert.match(doc, /iam:DetachRolePolicy/);
  assert.match(doc, /ORIGIN_VERIFY_REQUIRE.*\*\*true\*\*/);
  assert.match(doc, /still exists \/ assumable/);
  assert.match(doc, /Permanent `checksops-production-origin-verify` Lambda/);
  assert.match(doc, /Raw execute-api.*403/);
  assert.match(doc, /Fabricated header.*403/);
  assert.match(doc, /holds\.ok.*\*\*true\*\*/);
  assert.match(doc, /productionExecution.*\*\*false\*\*/);
  assert.match(doc, /Do \*\*not\*\* retry this delete as staging/);
  assert.doesNotMatch(doc, /DisableExecuteApiEndpoint=true/);
  assert.doesNotMatch(doc, /HeaderValue\s*[:=]\s*["'][^"']{4,}/);
  assert.doesNotMatch(doc, /SecretString/);
  assert.doesNotMatch(doc, /eyJ[A-Za-z0-9_-]{10,}\./);
});
