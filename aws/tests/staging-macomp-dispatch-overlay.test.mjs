import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  addedLines,
  LIVE_APP_SERVICES_SHA256,
  patchLiveAppServices,
  REQUIRED_PRESERVED_ROUTES,
} from '../isolated/mortgage-agent-compensation/lambda-staging-dispatch/patch-app-services.mjs';
import {
  LIVE_COMPENSATION_SHA256,
  MEMBER_SOURCES,
  OWNED_ADD,
  OWNED_REPLACE,
  PATCHED_APP_SERVICES_SHA256,
  STAGING_ONLY_HOMEOWNER_ROUTES,
} from '../isolated/mortgage-agent-compensation/lambda-staging-dispatch/constants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIX = path.join(ROOT, 'aws/isolated/mortgage-agent-compensation/lambda-staging-dispatch/fixtures');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const read = (rel) => fs.readFileSync(path.join(FIX, rel), 'utf8');

function classANames(source) {
  const match = String(source).match(/export const CLASS_A_FUNCTIONS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(match, 'CLASS_A_FUNCTIONS set');
  return [...match[1].matchAll(/'([a-z0-9-]+)'/g)].map((row) => row[1]);
}

function switchCases(source) {
  return [...String(source).matchAll(/case '([a-z0-9-]+)':/g)].map((row) => row[1]);
}

test('live fixture matches pinned staging dispatcher bytes', () => {
  const live = fs.readFileSync(path.join(FIX, 'app-services.live.mjs'));
  assert.equal(sha256(live), LIVE_APP_SERVICES_SHA256);
  const text = live.toString('utf8');
  assert.equal(text.includes('handleMortgageAgentCompensation'), false);
  assert.equal(text.includes("'mortgage-agent-compensation'"), false);
  for (const route of STAGING_ONLY_HOMEOWNER_ROUTES) {
    assert.ok(classANames(text).includes(route), route);
    assert.ok(switchCases(text).includes(route), `switch ${route}`);
  }
});

test('patched fixture is live plus only compensation dispatcher registration', () => {
  const live = read('app-services.live.mjs');
  const patched = read('app-services.patched.mjs');
  assert.equal(sha256(patched), PATCHED_APP_SERVICES_SHA256);
  assert.equal(patchLiveAppServices(live), patched);
  const { removed, added } = addedLines(live, patched);
  assert.deepEqual(removed, []);
  assert.deepEqual(added, [
    "import { handleMortgageAgentCompensation } from './mortgage-agent-compensation.mjs';",
    "  'mortgage-agent-compensation',",
    "    case 'mortgage-agent-compensation':",
    '      return handleMortgageAgentCompensation(event);',
  ]);
  const liveNames = classANames(live);
  const patchedNames = classANames(patched);
  assert.deepEqual(patchedNames.filter((name) => !liveNames.includes(name)), ['mortgage-agent-compensation']);
  assert.deepEqual(liveNames.filter((name) => !patchedNames.includes(name)), []);
  const liveCases = switchCases(live);
  const patchedCases = switchCases(patched);
  assert.deepEqual(patchedCases.filter((name) => !liveCases.includes(name)), ['mortgage-agent-compensation']);
  for (const route of REQUIRED_PRESERVED_ROUTES) {
    assert.ok(patchedNames.includes(route), route);
    assert.ok(patchedCases.includes(route), `switch ${route}`);
  }
  assert.equal(patched.includes('save-tenant-billing-account'), false);
  assert.equal(patched.includes('tenant-company-branding-save'), false);
});

test('overlay owns only app-services.mjs replace and does not add compensation member', () => {
  assert.deepEqual([...OWNED_REPLACE], ['app-services.mjs']);
  assert.deepEqual([...OWNED_ADD], []);
  assert.deepEqual(MEMBER_SOURCES, { 'app-services.mjs': 'aws/functions/api/app-services.mjs' });
  assert.equal(LIVE_COMPENSATION_SHA256, '531837ab7ff9fb8279bcfb6cf624bde8aa183820f4a2ac355c6f7a1814cca4bb');
});

test('repo dispatcher stays origin/main and is not the live staging file', () => {
  const repo = fs.readFileSync(path.join(ROOT, 'aws/functions/api/app-services.mjs'));
  assert.equal(sha256(repo), '54a78355b26a2dc30644768d9fb411d08b6a8979b2ee231efd4f861cf541524b');
  assert.notEqual(sha256(repo), LIVE_APP_SERVICES_SHA256);
  assert.notEqual(sha256(repo), PATCHED_APP_SERVICES_SHA256);
  const text = repo.toString('utf8');
  assert.equal(text.includes('homeowner-ledger-endorse-link'), false);
  assert.equal(text.includes('mortgage-agent-compensation'), false);
});
