/**
 * Temporary Collection V2 UAT harness must be absent after source-only removal.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const indexSource = () => readFileSync(new URL('../functions/api/index.mjs', import.meta.url), 'utf8');

test('UAT harness member and route are gone', () => {
  assert.equal(existsSync(new URL('../functions/api/tenant-collection-v2-uat.mjs', import.meta.url)), false);
  const source = indexSource();
  assert.equal(source.includes('handleCollectionV2UatRequest'), false);
  assert.equal(source.includes('/uat/collection-v2'), false);
  assert.equal(source.includes('tenant-collection-v2-uat.mjs'), false);
});

test('TMP catalog inspector member and route are gone', () => {
  assert.equal(existsSync(new URL('../functions/api/tenant-maintenance-payments-catalog-inspect.mjs', import.meta.url)), false);
  const source = indexSource();
  assert.equal(source.includes('handleTmpRlsCatalogInspectRequest'), false);
  assert.equal(source.includes('/inspect/tmp-rls-catalog'), false);
  assert.equal(source.includes('tenant-maintenance-payments-catalog-inspect.mjs'), false);
});
