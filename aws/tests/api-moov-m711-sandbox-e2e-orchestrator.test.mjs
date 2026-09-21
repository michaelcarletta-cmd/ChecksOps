import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { KNOWN_APPROVED_MOOV } from '../functions/api/providers/production/moov-accounts.mjs';
import { PIPELINE_TEST_SANDBOX } from '../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import {
  canTransitionFunding,
  canTransitionPayout,
  computeShortfallCents,
  createMemoryPayoutStore,
  getReconciliationMayCreateMoneyIntent,
  payoutOperationIdFor,
  SEQUENCE_STATES,
  webhookMayCreateMoneyIntent,
} from '../functions/api/providers/production/moov-payout-orchestrator.mjs';
import {
  executeSandboxPayoutE2e,
  explainMissingSandboxPayoutWebhookReceipt,
  M711_PHASE,
} from '../functions/api/providers/production/moov-sandbox-payout-e2e.mjs';
import { sandboxWebhookApplyEnabled } from '../functions/api/providers/webhook-apply.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const PIPELINE = PIPELINE_TEST_SANDBOX.tenantId;
const FREEDOM = KNOWN_APPROVED_MOOV.freedom.tenantId;
const PAYOUT_TRANSFER = 'c2d1078a-0261-4a3b-9782-777fad834af9';
const FUND_TRANSFER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PAYOUT_XFER = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

const labels = {
  fund: { sourceLabel: 'Sandbox bank', destinationLabel: 'Sandbox wallet' },
  disburse: {
    sourceLabel: 'Sandbox wallet',
    destinationLabel: 'Sandbox recipient bank',
    recipientLabel: 'Pipeline Test Payee',
    recipientId: PIPELINE_TEST_SANDBOX.recipientAccountId,
  },
};

const sandboxCreds = {
  environment: 'sandbox',
  publicKey: 'sandbox-public',
  secretKey: 'sandbox-secret',
};

const base = {
  tenantId: PIPELINE,
  tenantEnvironment: 'sandbox',
  payoutCents: 1,
  recipientVerified: true,
  credentials: sandboxCreds,
  productionPublicKey: 'prod-public',
  productionSecretKey: 'prod-secret',
  persistMoneyIntents: true,
  labels,
};

const posted = ({ id, status, live = true, outcome = 'posted' }) => ({
  ok: true,
  outcome,
  liveProviderCalled: live,
  liveProviderPosted: live && outcome === 'posted',
  provider_transfer_id: id,
  provider_status: status,
  doNotRetry: true,
});

test('state machine includes wallet_check, funding_pending, and payout_pending', () => {
  for (const state of [
    'payout_requested', 'wallet_check',
    'funding_required', 'funding_submitting', 'funding_pending', 'funding_completed',
    'funding_failed', 'funding_returned', 'funding_unknown',
    'payout_ready', 'payout_submitting', 'payout_pending', 'payout_completed',
    'payout_failed', 'payout_unknown',
  ]) {
    assert.equal(SEQUENCE_STATES.includes(state), true, state);
  }
  assert.equal(canTransitionFunding('funding_submitting', 'funding_pending').ok, true);
  assert.equal(canTransitionFunding('funding_pending', 'funding_completed').ok, true);
  assert.equal(canTransitionFunding('funding_failed', 'funding_required').reason, 'terminal_regression');
  assert.equal(canTransitionPayout('payout_pending', 'payout_completed').ok, true);
  assert.equal(canTransitionPayout('payout_completed', 'payout_pending').reason, 'terminal_regression');
});

test('A. wallet sufficient skips funding and reaches payout_ready', async () => {
  const store = createMemoryPayoutStore();
  const result = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 1,
    rdsAvailableCents: 99,
    store,
    transferPostEnabled: false,
    productionTransferPostEnabled: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision, 'PAYOUT_READY');
  assert.equal(result.shortfall_cents, 0);
  assert.equal(result.funding_intent, null);
  assert.equal(result.payout_state, 'payout_ready');
  assert.equal(result.wallet_check, true);
  assert.equal(result.live_balance_authority, true);
  assert.equal(result.rds_balance_ignored, true);
  assert.equal(result.available_cents, 1);
  assert.notEqual(result.available_cents, 99);
  assert.equal(result.sandbox_provider_posts, 0);
  assert.equal(result.payout_provider_posts, 0);
  assert.equal(result.production_provider_posts, 0);
});

test('B. empty wallet funds exact shortage and blocks payout until available', async () => {
  const store = createMemoryPayoutStore();
  const first = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 0,
    store,
    transferPostEnabled: true,
    executeFunding: async () => posted({ id: FUND_TRANSFER, status: 'pending' }),
    executePayout: async () => { throw new Error('payout_post_forbidden'); },
  });
  assert.equal(first.decision, 'FUND_FIRST');
  assert.equal(first.exact_shortfall, 1);
  assert.equal(first.funding_provider_posts, 1);
  assert.equal(first.payout_provider_posts, 0);
  assert.ok(first.blocked_reasons.includes('funding_pending') || first.funding_state === 'funding_pending' || first.funding_gate === true);

  const fundingKey = first.funding_intent.idempotency_key;
  await store.updateIntent(fundingKey, {
    status: 'completed',
    provider_transfer_id: FUND_TRANSFER,
    provider_status: 'completed',
  });
  const released = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 1,
    store,
    existingRows: [await store.getIntent(fundingKey)],
    transferPostEnabled: true,
    executeFunding: async () => { throw new Error('second_fund_forbidden'); },
    executePayout: async () => posted({ id: PAYOUT_XFER, status: 'pending' }),
  });
  assert.equal(released.decision, 'PAYOUT_READY');
  assert.equal(released.shortfall_cents, 0);
  assert.equal(released.payout_release_gate, true);
  assert.equal(released.payout_provider_posts, 1);
  assert.equal(released.funding_provider_posts, 0);
  assert.equal(store.inserts.filter((k) => k === 'wallet_funding').length, 1);
});

test('C. partial wallet funds exact difference only', async () => {
  assert.equal(computeShortfallCents(5, 2), 3);
  assert.equal(computeShortfallCents(1, 0), 1);
  assert.equal(computeShortfallCents(1, 1), 0);
  const store = createMemoryPayoutStore();
  const result = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 0,
    payoutCents: 1,
    store,
    transferPostEnabled: false,
  });
  assert.equal(result.shortfall_cents, 1);
  assert.equal(result.funding_intent.amount_cents, 1);
  const plenty = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 1,
    store: createMemoryPayoutStore(),
    transferPostEnabled: false,
  });
  assert.equal(plenty.shortfall_cents, 0);
  assert.equal(plenty.funding_intent, null);
});

test('D. duplicate payout request reuses the same operation and intents', async () => {
  const store = createMemoryPayoutStore();
  const first = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 0,
    store,
    transferPostEnabled: false,
  });
  const second = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 0,
    store,
    transferPostEnabled: false,
  });
  assert.equal(second.payout_operation_id, first.payout_operation_id);
  assert.equal(second.funding_intent.reused, true);
  assert.equal(second.payout_intent.reused, true);
  assert.equal(store.inserts.filter((k) => k === 'wallet_funding').length, 1);
  assert.equal(store.inserts.filter((k) => k === 'wallet_disbursement').length, 1);
});

test('E. funding pending does not POST payout', async () => {
  const store = createMemoryPayoutStore();
  const op = payoutOperationIdFor({
    tenantId: PIPELINE,
    environment: 'sandbox',
    recipientId: PIPELINE_TEST_SANDBOX.recipientAccountId,
    payoutCents: 1,
  });
  const result = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 0,
    store,
    transferPostEnabled: true,
    existingRows: [{
      environment: 'sandbox',
      kind: 'wallet_funding',
      leg_role: 'wallet_funding',
      payout_operation_id: op,
      idempotency_key: `checksops:m77:wallet_funding:env:sandbox:op:${op}:cents:1`,
      amount_cents: 1,
      status: 'pending',
      provider_transfer_id: FUND_TRANSFER,
      origin: 'checksops',
    }],
    executeFunding: async () => { throw new Error('funding_repost_forbidden'); },
    executePayout: async () => { throw new Error('payout_post_forbidden'); },
  });
  assert.equal(result.payout_provider_posts, 0);
  assert.equal(result.funding_provider_posts, 0);
  assert.equal(result.payout_submittable, false);
});

test('F. funding failed does not POST payout', async () => {
  const store = createMemoryPayoutStore();
  const op = payoutOperationIdFor({
    tenantId: PIPELINE,
    environment: 'sandbox',
    recipientId: PIPELINE_TEST_SANDBOX.recipientAccountId,
    payoutCents: 1,
  });
  const result = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 0,
    store,
    transferPostEnabled: true,
    existingRows: [{
      environment: 'sandbox',
      kind: 'wallet_funding',
      leg_role: 'wallet_funding',
      payout_operation_id: op,
      idempotency_key: `checksops:m77:wallet_funding:env:sandbox:op:${op}:cents:1`,
      amount_cents: 1,
      status: 'failed',
      origin: 'checksops',
    }],
    executePayout: async () => { throw new Error('payout_post_forbidden'); },
  });
  assert.ok(result.blocked_reasons.includes('funding_failed'));
  assert.equal(result.payout_provider_posts, 0);
});

test('G. funding returned does not POST payout', async () => {
  const store = createMemoryPayoutStore();
  const op = payoutOperationIdFor({
    tenantId: PIPELINE,
    environment: 'sandbox',
    recipientId: PIPELINE_TEST_SANDBOX.recipientAccountId,
    payoutCents: 1,
  });
  const result = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 0,
    store,
    transferPostEnabled: true,
    existingRows: [{
      environment: 'sandbox',
      kind: 'wallet_funding',
      leg_role: 'wallet_funding',
      payout_operation_id: op,
      idempotency_key: `checksops:m77:wallet_funding:env:sandbox:op:${op}:cents:1`,
      amount_cents: 1,
      status: 'returned',
      origin: 'checksops',
    }],
    executePayout: async () => { throw new Error('payout_post_forbidden'); },
  });
  assert.ok(result.blocked_reasons.includes('funding_failed'));
  assert.equal(result.payout_provider_posts, 0);
});

test('H. funding unknown does not blind-retry or POST payout', async () => {
  const store = createMemoryPayoutStore();
  const op = payoutOperationIdFor({
    tenantId: PIPELINE,
    environment: 'sandbox',
    recipientId: PIPELINE_TEST_SANDBOX.recipientAccountId,
    payoutCents: 1,
  });
  const result = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 0,
    store,
    transferPostEnabled: true,
    existingRows: [{
      environment: 'sandbox',
      kind: 'wallet_funding',
      leg_role: 'wallet_funding',
      payout_operation_id: op,
      idempotency_key: `checksops:m77:wallet_funding:env:sandbox:op:${op}:cents:1`,
      amount_cents: 1,
      status: 'unknown',
      provider_metadata: { post_attempted: true, post_outcome: 'unknown' },
      origin: 'checksops',
    }],
    executeFunding: async () => { throw new Error('unknown_retry_forbidden'); },
    executePayout: async () => { throw new Error('payout_post_forbidden'); },
  });
  assert.equal(result.funding_state, 'funding_unknown');
  assert.equal(result.payout_provider_posts, 0);
  assert.equal(result.funding_provider_posts, 0);
});

test('I. payout pending does not duplicate payout POST', async () => {
  const store = createMemoryPayoutStore();
  const op = payoutOperationIdFor({
    tenantId: PIPELINE,
    environment: 'sandbox',
    recipientId: PIPELINE_TEST_SANDBOX.recipientAccountId,
    payoutCents: 1,
  });
  const result = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 1,
    store,
    transferPostEnabled: true,
    existingRows: [{
      environment: 'sandbox',
      kind: 'wallet_disbursement',
      leg_role: 'wallet_disbursement',
      payout_operation_id: op,
      idempotency_key: `checksops:m77:wallet_disbursement:env:sandbox:op:${op}:cents:1`,
      amount_cents: 1,
      status: 'pending',
      provider_transfer_id: PAYOUT_XFER,
      origin: 'checksops',
    }],
    executePayout: async () => { throw new Error('duplicate_payout_forbidden'); },
  });
  assert.equal(result.payout_state, 'payout_pending');
  assert.equal(result.payout_provider_posts, 0);
});

test('J. payout completion via webhook updates existing intent only', async () => {
  const store = createMemoryPayoutStore();
  const op = payoutOperationIdFor({
    tenantId: PIPELINE,
    environment: 'sandbox',
    recipientId: PIPELINE_TEST_SANDBOX.recipientAccountId,
    payoutCents: 1,
  });
  const intent = {
    environment: 'sandbox',
    kind: 'wallet_disbursement',
    leg_role: 'wallet_disbursement',
    payout_operation_id: op,
    idempotency_key: `checksops:m77:wallet_disbursement:env:sandbox:op:${op}:cents:1`,
    amount_cents: 1,
    status: 'pending',
    provider_transfer_id: PAYOUT_XFER,
    origin: 'checksops',
  };
  await store.putIntent(intent);
  const result = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 1,
    store,
    existingRows: [intent],
    transferPostEnabled: false,
    applyWebhookPayload: {
      type: 'transfer.updated',
      eventID: 'evt-payout-complete',
      data: {
        transferID: PAYOUT_XFER,
        status: 'completed',
        completedOn: '2026-09-21T12:46:00.843705Z',
        destination: { achDetails: { completedOn: '2026-09-21T12:46:00.843705Z' } },
      },
    },
    executePayout: async () => { throw new Error('payout_post_forbidden'); },
  });
  assert.equal(result.payout_state, 'payout_completed');
  assert.equal(result.webhook_recon, true);
  assert.equal(result.payout_provider_posts, 0);
  assert.equal(webhookMayCreateMoneyIntent(), false);
});

test('funding GET fallback completes funding but still blocks payout until live wallet is available', async () => {
  const store = createMemoryPayoutStore();
  const op = payoutOperationIdFor({
    tenantId: PIPELINE,
    environment: 'sandbox',
    recipientId: PIPELINE_TEST_SANDBOX.recipientAccountId,
    payoutCents: 1,
  });
  const result = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 0,
    store,
    transferPostEnabled: true,
    existingRows: [{
      environment: 'sandbox',
      kind: 'wallet_funding',
      leg_role: 'wallet_funding',
      payout_operation_id: op,
      idempotency_key: `checksops:m77:wallet_funding:env:sandbox:op:${op}:cents:1`,
      amount_cents: 1,
      status: 'pending',
      provider_transfer_id: FUND_TRANSFER,
      origin: 'checksops',
    }],
    getTransfer: async (id) => {
      assert.equal(id, FUND_TRANSFER);
      return { transferID: FUND_TRANSFER, status: 'completed', completedOn: '2026-09-21T12:20:00Z' };
    },
    executeFunding: async () => { throw new Error('funding_repost_forbidden'); },
    executePayout: async () => { throw new Error('payout_post_forbidden'); },
  });
  assert.equal(result.funding_state, 'funding_completed');
  assert.equal(result.payout_provider_posts, 0);
  assert.equal(result.funding_provider_posts, 0);
  assert.equal(result.payout_release_gate, false);
  assert.ok(result.blocked_reasons.includes('wallet_available_unconfirmed'));
  assert.equal(result.payout_recon.createdPaymentTransfer, false);
});

test('K. payout completion via GET fallback never creates another transfer', async () => {
  const store = createMemoryPayoutStore();
  const op = payoutOperationIdFor({
    tenantId: PIPELINE,
    environment: 'sandbox',
    recipientId: PIPELINE_TEST_SANDBOX.recipientAccountId,
    payoutCents: 1,
  });
  const intent = {
    environment: 'sandbox',
    kind: 'wallet_disbursement',
    leg_role: 'wallet_disbursement',
    payout_operation_id: op,
    idempotency_key: `checksops:m77:wallet_disbursement:env:sandbox:op:${op}:cents:1`,
    amount_cents: 1,
    status: 'pending',
    provider_transfer_id: PAYOUT_XFER,
    origin: 'checksops',
  };
  await store.putIntent(intent);
  const result = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 1,
    store,
    existingRows: [intent],
    transferPostEnabled: false,
    getTransfer: async (id) => {
      assert.equal(id, PAYOUT_XFER);
      return {
        transferID: PAYOUT_XFER,
        status: 'completed',
        completedOn: '2026-09-21T12:46:00.843705Z',
        destination: { achDetails: { completedOn: '2026-09-21T12:46:00.843705Z' } },
      };
    },
    executePayout: async () => { throw new Error('payout_post_forbidden'); },
  });
  assert.equal(result.payout_state, 'payout_completed');
  assert.equal(result.get_fallback, true);
  assert.equal(result.payout_recon.createdPaymentTransfer, false);
  assert.equal(result.payout_provider_posts, 0);
  assert.equal(getReconciliationMayCreateMoneyIntent(), false);
});

test('L. cross-environment IDs and production tenant/credentials/flags are refused', async () => {
  const freedom = await executeSandboxPayoutE2e({
    ...base,
    tenantId: FREEDOM,
    liveAvailableCents: 1,
  });
  assert.equal(freedom.ok, false);
  assert.equal(freedom.error, 'refused_production_tenant');

  const prodEnv = await executeSandboxPayoutE2e({
    ...base,
    tenantEnvironment: 'production',
    liveAvailableCents: 1,
  });
  assert.equal(prodEnv.ok, false);
  assert.equal(prodEnv.error, 'tenant_not_sandbox');

  const prodFlag = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 1,
    productionTransferPostEnabled: true,
  });
  assert.equal(prodFlag.ok, false);
  assert.equal(prodFlag.error, 'production_post_flag_refused');

  const prodCreds = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: 1,
    credentials: { environment: 'production', publicKey: 'p', secretKey: 's' },
  });
  assert.equal(prodCreds.ok, false);
  assert.equal(prodCreds.error, 'cross_environment_credential_refused');

  const rdsOnly = await executeSandboxPayoutE2e({
    ...base,
    liveAvailableCents: null,
    rdsAvailableCents: 1,
  });
  assert.equal(rdsOnly.ok, false);
  assert.equal(rdsOnly.error, 'live_balance_required');
});

test('M7.10 webhook receipt lookup cannot key off the transfer UUID', () => {
  const explained = explainMissingSandboxPayoutWebhookReceipt({
    transferId: PAYOUT_TRANSFER,
    receiptsByTransferId: [],
    receiptsByEventId: [],
    tenantTransferReceipts: [],
    sandboxApplyEnabled: sandboxWebhookApplyEnabled(),
    productionExecutionEnabled: true,
    dryRun: false,
  });
  assert.equal(explained.getFallbackRequired, true);
  assert.equal(explained.webhookChangeRequired, false);
  assert.equal(explained.lookup.notStored.includes('transferID'), true);
  assert.ok(explained.reasons.includes('receipts_keyed_by_event_uuid_not_transfer_uuid'));
  assert.ok(explained.reasons.includes('sandbox_apply_disabled'));
  const src = sourceOf('../functions/api/providers/webhooks.mjs');
  assert.match(src, /external_event_id/);
  assert.match(src, /payload\?\.eventID/);
  assert.doesNotMatch(src, /INSERT INTO public\.aws_provider_webhook_receipts[\s\S]{0,400}transferID/);
  const apply = sourceOf('../functions/api/providers/webhook-apply.mjs');
  assert.match(apply, /sandboxWebhookApplyEnabled/);
  assert.match(apply, /providerSandboxExecutionEnabled/);
});

test('M7.11 engine never POSTs when sandbox flag is false and never arms production', () => {
  const src = sourceOf('../functions/api/providers/production/moov-sandbox-payout-e2e.mjs');
  assert.match(src, /M7\.11/);
  assert.match(src, /PIPELINE_TEST_TENANT_ID/);
  assert.match(src, /live_balance_required/);
  assert.match(src, /production_post_flag_refused/);
  assert.match(src, /applyGetFallbackToIntent/);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED': 'true'/);
  const handler = sourceOf('../functions/api/providers/production/moov-payout-orchestrate.mjs');
  assert.match(handler, /money_intent_persist_refused/);
  assert.match(handler, /provider_post_refused/);
  const diag = sourceOf('../providers/oneshot/m711-webhook-diag.mjs');
  assert.match(diag, /assertGetOnly/);
  assert.match(diag, /diagnose_payout_webhook/);
  assert.match(diag, /refused_sandbox_post_armed/);
  assert.match(diag, /refused_production_post_armed/);
  assert.doesNotMatch(diag, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(diag, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(diag, /method:\s*['"]POST['"]\s*,[\s\S]{0,80}\/transfers/);
  const oneshot = sourceOf('../providers/oneshot/m79-sandbox-tenant/index.mjs');
  assert.match(oneshot, /diagnosePayoutWebhook/);
  assert.match(oneshot, /diagnose_payout_webhook/);
  assert.doesNotMatch(oneshot, /\/transfers/);
  assert.equal(M711_PHASE, 'M7.11');
});
