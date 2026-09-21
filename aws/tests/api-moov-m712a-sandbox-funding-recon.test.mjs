import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  createMemoryPayoutStore,
  fundingIdempotencyKey,
  payoutIdempotencyKey,
} from '../functions/api/providers/production/moov-payout-orchestrator.mjs';
import { PIPELINE_TEST_SANDBOX } from '../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import {
  M712_FUNDING_INTENT_ID,
  M712_FUNDING_TRANSFER_ID,
  M712_OPERATION_ID,
  M712_PAYOUT_INTENT_ID,
  evaluateSandboxFundingResumeGate,
  executeSandboxPayoutE2e,
  m712PayoutOperationId,
} from '../functions/api/providers/production/moov-sandbox-payout-e2e.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const PIPELINE = PIPELINE_TEST_SANDBOX.tenantId;
const OPERATION = m712PayoutOperationId();
const FUND_TRANSFER = M712_FUNDING_TRANSFER_ID;

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
  persistMoneyIntents: false,
  labels,
  operationId: OPERATION,
  transferPostEnabled: false,
  haltAfterFundingAttempt: true,
};

const seedOperation = async ({ fundingStatus, providerStatus = fundingStatus, transferId = FUND_TRANSFER }) => {
  const store = createMemoryPayoutStore();
  const fundingKey = fundingIdempotencyKey(OPERATION, 1, 'sandbox');
  const payoutKey = payoutIdempotencyKey(OPERATION, 1, 'sandbox');
  await store.putIntent({
    id: M712_FUNDING_INTENT_ID,
    kind: 'wallet_funding',
    leg_role: 'wallet_funding',
    environment: 'sandbox',
    payout_operation_id: OPERATION,
    idempotency_key: fundingKey,
    status: fundingStatus,
    provider_status: providerStatus,
    provider_transfer_id: transferId,
    amount_cents: 1,
  });
  await store.putIntent({
    id: M712_PAYOUT_INTENT_ID,
    kind: 'wallet_disbursement',
    leg_role: 'wallet_disbursement',
    environment: 'sandbox',
    payout_operation_id: OPERATION,
    idempotency_key: payoutKey,
    status: 'planned',
    provider_transfer_id: null,
    amount_cents: 1,
  });
  return {
    store,
    existingRows: [
      await store.getIntent(fundingKey),
      await store.getIntent(payoutKey),
    ],
  };
};

test('M7.12A frozen IDs match the accepted live operation', () => {
  assert.equal(OPERATION, M712_OPERATION_ID);
  assert.equal(M712_FUNDING_INTENT_ID, '985f487b-74f2-4d9f-8e6f-7cad9ae10c97');
  assert.equal(M712_PAYOUT_INTENT_ID, 'df6e3d55-ccc9-43cd-b275-8cde8e24c343');
  assert.equal(M712_FUNDING_TRANSFER_ID, 'e42635e8-7a75-4d25-ad2f-dd0e5696372d');
});

test('resume gate: pending funding stays pending and is not payout_ready', () => {
  const gate = evaluateSandboxFundingResumeGate({
    fundingIntentStatus: 'pending',
    providerStatus: 'pending',
    liveAvailableCents: 0,
  });
  assert.equal(gate.reason, 'funding_pending');
  assert.equal(gate.funding_state, 'funding_pending');
  assert.equal(gate.payout_ready, false);
  assert.equal(gate.release_conditions_satisfied, false);
  assert.equal(gate.safe_to_resume_payout, false);
});

test('resume gate: completed funding with live wallet 0 waits for wallet', () => {
  const gate = evaluateSandboxFundingResumeGate({
    fundingIntentStatus: 'completed',
    providerStatus: 'completed',
    liveAvailableCents: 0,
  });
  assert.equal(gate.reason, 'funding_completed_waiting_for_wallet');
  assert.equal(gate.funding_state, 'funding_completed');
  assert.equal(gate.payout_state, 'payout_requested');
  assert.equal(gate.payout_ready, false);
  assert.equal(gate.safe_to_resume_payout, false);
});

test('resume gate: completed funding plus live wallet >= 1 is payout_ready without posting', () => {
  const gate = evaluateSandboxFundingResumeGate({
    fundingIntentStatus: 'completed',
    providerStatus: 'completed',
    liveAvailableCents: 1,
  });
  assert.equal(gate.reason, 'payout_ready');
  assert.equal(gate.funding_state, 'funding_completed');
  assert.equal(gate.payout_state, 'payout_ready');
  assert.equal(gate.payout_ready, true);
  assert.equal(gate.release_conditions_satisfied, true);
  assert.equal(gate.safe_to_resume_payout, true);
});

test('resume gate: failed or unknown funding keeps payout blocked', () => {
  const failed = evaluateSandboxFundingResumeGate({
    fundingIntentStatus: 'failed',
    providerStatus: 'failed',
    liveAvailableCents: 1,
  });
  const unknown = evaluateSandboxFundingResumeGate({
    fundingIntentStatus: 'unknown',
    providerStatus: 'unknown',
    liveAvailableCents: 1,
  });
  assert.equal(failed.reason, 'payout_blocked');
  assert.equal(failed.payout_ready, false);
  assert.equal(unknown.reason, 'payout_blocked');
  assert.equal(unknown.funding_state, 'funding_unknown');
});

test('GET-only pending recon leaves the same operation funding_pending and posts nothing', async () => {
  const seeded = await seedOperation({ fundingStatus: 'pending' });
  const result = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 0,
    store: seeded.store,
    existingRows: seeded.existingRows,
    executeFunding: async () => { throw new Error('second_fund_forbidden'); },
    executePayout: async () => { throw new Error('payout_post_forbidden'); },
    getTransfer: async () => ({
      transferID: FUND_TRANSFER,
      status: 'pending',
    }),
  });
  assert.equal(result.payout_operation_id, OPERATION);
  assert.equal(result.funding_state, 'funding_pending');
  assert.equal(result.payout_state, 'payout_requested');
  assert.equal(result.funding_provider_posts, 0);
  assert.equal(result.payout_provider_posts, 0);
  assert.equal(result.persist_money_intents, false);
  assert.equal(seeded.store.inserts.length, 2);
});

test('GET-only completed funding plus live wallet advances the same operation to payout_ready without POST', async () => {
  const seeded = await seedOperation({ fundingStatus: 'pending' });
  const result = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 0,
    store: seeded.store,
    existingRows: seeded.existingRows,
    executeFunding: async () => { throw new Error('second_fund_forbidden'); },
    executePayout: async () => { throw new Error('payout_post_forbidden'); },
    getTransfer: async () => ({
      transferID: FUND_TRANSFER,
      status: 'completed',
      completedOn: '2026-09-21T14:10:00Z',
    }),
    refreshLiveWallet: async () => 1,
  });
  assert.equal(result.payout_operation_id, OPERATION);
  assert.equal(result.decision, 'PAYOUT_READY');
  assert.equal(result.payout_state, 'payout_ready');
  assert.ok(result.funding_state === 'funding_completed' || result.funding_state == null);
  assert.equal(result.payout_release_gate, true);
  assert.equal(result.funding_provider_posts, 0);
  assert.equal(result.payout_provider_posts, 0);
  const funding = await seeded.store.getIntent(fundingIdempotencyKey(OPERATION, 1, 'sandbox'));
  assert.equal(funding.status, 'completed');
  assert.equal(seeded.store.inserts.filter((k) => k === 'wallet_funding').length, 1);
  assert.equal(seeded.store.inserts.filter((k) => k === 'wallet_disbursement').length, 1);
});

test('completed provider with live wallet 0 does not release payout', async () => {
  const seeded = await seedOperation({ fundingStatus: 'pending' });
  const result = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 0,
    store: seeded.store,
    existingRows: seeded.existingRows,
    executeFunding: async () => { throw new Error('second_fund_forbidden'); },
    executePayout: async () => { throw new Error('payout_post_forbidden'); },
    getTransfer: async () => ({
      transferID: FUND_TRANSFER,
      status: 'completed',
      completedOn: '2026-09-21T14:10:00Z',
    }),
    refreshLiveWallet: async () => 0,
  });
  const gate = evaluateSandboxFundingResumeGate({
    fundingIntentStatus: result.funding_intent?.status,
    providerStatus: 'completed',
    liveAvailableCents: result.available_cents,
  });
  assert.equal(result.funding_state, 'funding_completed');
  assert.equal(result.payout_state, 'payout_requested');
  assert.equal(result.payout_provider_posts, 0);
  assert.equal(result.funding_provider_posts, 0);
  assert.equal(gate.reason, 'funding_completed_waiting_for_wallet');
  assert.equal(gate.payout_ready, false);
});

test('failed provider GET keeps payout blocked on the same operation', async () => {
  const seeded = await seedOperation({ fundingStatus: 'pending' });
  const result = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 0,
    store: seeded.store,
    existingRows: seeded.existingRows,
    executeFunding: async () => { throw new Error('second_fund_forbidden'); },
    executePayout: async () => { throw new Error('payout_post_forbidden'); },
    getTransfer: async () => ({
      transferID: FUND_TRANSFER,
      status: 'failed',
    }),
  });
  const gate = evaluateSandboxFundingResumeGate({
    fundingIntentStatus: result.funding_intent?.status,
    providerStatus: 'failed',
    liveAvailableCents: 0,
  });
  assert.equal(result.payout_operation_id, OPERATION);
  assert.equal(result.funding_state, 'funding_failed');
  assert.equal(result.payout_state, 'payout_requested');
  assert.equal(result.payout_provider_posts, 0);
  assert.equal(gate.reason, 'payout_blocked');
});

test('M7.12A runner is GET-only for the existing funding transfer and never posts or arms flags', () => {
  const src = sourceOf('../providers/oneshot/m712a-run.mjs');
  const oneshot = sourceOf('../providers/oneshot/m79-sandbox-tenant/index.mjs');
  assert.match(src, /M7\.12A/);
  assert.match(src, new RegExp(M712_OPERATION_ID));
  assert.match(src, new RegExp(M712_FUNDING_INTENT_ID));
  assert.match(src, new RegExp(M712_PAYOUT_INTENT_ID));
  assert.match(src, new RegExp(M712_FUNDING_TRANSFER_ID));
  assert.match(src, /assertGetOnly/);
  assert.match(src, /refused_transfer_post/);
  assert.match(src, /refused_sandbox_post_armed/);
  assert.match(src, /refused_production_post_armed/);
  assert.match(src, /reconcile_funding_parity/);
  assert.match(src, /evaluateSandboxFundingResumeGate/);
  assert.match(src, /persistMoneyIntents: false/);
  assert.match(src, /transferPostEnabled: false/);
  assert.match(src, /funding_completed_waiting_for_wallet/);
  assert.match(src, /STOP FOR REVIEW/);
  assert.match(src, /Do not POST the payout even if PAYOUT_READY=true/);
  assert.match(src, /Do not arm either POST flag/);
  assert.match(src, /second_fund_forbidden/);
  assert.match(src, /payout_post_forbidden/);
  assert.match(src, /new_intent_refused/);
  assert.doesNotMatch(src, /setSandboxPostFlag/);
  assert.doesNotMatch(src, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /persist_orchestrator_intent/);
  assert.doesNotMatch(src, /persist_funding_intent/);
  assert.doesNotMatch(src, /persist_payout_intent/);
  assert.doesNotMatch(src, /overlayApi/);
  assert.doesNotMatch(src, /apply_sql78/);
  assert.doesNotMatch(src, /method:\s*['"]POST['"]\s*,[\s\S]{0,80}\/transfers/);
  assert.doesNotMatch(src, /update-function-code[\s\S]{0,120}API_FN/);
  assert.match(oneshot, /skipped: 'pending'/);
  assert.match(oneshot, /intent_leg_mismatch/);
  assert.match(oneshot, /payout_intent_refused/);
  assert.match(oneshot, /mode: 'update_existing_only'/);
  assert.doesNotMatch(oneshot, /\/transfers/);
  assert.doesNotMatch(oneshot, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED/);
  assert.doesNotMatch(oneshot, /AWS_MOOV_TRANSFER_POST_ENABLED/);
});
