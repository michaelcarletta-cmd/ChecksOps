/**
 * Tenant Collection Contract v2 — 32-case staging/mocked matrix.
 * Fixtures only. Does not POST production Moov or change sweep config.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHECKSOPS_PLATFORM_ACCOUNT_ID,
  CHECKSOPS_PLATFORM_WALLET_PM_ID,
  CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID,
  COLLECTION_STATUS,
  LEG_TYPE,
  appliedCents,
  bankLegIdempotencyKey,
  classifyCollectionStatus,
  collectTenantObligation,
  createMemoryCollectionStore,
  receivedCentsFromLegs,
  remainingUnpaidCents,
  splitCollectionAmounts,
  walletLegIdempotencyKey,
} from '../functions/api/tenant-collection-v2.mjs';
import {
  TENANT_COLLECTION_CONTRACT_V2,
  evaluateCollectionOperation,
} from '../functions/api/tenant-collection-contract-v2.mjs';
import {
  assembleReceivables,
  receivedCentsFor,
  PAYMENT_STATUS,
  summarizeReceivables,
} from '../functions/api/providers/parity/tenant-receivables.mjs';

const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER = '4f172140-f57a-4744-8050-95f4f07b13b4';
const PERIOD = '2026-10';
const OBLIGATION = '11111111-1111-4111-8111-111111111111';
const WALLET_PM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BANK_PM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TENANT_ACCOUNT = '60922058-7eca-4889-81dd-5720d7b9de96';
const TENANT_WALLET = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const destination = {
  ok: true,
  accountId: CHECKSOPS_PLATFORM_ACCOUNT_ID,
  paymentMethodId: CHECKSOPS_PLATFORM_WALLET_PM_ID,
};

const occurrence = {
  id: OBLIGATION,
  tenant_id: TENANT,
  billing_period: PERIOD,
  amount_cents: 10000,
  occurrence_kind: 'monthly_subscription',
  status: 'due',
};

const readiness = {
  environment: 'production',
  authorization: {
    tenant_id: TENANT,
    provider_account_id: TENANT_ACCOUNT,
    provider_payment_method_id: BANK_PM,
  },
  account: { provider_account_id: TENANT_ACCOUNT },
};

const wallet = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  tenant_id: TENANT,
  environment: 'production',
  provider_account_id: TENANT_ACCOUNT,
  provider_wallet_id: TENANT_WALLET,
  provider_payment_method_id: WALLET_PM,
  available_cents: 0,
  pending_cents: 0,
};

function provider(script = {}) {
  const created = new Map();
  const posts = [];
  const postTransfer = async ({ amount, idempotencyKey, sourceMethodId, destMethodId }) => {
    posts.push({ amount, idempotencyKey, sourceMethodId, destMethodId });
    const kind = String(idempotencyKey).endsWith('-wallet') ? 'wallet' : 'bank';
    const action = script[kind] || 'success';
    if (action === 'fail-before-create') throw new Error('provider_rejected');
    if (action === 'timeout-created') {
      created.set(idempotencyKey, {
        transferID: `prov-${idempotencyKey}`,
        status: 'pending',
        amount,
      });
      const error = new Error('timeout');
      error.unknown = true;
      throw error;
    }
    if (action === 'timeout-missing') {
      const error = new Error('timeout');
      error.unknown = true;
      throw error;
    }
    if (action === 'timeout-unknown') {
      const error = new Error('timeout');
      error.unknown = true;
      throw error;
    }
    if (action === 'fail') throw new Error('bank_rejected');
    if (created.has(idempotencyKey)) return created.get(idempotencyKey);
    const transfer = {
      transferID: `prov-${idempotencyKey}`,
      status: script.settled ? 'completed' : 'pending',
      amount,
    };
    created.set(idempotencyKey, transfer);
    return transfer;
  };
  return {
    posts,
    created,
    postTransfer,
    findTransferByIdempotency: async (key) => {
      if (script[String(key).endsWith('-wallet') ? 'wallet' : 'bank'] === 'timeout-unknown') {
        return undefined;
      }
      if (script[String(key).endsWith('-wallet') ? 'wallet' : 'bank'] === 'timeout-missing') {
        return null;
      }
      return created.get(key) || null;
    },
  };
}

async function collect(overrides = {}) {
  const store = overrides.store || createMemoryCollectionStore();
  const moov = overrides.moov || provider(overrides.script || {});
  const result = await collectTenantObligation(null, {
    occurrence: { ...occurrence, ...overrides.occurrence },
    readiness: { ...readiness, ...overrides.readiness },
    destination: overrides.destination || destination,
    fetchImpl: async () => { throw new Error('live_fetch_refused_in_fixture'); },
    postTransfer: moov.postTransfer,
    resolveBillingDebitSource: overrides.resolveBillingDebitSource || (async () => ({
      ok: true,
      sourceMethodId: BANK_PM,
      sourceAccountId: TENANT_ACCOUNT,
      sourceRail: 'ach-debit-fund',
    })),
    deps: {
      store,
      simulate: true,
      wallet: { ...wallet, available_cents: overrides.available ?? 0, pending_cents: overrides.pending ?? 0 },
      availableWalletCents: overrides.available ?? 0,
      pendingWalletCents: overrides.pending ?? 0,
      getWalletBalance: overrides.getWalletBalance,
      findTransferByIdempotency: moov.findTransferByIdempotency,
      selection: overrides.selection,
      allowSandboxFallback: overrides.allowSandboxFallback,
      ...overrides.deps,
    },
  });
  return { result, store, moov };
}

test('contract remains proposed / staging', () => {
  assert.equal(TENANT_COLLECTION_CONTRACT_V2.status, 'PROPOSED / STAGING');
  assert.equal(TENANT_COLLECTION_CONTRACT_V2.production_accepted, false);
});

test('1 due $100 / wallet $150 → wallet $100 / bank $0', async () => {
  const { result, moov } = await collect({ available: 15000, script: { wallet: 'success' } });
  assert.equal(result.split.walletAmountCents, 10000);
  assert.equal(result.split.bankAmountCents, 0);
  assert.equal(moov.posts.length, 1);
  assert.equal(moov.posts[0].amount, 10000);
  assert.match(moov.posts[0].idempotencyKey, /-wallet$/);
});

test('2 due $100 / wallet $100 → wallet $100 / bank $0', async () => {
  const split = splitCollectionAmounts({ amountDueCents: 10000, availableWalletCents: 10000 });
  assert.deepEqual(split, {
    amountDueCents: 10000,
    availableWalletCents: 10000,
    pendingWalletCents: 0,
    pendingExcludedCents: 0,
    walletAmountCents: 10000,
    bankAmountCents: 0,
  });
});

test('3 due $100 / wallet $75 → wallet $75 / bank $25', async () => {
  const { result, moov } = await collect({ available: 7500 });
  assert.equal(result.wallet_applied_cents, 7500);
  assert.equal(result.bank_ach_cents, 2500);
  assert.equal(moov.posts.map((row) => row.amount).join(','), '7500,2500');
});

test('4 due $100 / wallet $0 → wallet $0 / bank $100', async () => {
  const { result, moov } = await collect({ available: 0 });
  assert.equal(result.wallet_applied_cents, 0);
  assert.equal(result.bank_ach_cents, 10000);
  assert.equal(moov.posts.length, 1);
  assert.match(moov.posts[0].idempotencyKey, /-bank$/);
});

test('5 pending wallet funds excluded', async () => {
  const split = splitCollectionAmounts({
    amountDueCents: 10000, availableWalletCents: 0, pendingWalletCents: 4000,
  });
  assert.equal(split.walletAmountCents, 0);
  assert.equal(split.bankAmountCents, 10000);
  const { result } = await collect({ available: 0, pending: 4000 });
  assert.equal(result.wallet_applied_cents, 0);
  assert.equal(result.bank_ach_cents, 10000);
});

test('6 wallet leg succeeds', async () => {
  const { result } = await collect({ available: 10000 });
  assert.equal(result.ok, true);
  assert.equal(result.legs[0].leg_type, LEG_TYPE.WALLET);
  assert.ok(result.legs[0].provider_transfer_id);
});

test('7 wallet leg fails before provider creation', async () => {
  const { result, moov } = await collect({
    available: 4000,
    script: { wallet: 'fail-before-create', bank: 'success' },
  });
  assert.equal(result.wallet_applied_cents, 0);
  assert.equal(result.bank_ach_cents, 10000);
  assert.equal(moov.posts.filter((row) => row.idempotencyKey.endsWith('-bank'))[0].amount, 10000);
});

test('8 wallet POST timeout but provider DID create transfer', async () => {
  const { result, moov } = await collect({
    available: 4000,
    script: { wallet: 'timeout-created', bank: 'success' },
  });
  assert.ok(result.legs.some((leg) => leg.leg_type === 'wallet' && leg.provider_transfer_id));
  assert.equal(moov.posts.find((row) => row.idempotencyKey.endsWith('-bank')).amount, 6000);
});

test('9 wallet POST timeout and provider did NOT create transfer', async () => {
  const { result, moov } = await collect({
    available: 4000,
    script: { wallet: 'timeout-missing', bank: 'success' },
  });
  assert.equal(result.error !== 'RECONCILIATION_REQUIRED', true);
  assert.equal(moov.posts.find((row) => row.idempotencyKey.endsWith('-bank')).amount, 10000);
});

test('10 wallet success + bank success', async () => {
  const { result } = await collect({ available: 4000 });
  assert.equal(result.ok, true);
  assert.equal(result.legs.length, 2);
});

test('11 wallet success + bank failure', async () => {
  const { result } = await collect({
    occurrence: { amount_cents: 13900 },
    available: 4000,
    script: { wallet: 'success', bank: 'fail' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.wallet_applied_cents, 4000);
  assert.equal(result.collection_status, COLLECTION_STATUS.PARTIALLY_PAID_BANK_FAILED);
  assert.equal(result.amount_received_cents, 0);
  assert.equal(result.outstanding_cents, 13900);
});

test('11b settled wallet + failed bank is partially paid / bank failed', () => {
  const status = classifyCollectionStatus({
    amountDueCents: 13900,
    legs: [
      { leg_type: 'wallet', amount_cents: 4000, status: 'settled', provider_status: 'completed' },
      { leg_type: 'ach_debit', amount_cents: 9900, status: 'failed', provider_status: 'failed' },
    ],
  });
  assert.equal(status, COLLECTION_STATUS.PARTIALLY_PAID_BANK_FAILED);
  assert.equal(receivedCentsFromLegs([
    { status: 'completed', amount_cents: 4000 },
    { status: 'failed', amount_cents: 9900 },
  ]), 4000);
});

test('12 wallet success + bank timeout/provider created', async () => {
  const { result } = await collect({
    available: 4000,
    script: { wallet: 'success', bank: 'timeout-created' },
  });
  assert.ok(result.legs.some((leg) => leg.leg_type === 'ach_debit' && leg.provider_transfer_id));
  assert.notEqual(result.collection_status, COLLECTION_STATUS.RECONCILIATION_REQUIRED);
});

test('13 duplicate UI/request does not create duplicate legs', async () => {
  const store = createMemoryCollectionStore();
  const moov = provider();
  const first = await collect({ available: 4000, store, moov });
  const second = await collect({ available: 4000, store, moov });
  assert.equal(first.result.legs.length, 2);
  assert.equal(second.result.legs.length, 2);
  assert.equal(moov.posts.length, 2);
});

test('14 retry after partial success charges only unpaid remainder', async () => {
  const store = createMemoryCollectionStore();
  await collect({
    occurrence: { amount_cents: 13900 },
    available: 4000,
    store,
    script: { wallet: 'success', bank: 'fail' },
  });
  const retry = await collect({
    occurrence: { amount_cents: 13900 },
    available: 4000,
    store,
    script: { wallet: 'success', bank: 'success' },
  });
  const bankPosts = retry.moov.posts.filter((row) => row.idempotencyKey.endsWith('-bank'));
  assert.ok(bankPosts.every((row) => row.amount === 9900));
  assert.equal(retry.result.wallet_applied_cents, 4000);
});

test('15 local persistence fails after provider wallet creation', async () => {
  const store = createMemoryCollectionStore();
  store.failPersist = (row) => row.leg_type === 'wallet' && !store._walletOnce;
  const first = await collect({ available: 4000, store });
  assert.equal(first.result.legs.some((leg) => leg.persist_failed || leg.provider_transfer_id), true);
  store.failPersist = null;
  const retry = await collect({ available: 4000, store, moov: first.moov });
  assert.equal(retry.moov.posts.filter((row) => row.idempotencyKey.endsWith('-wallet')).length, 1);
});

test('16 local persistence fails after provider bank creation', async () => {
  const store = createMemoryCollectionStore();
  let bankPersistAttempts = 0;
  store.failPersist = (row) => {
    if (row.leg_type === 'ach_debit') {
      bankPersistAttempts += 1;
      return bankPersistAttempts === 1;
    }
    return false;
  };
  const first = await collect({ available: 0, store });
  assert.equal(first.result.legs[0].provider_transfer_id.startsWith('prov-'), true);
  const retry = await collect({ available: 0, store, moov: first.moov });
  assert.equal(retry.moov.posts.filter((row) => row.idempotencyKey.endsWith('-bank')).length, 1);
});

test('17 wallet balance changes after GET uses the GET snapshot and never overdrafts', async () => {
  let reads = 0;
  const { result } = await collect({
    available: 4000,
    getWalletBalance: async () => {
      reads += 1;
      return { walletId: TENANT_WALLET, available_cents: 2500, pending_cents: 9000 };
    },
  });
  assert.equal(reads, 1);
  assert.equal(result.wallet_applied_cents, 2500);
  assert.equal(result.bank_ach_cents, 7500);
});

test('18 cross-tenant wallet attempt is denied', async () => {
  const { result } = await collect({
    available: 4000,
    deps: { wallet: { ...wallet, tenant_id: OTHER, available_cents: 4000 } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cross_tenant_wallet');
});

test('19 cross-tenant bank attempt is denied', async () => {
  const { result } = await collect({
    available: 0,
    readiness: {
      ...readiness,
      authorization: { ...readiness.authorization, tenant_id: OTHER },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cross_tenant_bank');
});

test('20 first-wallet fallback attempt is denied', async () => {
  const { result } = await collect({ available: 4000, selection: 'first_wallet' });
  assert.equal(result.ok, false);
  assert.match(result.error, /wallet_fallback/);
});

test('21 first-bank fallback attempt is denied', async () => {
  const { result } = await collect({ available: 0, selection: 'first_bank' });
  assert.equal(result.ok, false);
  assert.match(result.error, /bank_fallback/);
});

test('22 source/destination reversal is denied', async () => {
  const { result } = await collect({
    available: 0,
    resolveBillingDebitSource: async () => ({
      ok: true,
      sourceMethodId: CHECKSOPS_PLATFORM_WALLET_PM_ID,
      sourceAccountId: CHECKSOPS_PLATFORM_ACCOUNT_ID,
    }),
  });
  assert.equal(result.ok, false);
  assert.ok(['platform_chase_used_as_source', 'source_destination_reversal'].includes(result.error));
});

test('23 sandbox resource in production-mode fixture is denied', async () => {
  const { result } = await collect({
    available: 4000,
    deps: {
      wallet: {
        ...wallet,
        provider_account_id: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID,
        available_cents: 4000,
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'sandbox_resource_in_production');
});

test('24 bank charged full amount after partial wallet success MUST FAIL CONTRACT', () => {
  const evaluated = evaluateCollectionOperation({
    tenant_id: TENANT,
    environment: 'production',
    amount_due_cents: 13900,
    available_wallet_cents: 4000,
    source: { accountId: TENANT_ACCOUNT, paymentMethodId: WALLET_PM },
    destination,
    legs: [
      { leg_type: 'wallet', amount_cents: 4000, provider_transfer_id: 'w1', obligation_id: OBLIGATION },
      { leg_type: 'ach_debit', amount_cents: 13900, provider_transfer_id: 'b1', obligation_id: OBLIGATION },
    ],
  });
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.some((row) => /bank charged full amount/.test(row)));
});

test('25 duplicate wallet leg MUST FAIL CONTRACT', () => {
  const evaluated = evaluateCollectionOperation({
    tenant_id: TENANT,
    environment: 'staging',
    amount_due_cents: 10000,
    source: { accountId: TENANT_ACCOUNT },
    destination,
    legs: [
      { leg_type: 'wallet', amount_cents: 4000, obligation_id: OBLIGATION },
      { leg_type: 'wallet', amount_cents: 4000, obligation_id: OBLIGATION },
    ],
  });
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.some((row) => row === 'duplicate wallet leg'));
});

test('26 duplicate bank leg MUST FAIL CONTRACT', () => {
  const evaluated = evaluateCollectionOperation({
    tenant_id: TENANT,
    environment: 'staging',
    amount_due_cents: 10000,
    source: { accountId: TENANT_ACCOUNT },
    destination,
    legs: [
      { leg_type: 'ach_debit', amount_cents: 10000, obligation_id: OBLIGATION },
      { leg_type: 'ach_debit', amount_cents: 10000, obligation_id: OBLIGATION },
    ],
  });
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.some((row) => row === 'duplicate bank leg'));
});

test('27 amount mismatch is flagged', () => {
  const evaluated = evaluateCollectionOperation({
    tenant_id: TENANT,
    environment: 'staging',
    amount_due_cents: 10000,
    source: { accountId: TENANT_ACCOUNT },
    destination,
    amount_mismatch: true,
    legs: [{ leg_type: 'wallet', amount_cents: 4000, obligation_id: OBLIGATION }],
  });
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.includes('amount mismatch'));
});

test('28 provider/local status mismatch is flagged', () => {
  const evaluated = evaluateCollectionOperation({
    tenant_id: TENANT,
    environment: 'staging',
    amount_due_cents: 10000,
    source: { accountId: TENANT_ACCOUNT },
    destination,
    provider_local_status_mismatch: true,
    legs: [{ leg_type: 'wallet', amount_cents: 10000, obligation_id: OBLIGATION }],
  });
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.includes('provider/local status mismatch'));
});

test('29 pending/originated counted as received MUST FAIL CONTRACT', () => {
  assert.equal(receivedCentsFor(PAYMENT_STATUS.SUBMITTED, 13900), 0);
  assert.equal(receivedCentsFromLegs([
    { status: 'pending', provider_status: 'originated', amount_cents: 4000 },
    { status: 'submitted', amount_cents: 9900 },
  ]), 0);
  const evaluated = evaluateCollectionOperation({
    tenant_id: TENANT,
    environment: 'staging',
    amount_due_cents: 13900,
    source: { accountId: TENANT_ACCOUNT },
    destination,
    count_pending_as_received: true,
    legs: [
      { leg_type: 'wallet', amount_cents: 4000, status: 'pending', obligation_id: OBLIGATION },
      { leg_type: 'ach_debit', amount_cents: 9900, status: 'originated', obligation_id: OBLIGATION },
    ],
  });
  assert.equal(evaluated.ok, false);
  assert.ok(evaluated.errors.some((row) => /pending\/originated counted as received/.test(row)));
});

test('30 both legs map to one billing obligation', async () => {
  const { result } = await collect({ available: 4000 });
  assert.equal(new Set(result.legs.map((leg) => leg.obligation_id)).size, 1);
  assert.equal(result.obligation_id, OBLIGATION);
  const evaluated = evaluateCollectionOperation({
    tenant_id: TENANT,
    environment: 'production',
    amount_due_cents: 10000,
    available_wallet_cents: 4000,
    source: { accountId: TENANT_ACCOUNT, paymentMethodId: WALLET_PM },
    destination,
    legs: result.legs,
    wallet_posted: true,
    bank_posted: true,
    wallet_reconciled_before_bank: true,
  });
  assert.deepEqual(evaluated.errors, []);
});

test('31 receivables totals do not double count', () => {
  const rows = assembleReceivables({
    payments: [{
      id: OBLIGATION,
      tenant_id: TENANT,
      amount_cents: 13900,
      period_start: '2026-10-01',
      status: 'submitted',
      notes: 'Monthly consolidated invoice 2026-10',
      idempotence_key: `billing:${TENANT}:${PERIOD}`,
      collection_legs: [
        { leg_type: 'wallet', amount_cents: 4000, status: 'completed', obligation_id: OBLIGATION },
        { leg_type: 'ach_debit', amount_cents: 9900, status: 'pending', obligation_id: OBLIGATION },
      ],
    }],
    tenants: new Map([[TENANT, { name: 'Freedom Adjustment' }]]),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount_billed_cents, 13900);
  assert.equal(rows[0].wallet_applied_cents, 4000);
  assert.equal(rows[0].bank_ach_cents, 9900);
  assert.equal(rows[0].amount_received_cents, 4000);
  const totals = summarizeReceivables(rows);
  assert.equal(totals.amount_billed_cents, 13900);
  assert.equal(totals.amount_collected_cents, 4000);
  assert.equal(totals.row_count, 1);
});

test('32 tenant isolation', async () => {
  const { result } = await collect({
    available: 4000,
    deps: { wallet: { ...wallet, tenant_id: OTHER } },
  });
  assert.equal(result.ok, false);
  const rows = assembleReceivables({
    payments: [{
      id: OBLIGATION,
      tenant_id: TENANT,
      amount_cents: 10000,
      period_start: '2026-10-01',
      status: 'due',
      notes: 'Monthly consolidated invoice 2026-10',
      idempotence_key: `billing:${TENANT}:${PERIOD}`,
    }],
    tenants: new Map([[TENANT, { name: 'Freedom Adjustment' }], [OTHER, { name: 'Other' }]]),
  });
  assert.ok(rows.every((row) => row.tenant_id === TENANT));
});

test('wallet-first timeout unknown fail-closed does not charge bank', async () => {
  const { result, moov } = await collect({
    available: 4000,
    script: { wallet: 'timeout-unknown' },
  });
  assert.equal(result.collection_status, COLLECTION_STATUS.RECONCILIATION_REQUIRED);
  assert.equal(moov.posts.some((row) => row.idempotencyKey.endsWith('-bank')), false);
});

test('idempotency keys are obligation + leg', () => {
  assert.equal(walletLegIdempotencyKey({ tenantId: TENANT, billingPeriod: PERIOD }), `billing-${PERIOD}-${TENANT}-wallet`);
  assert.equal(bankLegIdempotencyKey({ tenantId: TENANT, billingPeriod: PERIOD }), `billing-${PERIOD}-${TENANT}-bank`);
});

test('remaining unpaid ignores failed uncreated legs', () => {
  assert.equal(remainingUnpaidCents({
    amountDueCents: 13900,
    legs: [
      { amount_cents: 4000, provider_transfer_id: 'w1', status: 'submitted' },
      { amount_cents: 9900, outcome: 'not_created', status: 'failed' },
    ],
  }), 9900);
});

test('applied cents ignore failed bank', () => {
  assert.equal(appliedCents([
    { leg_type: 'wallet', amount_cents: 4000, status: 'submitted' },
    { leg_type: 'ach_debit', amount_cents: 9900, status: 'failed' },
  ], 'ach_debit'), 0);
});
