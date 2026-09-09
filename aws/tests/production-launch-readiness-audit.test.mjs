import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const doc = fs.readFileSync(
  path.join(ROOT, 'aws/cutover/PRODUCTION_LAUNCH_READINESS_AUDIT.md'),
  'utf8',
);

test('launch-readiness audit is read-only, hold-safe, and sanitized', () => {
  assert.match(doc, /STOP FOR REVIEW/);
  assert.match(doc, /READ-ONLY/);
  assert.match(doc, /This audit did not fix anything/);
  assert.match(doc, /productionExecution.*\*\*false\*\*/);
  assert.match(doc, /AWS_MOOV_ENABLED.*\*\*false\*\*/);
  assert.match(doc, /AWS_CHECKALT_ENABLED.*\*\*false\*\*/);
  assert.match(doc, /financialActivationSqlApplied.*\*\*false\*\*/);
  assert.match(doc, /64_financial_activation_grants\.sql.*NOT_APPLIED/);
  assert.match(doc, /### P0/);
  assert.match(doc, /### P1/);
  assert.match(doc, /### P2/);
  assert.match(doc, /AwsStagingBanner/);
  assert.doesNotMatch(doc, /DisableExecuteApiEndpoint=true/);
  assert.doesNotMatch(doc, /ORIGIN_VERIFY_REQUIRE=false/);
  assert.doesNotMatch(doc, /HeaderValue\s*[:=]\s*["'][^"']{4,}/);
  assert.doesNotMatch(doc, /SecretString/);
  assert.doesNotMatch(doc, /eyJ[A-Za-z0-9_-]{10,}\./);
});
