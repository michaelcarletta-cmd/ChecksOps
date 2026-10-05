/**
 * Temporary Collection V2 staging UAT harness.
 * Fixtures only. No Moov, AWS mutation, SQL apply, or money movement.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { applyBillingProviderEvent } from '../functions/api/tenant-collection-v2-settlement.mjs';
import {
  CAN_WRITE_TENANT_SQL,
  FORBIDDEN_OBLIGATION_ID,
  FORBIDDEN_TRANSFER_ID,
  FREEDOM_TENANT_ID,
  LIST_AUTHORIZED_WRITE_TENANTS_SQL,
  SYNTHETIC_UAT_MARKER,
  UAT_AMOUNT_CENTS,
  UAT_COMPLETED_AT,
  UAT_PROVIDER_ENVIRONMENT,
  UAT_SETTLEMENT_FN,
  handleCollectionV2Uat,
  runCollectionV2Uat,
  selectAuthorizedSyntheticTenant,
} from '../functions/api/tenant-collection-v2-uat.mjs';

const C1C = '4f172140-f57a-4744-8050-95f4f07b13b4';
const ADMIN = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const MEMBER = '11111111-1111-4111-8111-111111111111';
const ISOLATION = 'db13cc17-547b-4ca8-806a-f3cf79eafe59';
const UNRELATED = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UAT_ADMIN = '75d3da03-326c-4ea0-8cd1-684d695495a3';
const REAL_TMP = {
  id: FORBIDDEN_OBLIGATION_ID,
  tenant_id: FREEDOM_TENANT_ID,
  amount_cents: 13900,
  status: 'submitted',
  settled_at: null,
  occurrence_kind: 'monthly_subscription',
  billing_period: '2026-09',
  provider_environment: 'production',
  provider_transfer_id: FORBIDDEN_TRANSFER_ID,
  notes: 'Freedom real TMP — not synthetic',
};

const uatSource = () => readFileSync(new URL('../functions/api/tenant-collection-v2-uat.mjs', import.meta.url), 'utf8');
const indexSource = () => readFileSync(new URL('../functions/api/index.mjs', import.meta.url), 'utf8');

const jwtEvent = (body, extra = {}) => ({
  rawPath: '/uat/collection-v2',
  headers: { authorization: extra.auth === null ? undefined : 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/uat/collection-v2' },
  },
});

function createUatStore({
  roles = ['admin'],
  master = true,
  platform = true,
  tenants = [{ id: C1C, created_at: '2026-01-01' }, { id: FREEDOM_TENANT_ID, created_at: '2025-01-01' }],
  writableTenantIds = null,
  existing = [REAL_TMP],
  eventLogGrant = true,
  insertDenied = false,
} = {}) {
  const obligations = existing.map((row) => ({ ...row }));
  const events = [];
  const queries = [];
  const client = {
    queries,
    obligations,
    events,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql === USER_ROLES_SQL) {
        return { rows: roles.map((role) => ({ role })) };
      }
      if (sql.includes('is_master_owner()') && sql.includes('is_platform_owner()')) {
        return { rows: [{ is_master: master, is_platform: platform }] };
      }
      if (sql.includes('aws_can_write_tenant(t.id)')) {
        const allowed = writableTenantIds || tenants.map((row) => row.id);
        const ranked = tenants
          .filter((row) => allowed.includes(row.id))
          .sort((a, b) => {
            const aFreedom = a.id === FREEDOM_TENANT_ID ? 1 : 0;
            const bFreedom = b.id === FREEDOM_TENANT_ID ? 1 : 0;
            if (aFreedom !== bFreedom) return aFreedom - bFreedom;
            return String(a.created_at || '').localeCompare(String(b.created_at || ''))
              || String(a.id).localeCompare(String(b.id));
          });
        return { rows: ranked.map((row) => ({ id: row.id })) };
      }
      if (sql.includes('aws_can_write_tenant($1')) {
        const allowed = writableTenantIds || tenants.map((row) => row.id);
        return { rows: [{ ok: allowed.includes(params[0]) }] };
      }
      if (sql.includes('FROM public.tenants') && sql.includes('id <> $1')) {
        return { rows: tenants.filter((row) => row.id !== params[0]) };
      }
      if (sql.includes('FROM public.tenants')) {
        return { rows: tenants };
      }
      if (sql.includes('FROM public.payment_transfers')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO public.tenant_maintenance_payments')) {
        if (insertDenied) {
          const error = new Error('new row violates row-level security policy for table "tenant_maintenance_payments"');
          error.code = '42501';
          throw error;
        }
        const row = {
          id: params[0],
          tenant_id: params[1],
          amount_cents: params[2],
          monthly_rate_cents: params[2],
          discount_cents: 0,
          billing_period: params[3],
          method: 'synthetic_uat',
          status: 'submitted',
          idempotence_key: params[4],
          recorded_by: params[5],
          notes: params[6],
          funding_source_method_id: null,
          destination_account_id: null,
          destination_payment_method_id: null,
          provider_environment: params[7],
          occurrence_kind: 'monthly_subscription',
          provider_transfer_id: params[8],
          settled_at: null,
          returned_at: null,
          return_reason: null,
        };
        obligations.push(row);
        return { rows: [row] };
      }
      if (sql.includes('DELETE FROM public.tenant_maintenance_payments')) {
        const idx = obligations.findIndex((row) => (
          row.id === params[0]
          && String(row.notes || '').includes(SYNTHETIC_UAT_MARKER)
          && String(row.notes || '').includes(`harness=${String(params[2] || '').replaceAll('%', '').replace('harness=', '')}` || '')
          && Number(row.amount_cents) === params[3]
          && row.provider_environment === params[4]
          && row.id !== params[5]
        ));
        const harness = String(params[2] || '').replaceAll('%', '');
        const removed = [];
        for (let i = obligations.length - 1; i >= 0; i -= 1) {
          const row = obligations[i];
          if (
            row.id === params[0]
            && String(row.notes || '').includes(SYNTHETIC_UAT_MARKER)
            && String(row.notes || '').includes(harness)
            && Number(row.amount_cents) === params[3]
            && row.provider_environment === params[4]
            && row.id !== params[5]
          ) {
            removed.push(obligations.splice(i, 1)[0]);
          }
        }
        return { rows: removed.map((row) => ({ id: row.id })) };
      }
      if (sql.includes('DELETE FROM public.payment_event_log')) {
        if (!eventLogGrant) {
          const error = new Error('permission denied for table payment_event_log');
          error.code = '42501';
          throw error;
        }
        const removed = [];
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const event = events[i];
          const meta = typeof event.provider_metadata === 'string'
            ? JSON.parse(event.provider_metadata)
            : (event.provider_metadata || {});
          if (
            event.provider_transfer_id === params[0]
            && (meta.synthetic_uat_marker === params[1] || meta.harness_id === params[2])
          ) {
            removed.push(events.splice(i, 1)[0]);
          }
        }
        return { rows: removed.map((row) => ({ id: row.id })) };
      }
      if (sql.includes('FROM public.payment_event_log') && sql.includes('SELECT id, event_type')) {
        return {
          rows: events.filter((event) => event.provider_transfer_id === params[0]),
        };
      }
      if (sql.includes('FROM public.payment_event_log')) {
        return {
          rows: events.filter((event) => (
            event.provider_transfer_id === params[0]
            && event.event_type === params[1]
            && event.new_status === params[2]
          )),
        };
      }
      if (sql.includes('INSERT INTO public.payment_event_log')) {
        const meta = typeof params[7] === 'string' ? JSON.parse(params[7]) : params[7];
        const event = {
          id: `evt-${events.length + 1}`,
          provider_transfer_id: params[3],
          event_type: params[4],
          previous_status: params[5],
          new_status: params[6],
          tenant_id: params[1],
          environment: params[0],
          provider_metadata: meta,
          created_at: '2026-10-05T14:00:00.000Z',
        };
        events.push(event);
        return { rows: [event] };
      }
      if (sql.includes('UPDATE public.tenant_maintenance_payments')) {
        const row = obligations.find((item) => item.id === params[0]);
        if (!row) return { rows: [] };
        const nextStatus = params[1];
        row.status = nextStatus;
        row.settled_at = nextStatus === 'settled'
          ? (row.settled_at || params[3] || UAT_COMPLETED_AT)
          : row.settled_at;
        row.returned_at = nextStatus === 'returned'
          ? (row.returned_at || '2026-10-05T15:00:00.000Z')
          : row.returned_at;
        row.return_reason = nextStatus === 'returned'
          ? (params[2] || row.return_reason)
          : row.return_reason;
        return { rows: [row] };
      }
      if (sql.includes('FROM public.tenant_maintenance_payments') && sql.includes('notes LIKE')) {
        const marker = String(params[0] || '').replaceAll('%', '');
        const harness = String(params[1] || '').replaceAll('%', '');
        return {
          rows: obligations.filter((row) => (
            String(row.notes || '').includes(marker)
            && String(row.notes || '').includes(harness)
            && Number(row.amount_cents) === Number(params[2])
            && row.provider_environment === params[3]
            && row.id !== params[4]
          )),
        };
      }
      if (sql.includes('FROM public.tenant_maintenance_payments') && sql.includes('provider_transfer_id')) {
        return {
          rows: obligations.filter((row) => (
            row.id === params[0] || row.provider_transfer_id === params[1] || row.provider_transfer_id === params[0]
          )),
        };
      }
      if (sql.includes('FROM public.tenant_maintenance_payments WHERE id')) {
        return { rows: obligations.filter((row) => row.id === params[0]) };
      }
      return { rows: [] };
    },
  };
  return { client, obligations, events, queries };
}

const run = (store, body, extra = {}) => runCollectionV2Uat({
  client: store.client,
  mapping: { application_user_id: extra.userId || ADMIN },
  body: { marker: SYNTHETIC_UAT_MARKER, ...body },
  applyEvent: extra.applyEvent || applyBillingProviderEvent,
  randomId: extra.randomId || randomUUID,
});

const handle = (store, body, extra = {}) => handleCollectionV2Uat(jwtEvent(body), {
  env: Object.hasOwn(extra, 'env') ? extra.env : 'staging',
  withIdentityWrite: async (_event, fn) => fn({
    client: store.client,
    mapping: { application_user_id: extra.userId || ADMIN },
    body,
    spoof: { ignored: true },
  }),
  applyBillingProviderEvent: extra.applyEvent || applyBillingProviderEvent,
  randomUUID: extra.randomId || randomUUID,
});

test('exports the exact production applyBillingProviderEvent implementation', () => {
  assert.equal(UAT_SETTLEMENT_FN, applyBillingProviderEvent);
  const source = uatSource();
  assert.match(source, /import \{ applyBillingProviderEvent \} from '\.\/tenant-collection-v2-settlement\.mjs'/);
  assert.equal(source.includes('UPDATE public.tenant_maintenance_payments SET'), false);
  assert.equal(source.includes('moov.checksops') || source.includes('api.moov.io'), false);
  assert.equal(source.includes('INSERT INTO public.payment_transfers'), false);
  assert.equal(source.includes('INSERT INTO public.payment_wallets'), false);
  assert.equal(source.includes('postTransferLedger'), false);
  assert.match(source, /aws_can_write_tenant/);
  assert.equal(source.includes('SELECT id FROM public.tenants\n      WHERE id <> $1::uuid'), false);
});

test('index exposes only POST /uat/collection-v2 and marks it temporary', () => {
  const source = indexSource();
  assert.match(source, /handleCollectionV2UatRequest/);
  assert.match(source, /TEMPORARY staging-only Collection V2 UAT harness/);
  assert.equal((source.match(/handleCollectionV2UatRequest/g) || []).length, 2);
  assert.equal((uatSource().match(/path !== '\/uat\/collection-v2'/g) || []).length, 1);
});

test('production invocation is impossible', async () => {
  const store = createUatStore();
  const result = await handle(store, {
    action: 'create',
    marker: SYNTHETIC_UAT_MARKER,
  }, { env: 'production' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'production_uat_forbidden');
  assert.equal(store.client.queries.length, 0);
  assert.equal(store.obligations.some((row) => row.notes?.includes(SYNTHETIC_UAT_MARKER)), false);
});

test('unset and unknown environments are refused like production', async () => {
  const store = createUatStore();
  for (const env of ['', 'unknown', 'prod', undefined]) {
    const result = await handle(store, { action: 'create', marker: SYNTHETIC_UAT_MARKER }, { env });
    assert.equal(result.error, 'production_uat_forbidden', String(env));
  }
});

test('non-admin invocation is denied', async () => {
  const store = createUatStore({ roles: ['member'], master: false, platform: false });
  const result = await run(store, { action: 'create' }, { userId: MEMBER });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'admin_required');
  assert.equal(store.obligations.some((row) => row.notes?.includes(SYNTHETIC_UAT_MARKER)), false);
});

test('missing synthetic marker is denied', async () => {
  const store = createUatStore();
  const result = await runCollectionV2Uat({
    client: store.client,
    mapping: { application_user_id: ADMIN },
    body: { action: 'create' },
  });
  assert.equal(result.error, 'synthetic_marker_required');
});

test('arbitrary existing TMP cannot be selected', async () => {
  const store = createUatStore();
  const result = await run(store, {
    action: 'complete',
    obligation_id: FORBIDDEN_OBLIGATION_ID,
    harness_id: randomUUID(),
  });
  assert.equal(result.error, 'freedom_obligation_forbidden');
});

test('real Freedom TMP and transfer are explicitly denied', async () => {
  const store = createUatStore();
  const tmp = await run(store, {
    action: 'inspect',
    payment_id: FORBIDDEN_OBLIGATION_ID,
  });
  assert.equal(tmp.error, 'freedom_obligation_forbidden');
  const xfer = await run(store, {
    action: 'complete',
    provider_transfer_id: FORBIDDEN_TRANSFER_ID,
  });
  assert.equal(xfer.error, 'real_transfer_forbidden');
});

test('caller-supplied existing IDs are refused', async () => {
  const store = createUatStore();
  const result = await run(store, {
    action: 'create',
    obligation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  });
  assert.equal(result.error, 'caller_ids_refused');
});

test('caller cannot provide or override tenant_id', async () => {
  const store = createUatStore({
    master: false,
    platform: false,
    tenants: [
      { id: UNRELATED, created_at: '2020-01-01' },
      { id: ISOLATION, created_at: '2026-01-01' },
      { id: FREEDOM_TENANT_ID, created_at: '2025-01-01' },
    ],
    writableTenantIds: [ISOLATION],
  });
  const result = await run(store, {
    action: 'create',
    tenant_id: UNRELATED,
  }, { userId: UAT_ADMIN });
  assert.equal(result.error, 'caller_ids_refused');
  assert.equal(result.refused_keys.includes('tenant_id'), true);
  assert.equal(store.obligations.some((row) => row.notes?.includes(SYNTHETIC_UAT_MARKER)), false);
});

test('admin belonging to Tenant A selects Tenant A rather than unrelated Tenant B', async () => {
  const store = createUatStore({
    master: false,
    platform: false,
    tenants: [
      { id: UNRELATED, created_at: '2020-01-01' },
      { id: ISOLATION, created_at: '2026-01-01' },
      { id: FREEDOM_TENANT_ID, created_at: '2025-01-01' },
    ],
    writableTenantIds: [ISOLATION],
  });
  const selected = await selectAuthorizedSyntheticTenant(store.client);
  assert.equal(selected, ISOLATION);
  const result = await run(store, { action: 'create' }, { userId: UAT_ADMIN });
  assert.equal(result.ok, true);
  assert.equal(result.fixture.tenant_id, ISOLATION);
  assert.equal(result.fixture.tenant_id === UNRELATED, false);
});

test('unrelated global tenant cannot be selected', async () => {
  const store = createUatStore({
    master: false,
    platform: false,
    tenants: [
      { id: UNRELATED, created_at: '2019-01-01' },
      { id: C1C, created_at: '2020-01-01' },
      { id: ISOLATION, created_at: '2026-01-01' },
    ],
    writableTenantIds: [ISOLATION],
  });
  const result = await run(store, { action: 'create' }, { userId: UAT_ADMIN });
  assert.equal(result.fixture.tenant_id, ISOLATION);
  assert.equal(store.client.queries.some((query) => (
    query.sql.includes('FROM public.tenants')
    && query.sql.includes('id <> $1')
    && !query.sql.includes('aws_can_write_tenant')
  )), false);
});

test('user with no writable tenant fails closed', async () => {
  const store = createUatStore({
    master: false,
    platform: false,
    writableTenantIds: [],
  });
  const result = await run(store, { action: 'create' }, { userId: UAT_ADMIN });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_writable_synthetic_tenant');
  assert.equal(store.obligations.some((row) => row.notes?.includes(SYNTHETIC_UAT_MARKER)), false);
});

test('current UAT identity resolves to its legitimately writable isolation tenant', async () => {
  const store = createUatStore({
    master: false,
    platform: false,
    roles: ['admin'],
    tenants: [
      { id: C1C, created_at: '2020-01-01' },
      { id: FREEDOM_TENANT_ID, created_at: '2021-01-01' },
      { id: ISOLATION, created_at: '2026-01-01' },
    ],
    writableTenantIds: [ISOLATION],
  });
  const selected = await selectAuthorizedSyntheticTenant(store.client);
  assert.equal(selected, ISOLATION);
  const created = await run(store, { action: 'create' }, { userId: UAT_ADMIN });
  assert.equal(created.ok, true);
  assert.equal(created.fixture.tenant_id, ISOLATION);
  assert.match(store.client.queries.map((query) => query.sql).join('\n'), /aws_can_write_tenant/);
});

test('master/platform selection still uses aws_can_write_tenant and does not broaden non-master access', async () => {
  const masterStore = createUatStore({
    master: true,
    platform: true,
    tenants: [
      { id: C1C, created_at: '2026-01-01' },
      { id: FREEDOM_TENANT_ID, created_at: '2025-01-01' },
    ],
    writableTenantIds: [C1C, FREEDOM_TENANT_ID],
  });
  const masterCreated = await run(masterStore, { action: 'create' });
  assert.equal(masterCreated.fixture.tenant_id, C1C);

  const nonMaster = createUatStore({
    master: false,
    platform: false,
    tenants: [
      { id: C1C, created_at: '2020-01-01' },
      { id: ISOLATION, created_at: '2026-01-01' },
      { id: FREEDOM_TENANT_ID, created_at: '2021-01-01' },
    ],
    writableTenantIds: [ISOLATION],
  });
  const isolated = await run(nonMaster, { action: 'create' }, { userId: UAT_ADMIN });
  assert.equal(isolated.fixture.tenant_id, ISOLATION);
  assert.equal(isolated.fixture.tenant_id === C1C, false);
});

test('RLS remains the final DB enforcement layer on INSERT', async () => {
  const source = uatSource();
  assert.match(source, /INSERT INTO public.tenant_maintenance_payments/);
  assert.match(source, /aws_can_write_tenant/);
  assert.equal(source.includes('SET row_security'), false);
  assert.equal(source.includes('BYPASSRLS'), false);
  assert.equal(/SET\s+ROLE/i.test(source), false);
  assert.equal(source.includes('FORCE ROW LEVEL SECURITY'), false);
  assert.equal(/75d3da03-326c-4ea0-8cd1-684d695495a3/.test(source), false);
  assert.equal(/db13cc17-547b-4ca8-806a-f3cf79eafe59/.test(source), false);
  const store = createUatStore({
    master: false,
    platform: false,
    writableTenantIds: [ISOLATION],
    tenants: [{ id: ISOLATION, created_at: '2026-01-01' }],
    insertDenied: true,
  });
  await assert.rejects(
    () => run(store, { action: 'create' }, { userId: UAT_ADMIN }),
    (error) => error.code === '42501',
  );
  assert.equal(CAN_WRITE_TENANT_SQL.includes('aws_can_write_tenant'), true);
  assert.equal(LIST_AUTHORIZED_WRITE_TENANTS_SQL.includes('aws_can_write_tenant(t.id)'), true);
});

test('non-synthetic row cannot be cleaned up', async () => {
  const store = createUatStore();
  const result = await run(store, {
    action: 'cleanup',
    harness_id: randomUUID(),
  });
  assert.equal(result.error, 'synthetic_fixture_not_found');
  assert.equal(store.obligations.some((row) => row.id === FORBIDDEN_OBLIGATION_ID), true);
});

test('amount other than 1 cent is denied', async () => {
  const store = createUatStore();
  const result = await run(store, { action: 'create', amount_cents: 13900 });
  assert.equal(result.error, 'amount_not_one_cent');
});

test('non-sandbox provider environment is denied', async () => {
  const store = createUatStore();
  const result = await run(store, { action: 'create', provider_environment: 'production' });
  assert.equal(result.error, 'sandbox_required');
});

test('generated IDs cannot collide with existing rows', async () => {
  const store = createUatStore();
  const colliding = [FORBIDDEN_OBLIGATION_ID, FORBIDDEN_TRANSFER_ID, FORBIDDEN_OBLIGATION_ID];
  const result = await run(store, { action: 'create' }, {
    randomId: () => colliding.shift() || randomUUID(),
  });
  assert.equal(result.ok, true);
  assert.notEqual(result.fixture.id, FORBIDDEN_OBLIGATION_ID);
  assert.notEqual(result.fixture.provider_transfer_id, FORBIDDEN_TRANSFER_ID);
  assert.equal(store.obligations.filter((row) => row.id === FORBIDDEN_OBLIGATION_ID).length, 1);
});

test('create writes exactly one synthetic submitted 1-cent sandbox fixture', async () => {
  const store = createUatStore();
  const result = await run(store, { action: 'create' });
  assert.equal(result.ok, true);
  assert.equal(result.fixture.status, 'submitted');
  assert.equal(result.fixture.amount_cents, UAT_AMOUNT_CENTS);
  assert.equal(result.fixture.provider_environment, UAT_PROVIDER_ENVIRONMENT);
  assert.equal(result.fixture.settled_at, null);
  assert.match(result.fixture.notes, new RegExp(SYNTHETIC_UAT_MARKER));
  assert.match(result.fixture.notes, /collection_v2/);
  assert.equal(result.fixture.occurrence_kind, 'monthly_subscription');
  assert.equal(result.fixture.tenant_id, C1C);
  assert.equal(result.created.payment_transfers, false);
  assert.equal(store.client.queries.some((query) => query.sql.includes('INSERT INTO public.payment_transfers')), false);
  assert.equal(store.client.queries.some((query) => query.sql.includes('payment_wallets')), false);
  assert.equal(store.client.queries.some((query) => query.sql.includes('ledger')), false);
  assert.equal(store.client.queries.some((query) => /moov/i.test(query.sql) && query.sql.includes('INSERT')), false);
});

test('complete uses real applyBillingProviderEvent and writes provider timestamp', async () => {
  const store = createUatStore();
  const created = await run(store, { action: 'create' });
  let seen = 0;
  const wrapped = async (...args) => {
    seen += 1;
    assert.equal(wrapped === applyBillingProviderEvent, false);
    return applyBillingProviderEvent(...args);
  };
  const completed = await run(store, {
    action: 'complete',
    harness_id: created.harness_id,
  }, { applyEvent: UAT_SETTLEMENT_FN });
  assert.equal(completed.ok, true);
  assert.equal(completed.used_real_settlement_fn, true);
  assert.equal(completed.settlement.applied, true);
  assert.equal(completed.fixture.status, 'settled');
  assert.equal(completed.fixture.settled_at, UAT_COMPLETED_AT);
  assert.equal(UAT_SETTLEMENT_FN, applyBillingProviderEvent);
  const viaHandle = await handle(store, {
    action: 'complete_again',
    marker: SYNTHETIC_UAT_MARKER,
    harness_id: created.harness_id,
  });
  assert.equal(viaHandle.settlement.duplicate, true);
  assert.equal(viaHandle.fixture.settled_at, UAT_COMPLETED_AT);
  assert.equal(store.events.filter((event) => event.new_status === 'settled').length, 1);
});

test('duplicate complete preserves timestamp and does not write a second settled event', async () => {
  const store = createUatStore();
  const created = await run(store, { action: 'create' });
  await run(store, { action: 'complete', harness_id: created.harness_id });
  const again = await run(store, { action: 'complete_again', harness_id: created.harness_id });
  assert.equal(again.settlement.duplicate, true);
  assert.equal(again.fixture.settled_at, UAT_COMPLETED_AT);
  assert.equal(store.events.filter((event) => event.event_type === 'collection_v2.completed' && event.new_status === 'settled').length, 1);
});

test('unrelated transfer does nothing to the synthetic fixture', async () => {
  const store = createUatStore();
  const created = await run(store, { action: 'create' });
  await run(store, { action: 'complete', harness_id: created.harness_id });
  const unrelated = await run(store, { action: 'unrelated', harness_id: created.harness_id });
  assert.equal(unrelated.ok, true);
  assert.equal(unrelated.unchanged, true);
  assert.equal(unrelated.settlement.skipped, 'no_billing_occurrence');
  assert.equal(unrelated.fixture.status, 'settled');
  assert.equal(unrelated.fixture.settled_at, UAT_COMPLETED_AT);
});

test('settled-to-returned uses the real settlement function and preserves settled_at', async () => {
  const store = createUatStore();
  const created = await run(store, { action: 'create' });
  await run(store, { action: 'complete', harness_id: created.harness_id });
  const returned = await run(store, { action: 'return', harness_id: created.harness_id });
  assert.equal(returned.ok, true);
  assert.equal(returned.used_real_settlement_fn, true);
  assert.equal(returned.fixture.status, 'returned');
  assert.equal(returned.fixture.settled_at, UAT_COMPLETED_AT);
  assert.equal(returned.fixture.return_reason, 'synthetic_uat_return');
});

test('inspect reads only the synthetic obligation and matching event-log rows', async () => {
  const store = createUatStore();
  const created = await run(store, { action: 'create' });
  await run(store, { action: 'complete', harness_id: created.harness_id });
  const inspected = await run(store, { action: 'inspect', harness_id: created.harness_id });
  assert.equal(inspected.fixture.id, created.fixture.id);
  assert.equal(inspected.events.length, 1);
  assert.equal(inspected.events[0].new_status, 'settled');
  assert.equal(store.obligations.some((row) => row.id === FORBIDDEN_OBLIGATION_ID), true);
});

test('cleanup deletes only harness-created synthetic rows', async () => {
  const store = createUatStore();
  const created = await run(store, { action: 'create' });
  await run(store, { action: 'complete', harness_id: created.harness_id });
  const cleaned = await run(store, { action: 'cleanup', harness_id: created.harness_id });
  assert.equal(cleaned.ok, true);
  assert.deepEqual(cleaned.deleted.tenant_maintenance_payments, [created.fixture.id]);
  assert.equal(cleaned.deleted.payment_event_log.length, 1);
  assert.equal(store.obligations.some((row) => row.id === created.fixture.id), false);
  assert.equal(store.obligations.some((row) => row.id === FORBIDDEN_OBLIGATION_ID), true);
});

test('cleanup reports event-log grant/RLS block without widening permissions', async () => {
  const store = createUatStore({ eventLogGrant: false });
  const created = await run(store, { action: 'create' });
  const cleaned = await run(store, { action: 'cleanup', harness_id: created.harness_id });
  assert.equal(cleaned.ok, true);
  assert.equal(cleaned.event_log_cleanup_blocked, true);
  assert.deepEqual(cleaned.deleted.tenant_maintenance_payments, [created.fixture.id]);
});

test('zero Moov, ACH, wallet, or ledger operations across the lifecycle', async () => {
  const store = createUatStore();
  const created = await run(store, { action: 'create' });
  await run(store, { action: 'complete', harness_id: created.harness_id });
  await run(store, { action: 'complete_again', harness_id: created.harness_id });
  await run(store, { action: 'unrelated', harness_id: created.harness_id });
  await run(store, { action: 'return', harness_id: created.harness_id });
  await run(store, { action: 'inspect', harness_id: created.harness_id });
  await run(store, { action: 'cleanup', harness_id: created.harness_id });
  const sql = store.client.queries.map((query) => query.sql).join('\n');
  assert.equal(sql.includes('INSERT INTO public.payment_transfers'), false);
  assert.equal(sql.includes('payment_wallets'), false);
  assert.equal(sql.includes('payment_wallet_sub_ledgers'), false);
  assert.equal(/moov\.io|api\.moov/i.test(sql), false);
  assert.equal(sql.includes('ach_authorizations'), false);
});
