/**
 * Reverse-import check (release 2026-10-17): the production API is overlaid
 * one file at a time, so while a new file X is live, the other live files are
 * still main's. Every name a main file imports from a module under
 * aws/functions/api (static and destructured dynamic imports) must still be
 * exported by that module on this branch, or the live importer stops loading.
 *
 * The edges come from main (fixtures/main-api-import-edges.json, base sha in
 * the file); names that were already missing on main are not listed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { exportsOf, importsOf } from './helpers/module-exports.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'aws/tests/fixtures/main-api-import-edges.json'), 'utf8'));

test('every export main\'s API files import still exists on the branch (each file can be overlaid alone)', () => {
  assert.ok(FIXTURE.edges.length > 400, String(FIXTURE.edges.length));
  const missing = [];
  const cache = new Map();
  for (const { importer, target, names } of FIXTURE.edges) {
    const abs = path.join(ROOT, target);
    if (!cache.has(abs)) cache.set(abs, fs.existsSync(abs) ? exportsOf(fs.readFileSync(abs, 'utf8')) : null);
    const exported = cache.get(abs);
    if (!exported) {
      missing.push(`${importer} -> ${target}: module missing (${names.join(', ')})`);
      continue;
    }
    for (const name of names) if (!exported.has(name)) missing.push(`${importer} -> ${target}: ${name}`);
  }
  assert.deepEqual(missing, []);
});

test('the compatibility shims cannot reintroduce a bypass', async () => {
  const { isPrivilegedRoleList } = await import('../functions/api/privileged-auth.mjs');
  for (const roles of [['admin'], ['staff'], ['owner'], ['admin', 'staff', 'owner'], []]) assert.equal(isPrivilegedRoleList(roles), false);

  const { isPlatformAdmin } = await import('../functions/api/providers/parity/caller.mjs');
  for (const owner of [true, false]) {
    const seen = [];
    const client = { query: async (sql) => { seen.push(String(sql)); return { rows: [{ is_owner: owner }] }; } };
    assert.equal(await isPlatformAdmin(client, 'a1000000-0000-4000-8000-000000000001'), owner);
    assert.equal(seen.some((sql) => /user_roles/.test(sql)), false);
    assert.ok(seen.some((sql) => /is_platform_owner\(\)/.test(sql)));
  }

  const authz = await import('../functions/api/financial-authz.mjs');
  assert.ok(authz.FINANCIAL_ROLES instanceof Set);
  const newCode = fs.readFileSync(path.join(ROOT, 'aws/functions/api/financial-authz.mjs'), 'utf8');
  assert.equal((newCode.match(/FINANCIAL_ROLES/g) || []).length, 1, 'exported, never used by the new code');

  const { handleSaveTenantCompanyBranding } = await import('../functions/api/tenant-settings-handlers.mjs');
  const branding = await handleSaveTenantCompanyBranding({ body: JSON.stringify({ business_address: 'x' }) });
  assert.equal(branding.statusCode, 410);
  assert.equal(branding.error, 'route_retired');

  const ingest = await import('../functions/api/ingest-shared-check.mjs');
  assert.equal((await ingest.handleIngestSharedCheck({})).statusCode, 410);
  assert.equal(ingest.bridgeSecretMatches({ headers: { 'x-bridge-secret': 'x' } }), false);
  assert.throws(() => ingest.buildIngestPlan({}), /ingest_shared_check_retired/);
});

test('the scanner reads static and destructured dynamic imports', () => {
  const src = "import { a, b as c } from './x.mjs';\nconst { d, e: f } = await import('./y.mjs');\nimport pg from 'pg';";
  assert.deepEqual(importsOf(src), [{ spec: './x.mjs', names: ['a', 'b'] }, { spec: './y.mjs', names: ['d', 'e'] }]);
  assert.deepEqual([...exportsOf('export const a = 1; export async function b() {} export { c, d as e };')].sort(), ['a', 'b', 'c', 'e']);
});
