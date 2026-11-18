// Contractor payee endorsement (owner 2026-11-18), planning only: the two API members, their
// planning manifest and their place in the production overlay plan. Nothing here deploys.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { localImports, resolvePlannedMember } from '../../scripts/deployment-guard/github-production-lambda-overlay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const API = 'aws/functions/api';
const RULE = 'endorsement-completion.mjs';
const HANDLER = 'check-endorsement.mjs';
const REL = 'aws/tests/fixtures/production-contractor-payee-endorsement-api-manifest-2026-11-18.json';
const LINK_EXPIRY = 'aws/tests/fixtures/production-endorsement-link-expiry-manifest-2026-10-31.json';
const PLAN = JSON.parse(read('ops/deployment-guard/production-api-overlay-plan.json'));
const MANIFEST = JSON.parse(read(REL));
const REBUILD = JSON.parse(read('ops/deployment-guard/lambda-rebuild-plan.json')).environments;

test('the manifest is planning only and quotes the owner', () => {
  assert.equal(MANIFEST.deploy_authorized, false);
  assert.match(MANIFEST.authorization, /^Pending owner review \(2026-11-18\)\. Planning only/);
  assert.match(MANIFEST.notes, /Sometimes contractors are in checks so we need to allow them to endorse checks/);
  assert.match(MANIFEST.notes, /Required like the insured/);
  assert.deepEqual(Object.keys(MANIFEST.members), [RULE, HANDLER]);
});

test('both rows accept main\'s bytes and expect the bytes the rebuild records say are live', () => {
  // endorsement-completion.mjs: the first staging rebuild's accepted bytes; no production section lists the file.
  const ruleLive = REBUILD.staging.history[0].members[RULE].accepted_sha256;
  for (const section of REBUILD.production.history) assert.equal(section.members[RULE], undefined);
  // check-endorsement.mjs: the fourth production rebuild's accepted bytes; no later production section lists it.
  const handlerLive = REBUILD.production.history[3].members[HANDLER].accepted_sha256;
  for (const section of REBUILD.production.history.slice(4)) assert.equal(section.members[HANDLER], undefined);
  const expected = {
    [RULE]: { live_sha256: ruleLive, accepted_sha256: sha256(read(`${API}/${RULE}`)), operation: 'replace' },
    [HANDLER]: { live_sha256: handlerLive, accepted_sha256: sha256(read(`${API}/${HANDLER}`)), operation: 'replace', previous_manifest: LINK_EXPIRY },
  };
  assert.deepEqual(MANIFEST.members, expected);
  for (const name of [RULE, HANDLER]) {
    assert.notEqual(expected[name].live_sha256, expected[name].accepted_sha256, name);
    assert.deepEqual(PLAN.members[name], {
      operation: 'replace',
      accepted_sha256: expected[name].accepted_sha256,
      expected_live_sha256: expected[name].live_sha256,
      sql_before: null,
      manifest: REL,
    }, name);
    assert.equal(resolvePlannedMember(name, { root: ROOT, plan: PLAN }).ok, true, name);
  }
  assert.equal(JSON.parse(read(LINK_EXPIRY)).members[HANDLER].accepted_sha256, handlerLive);
});

test('the rule file is applied first: it sits directly before its only importer, in the plan and in the workflow list', () => {
  const at = PLAN.order.indexOf(RULE);
  assert.ok(at >= 0);
  assert.equal(PLAN.order[at + 1], HANDLER);
  assert.ok(!PLAN.do_not_overlay.includes(RULE));
  const importers = fs.readdirSync(path.join(ROOT, API), { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.mjs') && name !== RULE)
    .filter((name) => /endorsement-completion\.mjs/.test(fs.readFileSync(path.join(ROOT, API, name), 'utf8')));
  assert.deepEqual(importers, [HANDLER]);
  assert.ok(localImports(read(`${API}/${HANDLER}`).toString('utf8'), HANDLER).includes(RULE));
  assert.deepEqual(localImports(read(`${API}/${RULE}`).toString('utf8'), RULE), []);
  const workflow = read('.github/workflows/guarded-production-lambda-overlay.yml').toString('utf8');
  assert.match(workflow, /\n {10}- endorsement-completion\.mjs\n {10}- check-endorsement\.mjs\n/);
});

test('the plan notes say what changes and that nothing is deployed', () => {
  const note = PLAN.notes.slice(PLAN.notes.indexOf('Contractor payee endorsement API (2026-11-18'));
  assert.match(note, /endorsement-completion\.mjs REPLACE e0a162ce -> /);
  assert.match(note, /check-endorsement\.mjs REPLACE edd20078 -> /);
  assert.match(note, /read-only production overlay inspect before any apply/);
  assert.match(note, /Nothing deployed\.$/);
});
