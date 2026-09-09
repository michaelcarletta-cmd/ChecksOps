import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Gate 3C observe revalidation is sanitized and does not start Gate 3D', () => {
  const doc = read('aws/cutover/API_PERIMETER_STEP3_GATE3C_OBSERVE_REVALIDATE.md');
  assert.match(doc, /STOP FOR REVIEW/);
  assert.match(doc, /did not re-apply Gate 3C/i);
  assert.match(doc, /ORIGIN_VERIFY_REQUIRE.*`<unset>` \/ false/);
  assert.match(doc, /holds\.ok.*\*\*true\*\*/);
  assert.match(doc, /productionExecution.*\*\*false\*\*/);
  assert.match(doc, /CloudFront `https:\/\/checksops\.com\/prep\/health` \| `true` \| `true`/);
  assert.match(doc, /Raw `https:\/\/kiqojucc02\.execute-api\.us-east-1\.amazonaws\.com\/prep\/health` \| `false` \| `false`/);
  assert.match(doc, /missing_cognito_token/);
  assert.match(doc, /Do \*\*not\*\* start Gate 3D/);
  assert.doesNotMatch(doc, /ORIGIN_VERIFY_REQUIRE=true/);
  assert.doesNotMatch(doc, /DisableExecuteApiEndpoint=true/);
  assert.doesNotMatch(doc, /HeaderValue\s*[:=]\s*["'][^"']{4,}/);
  assert.doesNotMatch(doc, /SecretString/);
  assert.doesNotMatch(doc, /eyJ[A-Za-z0-9_-]{10,}\./);
  assert.doesNotMatch(doc, /CHECKSOPS_APPLY_GATE3C=I_UNDERSTAND_PRODUCTION/);
});
