/**
 * save-tenant-billing-account never reports a billing change the database did not make
 * (owner report, staging 2026-11-01: unchecking auto-debit said "updated" but the box stayed
 * checked after reload). toggleTenantAutoDebit and saveTenantBillingAuthorization return
 * 409 billing_update_not_applied when the UPDATE/INSERT ... RETURNING yields no row (row
 * security or anything else filtered it) or, for the toggle, a row without the requested value;
 * on success they return the row actually written.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { saveTenantBillingAuthorization, toggleTenantAutoDebit } from '../functions/api/tenant-settings-handlers.mjs';

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
const STAKEHOLDER_ROW = [{
  id: STAKEHOLDER, tenant_id: TENANT, nickname: 'Ops', custname: 'Freedom Adjustment', acct_type: 'C',
  chk_acct: '000123456789', chk_aba: '021000021', verification_status: 'verified', is_active: true,
}];

test('toggle: an update that changes no row is refused, not reported as updated', async () => {
  const client = fakeClient([[SELECT_BILLING, [EXISTING]], [UPDATE_BILLING, []]]);
  const result = await toggleTenantAutoDebit(client, { tenantId: TENANT, enabled: false });
  assert.deepEqual(result, { ok: false, statusCode: 409, error: 'billing_update_not_applied' });
});

test('toggle: a returned row that does not hold the requested value is refused', async () => {
  const client = fakeClient([[SELECT_BILLING, [EXISTING]], [UPDATE_BILLING, [{ ...EXISTING, auto_debit_enabled: true }]]]);
  const result = await toggleTenantAutoDebit(client, { tenantId: TENANT, enabled: false });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'billing_update_not_applied');
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
  assert.deepEqual(result, { ok: false, statusCode: 409, error: 'billing_update_not_applied' });
  assert.ok(client.queries.some((q) => UPDATE_BILLING.test(q.sql)));
});

test('save: an INSERT that returns no row is refused', async () => {
  const client = fakeClient([[/FROM public\.stakeholder_accounts/, STAKEHOLDER_ROW], [INSERT_BILLING, []]]);
  const result = await saveTenantBillingAuthorization(client, { tenantId: TENANT, userId: USER, stakeholderId: STAKEHOLDER, authorized: true });
  assert.deepEqual(result, { ok: false, statusCode: 409, error: 'billing_update_not_applied' });
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
