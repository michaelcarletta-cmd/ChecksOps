import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PIPELINE_TEST_SANDBOX } from '../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import {
  M712_FUNDING_PROVIDER_UUID,
  SANDBOX_FUNDING_PROVIDER_UUID,
  allowedSandboxFundingProviderUuids,
} from '../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import {
  M712_PAYOUT_PROVIDER_UUID,
  SANDBOX_PAYOUT_PROVIDER_UUID,
  allowedSandboxPayoutProviderUuids,
} from '../functions/api/providers/production/moov-sandbox-wallet-disburse.mjs';
import {
  createMemoryPayoutStore,
  payoutOperationIdFor,
} from '../functions/api/providers/production/moov-payout-orchestrator.mjs';
import {
  executeSandboxPayoutE2e,
  m712PayoutOperationId,
} from '../functions/api/providers/production/moov-sandbox-payout-e2e.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const PIPELINE = PIPELINE_TEST_SANDBOX.tenantId;
const FUND_TRANSFER = 'cccccccc-dddd-4eee-8fff-000000000001';
const OPERATION = m712PayoutOperationId();

const labels = {
  fund: { sourceLabel: 'Sandbox bank', destinationLabel: 'Sandbox wallet' },
  disburse: {
    sourceLabel: 'Sandbox wallet',
    destinationLabel: 'Sandbox recipient bank',
    recipientLabel: 'Pipeline Test Payee',
    recipientId: PIPELINE_TEST_SANDBOX.recipientAccountId,
  },
};

const base = {
  tenantId: PIPELINE,
  tenantEnvironment: 'sandbox',
  payoutCents: 1,
  recipientVerified: true,
  credentials: { environment: 'sandbox', publicKey: 's', secretKey: 's' },
  persistMoneyIntents: true,
  labels,
  operationId: OPERATION,
};

const posted = ({ id, status }) => ({
  ok: true,
  outcome: 'posted',
  liveProviderCalled: true,
  liveProviderPosted: true,
  provider_transfer_id: id,
  provider_status: status,
  doNotRetry: true,
});

test('M7.12 operation id is distinct from the M7.7 first-payout id', () => {
  const m77 = payoutOperationIdFor({
    tenantId: PIPELINE,
    environment: 'sandbox',
    recipientId: PIPELINE_TEST_SANDBOX.recipientAccountId,
    payoutCents: 1,
  });
  assert.notEqual(OPERATION, m77);
  assert.match(OPERATION, /^[0-9a-f-]{36}$/i);
});

test('M7.12 provider UUIDs are replay-safe and not the M7.9G/M7.10 keys', () => {
  assert.notEqual(M712_FUNDING_PROVIDER_UUID, SANDBOX_FUNDING_PROVIDER_UUID);
  assert.notEqual(M712_PAYOUT_PROVIDER_UUID, SANDBOX_PAYOUT_PROVIDER_UUID);
  assert.equal(allowedSandboxFundingProviderUuids().includes(M712_FUNDING_PROVIDER_UUID), true);
  assert.equal(allowedSandboxPayoutProviderUuids().includes(M712_PAYOUT_PROVIDER_UUID), true);
});

test('dark M7.12 run persists one operation and posts nothing', async () => {
  const store = createMemoryPayoutStore();
  const first = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 0,
    store,
    transferPostEnabled: false,
    haltAfterFundingAttempt: true,
  });
  const second = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 0,
    store,
    transferPostEnabled: false,
    haltAfterFundingAttempt: true,
  });
  assert.equal(first.ok, true);
  assert.equal(first.decision, 'FUND_FIRST');
  assert.equal(first.sandbox_provider_posts, 0);
  assert.equal(first.production_provider_posts, 0);
  assert.equal(second.payout_operation_id, first.payout_operation_id);
  assert.equal(second.funding_intent.reused, true);
  assert.equal(second.payout_intent.reused, true);
  assert.equal(store.inserts.filter((k) => k === 'wallet_funding').length, 1);
  assert.equal(store.inserts.filter((k) => k === 'wallet_disbursement').length, 1);
});

test('armed funding halt does not POST payout even if GET completes and wallet refreshes', async () => {
  const store = createMemoryPayoutStore();
  let walletTicks = 0;
  const result = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 0,
    store,
    transferPostEnabled: true,
    haltAfterFundingAttempt: true,
    executeFunding: async () => posted({ id: FUND_TRANSFER, status: 'pending' }),
    refreshLiveWallet: async () => {
      walletTicks += 1;
      return walletTicks > 1 ? 1 : 0;
    },
    getTransfer: async () => ({
      transferID: FUND_TRANSFER,
      status: 'completed',
      completedOn: '2026-09-21T13:30:00Z',
    }),
    executePayout: async () => { throw new Error('payout_post_forbidden'); },
  });
  assert.equal(result.funding_provider_posts, 1);
  assert.equal(result.payout_provider_posts, 0);
  assert.equal(result.halted_after_funding, true);
});

test('resume contract: completed funding plus live wallet advances the same operation to payout_ready', async () => {
  const store = createMemoryPayoutStore();
  const first = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 0,
    store,
    transferPostEnabled: true,
    haltAfterFundingAttempt: true,
    executeFunding: async () => posted({ id: FUND_TRANSFER, status: 'pending' }),
    executePayout: async () => { throw new Error('payout_post_forbidden'); },
  });
  await store.updateIntent(first.funding_intent.idempotency_key, {
    status: 'completed',
    provider_transfer_id: FUND_TRANSFER,
    provider_status: 'completed',
  });
  const resumed = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 1,
    store,
    existingRows: [await store.getIntent(first.funding_intent.idempotency_key)],
    transferPostEnabled: false,
    haltAfterFundingAttempt: true,
    executeFunding: async () => { throw new Error('second_fund_forbidden'); },
    executePayout: async () => { throw new Error('payout_post_forbidden'); },
  });
  assert.equal(resumed.payout_operation_id, first.payout_operation_id);
  assert.equal(resumed.decision, 'PAYOUT_READY');
  assert.equal(resumed.payout_release_gate, true);
  assert.equal(resumed.funding_provider_posts, 0);
  assert.equal(resumed.payout_provider_posts, 0);
  assert.equal(store.inserts.filter((k) => k === 'wallet_funding').length, 1);
  assert.equal(store.inserts.filter((k) => k === 'wallet_disbursement').length, 1);
});

test('M7.12 runner never arms production, overlays API, or POSTs payout after funding in the same run', () => {
  const src = sourceOf('../providers/oneshot/m712-run.mjs');
  assert.match(src, /M7\.12/);
  assert.match(src, /executeSandboxPayoutE2e/);
  assert.match(src, /haltAfterFundingAttempt: true/);
  assert.match(src, /m712PayoutOperationId/);
  assert.match(src, /setSandboxPostFlag\('false'\)/);
  assert.match(src, /refused_production_post_armed/);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /update-function-code[\s\S]{0,120}API_FN/);
  assert.doesNotMatch(src, /overlayApi/);
  const oneshot = sourceOf('../providers/oneshot/m79-sandbox-tenant/index.mjs');
  assert.match(oneshot, /persistOrchestratorIntent/);
  assert.match(oneshot, /persist_orchestrator_intent/);
  assert.doesNotMatch(oneshot, /\/transfers/);
  const handler = sourceOf('../functions/api/providers/production/moov-payout-orchestrate.mjs');
  assert.match(handler, /money_intent_persist_refused/);
  assert.match(handler, /provider_post_refused/);
});
