import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLASS_A_FUNCTIONS, handleAppServiceRequest } from '../functions/api/app-services.mjs';
import {
  buildReconciliationAlerts,
  filterAlertsForTenants,
  runCheckReconciliation,
} from '../functions/api/check-reconciliation.mjs';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const sqlClient = (handlers) => ({
  query: async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    for (const handler of handlers) {
      if (handler.match(compact, params)) return handler.result(params, compact);
    }
    return { rows: [], rowCount: 0 };
  },
});

test('check-reconciliation is Class A and requires auth', async () => {
  assert.ok(CLASS_A_FUNCTIONS.has('check-reconciliation'));
  const result = await handleAppServiceRequest({
    body: '{}',
    requestContext: { http: { method: 'POST', path: '/functions/v1/check-reconciliation' } },
  }, '/functions/v1/check-reconciliation', 'POST');
  assert.equal(result.statusCode, 401);
  assert.notEqual(result.error, 'provider_disabled');
});

test('alert builder covers stale missing-loss-draft and dashboard mismatch', () => {
  const alerts = buildReconciliationAlerts({
    stuck: [{ id: 'c1', is_overdue: true, hours_in_status: 50, sla_hours: 24, tenant_id: TENANT_A, status: 'uploaded' }],
    missingLossDraft: [{ id: 'c2', tenant_id: TENANT_A, payee_line: 'Bank' }],
    total: 10,
    bucketSum: 7,
  });
  assert.equal(alerts.find((a) => a.alert_type === 'stale_status').severity, 'critical');
  assert.equal(alerts.some((a) => a.alert_type === 'missing_loss_draft_row'), true);
  assert.equal(alerts.some((a) => a.alert_type === 'dashboard_count_mismatch'), true);
  const filtered = filterAlertsForTenants(alerts, [TENANT_A], false);
  assert.equal(filtered.every((a) => !a.tenant_id || a.tenant_id === TENANT_A), true);
});

test('reconciliation is tenant-isolated for non-admins', async () => {
  const inserted = [];
  const result = await runCheckReconciliation({
    mapping: { application_user_id: '55555555-5555-4555-8555-555555555555' },
    spoof: { ignored: true, headerTenantId: TENANT_B },
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.user_roles'),
        result: () => ({ rows: [{ role: 'staff' }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.tenant_users'),
        result: () => ({ rows: [{ tenant_id: TENANT_A }] }),
      },
      {
        match: (sql) => sql.includes('get_stuck_checks'),
        result: () => ({ rows: [
          { id: 'c1', is_overdue: true, hours_in_status: 10, sla_hours: 8, tenant_id: TENANT_A, status: 'uploaded' },
          { id: 'c2', is_overdue: true, hours_in_status: 10, sla_hours: 8, tenant_id: TENANT_B, status: 'uploaded' },
        ] }),
      },
      {
        match: (sql) => sql.includes('loss_draft_tracking'),
        result: () => ({ rows: [{ id: 'c9', tenant_id: TENANT_B, payee_line: 'Other' }] }),
      },
      {
        match: (sql) => sql.includes('count(*)') && sql.includes('check_intake_items') && !sql.includes('status ='),
        result: () => ({ rows: [{ n: 2 }] }),
      },
      {
        match: (sql) => sql.includes('count(*)') && sql.includes('status ='),
        result: () => ({ rows: [{ n: 2 }] }),
      },
      {
        match: (sql) => sql.includes('INSERT INTO public.check_reconciliation_alerts'),
        result: (params) => {
          inserted.push(params[0]);
          return { rows: [], rowCount: 1 };
        },
      },
    ]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.orphan_storage_skipped, true);
  assert.equal(inserted.includes('missing_loss_draft_row'), false);
  assert.equal(inserted.includes('stale_status'), true);
});

test('empty tenant scope does not fail open', () => {
  const alerts = [
    { alert_type: 'stale_status', tenant_id: TENANT_B },
    { alert_type: 'missing_loss_draft_row', tenant_id: TENANT_A },
  ];
  assert.deepEqual(filterAlertsForTenants(alerts, [], false), []);
  assert.equal(filterAlertsForTenants(alerts, [], true).length, 2);
});

test('tenant user_roles.admin stays tenant-scoped', async () => {
  const inserted = [];
  const result = await runCheckReconciliation({
    mapping: { application_user_id: '55555555-5555-4555-8555-555555555555' },
    spoof: {},
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.user_roles'),
        result: () => ({ rows: [{ role: 'admin' }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.tenant_users'),
        result: () => ({ rows: [{ tenant_id: TENANT_A }] }),
      },
      {
        match: (sql) => sql.includes('is_master_owner') || sql.includes('is_platform_owner'),
        result: () => ({ rows: [{ is_master: false, is_platform: false }] }),
      },
      {
        match: (sql) => sql.includes('get_stuck_checks'),
        result: () => ({ rows: [
          { id: 'c1', is_overdue: true, hours_in_status: 10, sla_hours: 8, tenant_id: TENANT_A, status: 'uploaded' },
          { id: 'c2', is_overdue: true, hours_in_status: 10, sla_hours: 8, tenant_id: TENANT_B, status: 'uploaded' },
        ] }),
      },
      {
        match: (sql) => sql.includes('loss_draft_tracking'),
        result: () => ({ rows: [{ id: 'c9', tenant_id: TENANT_B, payee_line: 'Other' }] }),
      },
      {
        match: (sql) => sql.includes('count(*)') && sql.includes('check_intake_items') && !sql.includes('status ='),
        result: () => ({ rows: [{ n: 2 }] }),
      },
      {
        match: (sql) => sql.includes('count(*)') && sql.includes('status ='),
        result: () => ({ rows: [{ n: 2 }] }),
      },
      {
        match: (sql) => sql.includes('INSERT INTO public.check_reconciliation_alerts'),
        result: (params) => {
          inserted.push(params[0]);
          return { rows: [], rowCount: 1 };
        },
      },
    ]),
  });
  assert.equal(result.ok, true);
  assert.equal(inserted.includes('stale_status'), true);
  assert.equal(inserted.includes('missing_loss_draft_row'), false);
});

test('unattached mortgage_agent cannot reconcile all tenants', async () => {
  const result = await runCheckReconciliation({
    mapping: { application_user_id: '66666666-6666-4666-8666-666666666666' },
    spoof: {},
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.user_roles'),
        result: () => ({ rows: [{ role: 'mortgage_agent' }] }),
      },
      {
        match: (sql) => sql.includes('FROM public.tenant_users'),
        result: () => ({ rows: [] }),
      },
      {
        match: (sql) => sql.includes('is_master_owner') || sql.includes('is_platform_owner'),
        result: () => ({ rows: [{ is_master: false, is_platform: false }] }),
      },
      {
        match: (sql) => sql.includes('get_stuck_checks'),
        result: () => ({ rows: [
          { id: 'c2', is_overdue: true, hours_in_status: 10, sla_hours: 8, tenant_id: TENANT_B, status: 'uploaded' },
        ] }),
      },
    ]),
  });
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'forbidden');
});

test('platform owner may reconcile across tenants', async () => {
  const inserted = [];
  const result = await runCheckReconciliation({
    mapping: { application_user_id: '77777777-7777-4777-8777-777777777777' },
    spoof: {},
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.tenant_users'),
        result: () => ({ rows: [] }),
      },
      {
        match: (sql) => sql.includes('is_master_owner') || sql.includes('is_platform_owner'),
        result: () => ({ rows: [{ is_master: true, is_platform: true }] }),
      },
      {
        match: (sql) => sql.includes('get_stuck_checks'),
        result: () => ({ rows: [
          { id: 'c1', is_overdue: true, hours_in_status: 10, sla_hours: 8, tenant_id: TENANT_A, status: 'uploaded' },
          { id: 'c2', is_overdue: true, hours_in_status: 10, sla_hours: 8, tenant_id: TENANT_B, status: 'uploaded' },
        ] }),
      },
      {
        match: (sql) => sql.includes('loss_draft_tracking'),
        result: () => ({ rows: [] }),
      },
      {
        match: (sql) => sql.includes('count(*)') && sql.includes('check_intake_items') && !sql.includes('status ='),
        result: () => ({ rows: [{ n: 2 }] }),
      },
      {
        match: (sql) => sql.includes('count(*)') && sql.includes('status ='),
        result: () => ({ rows: [{ n: 2 }] }),
      },
      {
        match: (sql) => sql.includes('INSERT INTO public.check_reconciliation_alerts'),
        result: (params) => {
          inserted.push(params[0]);
          return { rows: [], rowCount: 1 };
        },
      },
    ]),
  });
  assert.equal(result.ok, true);
  assert.equal(inserted.filter((type) => type === 'stale_status').length, 2);
});
