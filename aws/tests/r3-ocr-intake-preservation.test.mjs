import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { INTAKE_PROHIBITED_COLUMNS } from '../functions/api/write-allowlist.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (rel) => createHash('sha256').update(readFileSync(path.join(ROOT, rel))).digest('hex');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

test('R2 identity lock files remain the production-pinned hashes', () => {
  assert.equal(
    sha256('functions/api/identity-env.mjs'),
    'e814546feded3a323461b3a7a8369e3d8a09f9a5d306d68973e15389b871f443',
  );
  assert.equal(
    sha256('functions/api/tenant-admin.mjs'),
    '2e4a30da6f8eb8504044ab1159ba0ecb79403ecef97c067d3581e08917eb8244',
  );
  const env = read('functions/api/identity-env.mjs');
  const admin = read('functions/api/tenant-admin.mjs');
  assert.match(env, /bindProductionCognitoLock/);
  assert.match(admin, /bindProductionCognitoLock/);
  const hire = admin.slice(admin.indexOf('export const runHireMortgageAgent'));
  assert.doesNotMatch(hire, /bindProductionCognitoLock/);
});

test('S14 deposited-check module and remaining-balance helper stay pinned', () => {
  assert.equal(
    sha256('functions/api/check-deposited.mjs'),
    '395ddec5c88e2290fc72f2ab86ef2c934fe7654c7f2309a8176e1147ce32edf1',
  );
  assert.equal(
    sha256('functions/api/financial-remaining.mjs'),
    'e608c00f65623bfc226eecd7d216d64141e610f2a2c1b0cb841f9736d5397989',
  );
  const deposited = read('functions/api/check-deposited.mjs');
  assert.match(deposited, /export const isCheckDeposited/);
  assert.match(deposited, /export const resolveWritablePayeeLine/);
  assert.match(deposited, /export const rejectPayeeLineIfDeposited/);
  assert.match(deposited, /payee_line cannot change after deposit/);
});

test('R3 persist keeps S14 payee guard and historical amount RPC together', () => {
  const persist = read('functions/api/ocr-descriptive-persist.mjs');
  const ocr = read('functions/api/ocr.mjs');
  const parse = read('functions/api/ocr-parse.mjs');
  const provider = read('functions/api/check-ocr-provider.mjs');
  assert.match(persist, /resolveWritablePayeeLine/);
  assert.match(persist, /ocr_persist_extracted_amount/);
  assert.match(persist, /matchKnownCarrier/);
  assert.match(persist, /sanitizeCarrierName/);
  assert.match(persist, /cleanPayeeLine/);
  assert.match(ocr, /resolveWritablePayeeLine/);
  assert.match(ocr, /persistOcrDescriptiveHandoff/);
  assert.match(ocr, /Intentionally do not set amount here/);
  assert.doesNotMatch(ocr, /ocr_persist_extracted_amount/);
  assert.match(parse, /const CLAIM_PATTERNS =/);
  assert.match(parse, /const KNOWN_BANK_ALIASES =/);
  assert.match(parse, /const claimTokenFromText =/);
  assert.match(parse, /export const matchKnownCarrier/);
  assert.match(provider, /sanitizeCarrierName\(supp\.carrier_name\)/);
  assert.match(provider, /cleanPayeeLine\(supp\.payee_line\)/);
});

test('generic amount write remains prohibited', () => {
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('amount'), true);
  assert.equal(INTAKE_PROHIBITED_COLUMNS.has('detected_claim_number'), true);
  const persist = read('functions/api/ocr-descriptive-persist.mjs');
  assert.doesNotMatch(persist, /SET[\s\S]{0,80}amount\s*=/);
});

test('Delete Check / S5 workflow-rpc source is not part of R3 edits', () => {
  const workflow = read('functions/api/workflow.mjs');
  assert.match(workflow, /admin_delete_check|delete/i);
  assert.doesNotMatch(workflow, /ocr_persist_extracted_amount/);
  assert.doesNotMatch(workflow, /CLAIM_PATTERNS/);
});
