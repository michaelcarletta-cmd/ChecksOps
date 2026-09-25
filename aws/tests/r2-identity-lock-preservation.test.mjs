import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

test('mortgage hire remains unchanged and does not bind production locks', () => {
  const src = read('functions/api/tenant-admin.mjs');
  assert.match(src, /Hire mortgage desk agent/);
  const hire = src.slice(src.indexOf('export const runHireMortgageAgent'));
  assert.doesNotMatch(hire, /bindProductionCognitoLock/);
  assert.doesNotMatch(hire, /identity_production_cognito_locks/);
  assert.doesNotMatch(hire, /PRODUCTION_IDENTITY_WRITE_GUC/);
});

test('login/read identity path still does not create locks', () => {
  const identity = read('functions/api/identity.mjs');
  const env = read('functions/api/identity-env.mjs');
  assert.doesNotMatch(identity, /bindProductionCognitoLock|INSERT_PRODUCTION_LOCK_SQL/);
  assert.match(env, /writesAttempted: false/);
  assert.match(env, /Login \/identity\/me must not call this/);
});

test('OCR, Delete Check, and money-path modules are not part of R2 source edits', () => {
  const workflow = read('functions/api/workflow.mjs');
  const ocr = read('functions/api/ocr.mjs');
  const ocrParse = read('functions/api/ocr-parse.mjs');
  assert.match(workflow, /admin_delete_check|delete/i);
  assert.doesNotMatch(workflow, /bindProductionCognitoLock/);
  assert.doesNotMatch(ocr, /bindProductionCognitoLock/);
  assert.doesNotMatch(ocrParse, /bindProductionCognitoLock/);
});
