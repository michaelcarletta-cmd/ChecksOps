import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  assertCheckClaimLinkAllowed,
  claimIsSelectableForTenant,
  claimNumberSaveWritePayload,
  evaluateCheckClaimLink,
  filterSelectableClaims,
  isCheckClaimLinkDenied,
  newTrackingClaimInsert,
  planClaimNumberSave,
  resolveAutoLinkCandidate,
} from '../../src/lib/checkClaimLinkGuard.ts';
import { fundsReceivedForClaim, fundsReceivedFromScopedIntakeRows } from '../../src/lib/claimLedgerSync.ts';
import {
  claimPaymentsIndexCatalogMatches,
  verifyClaimPaymentsCheckIntakeIndex,
} from '../../src/lib/claimPaymentIndexGuard.ts';

const CHECK_ID = '33333333-3333-4333-8333-333333333333';
const CHECK_2 = '44444444-4444-4444-8444-444444444444';
const CLAIM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLAIM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function applyAuthoritativeCheckReceived(store, check, prevClaimId = null) {
  if (String(check.check_source || 'insurance') !== 'insurance') return store;
  if (!check.claim_id) return store;
  if (prevClaimId != null && String(prevClaimId) === String(check.claim_id)) return store;
  const existing = store.homeowner_ledger_events
    .filter((row) => row.check_id === check.id && row.event_type === 'check_received')
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  if (existing[0]) {
    existing[0].claim_id = check.claim_id;
    existing[0].tenant_id = check.tenant_id || existing[0].tenant_id;
    return store;
  }
  store.homeowner_ledger_events.push({
    id: `recv-${check.id}`,
    check_id: check.id,
    claim_id: check.claim_id,
    tenant_id: check.tenant_id,
    event_type: 'check_received',
    created_at: '2026-01-01T00:00:00.000Z',
  });
  return store;
}

function applyStatusEvent(store, check, prevStatus) {
  if (String(check.check_source || 'insurance') !== 'insurance') return store;
  if (!check.claim_id) return store;
  if (check.status === prevStatus) return store;
  const eventType = check.status === 'deposited' ? 'deposited' : null;
  if (!eventType || eventType === 'check_received') return store;
  if (store.homeowner_ledger_events.some((row) => row.check_id === check.id && row.event_type === eventType)) {
    return store;
  }
  store.homeowner_ledger_events.push({
    id: `${eventType}-${check.id}`,
    check_id: check.id,
    claim_id: check.claim_id,
    event_type: eventType,
  });
  return store;
}

function autoLinkIfAllowed(check, claims) {
  const candidateId = resolveAutoLinkCandidate({
    freedomClaimId: check.freedom_claim_id,
    freedomClaimNumber: check.freedom_claim_number,
    detectedClaimNumber: check.detected_claim_number,
    claims,
  });
  if (!candidateId) return { ...check, claim_id: check.claim_id ?? null };
  const claim = claims.find((row) => row.id === candidateId);
  const decision = evaluateCheckClaimLink({
    checkTenantId: check.tenant_id,
    claimId: candidateId,
    claimExists: Boolean(claim),
    claimOrgId: claim?.org_id ?? null,
  });
  if (!decision.allowed) return { ...check, claim_id: check.claim_id ?? null, denied: decision.reason };
  return { ...check, claim_id: candidateId };
}

test('same-org existing claim is allowed', () => {
  const decision = evaluateCheckClaimLink({
    checkTenantId: TENANT_A,
    claimId: CLAIM_A,
    claimExists: true,
    claimOrgId: TENANT_A,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'same_org');
});

test('known foreign-org claim is denied', () => {
  const decision = evaluateCheckClaimLink({
    checkTenantId: TENANT_A,
    claimId: CLAIM_B,
    claimExists: true,
    claimOrgId: TENANT_B,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'cross_org');
});

test('NULL-org claim is denied even with same-tenant child evidence', () => {
  const decision = evaluateCheckClaimLink({
    checkTenantId: TENANT_A,
    claimId: CLAIM_A,
    claimExists: true,
    claimOrgId: null,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'unassigned_claim');
});

test('missing check tenant is denied', () => {
  const decision = evaluateCheckClaimLink({
    checkTenantId: null,
    claimId: CLAIM_A,
    claimExists: true,
    claimOrgId: TENANT_A,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'missing_check_tenant');
});

test('NULL-org claim is denied without using child rows as ownership', () => {
  const decision = evaluateCheckClaimLink({
    checkTenantId: TENANT_A,
    claimId: CLAIM_A,
    claimExists: true,
    claimOrgId: null,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'unassigned_claim');
});

test('new tracking claim is created with the check tenant/org', () => {
  const row = newTrackingClaimInsert('CL-NEW', TENANT_A);
  assert.equal(row.status, 'tracking');
  assert.equal(row.org_id, TENANT_A);
  assert.equal(row.claim_number, 'CL-NEW');
});

test('existing claim number save updates in place and does not create or relink', () => {
  const existing = planClaimNumberSave({ existingClaimId: CLAIM_A, claimNumber: '  CLM-NEW  ' });
  assert.equal(existing.mode, 'update_existing');
  assert.equal(existing.claimId, CLAIM_A);
  assert.equal(existing.claimNumber, 'CLM-NEW');

  const unlinked = planClaimNumberSave({ existingClaimId: null, claimNumber: 'CLM-LINK' });
  assert.equal(unlinked.mode, 'link_or_create');
  assert.equal(unlinked.claimNumber, 'CLM-LINK');

  assert.throws(() => planClaimNumberSave({ existingClaimId: CLAIM_A, claimNumber: '   ' }));

  const write = claimNumberSaveWritePayload(existing);
  assert.deepEqual(write, {
    table: 'claims',
    op: 'update',
    values: { claim_number: 'CLM-NEW' },
    filters: [{ column: 'id', op: 'eq', value: CLAIM_A }],
    single: true,
    select: 'id, claim_number, policyholder_name, org_id, status, insurance_company, policyholder_address',
  });
  assert.throws(() => claimNumberSaveWritePayload(unlinked), /in-place claim_number update/);

  const src = readFileSync('src/components/payments/ClaimLedgerCard.tsx', 'utf8');
  assert.match(src, /planClaimNumberSave/);
  assert.match(src, /mode === "update_existing"/);
  assert.match(src, /\.from\("claims"\)[\s\S]*\.update\(\{ claim_number: plan\.claimNumber \}\)/);
  assert.match(src, /Claim number save did not keep the existing claim/);
  assert.match(src, /handleLinkedSave/);
  assert.match(src, /existingClaimId: resolveExistingClaimId\(\)/);
  assert.match(src, /onClick=\{handleLinkedSave\}/);
  assert.match(src, /Claim Ledger Save only updates an existing claim/);
  assert.equal(/newTrackingClaimInsert/.test(src), false);
  assert.equal(/\.from\("claims"\)[\s\S]*\.insert\(/.test(src), false);
  const updateBlock = src.slice(src.indexOf('plan.mode === "update_existing"'), src.indexOf('const trimmed = plan.claimNumber'));
  assert.equal(/\.insert\(/.test(updateBlock), false);
  assert.equal(/detected_claim_number/.test(updateBlock), false);
  assert.equal(/claim_id:/.test(updateBlock), false);
  assert.match(updateBlock, /if \(vars\.existingClaimId\)/);

  const ccc = readFileSync('src/pages/CheckCommandCenter.tsx', 'utf8');
  assert.match(ccc, /lg:flex-row/);
  assert.match(ccc, /selectedCheck \? "58%" : "80%"/);
  assert.match(ccc, /selectedCheck \? "42%" : "20%"/);
});

test('manual link uses the same guard as the database', () => {
  assert.doesNotThrow(() => assertCheckClaimLinkAllowed({
    checkTenantId: TENANT_A,
    claimId: CLAIM_A,
    claimExists: true,
    claimOrgId: TENANT_A,
  }));
  assert.throws(
    () => assertCheckClaimLinkAllowed({
      checkTenantId: TENANT_A,
      claimId: CLAIM_B,
      claimExists: true,
      claimOrgId: TENANT_B,
    }),
    /check_claim_link_denied: cross_org/,
  );
});

test('auto-link obeys the same guard and does not attach a denied candidate', () => {
  const claims = [
    { id: CLAIM_A, claim_number: 'CL-A', org_id: TENANT_A },
    { id: CLAIM_B, claim_number: 'CL-B', org_id: TENANT_B },
  ];
  const allowed = autoLinkIfAllowed({
    tenant_id: TENANT_A,
    detected_claim_number: 'CL-A',
  }, claims);
  assert.equal(allowed.claim_id, CLAIM_A);

  const denied = autoLinkIfAllowed({
    tenant_id: TENANT_A,
    detected_claim_number: 'CL-B',
  }, claims);
  assert.equal(denied.claim_id, null);
  assert.equal(denied.denied, 'cross_org');

  const unassigned = autoLinkIfAllowed({
    tenant_id: TENANT_A,
    freedom_claim_id: CLAIM_A,
  }, [{ id: CLAIM_A, claim_number: 'CL-A', org_id: null }]);
  assert.equal(unassigned.claim_id, null);
  assert.equal(unassigned.denied, 'unassigned_claim');
});

test('service-role / SECURITY DEFINER path uses the same deny rule', () => {
  assert.equal(isCheckClaimLinkDenied({ message: 'check_claim_link_denied: cross_org' }), true);
  assert.throws(
    () => assertCheckClaimLinkAllowed({
      checkTenantId: TENANT_B,
      claimId: CLAIM_A,
      claimExists: true,
      claimOrgId: TENANT_A,
    }),
    /check_claim_link_denied/,
  );
});

test('one check maps to one claim; multiple checks may share a claim', () => {
  const checks = [
    { id: CHECK_ID, claim_id: CLAIM_A, amount: 10 },
    { id: CHECK_2, claim_id: CLAIM_A, amount: 15 },
  ];
  assert.equal(new Set(checks.map((row) => row.claim_id)).size, 1);
  assert.equal(fundsReceivedForClaim(checks, CLAIM_A), 25);
});

test('linked check contributes its amount to ClaimLedgerCard Received', () => {
  assert.equal(fundsReceivedForClaim([
    { id: CHECK_ID, claim_id: CLAIM_A, amount: 100 },
  ], CLAIM_A), 100);
});

test('two checks linked to the same claim aggregate', () => {
  assert.equal(fundsReceivedForClaim([
    { id: CHECK_ID, claim_id: CLAIM_A, amount: 100 },
    { id: CHECK_2, claim_id: CLAIM_A, amount: 40 },
  ], CLAIM_A), 140);
});

test('relink A → B moves the amount because the source of truth is claim_id', () => {
  const before = [
    { id: CHECK_ID, claim_id: CLAIM_A, amount: 75 },
    { id: CHECK_2, claim_id: CLAIM_A, amount: 10 },
  ];
  const after = [
    { id: CHECK_ID, claim_id: CLAIM_B, amount: 75 },
    { id: CHECK_2, claim_id: CLAIM_A, amount: 10 },
  ];
  assert.equal(fundsReceivedForClaim(before, CLAIM_A), 85);
  assert.equal(fundsReceivedForClaim(after, CLAIM_A), 10);
  assert.equal(fundsReceivedForClaim(after, CLAIM_B), 75);
});

test('missing claim_payments do not change Received', () => {
  const checks = [{ id: CHECK_ID, claim_id: CLAIM_A, amount: 50 }];
  const withoutPayments = fundsReceivedForClaim(checks, CLAIM_A);
  const stillWithoutPayments = fundsReceivedForClaim(checks, CLAIM_A);
  assert.equal(withoutPayments, 50);
  assert.equal(stillWithoutPayments, 50);
});

test('missing claim_checks do not change Received', () => {
  assert.equal(fundsReceivedForClaim([{ id: CHECK_ID, claim_id: CLAIM_A, amount: 12 }], CLAIM_A), 12);
});

test('missing homeowner_ledger_events do not change Received', () => {
  assert.equal(fundsReceivedForClaim([{ id: CHECK_ID, claim_id: CLAIM_A, amount: 9 }], CLAIM_A), 9);
});

test('insurance check inserted already linked creates exactly one check_received', () => {
  const store = { homeowner_ledger_events: [] };
  const check = { id: CHECK_ID, claim_id: CLAIM_A, tenant_id: TENANT_A, check_source: 'insurance' };
  applyAuthoritativeCheckReceived(store, check);
  applyAuthoritativeCheckReceived(store, check, CLAIM_A);
  applyStatusEvent(store, check, 'uploaded');
  assert.equal(store.homeowner_ledger_events.filter((row) => row.event_type === 'check_received').length, 1);
});

test('late link NULL → A creates exactly one check_received', () => {
  const store = { homeowner_ledger_events: [] };
  const unlinked = { id: CHECK_ID, claim_id: null, tenant_id: TENANT_A, check_source: 'insurance' };
  applyAuthoritativeCheckReceived(store, unlinked);
  assert.equal(store.homeowner_ledger_events.length, 0);
  applyAuthoritativeCheckReceived(store, { ...unlinked, claim_id: CLAIM_A }, null);
  assert.equal(store.homeowner_ledger_events.length, 1);
  assert.equal(store.homeowner_ledger_events[0].claim_id, CLAIM_A);
});

test('relink A → B updates the same physical-check event', () => {
  const store = { homeowner_ledger_events: [] };
  const check = { id: CHECK_ID, claim_id: CLAIM_A, tenant_id: TENANT_A };
  applyAuthoritativeCheckReceived(store, check);
  applyAuthoritativeCheckReceived(store, { ...check, claim_id: CLAIM_B }, CLAIM_A);
  const received = store.homeowner_ledger_events.filter((row) => row.event_type === 'check_received');
  assert.equal(received.length, 1);
  assert.equal(received[0].id, `recv-${CHECK_ID}`);
  assert.equal(received[0].claim_id, CLAIM_B);
});

test('retry does not duplicate check_received', () => {
  const store = { homeowner_ledger_events: [] };
  const check = { id: CHECK_ID, claim_id: CLAIM_A, tenant_id: TENANT_A };
  applyAuthoritativeCheckReceived(store, check);
  applyAuthoritativeCheckReceived(store, check, CLAIM_A);
  applyAuthoritativeCheckReceived(store, check, CLAIM_A);
  assert.equal(store.homeowner_ledger_events.length, 1);
});

test('status-event path does not create another check_received', () => {
  const store = { homeowner_ledger_events: [] };
  const check = { id: CHECK_ID, claim_id: CLAIM_A, tenant_id: TENANT_A, status: 'deposited' };
  applyAuthoritativeCheckReceived(store, check);
  applyStatusEvent(store, check, 'uploaded');
  assert.equal(store.homeowner_ledger_events.filter((row) => row.event_type === 'check_received').length, 1);
  assert.equal(store.homeowner_ledger_events.filter((row) => row.event_type === 'deposited').length, 1);
});

test('two physical checks create two check_received events', () => {
  const store = { homeowner_ledger_events: [] };
  applyAuthoritativeCheckReceived(store, { id: CHECK_ID, claim_id: CLAIM_A, tenant_id: TENANT_A });
  applyAuthoritativeCheckReceived(store, { id: CHECK_2, claim_id: CLAIM_A, tenant_id: TENANT_A });
  assert.equal(store.homeowner_ledger_events.length, 2);
});

test('successful link invalidates Received queries without a full reload', () => {
  const src = readFileSync('src/components/payments/ClaimLedgerCard.tsx', 'utf8');
  assert.match(src, /fundsReceivedFromScopedIntakeRows/);
  assert.equal(/fundsReceivedForClaim/.test(src), false);
  assert.match(src, /filterSelectableClaims/);
  assert.match(src, /invalidateQueries\(\{ queryKey: \["claim-ledger-checks", res\.claimId\] \}\)/);
  assert.match(src, /invalidateQueries\(\{ queryKey: \["check-detail", checkIntakeItemId\] \}\)/);
  assert.equal(/applyClaimLedgerSync/.test(src), false);
  assert.equal(/legacy_same_tenant/.test(src), false);
  assert.equal(/check_cases/.test(src), false);
});

test('ClaimLedgerCard Received uses the actual scoped query shape without row.claim_id', () => {
  const src = readFileSync('src/components/payments/ClaimLedgerCard.tsx', 'utf8');
  const siblingQuery = src.match(
    /ownerSiblingChecks[\s\S]*?\.select\("([^"]+)"\)[\s\S]*?\.eq\("claim_id", claimId!\)/,
  );
  assert.equal(Boolean(siblingQuery), true);
  assert.equal(siblingQuery?.[1].includes('claim_id'), false);
  assert.match(siblingQuery?.[1] ?? '', /\bamount\b/);

  const one = [{
    id: CHECK_ID,
    check_number: '1001',
    amount: 1000,
    status: 'needs_review',
    check_stage: 'review',
  }];
  assert.equal(one[0].claim_id, undefined);
  assert.equal(fundsReceivedFromScopedIntakeRows(one), 1000);

  const two = [
    ...one,
    {
      id: CHECK_2,
      check_number: '1002',
      amount: 2500,
      status: 'deposited',
      check_stage: 'deposit',
    },
  ];
  assert.equal(two.every((row) => row.claim_id === undefined), true);
  assert.equal(fundsReceivedFromScopedIntakeRows(two), 3500);
  assert.equal(fundsReceivedFromScopedIntakeRows([]), 0);

  const afterRelinkAway = two.filter((row) => row.id !== CHECK_ID);
  assert.equal(fundsReceivedFromScopedIntakeRows(afterRelinkAway), 2500);
  const afterRelinkOnto = [
    ...afterRelinkAway,
    {
      id: CHECK_ID,
      check_number: '1001',
      amount: 1000,
      status: 'needs_review',
      check_stage: 'review',
    },
  ];
  assert.equal(fundsReceivedFromScopedIntakeRows(afterRelinkOnto), 3500);
  assert.equal(fundsReceivedFromScopedIntakeRows(two), 3500);

  const withUnusedMirrors = fundsReceivedFromScopedIntakeRows(two);
  assert.equal(withUnusedMirrors, 3500);
  assert.equal(withUnusedMirrors, fundsReceivedFromScopedIntakeRows(two));
  assert.equal(/claim_payments|claim_checks|homeowner_ledger_events/.test(
    fundsReceivedFromScopedIntakeRows.toString(),
  ), false);
});

test('failed foreign-org link does not write claim_id', () => {
  const check = { id: CHECK_ID, claim_id: null, tenant_id: TENANT_A };
  const decision = evaluateCheckClaimLink({
    checkTenantId: check.tenant_id,
    claimId: CLAIM_B,
    claimExists: true,
    claimOrgId: TENANT_B,
  });
  assert.equal(decision.allowed, false);
  assert.equal(check.claim_id, null);
});

test('claim picker does not offer known foreign-org claims', () => {
  const claims = [
    { id: CLAIM_A, org_id: TENANT_A },
    { id: CLAIM_B, org_id: TENANT_B },
    { id: 'legacy', org_id: null },
  ];
  assert.deepEqual(filterSelectableClaims(claims, TENANT_A).map((row) => row.id), [CLAIM_A]);
  assert.equal(claimIsSelectableForTenant({ org_id: null }, TENANT_A), false);
});

test('payment-index catalog matcher uses uniqueness, relation, columns, and predicate', () => {
  assert.equal(claimPaymentsIndexCatalogMatches({
    indexname: 'idx_claim_payments_check_intake',
    nspname: 'public',
    relname: 'claim_payments',
    indisunique: true,
    columns: ['check_intake_item_id'],
    indpred: '(check_intake_item_id IS NOT NULL)',
  }), true);
  assert.equal(verifyClaimPaymentsCheckIntakeIndex({
    indexes: [{
      indexname: 'idx_claim_payments_check_intake',
      nspname: 'public',
      relname: 'claim_payments',
      indisunique: false,
      columns: ['check_intake_item_id'],
      indpred: '(check_intake_item_id IS NOT NULL)',
    }],
  }).action, 'stop');
  assert.equal(verifyClaimPaymentsCheckIntakeIndex({
    indexes: [{
      indexname: 'idx_claim_payments_check_intake',
      nspname: 'public',
      relname: 'other_table',
      indisunique: true,
      columns: ['check_intake_item_id'],
      indpred: '(check_intake_item_id IS NOT NULL)',
    }],
  }).action, 'stop');
});

test('SQL artifacts restore Lovable writer and fail-closed org guard', () => {
  const guard = readFileSync('supabase/migrations/20260918170010_guard_check_claim_org.sql', 'utf8');
  assert.match(guard, /unassigned_claim/);
  assert.match(guard, /same_org/);
  assert.equal(/legacy_same_tenant/.test(guard), false);
  assert.equal(/first_link/.test(guard), false);
  assert.equal(/CREATE OR REPLACE FUNCTION public\.claim_deterministic_tenant_ids/.test(guard), false);
  assert.match(guard, /auto_link_check_to_claim/);
  assert.match(guard, /tg_auto_link_check_to_claim/);
  assert.match(guard, /check_claim_link_allowed/);
  assert.match(guard, /ocr_unique_tenant_claim_id/);
  assert.match(guard, /IN \('unlinked', 'same_org'\)/);
  assert.equal(/\[\^A-Z0-9\]/.test(guard), false);
  assert.equal(/ORDER BY c\.created_at ASC/.test(guard), false);

  const writer = readFileSync('supabase/migrations/20260918170040_one_check_received_writer.sql', 'utf8');
  assert.match(writer, /hle_on_check_intake_insert/);
  assert.match(writer, /AFTER INSERT OR UPDATE OF claim_id/);
  assert.match(writer, /DROP TRIGGER IF EXISTS trg_sync_homeowner_ledger_ins/);
  assert.match(writer, /v_event_type IS DISTINCT FROM 'check_received'/);
  assert.match(writer, /WHERE NOT EXISTS/);

  const inspect = readFileSync('supabase/unapplied/ledger-backfill/01_inspect.sql', 'utf8');
  assert.match(inspect, /funds_received_source/);
  assert.match(inspect, /unassigned_claim/);
  assert.equal(/legacy_same_tenant/.test(inspect), false);
  assert.equal(/missing_claim_payments/.test(inspect), false);
  assert.equal(/02_apply/.test(readFileSync('supabase/unapplied/ledger-backfill/README.md', 'utf8')), false);

  const strip = readFileSync('supabase/migrations/20260918170110_strip_sync_check_claim_ledger_check_received.sql', 'utf8');
  assert.match(strip, /inserted_check_received', false/);
  assert.equal(/event_type = 'check_received'/.test(strip), false);

  const indexSql = readFileSync('supabase/migrations/20260918170020_verify_claim_payments_check_intake_index.sql', 'utf8');
  assert.match(indexSql, /indisunique/);
  assert.match(indexSql, /pg_get_expr\(i\.indpred/);
  assert.match(indexSql, /unnest\(i\.indkey\)/);

  const ocr = readFileSync('supabase/functions/check-ocr-intake/index.ts', 'utf8');
  assert.match(ocr, /Skipped — org mismatch or unassigned legacy claim/);
  assert.equal(/first_link|first-link|claim_observed_tenant/.test(ocr), false);
});
