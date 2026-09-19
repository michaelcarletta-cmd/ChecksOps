import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  hasProductionMoovHandler,
  hasProductionMoovLiveReadHandler,
} from '../functions/api/providers/production/moov-dispatch.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('M7.9 oneshot refuses Freedom/C1C and production provider IDs', () => {
  const src = sourceOf('../providers/oneshot/m79-sandbox-tenant/index.mjs');
  assert.match(src, /2eff5f1a-929d-4ce3-9a8b-cd96b98df42a/);
  assert.match(src, /refused_production_tenant/);
  assert.match(src, /production_object_refused/);
  assert.match(src, /aws_moov_set_tenant_environment/);
  assert.match(src, /77_moov_tenant_environment.sql/);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED/);
  assert.doesNotMatch(src, /UPDATE public\.tenants[\s\S]*moov_environment = 'sandbox'/);
});

test('M7.9 runner overlays M7.8 files without replacing money writers or auth', () => {
  const src = sourceOf('../providers/oneshot/m79-run.mjs');
  assert.match(src, /providers\/moov-tenant-environment.mjs/);
  assert.match(src, /auth-cognito.mjs/);
  assert.match(src, /overlay mutated protected file/);
  assert.match(sourceOf('../functions/api/provider-flags.mjs'), /export const moovTransferPostEnabled = productionMoovTransferPostEnabled/);
  assert.match(src, /overlay missing exports/);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.equal(hasProductionMoovHandler('moov-tenant-environment'), true);
  assert.equal(hasProductionMoovLiveReadHandler('moov-wallet-status'), true);
  assert.equal(hasProductionMoovLiveReadHandler('moov-payout-orchestrate'), true);
  assert.match(
    sourceOf('../functions/api/providers/production/moov-dispatch.mjs'),
    /export const runProductionMoovLiveReadHandler/,
  );
});

test('SQL 77 still does not bulk-switch tenants or mention Freedom', () => {
  const sql = sourceOf('../providers/sql/77_moov_tenant_environment.sql');
  assert.doesNotMatch(sql, /2eff5f1a-929d-4ce3-9a8b-cd96b98df42a/);
  assert.doesNotMatch(sql, /UPDATE public\.tenants[\s\S]*moov_environment = 'sandbox'/);
  assert.match(sql, /objects_migrated', false/);
});
