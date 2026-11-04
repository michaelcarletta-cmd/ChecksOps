/**
 * The staging files bucket CORS change (ops/staging-files-bucket-cors.md): the after state differs
 * from the recorded live before state only in the allowed origins, which add exactly the two origins
 * the iOS and Android apps serve the bundled SPA from. Production stays the production site only.
 * Static checks only; no AWS call.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const BEFORE = JSON.parse(read('ops/staging-files-bucket-cors/before-2026-11-04.json'));
const AFTER = JSON.parse(read('ops/staging-files-bucket-cors/after.json'));
const TEMPLATE = read('aws/template.yaml');
const RUNBOOK = read('ops/staging-files-bucket-cors.md');
const STAGING_SITE = 'https://staging.checksops.com';
const APP_ORIGINS = ['capacitor://localhost', 'https://localhost'];

test('1 the before state is the live refusal: only the staging site may upload', () => {
  assert.equal(BEFORE.CORSRules.length, 1);
  assert.deepEqual(BEFORE.CORSRules[0].AllowedOrigins, [STAGING_SITE]);
});

test('2 the after state changes only the allowed origins, adding the two app origins', () => {
  assert.equal(AFTER.CORSRules.length, BEFORE.CORSRules.length);
  const strip = (doc) => doc.CORSRules.map((r) => ({ ...r, AllowedOrigins: null }));
  assert.deepEqual(strip(AFTER), strip(BEFORE));
  assert.deepEqual(AFTER.CORSRules[0].AllowedOrigins, [STAGING_SITE, ...APP_ORIGINS]);
});

test('3 no wildcard origin and no write method other than PUT', () => {
  for (const rule of AFTER.CORSRules) {
    for (const origin of rule.AllowedOrigins) assert.ok(!origin.includes('*'), origin);
    for (const method of rule.AllowedMethods) assert.ok(['GET', 'HEAD', 'PUT'].includes(method), method);
  }
});

test('4 the stack template allows the same origins on staging and only the production site on production', () => {
  const start = TEMPLATE.indexOf('Id: SpaPresignedUploads');
  const block = TEMPLATE.slice(start, TEMPLATE.indexOf('AllowedMethods:', start));
  const production = block.slice(block.indexOf('IsProductionEnvironment'), block.indexOf(`- - ${STAGING_SITE}`));
  assert.match(production, /- - https:\/\/checksops\.com\n\s+- https:\/\/www\.checksops\.com\n/);
  for (const origin of APP_ORIGINS) assert.ok(!production.includes(origin), `production does not allow ${origin}`);
  const staging = block.slice(block.indexOf(`- - ${STAGING_SITE}`));
  for (const origin of APP_ORIGINS) assert.ok(staging.includes(`- ${origin}`), `staging allows ${origin}`);
});

test('5 the runbook checks the live state before and after, against these files', () => {
  assert.match(RUNBOOK, /checksops-staging-privatefilesbucket-erzqsolpucjp/);
  assert.match(RUNBOOK, /before-2026-11-04\.json\) \\\n\s+&& echo "LIVE MATCHES BEFORE"/);
  assert.match(RUNBOOK, /--cors-configuration file:\/\/ops\/staging-files-bucket-cors\/after\.json/);
  assert.match(RUNBOOK, /after\.json\) \\\n\s+&& echo "LIVE MATCHES AFTER"/);
});
