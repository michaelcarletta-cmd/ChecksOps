/**
 * The production files bucket CORS change for the iOS and Android apps
 * (ops/production-files-bucket-cors-app.md): the after state differs from the recorded live before
 * state only in the allowed origins of both rules, which add exactly the two origins the apps serve
 * the bundled SPA from. Static checks only; no AWS call.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const BEFORE = JSON.parse(read('ops/production-files-bucket-cors/before-2026-11-15.json'));
const AFTER = JSON.parse(read('ops/production-files-bucket-cors/after-app-origins.json'));
const PREVIOUS_AFTER = JSON.parse(read('ops/production-files-bucket-cors/after.json'));
const RUNBOOK = read('ops/production-files-bucket-cors-app.md');
const SITE = ['https://checksops.com', 'https://www.checksops.com'];
const APP_ORIGINS = ['capacitor://localhost', 'https://localhost'];

test('1 the before state is the 2026-11-04 after state: only the production site', () => {
  assert.deepEqual(BEFORE, PREVIOUS_AFTER);
  assert.equal(BEFORE.CORSRules.length, 2);
  for (const rule of BEFORE.CORSRules) assert.deepEqual(rule.AllowedOrigins, SITE);
});

test('2 the after state changes only the allowed origins, adding the two app origins to both rules', () => {
  assert.equal(AFTER.CORSRules.length, BEFORE.CORSRules.length);
  const strip = (doc) => doc.CORSRules.map((r) => ({ ...r, AllowedOrigins: null }));
  assert.deepEqual(strip(AFTER), strip(BEFORE));
  for (const rule of AFTER.CORSRules) assert.deepEqual(rule.AllowedOrigins, [...SITE, ...APP_ORIGINS]);
});

test('3 no wildcard origin and no write method other than PUT', () => {
  for (const rule of AFTER.CORSRules) {
    for (const origin of rule.AllowedOrigins) assert.ok(!origin.includes('*'), origin);
    for (const method of rule.AllowedMethods) assert.ok(['GET', 'HEAD', 'PUT'].includes(method), method);
  }
});

test('4 the runbook names the production bucket and the exact files, before and after', () => {
  assert.match(RUNBOOK, /B=checksops-production-privatefiles-806168576068/);
  assert.match(RUNBOOK, /ops\/production-files-bucket-cors\/before-2026-11-15\.json\) \\\n\s+&& echo "LIVE MATCHES BEFORE"/);
  assert.match(RUNBOOK, /--cors-configuration file:\/\/ops\/production-files-bucket-cors\/after-app-origins\.json/);
  assert.match(RUNBOOK, /ops\/production-files-bucket-cors\/after-app-origins\.json\) \\\n\s+&& echo "LIVE MATCHES AFTER"/);
  assert.match(RUNBOOK, /\*\*Rollback\.\*\* Run step 2 with `before-2026-11-15\.json`/);
});
