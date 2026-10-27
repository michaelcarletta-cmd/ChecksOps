/**
 * Item 8 (owner, 2026-10-26): Tenant Management deactivates, reactivates or deletes an empty
 * company through tenant-billing-admin, backed by the SQL 117 functions. Platform owner only,
 * with a readable message on every refusal.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEACTIVATE_TENANT_SQL,
  DEACTIVATED_TENANTS_SQL,
  DELETE_EMPTY_TENANT_SQL,
  REACTIVATE_TENANT_SQL,
  TENANT_ACTIVITY_SQL,
  handleTenantBillingAdmin,
  tenantLifecycleError,
} from '../functions/api/tenant-billing-handlers.mjs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'a1000000-0000-4000-8000-000000000001';

const sqlError = (message, code, detail) => Object.assign(new Error(message), { code, detail });

const fakeClient = ({ owner = true, fail = null, results = {} } = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      const text = String(sql);
      queries.push({ sql: text, params });
      if (/is_platform_owner\(\)/.test(text)) return { rows: [{ ok: owner }] };
      if (fail && fail.sql === text) throw fail.error;
      if (text === DEACTIVATED_TENANTS_SQL) return { rows: results.list || [] };
      if ([DEACTIVATE_TENANT_SQL, REACTIVATE_TENANT_SQL, TENANT_ACTIVITY_SQL, DELETE_EMPTY_TENANT_SQL].includes(text)) {
        return { rows: [{ result: results[text] || { ok: true } }] };
      }
      return { rows: [] };
    },
  };
};

const admin = (client, body) => handleTenantBillingAdmin(
  { body: JSON.stringify(body) },
  { client, mapping: { application_user_id: USER } },
);

test('deactivate, reactivate and activity call the SQL 117 functions with the tenant id', async () => {
  const client = fakeClient({
    results: {
      [DEACTIVATE_TENANT_SQL]: { ok: true, suspended: 3, already_deactivated: false },
      [TENANT_ACTIVITY_SQL]: { empty: false, total: 4, counts: { check_intake_items: 4 } },
    },
  });
  const off = await admin(client, { action: 'tenant-deactivate', tenant_id: TENANT, reason: 'Closed' });
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.equal(off.result.suspended, 3);
  assert.deepEqual(client.queries.find((q) => q.sql === DEACTIVATE_TENANT_SQL).params, [TENANT, 'Closed']);

  const on = await admin(client, { action: 'tenant-reactivate', tenant_id: TENANT });
  assert.equal(on.ok, true);
  assert.deepEqual(client.queries.find((q) => q.sql === REACTIVATE_TENANT_SQL).params, [TENANT]);

  const activity = await admin(client, { action: 'tenant-activity', tenant_id: TENANT });
  assert.equal(activity.result.empty, false);
  assert.equal(activity.result.counts.check_intake_items, 4);

  const noReason = fakeClient();
  await admin(noReason, { action: 'tenant-deactivate', tenant_id: TENANT });
  assert.deepEqual(noReason.queries.find((q) => q.sql === DEACTIVATE_TENANT_SQL).params, [TENANT, null]);
});

test('delete needs the typed URL name and passes it to SQL 117', async () => {
  const missing = fakeClient();
  const refused = await admin(missing, { action: 'tenant-delete', tenant_id: TENANT });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.error, 'confirmation_required');
  assert.equal(missing.queries.some((q) => q.sql === DELETE_EMPTY_TENANT_SQL), false);

  const client = fakeClient({ results: { [DELETE_EMPTY_TENANT_SQL]: { ok: true, deleted: true, slug: 'acme' } } });
  const res = await admin(client, { action: 'tenant-delete', tenant_id: TENANT, confirm_slug: 'acme' });
  assert.equal(res.ok, true);
  assert.equal(res.result.deleted, true);
  assert.deepEqual(client.queries.find((q) => q.sql === DELETE_EMPTY_TENANT_SQL).params, [TENANT, 'acme']);
});

test('the deactivated list needs no tenant id', async () => {
  const row = { tenant_id: TENANT, deactivated_at: '2026-10-26T00:00:00Z', reason: null, previous_subscription_status: 'active', suspended_memberships: 2 };
  const res = await admin(fakeClient({ results: { list: [row] } }), { action: 'tenants-deactivated' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.deactivated, [row]);
});

test('every lifecycle action is platform owner only', async () => {
  for (const body of [
    { action: 'tenants-deactivated' },
    { action: 'tenant-deactivate', tenant_id: TENANT },
    { action: 'tenant-reactivate', tenant_id: TENANT },
    { action: 'tenant-activity', tenant_id: TENANT },
    { action: 'tenant-delete', tenant_id: TENANT, confirm_slug: 'acme' },
  ]) {
    const client = fakeClient({ owner: false });
    const res = await admin(client, body);
    assert.equal(res.statusCode, 403, body.action);
    assert.equal(res.error, 'platform_owner_required');
    assert.equal(client.queries.some((q) => /aws_platform_owner_(de|re)activat|tenant_activity|delete_empty/.test(q.sql)), false);
  }
});

test('SQL 117 refusals come back as readable messages', async () => {
  const cases = [
    [sqlError('function public.aws_platform_owner_delete_empty_tenant(uuid, text) does not exist', '42883'), 503, 'tenant_lifecycle_missing', /SQL 117/],
    [sqlError('tenant_not_empty', '55000', '{"check_intake_items": 4}'), 409, 'tenant_not_empty', /can only be deactivated/],
    [sqlError('tenant_has_records', '55000', 'ledger_fk'), 409, 'tenant_has_records', /can only be deactivated/],
    [sqlError('system_tenant_protected', '55000'), 409, 'system_tenant_protected', /system company/],
    [sqlError('confirmation_mismatch', '22023', 'confirm_slug'), 400, 'confirmation_mismatch', /URL name/],
    [sqlError('tenant_not_found', 'P0002'), 404, 'tenant_not_found', /not found/],
    [sqlError('not_authorized: platform owner required', '42501'), 403, 'platform_owner_required', /platform owner/],
  ];
  for (const [error, statusCode, code, message] of cases) {
    const client = fakeClient({ fail: { sql: DELETE_EMPTY_TENANT_SQL, error } });
    const res = await admin(client, { action: 'tenant-delete', tenant_id: TENANT, confirm_slug: 'acme' });
    assert.equal(res.ok, false, code);
    assert.equal(res.statusCode, statusCode, code);
    assert.equal(res.error, code);
    assert.match(res.message, message, code);
  }
  assert.deepEqual(tenantLifecycleError(sqlError('tenant_not_empty', '55000', '{"check_intake_items": 4}')).counts, { check_intake_items: 4 });
  assert.equal(tenantLifecycleError(sqlError('tenant_has_records', '55000', 'ledger_fk')).constraint, 'ledger_fk');
  assert.throws(() => tenantLifecycleError(sqlError('boom', 'XX000')), /boom/);
});

test('wiring: Tenant Management offers deactivate, reactivate and delete, and hides deactivated companies', async () => {
  const fs = await import('node:fs');
  const read = (file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  const page = read('src/pages/admin/AdminTenants.tsx');
  assert.match(page, /queryKey: \["admin-tenants-deactivated"\]/);
  assert.match(page, /showDeactivated \? tenants : tenants\.filter\(\(t\) => !deactivatedById\.has\(t\.id\)\)/);
  assert.match(page, /\{!t\.is_system_tenant && \(/);
  assert.match(page, /Deactivate…/);
  assert.match(page, /Delete permanently…/);
  assert.match(page, /<DeleteTenantDialog/);
  const lib = read('src/lib/tenantLifecycle.ts');
  for (const action of ['tenants-deactivated', 'tenant-deactivate', 'tenant-reactivate', 'tenant-activity', 'tenant-delete']) {
    assert.match(lib, new RegExp(`action: "${action}"`), action);
  }
  const dialogs = read('src/components/admin/TenantLifecycleDialogs.tsx');
  assert.match(dialogs, /disabled=\{busy \|\| !activity\?\.empty \|\| !matches\}/);
  assert.match(dialogs, /Deactivate instead/);
});
