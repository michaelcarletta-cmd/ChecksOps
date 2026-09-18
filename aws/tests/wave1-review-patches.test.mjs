import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runAuthenticatedEndorsement } from '../functions/api/check-endorsement.mjs';
import { authorizeForceComplete, planForceCompleteRowUpdate } from '../../src/lib/forceCompleteAuth.ts';
import { runForceCompleteEndorsements } from '../../src/lib/forceCompleteEndorsements.ts';
import { decideCheckImageAccess, runGetCheckImageUrls } from '../../src/lib/checkImageAccess.ts';
import {
  applyClaimLedgerSync,
  applyDatabaseLedgerSync,
  buildClaimLedgerSyncPlan,
  fundsReceivedForClaim,
  selectCanonicalRow,
} from '../../src/lib/claimLedgerSync.ts';

const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const CHECK_2 = '44444444-4444-4444-8444-444444444444';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLAIM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER_STAFF = '55555555-5555-4555-8555-555555555555';

const mockClient = (impl) => ({
  query: async (sql, params = []) => impl(String(sql), params || []),
  connect: async () => {},
  end: async () => {},
});

const sqlClient = (handlers) => mockClient((sql, params) => {
  const compact = sql.replace(/\s+/g, ' ');
  if (/^BEGIN|COMMIT|ROLLBACK|SET TRANSACTION/i.test(compact.trim())) return { rows: [], rowCount: 0 };
  for (const handler of handlers) {
    if (handler.match(compact, params)) return handler.result(params, compact);
  }
  return { rows: [], rowCount: 0 };
});

function createMemoryDb(initial = {}) {
  const store = {
    claim_checks: [],
    claim_payments: [],
    homeowner_ledger_events: [],
    check_intake_items: [],
    ...Object.fromEntries(Object.entries(initial).map(([key, rows]) => [key, rows.map((row) => ({ ...row }))])),
  };

  const matches = (row, filters) => filters.every((filter) => (
    String(row[filter.col] ?? '') === String(filter.val ?? '')
  ));

  return {
    store,
    from(table) {
      const state = { filters: [] };
      const chain = {
        select() { return chain; },
        eq(col, val) {
          state.filters.push({ col, val });
          return chain;
        },
        order() { return chain; },
        insert(values) {
          const rows = Array.isArray(values) ? values : [values];
          for (const row of rows) {
            if (
              (table === 'claim_payments' || table === 'claim_checks')
              && row.check_intake_item_id
              && store[table].some((existing) => existing.check_intake_item_id === row.check_intake_item_id)
            ) {
              return Promise.resolve({ data: null, error: { code: '23505' } });
            }
            store[table].push({
              id: row.id || `${table}-${store[table].length + 1}`,
              created_at: row.created_at || `2026-01-${String(store[table].length + 1).padStart(2, '0')}`,
              ...row,
            });
          }
          return Promise.resolve({ data: rows, error: null });
        },
        update(values) {
          const updateFilters = [...state.filters];
          const updater = {
            eq(col, val) {
              updateFilters.push({ col, val });
              return updater;
            },
            then(resolve, reject) {
              try {
                for (const row of store[table]) {
                  if (matches(row, updateFilters)) Object.assign(row, values);
                }
                resolve({ data: null, error: null });
              } catch (error) {
                reject(error);
              }
            },
          };
          return updater;
        },
        then(resolve, reject) {
          try {
            resolve({ data: store[table].filter((row) => matches(row, state.filters)), error: null });
          } catch (error) {
            reject(error);
          }
        },
      };
      return chain;
    },
  };
}

function ledgerCounts(store, checkId) {
  return {
    claimChecks: store.claim_checks.filter((row) => row.check_intake_item_id === checkId).length,
    payments: store.claim_payments.filter((row) => row.check_intake_item_id === checkId).length,
    received: store.homeowner_ledger_events.filter((row) => (
      row.check_id === checkId && row.event_type === 'check_received'
    )).length,
  };
}

function forceCompleteDeps(overrides = {}) {
  const endorsements = overrides.endorsements || [
    {
      id: 'signed-1',
      status: 'signed',
      payee_type: 'insured',
      signed_at: '2026-01-01T00:00:00.000Z',
      notes: 'real signature',
      signature_method: 'drawn',
      signature_image_url: 'keep-image',
      endorsement_image_path: 'keep-path',
      signed_by: 'payee-1',
    },
    {
      id: 'waived-1',
      status: 'waived',
      payee_type: 'public_adjuster',
      signed_at: '2026-01-02T00:00:00.000Z',
      notes: 'waived already',
      signature_method: 'waive',
      signature_image_url: null,
      endorsement_image_path: null,
      signed_by: null,
    },
    {
      id: 'pending-1',
      status: 'pending',
      payee_type: 'additional_payee',
      signed_at: null,
      notes: null,
      signature_method: null,
      signature_image_url: 'do-not-clear',
      endorsement_image_path: 'keep-pending-path',
      signed_by: 'already-named',
    },
  ];
  const updates = [];
  return {
    updates,
    endorsements,
    deps: {
      getUser: async () => ({ id: USER_STAFF }),
      loadCheck: async () => ({ id: CHECK_ID, tenant_id: TENANT_A }),
      loadUserRoles: async () => ['staff'],
      loadTenantMemberships: async () => [{ tenant_id: TENANT_A, role: 'member' }],
      loadEndorsements: async () => endorsements,
      updateEndorsement: async (id, values) => {
        updates.push({ id, values });
        const row = endorsements.find((item) => item.id === id);
        if (row) Object.assign(row, values);
      },
      now: () => '2026-09-18T12:00:00.000Z',
      ...overrides.deps,
    },
  };
}

test('force-complete unauthenticated caller is denied before any write', async () => {
  const { updates, deps } = forceCompleteDeps({
    deps: { getUser: async () => null },
  });
  const result = await runForceCompleteEndorsements(deps, CHECK_ID);
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(updates.length, 0);
});

test('force-complete authenticated user with no tenant role is denied', async () => {
  const { updates, deps } = forceCompleteDeps({
    deps: {
      loadUserRoles: async () => ['client'],
      loadTenantMemberships: async () => [{ tenant_id: TENANT_A, role: 'client' }],
    },
  });
  const result = await runForceCompleteEndorsements(deps, CHECK_ID);
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(updates.length, 0);
});

test('force-complete user from another tenant is denied', async () => {
  const { updates, deps } = forceCompleteDeps({
    deps: {
      loadUserRoles: async () => ['staff'],
      loadTenantMemberships: async () => [{ tenant_id: TENANT_B, role: 'staff' }],
    },
  });
  const result = await runForceCompleteEndorsements(deps, CHECK_ID);
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(updates.length, 0);
});

test('force-complete nonexistent check is denied', async () => {
  const { updates, deps } = forceCompleteDeps({
    deps: { loadCheck: async () => null },
  });
  const result = await runForceCompleteEndorsements(deps, CHECK_ID);
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(updates.length, 0);
});

test('force-complete global staff without membership is denied', () => {
  const result = authorizeForceComplete({
    userId: USER_STAFF,
    check: { id: CHECK_ID, tenant_id: TENANT_A },
    userRoles: ['staff'],
    tenantMemberships: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test('force-complete authorized staff for the check tenant is allowed and preserves signed metadata', async () => {
  const { updates, endorsements, deps } = forceCompleteDeps();
  const result = await runForceCompleteEndorsements(deps, CHECK_ID);
  assert.equal(result.ok, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 'pending-1');
  assert.equal(updates[0].values.signed_at, '2026-09-18T12:00:00.000Z');
  assert.equal(updates[0].values.signature_method, 'manual');
  assert.equal(Object.hasOwn(updates[0].values, 'signature_image_url'), false);
  assert.equal(Object.hasOwn(updates[0].values, 'endorsement_image_path'), false);
  assert.equal(Object.hasOwn(updates[0].values, 'signed_by'), false);

  const signed = endorsements.find((row) => row.id === 'signed-1');
  const waived = endorsements.find((row) => row.id === 'waived-1');
  const pending = endorsements.find((row) => row.id === 'pending-1');
  assert.equal(signed.status, 'signed');
  assert.equal(signed.signature_image_url, 'keep-image');
  assert.equal(signed.endorsement_image_path, 'keep-path');
  assert.equal(signed.signed_by, 'payee-1');
  assert.equal(waived.status, 'waived');
  assert.equal(waived.notes, 'waived already');
  assert.equal(pending.status, 'signed');
  assert.equal(pending.signature_image_url, 'do-not-clear');
  assert.equal(pending.endorsement_image_path, 'keep-pending-path');
  assert.equal(pending.signed_by, 'already-named');
});

test('force-complete COALESCE keeps existing signed_at, notes, and signature_method', () => {
  const planned = planForceCompleteRowUpdate({
    id: 'row-1',
    status: 'pending',
    signed_at: '2026-01-03T00:00:00.000Z',
    notes: 'already noted',
    signature_method: 'in_person',
    signature_image_url: 'img',
    endorsement_image_path: 'path',
    signed_by: 'user',
  }, '2026-09-18T12:00:00.000Z');
  assert.equal(planned.signed_at, '2026-01-03T00:00:00.000Z');
  assert.equal(planned.notes, 'already noted');
  assert.equal(planned.signature_method, 'in_person');
  assert.equal(planned.unchanged.signature_image_url, 'img');
});

test('AWS force-complete denies another tenant and a missing check', async () => {
  const missing = await runAuthenticatedEndorsement({
    client: sqlClient([{
      match: (sql) => sql.includes('FROM public.check_intake_items'),
      result: () => ({ rows: [] }),
    }]),
    mapping: { application_user_id: USER_STAFF },
    body: { action: 'force_complete_endorsements', checkId: CHECK_ID },
    spoof: { ignored: true },
    event: { headers: {} },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.statusCode, 404);

  const updates = [];
  const forbidden = await runAuthenticatedEndorsement({
    client: sqlClient([
      {
        match: (sql) => sql.includes('FROM public.check_intake_items'),
        result: () => ({ rows: [{ id: CHECK_ID, tenant_id: TENANT_A }] }),
      },
      {
        match: (sql) => sql.includes('aws_can_write_tenant'),
        result: () => ({ rows: [{ ok: false }] }),
      },
      {
        match: (sql) => sql.includes("SET status = 'signed'"),
        result: (_params, sql) => {
          updates.push(sql);
          return { rows: [], rowCount: 1 };
        },
      },
    ]),
    mapping: { application_user_id: USER_STAFF },
    body: { action: 'force_complete_endorsements', checkId: CHECK_ID },
    spoof: { ignored: true },
    event: { headers: {} },
  });
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.statusCode, 403);
  assert.equal(updates.length, 0);
});

test('Lovable force-complete path authenticates, loads the check, and COALESCE-writes', () => {
  const source = readFileSync('supabase/functions/check-endorsement/index.ts', 'utf8');
  const force = source.slice(source.indexOf('case "force_complete_endorsements"'));
  assert.match(force, /auth\.getUser/);
  assert.match(force, /from\("check_intake_items"\)/);
  assert.match(force, /from\("user_roles"\)/);
  assert.match(force, /from\("tenant_users"\)/);
  assert.match(force, /error: "forbidden"/);
  assert.match(force, /error: "Check not found"/);
  assert.match(force, /signed_at: row\.signed_at \|\| nowIso/);
  assert.match(force, /notes: row\.notes \|\|/);
  assert.match(force, /signature_method: row\.signature_method \|\| "manual"/);
  assert.equal(/signature_image_url\s*:/.test(force.slice(0, force.indexOf('default:'))), false);
});

test('ledger SQL is trigger-internal, DATE-safe, and unique-payment idempotent', () => {
  const sql = readFileSync('supabase/migrations/20260918170100_sync_check_claim_ledger.sql', 'utf8');
  assert.match(sql, /COALESCE\(v_check\.issue_date, CURRENT_DATE\)/);
  assert.equal(/COALESCE\(v_check\.issue_date,\s*'/.test(sql), false);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /SET search_path TO 'public'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.sync_check_claim_ledger\(uuid\) FROM authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.sync_check_claim_ledger\(uuid\) TO service_role/);
  assert.match(sql, /ON CONFLICT \(check_intake_item_id\) WHERE check_intake_item_id IS NOT NULL/);
  assert.match(sql, /duplicate claim_payments\.check_intake_item_id/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_payments_check_intake/);
  assert.equal(/GRANT EXECUTE ON FUNCTION public\.sync_check_claim_ledger\(uuid\) TO authenticated/.test(sql), false);
});

test('ledger unlinked → A, A → B, B → B, and two checks → B stay one-payment-per-check', async () => {
  const check1 = {
    id: CHECK_ID,
    claim_id: null,
    amount: 1000,
    check_number: '100',
    carrier_name: 'A',
    issue_date: '2026-09-01',
    tenant_id: TENANT_A,
    status: 'endorsements_in_progress',
  };

  const first = buildClaimLedgerSyncPlan({
    check: check1,
    newClaimId: CLAIM_A,
    claimNumber: 'CL-A',
    actorTenantId: TENANT_A,
  });
  assert.equal(first.denied, false);
  assert.equal(first.skipWrites, false);
  assert.equal(first.claimPayments.op, 'insert');
  assert.equal(first.claimPayments.values.payment_date, '2026-09-01');

  const relink = buildClaimLedgerSyncPlan({
    check: { ...check1, claim_id: CLAIM_A },
    newClaimId: CLAIM_B,
    claimNumber: 'CL-B',
    existingClaimCheckId: 'cc-1',
    existingPaymentId: 'pay-1',
    existingEvents: [{ check_id: CHECK_ID, claim_id: CLAIM_A, event_type: 'check_received', tenant_id: TENANT_A }],
    actorTenantId: TENANT_A,
  });
  assert.equal(relink.claimChecks.op, 'update');
  assert.equal(relink.claimPayments.op, 'update');
  assert.equal(relink.insertCheckReceived, false);

  const resave = buildClaimLedgerSyncPlan({
    check: { ...check1, claim_id: CLAIM_B },
    newClaimId: CLAIM_B,
    claimNumber: 'CL-B',
    existingClaimCheckId: 'cc-1',
    existingPaymentId: 'pay-1',
    existingEvents: [{ check_id: CHECK_ID, claim_id: CLAIM_B, event_type: 'check_received', tenant_id: TENANT_A }],
    actorTenantId: TENANT_A,
  });
  assert.equal(resave.skipWrites, true);

  const client = createMemoryDb({
    check_intake_items: [
      { ...check1, claim_id: CLAIM_B },
      { id: CHECK_2, claim_id: CLAIM_B, amount: 250, tenant_id: TENANT_A, issue_date: '2026-09-02' },
    ],
  });
  await applyClaimLedgerSync(client, {
    check: { ...check1, claim_id: CLAIM_B },
    newClaimId: CLAIM_B,
    claimNumber: 'CL-B',
    actorTenantId: TENANT_A,
  });
  await applyClaimLedgerSync(client, {
    check: { id: CHECK_2, claim_id: CLAIM_B, amount: 250, tenant_id: TENANT_A, issue_date: '2026-09-02' },
    newClaimId: CLAIM_B,
    claimNumber: 'CL-B',
    actorTenantId: TENANT_A,
  });
  assert.equal(ledgerCounts(client.store, CHECK_ID).payments, 1);
  assert.equal(ledgerCounts(client.store, CHECK_2).payments, 1);
  assert.equal(fundsReceivedForClaim(client.store.check_intake_items, CLAIM_B), 1250);
});

test('client then DB-sync and DB-sync then client both keep one payment and event', async () => {
  const check = {
    id: CHECK_ID,
    claim_id: CLAIM_A,
    amount: 400,
    check_number: '200',
    carrier_name: 'Carrier',
    issue_date: '2026-09-10',
    tenant_id: TENANT_A,
    status: 'endorsements_in_progress',
  };

  const clientFirst = createMemoryDb({ check_intake_items: [check] });
  await applyClaimLedgerSync(clientFirst, {
    check,
    newClaimId: CLAIM_A,
    claimNumber: 'CL-A',
    actorTenantId: TENANT_A,
  });
  applyDatabaseLedgerSync(clientFirst.store, CHECK_ID);
  assert.deepEqual(ledgerCounts(clientFirst.store, CHECK_ID), {
    claimChecks: 1,
    payments: 1,
    received: 1,
  });

  const dbFirst = createMemoryDb({ check_intake_items: [check] });
  applyDatabaseLedgerSync(dbFirst.store, CHECK_ID);
  await applyClaimLedgerSync(dbFirst, {
    check,
    newClaimId: CLAIM_A,
    claimNumber: 'CL-A',
    actorTenantId: TENANT_A,
  });
  assert.deepEqual(ledgerCounts(dbFirst.store, CHECK_ID), {
    claimChecks: 1,
    payments: 1,
    received: 1,
  });
  assert.equal(dbFirst.store.claim_payments[0].claim_id, CLAIM_A);
});

test('legacy duplicate payments are selected safely and do not use maybeSingle', async () => {
  const source = readFileSync('src/lib/claimLedgerSync.ts', 'utf8');
  assert.equal(/maybeSingle\(/.test(source), false);

  const canonical = selectCanonicalRow([
    { id: 'newer', claim_id: CLAIM_B, created_at: '2026-02-01T00:00:00.000Z' },
    { id: 'older', claim_id: CLAIM_A, created_at: '2026-01-01T00:00:00.000Z' },
  ]);
  assert.equal(canonical.id, 'older');
  assert.equal(canonical.duplicate, true);

  const client = createMemoryDb({
    claim_payments: [
      { id: 'older', claim_id: CLAIM_A, check_intake_item_id: CHECK_ID, created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'newer', claim_id: CLAIM_A, check_intake_item_id: CHECK_ID, created_at: '2026-02-01T00:00:00.000Z' },
    ],
    claim_checks: [
      { id: 'cc-1', claim_id: CLAIM_A, check_intake_item_id: CHECK_ID, created_at: '2026-01-01T00:00:00.000Z' },
    ],
    homeowner_ledger_events: [
      { check_id: CHECK_ID, claim_id: CLAIM_A, event_type: 'check_received', tenant_id: TENANT_A },
    ],
  });
  const result = await applyClaimLedgerSync(client, {
    check: {
      id: CHECK_ID,
      claim_id: CLAIM_A,
      amount: 100,
      tenant_id: TENANT_A,
      issue_date: '2026-09-01',
    },
    newClaimId: CLAIM_B,
    claimNumber: 'CL-B',
    actorTenantId: TENANT_A,
  });
  assert.equal(result.duplicatePayments, true);
  assert.equal(client.store.claim_payments.filter((row) => row.check_intake_item_id === CHECK_ID).length, 2);
  assert.equal(client.store.claim_payments.find((row) => row.id === 'older').claim_id, CLAIM_B);
  assert.equal(client.store.claim_payments.find((row) => row.id === 'newer').claim_id, CLAIM_A);
});

test('cross-tenant ledger sync is denied and does not modify the other tenant', async () => {
  const client = createMemoryDb({
    claim_payments: [
      { id: 'pay-other', claim_id: CLAIM_A, check_intake_item_id: CHECK_ID, created_at: '2026-01-01' },
    ],
    homeowner_ledger_events: [
      { check_id: CHECK_ID, claim_id: CLAIM_A, event_type: 'check_received', tenant_id: TENANT_A },
    ],
  });
  const result = await applyClaimLedgerSync(client, {
    check: { id: CHECK_ID, claim_id: CLAIM_A, amount: 100, tenant_id: TENANT_A },
    newClaimId: CLAIM_B,
    claimNumber: 'CL-B',
    actorTenantId: TENANT_B,
  });
  assert.equal(result.denied, true);
  assert.equal(client.store.claim_payments[0].claim_id, CLAIM_A);
  assert.equal(client.store.homeowner_ledger_events[0].claim_id, CLAIM_A);
});

test('mortgage image handler allows an active request and denies the other states', async () => {
  const loaders = (request) => ({
    loadCheck: async () => ({ id: CHECK_ID, tenant_id: TENANT_A, check_number: '100' }),
    loadUserRoles: async () => ['mortgage_agent'],
    loadTenantIds: async () => [],
    loadActiveMortgageRequest: async () => request,
    loadSharedCheck: async () => false,
    signUrls: async () => ({ frontUrl: 'front', backUrl: 'back' }),
  });

  const allowedRequested = await runGetCheckImageUrls({
    userId: USER_STAFF,
    body: { checkId: CHECK_ID },
    ...loaders({ tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'requested' }),
  });
  assert.equal(allowedRequested.statusCode, 200);

  const allowedProgress = await runGetCheckImageUrls({
    userId: USER_STAFF,
    body: { check_id: CHECK_ID },
    ...loaders({ tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'in_progress' }),
  });
  assert.equal(allowedProgress.statusCode, 200);
  assert.equal(allowedProgress.front_url, 'front');

  const noRequest = await runGetCheckImageUrls({
    userId: USER_STAFF,
    body: { checkId: CHECK_ID },
    ...loaders(null),
  });
  assert.equal(noRequest.statusCode, 403);

  const otherCheck = await runGetCheckImageUrls({
    userId: USER_STAFF,
    body: { checkId: CHECK_ID },
    ...loaders({ tenant_id: TENANT_A, check_intake_item_id: CHECK_2, status: 'in_progress' }),
  });
  assert.equal(otherCheck.statusCode, 403);

  const otherTenant = await runGetCheckImageUrls({
    userId: USER_STAFF,
    body: { checkId: CHECK_ID },
    ...loaders({ tenant_id: TENANT_B, check_intake_item_id: CHECK_ID, status: 'requested' }),
  });
  assert.equal(otherTenant.statusCode, 403);

  const completed = await runGetCheckImageUrls({
    userId: USER_STAFF,
    body: { checkId: CHECK_ID },
    ...loaders({ tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'completed' }),
  });
  assert.equal(completed.statusCode, 403);

  const cancelled = await runGetCheckImageUrls({
    userId: USER_STAFF,
    body: { checkId: CHECK_ID },
    ...loaders({ tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'cancelled' }),
  });
  assert.equal(cancelled.statusCode, 403);

  const unauthenticated = await runGetCheckImageUrls({
    userId: null,
    body: { checkId: CHECK_ID },
    ...loaders(null),
  });
  assert.equal(unauthenticated.statusCode, 401);

  assert.equal(decideCheckImageAccess({
    userId: USER_STAFF,
    check: { id: CHECK_ID, tenant_id: TENANT_A },
    userRoles: ['mortgage_agent'],
    activeMortgageRequest: { tenant_id: TENANT_A, check_intake_item_id: CHECK_ID, status: 'in_progress' },
  }).ok, true);

  const handler = readFileSync('supabase/functions/get-check-image-urls/index.ts', 'utf8');
  assert.match(handler, /Assignment isolation is/);
  assert.equal(/assigned_employee_id/.test(handler), false);
  assert.match(handler, /in\("status", \["requested", "in_progress"\]\)/);
});
