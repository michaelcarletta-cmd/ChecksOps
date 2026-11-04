/**
 * The production files bucket CORS change (ops/production-files-bucket-cors.md): the after state
 * differs from the recorded live before state only in the PUT rule's allowed headers, and those are
 * exactly what the compliance document presigned upload sends. Static checks only; no AWS call.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const BEFORE = JSON.parse(read('ops/production-files-bucket-cors/before-2026-11-04.json'));
const AFTER = JSON.parse(read('ops/production-files-bucket-cors/after.json'));
const DOCS = read('aws/functions/api/providers/onboarding/documents.mjs');
const TEMPLATE = read('aws/template.yaml');
const RUNBOOK = read('ops/production-files-bucket-cors.md');
const ORIGINS = ['https://checksops.com', 'https://www.checksops.com'];
const UPLOAD_HEADERS = ['content-type', 'content-length', 'x-amz-server-side-encryption', 'x-amz-server-side-encryption-aws-kms-key-id'];

const putRule = (doc) => {
  const rules = doc.CORSRules.filter((r) => r.AllowedMethods.includes('PUT'));
  assert.equal(rules.length, 1);
  return rules[0];
};

test('1 the before state is the live refusal: PUT allows only content-type', () => {
  assert.deepEqual(putRule(BEFORE).AllowedHeaders, ['content-type']);
});

test('2 the after state changes only the PUT rule\'s allowed headers', () => {
  assert.equal(AFTER.CORSRules.length, BEFORE.CORSRules.length);
  const strip = (doc) => doc.CORSRules.map((r) => (r.AllowedMethods.includes('PUT') ? { ...r, AllowedHeaders: null } : r));
  assert.deepEqual(strip(AFTER), strip(BEFORE));
  assert.deepEqual(putRule(AFTER).AllowedHeaders, UPLOAD_HEADERS);
});

test('3 the origins stay the production site only, and no rule allows a write method other than PUT', () => {
  for (const rule of AFTER.CORSRules) {
    assert.deepEqual(rule.AllowedOrigins, ORIGINS);
    for (const method of rule.AllowedMethods) assert.ok(['GET', 'HEAD', 'PUT'].includes(method), method);
  }
  assert.doesNotMatch(JSON.stringify(AFTER), /"\*"\s*\]\s*,\s*"AllowedMethods":\s*\[\s*"PUT"/);
});

test('4 the allowed headers are what the presigned upload sends, and match the stack template', () => {
  for (const header of ['x-amz-server-side-encryption', 'x-amz-server-side-encryption-aws-kms-key-id']) {
    assert.ok(DOCS.includes(`'${header}'`), `documents.mjs sends ${header}`);
  }
  assert.match(DOCS, /'Content-Type'/);
  const block = TEMPLATE.slice(TEMPLATE.indexOf('Id: SpaPresignedUploads'), TEMPLATE.indexOf('ExposedHeaders:', TEMPLATE.indexOf('Id: SpaPresignedUploads')));
  for (const header of UPLOAD_HEADERS) assert.ok(block.includes(`- ${header}`), `template allows ${header}`);
});

test('5 the runbook checks the live state before and after, against these files', () => {
  assert.match(RUNBOOK, /checksops-production-privatefiles-806168576068/);
  assert.match(RUNBOOK, /before-2026-11-04\.json\) \\\n\s+&& echo "LIVE MATCHES BEFORE"/);
  assert.match(RUNBOOK, /--cors-configuration file:\/\/ops\/production-files-bucket-cors\/after\.json/);
  assert.match(RUNBOOK, /after\.json\) \\\n\s+&& echo "LIVE MATCHES AFTER"/);
});

test('6 the runbook records the applied change with its CloudTrail event and the read-back', () => {
  assert.match(RUNBOOK, /## Applied 2026-11-04 \(record\)/);
  assert.match(RUNBOOK, /PutBucketCors[\s\S]*2026-11-04T15:01:52Z, request id `WW1RDNV6ZT00ZW8J`/);
  assert.match(RUNBOOK, /live configuration equals\s+`ops\/production-files-bucket-cors\/after\.json`/);
});
