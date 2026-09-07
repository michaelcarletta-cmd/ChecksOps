import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampExpires, SIGNING_DOCUMENT_EXPIRES } from '../functions/api/storage.mjs';
import { evaluateForceRls, summarizeRlsMatrix } from '../functions/api/rls-audit.mjs';

test('authenticated view TTL clamps to 300 seconds', () => {
  assert.equal(clampExpires(undefined), 300);
  assert.equal(clampExpires(60), 60);
  assert.equal(clampExpires(1800), 300);
  assert.equal(clampExpires(14400), 300);
  assert.equal(clampExpires(99999), 300);
  assert.equal(SIGNING_DOCUMENT_EXPIRES, 1800);
  assert.equal(clampExpires(1800, 300, SIGNING_DOCUMENT_EXPIRES), 1800);
});

test('FORCE RLS is not recommended for the production execution model', () => {
  const force = evaluateForceRls({
    roles: [
      { rolname: 'checksops', rolsuper: false, rolbypassrls: false },
      { rolname: 'checksops_admin', rolsuper: false, rolbypassrls: false },
    ],
    tables: [{ owner: 'postgres' }, { owner: 'checksops_admin' }],
  });
  assert.equal(force.recommended, false);
  assert.equal(force.applied, false);
  assert.equal(force.appOwnsTables, false);
  assert.equal(force.wouldBreakExecutionModel, true);
});

test('RLS matrix flags tenant tables missing enablement or SELECT policy', () => {
  const summary = summarizeRlsMatrix([
    { table: 'check_intake_items', owner: 'postgres', rls_enabled: true, rls_forced: false, has_tenant_column: true },
    { table: 'mystery_tenant', owner: 'postgres', rls_enabled: false, rls_forced: false, has_tenant_column: true },
    { table: 'identity_accounts', owner: 'postgres', rls_enabled: false, rls_forced: false, has_tenant_column: false },
  ], [
    { tablename: 'check_intake_items', cmd: 'SELECT', n: 1 },
    { tablename: 'check_intake_items', cmd: 'ALL', n: 1 },
  ]);
  assert.deepEqual(summary.missingRls, ['mystery_tenant']);
  assert.deepEqual(summary.missingSelect, []);
  assert.equal(summary.matrix[0].select, true);
  assert.equal(summary.matrix[0].rlsForced, false);
});
