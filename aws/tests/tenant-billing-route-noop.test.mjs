/**
 * save-tenant-billing-account never reports a billing change the database did not make
 * (owner report, staging 2026-11-01: unchecking auto-debit said "updated" but the box stayed
 * checked after reload). toggleTenantAutoDebit and saveTenantBillingAuthorization return
 * 409 billing_update_not_applied when the UPDATE/INSERT ... RETURNING yields no row (row
 * security or anything else filtered it) or, for the toggle, a row without the requested value;
 * on success they return the row actually written. The refusal carries a read-only diagnostic
 * (billingWriteDiagnostic: row count, the session's write and membership checks, the role name and the
 * table's row-security metadata; booleans, counts and names only, never an id) so the owner can see why
 * the database did not apply the change (owner 2026-11-01, "add the billing diagnostic").
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { billingWriteDiagnostic, saveTenantBillingAuthorization, toggleTenantAutoDebit } from '../functions/api/tenant-settings-handlers.mjs';

const HANDLERS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../functions/api/tenant-settings-handlers.mjs');
const TENANT = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const STAKEHOLDER = '55555555-5555-4555-8555-555555555555';
const EXISTING = { id: 'b1', tenant_id: TENANT, auto_debit_enabled: true, verification_status: 'verified', routing_number: '', account_number_encrypted: '' };

/** A fake pg client: `routes` maps a SQL pattern to the rows it returns; everything else returns []. */
const fakeClient = (routes) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      for (const [pattern, rows] of routes) {
        if (pattern.test(text)) return { rows: typeof rows === 'function' ? rows(params) : rows };
      }
      return { rows: [] };
    },
  };
};
const SELECT_BILLING = /^\s*SELECT[\s\S]*FROM public\.tenant_billing_accounts/;
const UPDATE_BILLING = /UPDATE public\.tenant_billing_accounts/;
const INSERT_BILLING = /INSERT INTO public\.tenant_billing_accounts/;
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DIAGNOSTIC_KEYS = ['row_visible', 'can_write_tenant', 'is_tenant_member', 'auth_uid_set', 'auth_uid_matches_caller', 'current_user', 'policies', 'rls_enabled', 'rls_forced'];
const assertDiagnosticShape = (diagnostic, { returned = false } = {}) => {
  assert.ok(diagnostic && typeof diagnostic === 'object', 'diagnostic present');
  assert.deepEqual(Object.keys(diagnostic), returned ? [...DIAGNOSTIC_KEYS, 'returned_row', 'returned_auto_debit_enabled'] : DIAGNOSTIC_KEYS);
  // Never an id in the diagnostic.
  assert.doesNotMatch(JSON.stringify(diagnostic), UUID_IN_TEXT);
};

const STAKEHOLDER_ROW = [{
  id: STAKEHOLDER, tenant_id: TENANT, nickname: 'Ops', custname: 'Freedom Adjustment', acct_type: 'C',
  chk_acct: '000123456789', chk_aba: '021000021', verification_status: 'verified', is_active: true,
}];

test('toggle: an update that changes no row is refused, not reported as updated', async () => {
  const client = fakeClient([[SELECT_BILLING, [EXISTING]], [UPDATE_BILLING, []]]);
  const result = await toggleTenantAutoDebit(client, { tenantId: TENANT, enabled: false, userId: USER });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'billing_update_not_applied');
  assertDiagnosticShape(result.diagnostic, { returned: true });
  assert.equal(result.diagnostic.returned_row, false);
});

test('toggle: a returned row that does not hold the requested value is refused', async () => {
  const client = fakeClient([[SELECT_BILLING, [EXISTING]], [UPDATE_BILLING, [{ ...EXISTING, auto_debit_enabled: true }]]]);
  const result = await toggleTenantAutoDebit(client, { tenantId: TENANT, enabled: false, userId: USER });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'billing_update_not_applied');
  assertDiagnosticShape(result.diagnostic, { returned: true });
  assert.equal(result.diagnostic.returned_row, true);
  assert.equal(result.diagnostic.returned_auto_debit_enabled, true);
});

test('toggle: success returns the row actually written', async () => {
  const client = fakeClient([[SELECT_BILLING, [EXISTING]], [UPDATE_BILLING, [{ ...EXISTING, auto_debit_enabled: false }]]]);
  const result = await toggleTenantAutoDebit(client, { tenantId: TENANT, enabled: false });
  assert.equal(result.ok, true);
  assert.equal(result.authorization.id, 'b1');
  assert.equal(result.authorization.auto_debit_enabled, false);
});

test('toggle: no billing row at all is still missing_authorization (404)', async () => {
  const client = fakeClient([]);
  const result = await toggleTenantAutoDebit(client, { tenantId: TENANT, enabled: false });
  assert.deepEqual(result, { ok: false, statusCode: 404, error: 'missing_authorization' });
});

test('save: an UPDATE that returns no row is refused', async () => {
  const client = fakeClient([[/FROM public\.stakeholder_accounts/, STAKEHOLDER_ROW], [SELECT_BILLING, [EXISTING]], [UPDATE_BILLING, []]]);
  const result = await saveTenantBillingAuthorization(client, { tenantId: TENANT, userId: USER, stakeholderId: STAKEHOLDER, authorized: true });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'billing_update_not_applied');
  assertDiagnosticShape(result.diagnostic, { returned: true });
  assert.ok(client.queries.some((q) => UPDATE_BILLING.test(q.sql)));
});

test('save: an INSERT that returns no row is refused', async () => {
  const client = fakeClient([[/FROM public\.stakeholder_accounts/, STAKEHOLDER_ROW], [INSERT_BILLING, []]]);
  const result = await saveTenantBillingAuthorization(client, { tenantId: TENANT, userId: USER, stakeholderId: STAKEHOLDER, authorized: true });
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'billing_update_not_applied');
  assertDiagnosticShape(result.diagnostic, { returned: true });
  assert.ok(client.queries.some((q) => INSERT_BILLING.test(q.sql)));
});

test('save: success returns the row actually written', async () => {
  const written = { ...EXISTING, id: 'b2', stakeholder_account_id: STAKEHOLDER, auto_debit_enabled: true, ach_authorized_at: '2026-11-01T00:00:00.000Z' };
  const client = fakeClient([[/FROM public\.stakeholder_accounts/, STAKEHOLDER_ROW], [INSERT_BILLING, [written]]]);
  const result = await saveTenantBillingAuthorization(client, { tenantId: TENANT, userId: USER, stakeholderId: STAKEHOLDER, authorized: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.authorization.id, 'b2');
  assert.equal(result.authorization.stakeholder_account_id, STAKEHOLDER);
});

test('diagnostic: read-only probes in savepoints, ids only as bound parameters, values passed through', async () => {
  const POLICIES = [{ name: 'aws_write_tenant_billing_accounts', permissive: 'PERMISSIVE', cmd: 'ALL', roles: ['authenticated'] }];
  const client = fakeClient([
    [/count\(\*\)::int AS v FROM public\.tenant_billing_accounts/, [{ v: 1 }]],
    [/aws_can_write_tenant/, [{ v: false }]],
    [/aws_is_tenant_member/, [{ v: true }]],
    [/auth\.uid\(\) IS NOT NULL/, [{ v: true }]],
    [/IS NOT DISTINCT FROM/, [{ v: true }]],
    [/current_user/, [{ v: 'checksops' }]],
    [/pg_policies/, [{ v: POLICIES }]],
    [/relrowsecurity/, [{ v: true }]],
    [/relforcerowsecurity/, [{ v: false }]],
  ]);
  const diagnostic = await billingWriteDiagnostic(client, { tenantId: TENANT, userId: USER });
  assert.deepEqual(diagnostic, {
    row_visible: 1, can_write_tenant: false, is_tenant_member: true, auth_uid_set: true, auth_uid_matches_caller: true,
    current_user: 'checksops', policies: POLICIES, rls_enabled: true, rls_forced: false,
  });
  // Every probe is a SELECT inside its own savepoint; nothing writes.
  const probes = client.queries.filter((q) => !/SAVEPOINT/.test(q.sql));
  assert.equal(probes.length, 9);
  for (const q of probes) assert.match(q.sql, /^\s*SELECT\b/);
  assert.equal(client.queries.filter((q) => /^SAVEPOINT billing_diag_/.test(q.sql)).length, 9);
  assert.equal(client.queries.filter((q) => /^RELEASE SAVEPOINT billing_diag_/.test(q.sql)).length, 9);
  // The tenant and caller ids are bound parameters only.
  assert.deepEqual(probes.find((q) => /aws_can_write_tenant/.test(q.sql)).params, [TENANT]);
  assert.deepEqual(probes.find((q) => /IS NOT DISTINCT FROM/.test(q.sql)).params, [USER]);
  for (const q of probes) assert.doesNotMatch(q.sql, UUID_IN_TEXT);
});

test('diagnostic: a failing probe reports its SQLSTATE, rolls back its savepoint, and does not throw or stop the rest', async () => {
  const queries = [];
  const client = {
    query: async (sql, params = []) => {
      queries.push(String(sql));
      if (/aws_can_write_tenant/.test(sql)) {
        const error = new Error('permission denied for function aws_can_write_tenant');
        error.code = '42501';
        throw error;
      }
      if (/current_user/.test(sql)) return { rows: [{ v: 'checksops' }] };
      return { rows: [] };
    },
  };
  const diagnostic = await billingWriteDiagnostic(client, { tenantId: TENANT, userId: USER });
  assert.deepEqual(diagnostic.can_write_tenant, { error: '42501' });
  assert.equal(diagnostic.current_user, 'checksops');
  assert.equal(diagnostic.row_visible, null);
  assert.ok(queries.includes('ROLLBACK TO SAVEPOINT billing_diag_can_write_tenant'));
  assert.doesNotMatch(JSON.stringify(diagnostic), /permission denied/);
});

test('diagnostic: a caller id that is not a uuid is never sent', async () => {
  const client = fakeClient([]);
  await billingWriteDiagnostic(client, { tenantId: TENANT, userId: 'not-a-uuid' });
  assert.deepEqual(client.queries.find((q) => /IS NOT DISTINCT FROM/.test(q.sql)).params, [null]);
});

test('success paths carry no diagnostic', async () => {
  const toggled = await toggleTenantAutoDebit(fakeClient([[SELECT_BILLING, [EXISTING]], [UPDATE_BILLING, [{ ...EXISTING, auto_debit_enabled: false }]]]), { tenantId: TENANT, enabled: false, userId: USER });
  assert.equal(toggled.ok, true);
  assert.equal('diagnostic' in toggled, false);
  const written = { ...EXISTING, id: 'b2', stakeholder_account_id: STAKEHOLDER, auto_debit_enabled: true };
  const saved = await saveTenantBillingAuthorization(fakeClient([[/FROM public\.stakeholder_accounts/, STAKEHOLDER_ROW], [INSERT_BILLING, [written]]]), { tenantId: TENANT, userId: USER, stakeholderId: STAKEHOLDER, authorized: true });
  assert.equal(saved.ok, true);
  assert.equal('diagnostic' in saved, false);
  // The route passes the caller to the toggle so the diagnostic can compare it.
  assert.match(fs.readFileSync(HANDLERS, 'utf8'), /enabled: body\.auto_debit_enabled === true,\s*userId: mapping\.application_user_id,/);
});
