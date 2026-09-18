import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  assertCheckClaimLinkAllowed,
  collectClaimTenantIds,
  evaluateCheckClaimLink,
  isCheckClaimLinkDenied,
  signalsFromClaimRows,
} from '../../src/lib/checkClaimOwnership.ts';
import {
  assertClaimPaymentsCheckIntakeIndex,
  claimPaymentsIndexMatchesInvariant,
  verifyClaimPaymentsCheckIntakeIndex,
} from '../../src/lib/claimPaymentIndexGuard.ts';
import {
  applyLedgerBackfill,
  inspectLedgerBackfill,
} from '../../src/lib/ledgerBackfill.ts';
import {
  applyDatabaseLedgerSync,
  buildClaimLedgerSyncPlan,
  insertCheckReceivedConflictSafe,
} from '../../src/lib/claimLedgerSync.ts';

const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const CHECK_2 = '44444444-4444-4444-8444-444444444444';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLAIM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const CORRECT_PAYMENTS_INDEXDEF =
  'CREATE UNIQUE INDEX idx_claim_payments_check_intake ON public.claim_payments USING btree (check_intake_item_id) WHERE (check_intake_item_id IS NOT NULL)';

test('claim ownership: same tenant is allowed', () => {
  const decision = evaluateCheckClaimLink({
    checkTenantId: TENANT_A,
    claimId: CLAIM_A,
    claimExists: true,
    claimTenantIds: [TENANT_A],
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'same_tenant');
});

test('claim ownership: first link with no observed claim tenant is allowed', () => {
  const decision = evaluateCheckClaimLink({
    checkTenantId: TENANT_A,
    claimId: CLAIM_A,
    claimExists: true,
    signals: [],
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'first_link');
});

test('claim ownership: cross tenant is denied', () => {
  const decision = evaluateCheckClaimLink({
    checkTenantId: TENANT_A,
    claimId: CLAIM_B,
    claimExists: true,
    signals: [
      { source: 'check_case', tenantId: TENANT_B },
      { source: 'intake', tenantId: TENANT_B, checkId: CHECK_2 },
    ],
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'cross_tenant');
});

test('claim ownership: missing claim is denied', () => {
  const decision = evaluateCheckClaimLink({
    checkTenantId: TENANT_A,
    claimId: CLAIM_A,
    claimExists: false,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'missing_claim');
});

test('claim ownership: null unlink remains allowed', () => {
  const decision = evaluateCheckClaimLink({
    checkTenantId: TENANT_A,
    claimId: null,
    claimExists: true,
    claimTenantIds: [TENANT_B],
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'unlinked');
});

test('claim ownership: missing check tenant on a link is denied', () => {
  const decision = evaluateCheckClaimLink({
    checkTenantId: null,
    claimId: CLAIM_A,
    claimExists: true,
    claimTenantIds: [],
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'missing_check_tenant');
});

test('claim ownership: conflicting observed tenants are denied', () => {
  const decision = evaluateCheckClaimLink({
    checkTenantId: TENANT_A,
    claimId: CLAIM_A,
    claimExists: true,
    claimTenantIds: [TENANT_A, TENANT_B],
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'conflicting_claim_tenants');
});

test('claim ownership: service/internal path uses the same rule and has no bypass', () => {
  assert.equal(evaluateCheckClaimLink({
    checkTenantId: TENANT_A,
    claimId: CLAIM_A,
    claimExists: true,
    claimTenantIds: [TENANT_A],
  }).allowed, true);
  assert.throws(
    () => assertCheckClaimLinkAllowed({
      checkTenantId: TENANT_B,
      claimId: CLAIM_A,
      claimExists: true,
      claimTenantIds: [TENANT_A],
    }),
    /check_claim_link_denied: cross_tenant/,
  );
});

test('claim ownership: current check is excluded from claim tenant evidence', () => {
  const tenants = collectClaimTenantIds([
    { source: 'intake', tenantId: TENANT_B, checkId: CHECK_ID },
    { source: 'intake', tenantId: TENANT_A, checkId: CHECK_2 },
  ], CHECK_ID);
  assert.deepEqual(tenants, [TENANT_A]);
});

test('claim ownership: org_id is only one signal, not the sole owner key', () => {
  const rows = signalsFromClaimRows({
    claim: { id: CLAIM_A, org_id: null },
    intakes: [{ id: CHECK_2, tenant_id: TENANT_A }],
    checkCases: [{ tenant_id: TENANT_A }],
  });
  assert.equal(rows.claimExists, true);
  assert.equal(evaluateCheckClaimLink({
    checkTenantId: TENANT_A,
    claimId: CLAIM_A,
    claimExists: rows.claimExists,
    signals: rows.signals,
    excludeCheckId: CHECK_ID,
  }).reason, 'same_tenant');
});

test('index verification: correct unique partial index passes', () => {
  const decision = verifyClaimPaymentsCheckIntakeIndex({
    indexes: [{
      schemaname: 'public',
      indexname: 'idx_claim_payments_check_intake',
      tablename: 'claim_payments',
      indexdef: CORRECT_PAYMENTS_INDEXDEF,
    }],
    duplicateGroups: 0,
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.action, 'pass');
});

test('index verification: same name but non-unique stops', () => {
  const decision = verifyClaimPaymentsCheckIntakeIndex({
    indexes: [{
      indexname: 'idx_claim_payments_check_intake',
      indexdef: 'CREATE INDEX idx_claim_payments_check_intake ON public.claim_payments USING btree (check_intake_item_id) WHERE (check_intake_item_id IS NOT NULL)',
    }],
  });
  assert.equal(decision.action, 'stop');
  assert.equal(decision.reason, 'index_definition_mismatch');
  assert.throws(
    () => assertClaimPaymentsCheckIntakeIndex({
      indexes: [{
        indexname: 'idx_claim_payments_check_intake',
        indexdef: 'CREATE INDEX idx_claim_payments_check_intake ON public.claim_payments USING btree (check_intake_item_id) WHERE (check_intake_item_id IS NOT NULL)',
      }],
    }),
    /index_definition_mismatch/,
  );
});

test('index verification: wrong columns stop', () => {
  const decision = verifyClaimPaymentsCheckIntakeIndex({
    indexes: [{
      indexname: 'idx_claim_payments_check_intake',
      indexdef: 'CREATE UNIQUE INDEX idx_claim_payments_check_intake ON public.claim_payments USING btree (claim_id) WHERE (check_intake_item_id IS NOT NULL)',
    }],
  });
  assert.equal(decision.action, 'stop');
  assert.equal(claimPaymentsIndexMatchesInvariant(decision.indexdef), false);
});

test('index verification: wrong predicate stops', () => {
  const decision = verifyClaimPaymentsCheckIntakeIndex({
    indexes: [{
      indexname: 'idx_claim_payments_check_intake',
      indexdef: 'CREATE UNIQUE INDEX idx_claim_payments_check_intake ON public.claim_payments USING btree (check_intake_item_id)',
    }],
  });
  assert.equal(decision.action, 'stop');
});

test('index verification: duplicate historical payments stop', () => {
  const decision = verifyClaimPaymentsCheckIntakeIndex({
    indexes: [{
      indexname: 'idx_claim_payments_check_intake',
      indexdef: CORRECT_PAYMENTS_INDEXDEF,
    }],
    duplicateGroups: [{ check_intake_item_id: CHECK_ID, count: 2 }],
  });
  assert.equal(decision.action, 'stop');
  assert.equal(decision.reason, 'duplicate_claim_payments');
  assert.equal(decision.duplicateGroups, 1);
});

test('index verification SQL stops on definition mismatch and keeps the duplicate diagnostic', () => {
  const sql = readFileSync('supabase/migrations/20260918170020_verify_claim_payments_check_intake_index.sql', 'utf8');
  assert.match(sql, /FROM pg_indexes/);
  assert.match(sql, /indexdef/);
  assert.match(sql, /claim_payments_check_intake_index_matches/);
  assert.match(sql, /RAISE EXCEPTION/);
  assert.match(sql, /duplicate claim_payments\.check_intake_item_id/);
  assert.match(sql, /definition does not match/);
  assert.equal(/CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_payments_check_intake/.test(sql), false);
});

test('check_received: repeated sync keeps one event and preserves the existing row', () => {
  const store = {
    check_intake_items: [{
      id: CHECK_ID,
      claim_id: CLAIM_A,
      amount: 100,
      tenant_id: TENANT_A,
      issue_date: '2026-09-01',
    }],
    claim_checks: [],
    claim_payments: [],
    homeowner_ledger_events: [{
      id: 'keep-me',
      check_id: CHECK_ID,
      claim_id: CLAIM_A,
      event_type: 'check_received',
      tenant_id: TENANT_A,
      payload_json: { source: 'preexisting' },
    }],
  };
  applyDatabaseLedgerSync(store, CHECK_ID);
  applyDatabaseLedgerSync(store, CHECK_ID);
  const received = store.homeowner_ledger_events.filter((row) => row.event_type === 'check_received');
  assert.equal(received.length, 1);
  assert.equal(received[0].id, 'keep-me');
  assert.equal(received[0].payload_json.source, 'preexisting');
});

test('check_received: concurrent-equivalent inserts keep one event', () => {
  const events = [];
  const first = insertCheckReceivedConflictSafe(events, {
    id: 'one',
    check_id: CHECK_ID,
    event_type: 'check_received',
  });
  const second = insertCheckReceivedConflictSafe(events, {
    id: 'two',
    check_id: CHECK_ID,
    event_type: 'check_received',
  });
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'one');
});

test('check_received uniqueness SQL is partial unique on check_id', () => {
  const sql = readFileSync('supabase/migrations/20260918170030_one_check_received_per_check.sql', 'utf8');
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_homeowner_ledger_one_check_received/);
  assert.match(sql, /event_type = 'check_received' AND check_id IS NOT NULL/);
  assert.match(sql, /RAISE EXCEPTION/);
  assert.match(sql, /duplicate check_received/);
});

test('future ledger trigger uses conflict-safe check_received and re-asserts ownership', () => {
  const sql = readFileSync('supabase/migrations/20260918170100_sync_check_claim_ledger.sql', 'utf8');
  assert.match(sql, /PERFORM public\.assert_check_claim_link_allowed/);
  assert.match(sql, /ON CONFLICT \(check_id\) WHERE event_type = 'check_received' AND check_id IS NOT NULL/);
  assert.match(sql, /DO NOTHING/);
  assert.equal(/IF NOT EXISTS \(\s*SELECT 1 FROM public\.homeowner_ledger_events/.test(sql), false);
});

test('ownership SQL denies cross-tenant writes even on direct table updates', () => {
  const sql = readFileSync('supabase/migrations/20260918170010_guard_check_claim_tenant.sql', 'utf8');
  assert.match(sql, /claim_observed_tenant_ids/);
  assert.match(sql, /check_cases/);
  assert.match(sql, /claims cl/);
  assert.match(sql, /org_id/);
  assert.match(sql, /trg_guard_check_claim_link/);
  assert.match(sql, /BEFORE INSERT OR UPDATE ON public\.check_intake_items/);
  assert.match(sql, /check_claim_link_denied/);
  assert.match(sql, /WITH CHECK/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.assert_check_claim_link_allowed\(uuid, uuid, uuid\) TO service_role/);
});

test('backfill inspect identifies the three known gap classes without hardcoded counts', () => {
  const store = {
    claims: [{ id: CLAIM_A, org_id: null }],
    checks: [
      { id: CHECK_ID, claim_id: CLAIM_A, tenant_id: TENANT_A, amount: 100 },
      { id: CHECK_2, claim_id: CLAIM_A, tenant_id: TENANT_A, amount: 50 },
    ],
    claim_checks: [{ id: 'cc-1', claim_id: CLAIM_A, check_intake_item_id: CHECK_ID }],
    claim_payments: [],
    homeowner_ledger_events: [{
      check_id: CHECK_ID,
      claim_id: CLAIM_A,
      event_type: 'check_received',
      tenant_id: TENANT_A,
    }],
    check_cases: [{ external_claim_id: CLAIM_A, tenant_id: TENANT_A }],
  };
  const report = inspectLedgerBackfill(store);
  assert.equal(report.eligibleLinkedChecks, 2);
  assert.deepEqual(report.missingClaimChecks, [CHECK_2]);
  assert.deepEqual(report.missingClaimPayments, [CHECK_ID, CHECK_2]);
  assert.deepEqual(report.missingCheckReceived, [CHECK_2]);
  assert.equal(report.crossTenantAnomalies.length, 0);
  assert.equal(report.writes, 0);
  const inspectSql = readFileSync('supabase/unapplied/ledger-backfill/01_inspect.sql', 'utf8');
  assert.match(inspectSql, /eligible_linked_checks/);
  assert.match(inspectSql, /missing_claim_checks/);
  assert.match(inspectSql, /missing_claim_payments/);
  assert.match(inspectSql, /missing_check_received/);
  assert.match(inspectSql, /cross_tenant_anomalies/);
  assert.match(inspectSql, /duplicate_payment_identities/);
  assert.match(inspectSql, /duplicate_check_received_identities/);
  assert.equal(/39|107|86/.test(inspectSql), false);
});

test('backfill apply is idempotent and leaves valid rows intact', () => {
  const store = {
    claims: [{ id: CLAIM_A, org_id: null }],
    checks: [{ id: CHECK_ID, claim_id: CLAIM_A, tenant_id: TENANT_A, amount: 100, carrier_name: 'A' }],
    claim_checks: [],
    claim_payments: [],
    homeowner_ledger_events: [],
    check_cases: [{ external_claim_id: CLAIM_A, tenant_id: TENANT_A }],
  };
  const first = applyLedgerBackfill(store);
  assert.equal(first.writes, 3);
  assert.equal(store.claim_checks.length, 1);
  assert.equal(store.claim_payments.length, 1);
  assert.equal(store.homeowner_ledger_events.length, 1);
  const existingPaymentId = store.claim_payments[0].id;
  const existingEventId = store.homeowner_ledger_events[0].id;
  const second = applyLedgerBackfill(store);
  assert.equal(second.writes, 0);
  assert.equal(store.claim_payments[0].id, existingPaymentId);
  assert.equal(store.homeowner_ledger_events[0].id, existingEventId);
  assert.equal(store.claim_checks[0].claim_id, CLAIM_A);
});

test('backfill apply stops on a cross-tenant anomaly instead of repairing blindly', () => {
  const store = {
    claims: [{ id: CLAIM_B, org_id: TENANT_B }],
    checks: [{ id: CHECK_ID, claim_id: CLAIM_B, tenant_id: TENANT_A, amount: 100 }],
    claim_checks: [],
    claim_payments: [],
    homeowner_ledger_events: [],
    check_cases: [{ external_claim_id: CLAIM_B, tenant_id: TENANT_B }],
  };
  const report = inspectLedgerBackfill(store);
  assert.equal(report.crossTenantAnomalies.length, 1);
  assert.equal(report.crossTenantAnomalies[0].reason, 'cross_tenant');
  assert.throws(() => applyLedgerBackfill(store), /ledger_backfill_stop: cross_tenant_anomaly/);
  assert.equal(store.claim_checks.length, 0);
  assert.equal(store.claim_payments.length, 0);
  assert.equal(store.homeowner_ledger_events.length, 0);
});

test('client planner denies a cross-tenant assignment before writes', () => {
  const plan = buildClaimLedgerSyncPlan({
    check: { id: CHECK_ID, tenant_id: TENANT_A, amount: 10, claim_id: null },
    newClaimId: CLAIM_B,
    claimNumber: 'CL-B',
    claimExists: true,
    claimTenantSignals: [{ source: 'org_id', tenantId: TENANT_B }],
  });
  assert.equal(plan.denied, true);
  assert.equal(plan.skipWrites, true);
});

test('ClaimLedgerCard fails before updating claim_id and reverts if sync is denied', () => {
  const src = readFileSync('src/components/payments/ClaimLedgerCard.tsx', 'utf8');
  assert.match(src, /evaluateCheckClaimLink/);
  assert.match(src, /loadClaimTenantSignals/);
  const ownershipAt = src.indexOf('if (!ownership.allowed)');
  const updateAt = src.indexOf('.update({ detected_claim_number: trimmed, claim_id: matched.id })');
  const revertAt = src.indexOf('.update({ claim_id: previousClaimId })');
  assert.ok(ownershipAt > 0 && updateAt > ownershipAt);
  assert.ok(revertAt > updateAt);
  assert.match(src, /isCheckClaimLinkDenied/);
  assert.match(src, /does not commit and check_intake_items.claim_id is unchanged/);
});

test('database ledger sync refuses to amplify an invalid existing link', () => {
  const store = {
    claims: [{ id: CLAIM_B, org_id: TENANT_B }],
    check_cases: [{ external_claim_id: CLAIM_B, tenant_id: TENANT_B }],
    check_intake_items: [{
      id: CHECK_ID,
      claim_id: CLAIM_B,
      tenant_id: TENANT_A,
      amount: 25,
    }],
    claim_checks: [],
    claim_payments: [],
    homeowner_ledger_events: [],
  };
  assert.throws(() => applyDatabaseLedgerSync(store, CHECK_ID), /check_claim_link_denied: cross_tenant/);
  assert.equal(store.claim_payments.length, 0);
  assert.equal(store.homeowner_ledger_events.length, 0);
});

test('backfill apply SQL is conflict-safe and does not touch providers or statuses', () => {
  const sql = readFileSync('supabase/unapplied/ledger-backfill/02_apply.sql', 'utf8');
  assert.match(sql, /ledger_backfill_stop: cross_tenant_anomaly/);
  assert.match(sql, /ON CONFLICT \(check_id\) WHERE event_type = 'check_received'/);
  assert.equal(/\bcheckalt\b|\bmoov\b/i.test(sql), false);
  assert.equal(/SET status\b/.test(sql), false);
  assert.equal(/DELETE FROM/.test(sql), false);
});
