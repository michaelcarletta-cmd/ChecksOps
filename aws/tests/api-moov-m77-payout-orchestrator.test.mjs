import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FINANCIAL_OPERATIONS } from '../functions/api/financial-authz.mjs';
import { AUTHORITATIVE_DISBURSEMENT_FUNDING } from '../functions/api/providers/moov-funding-sequence.mjs';
import { KNOWN_APPROVED_MOOV } from '../functions/api/providers/production/moov-accounts.mjs';
import {
  FIRST_PRODUCTION_TRANSFER_CENTS,
  MOOV_DEPOSIT_TOTP_ACTION,
  MOOV_DISBURSE_TOTP_ACTION,
  MOOV_FUND_TOTP_ACTION,
  firstTestDisburseBinding,
  firstTestFundBinding,
} from '../functions/api/providers/production/moov-first-test.mjs';
import { handleProductionMoovPayoutOrchestrate } from '../functions/api/providers/production/moov-payout-orchestrate.mjs';
import {
  canTransitionFunding,
  canTransitionPayout,
  computeShortfallCents,
  createMemoryPayoutStore,
  decidePayoutFunding,
  exclusiveUiActions,
  firstTestPayoutOperationId,
  fundingIdempotencyKey,
  getReconciliationMayCreateMoneyIntent,
  isAuthoritativeFundingIntent,
  isSweepActivity,
  orchestratePayout,
  payoutIdempotencyKey,
  PERSIST_MONEY_INTENTS_THIS_PHASE,
  webhookMayCreateMoneyIntent,
} from '../functions/api/providers/production/moov-payout-orchestrator.mjs';
import { hasProductionMoovHandler } from '../functions/api/providers/production/moov-dispatch.mjs';
import { FUNCTION_BY_NAME } from '../functions/api/providers/catalog.mjs';

const FREEDOM_TENANT = KNOWN_APPROVED_MOOV.freedom.tenantId;
const FREEDOM_WALLET = KNOWN_APPROVED_MOOV.freedom.walletId;
const PRIOR_FUND = {
  id: '257b6033-eac0-4555-877e-a8cb4f801c8f',
  amount_cents: 1,
  status: 'completed',
  leg_role: 'wallet_funding',
  idempotency_key: 'prior-unrelated-fund',
  provider_transfer_id: '15946bc6-7e80-42d2-99a3-5a3793b24d2e',
  description: 'first penny fund',
};
const SWEEP_ACTIVITY = {
  origin: 'provider_sweep',
  activity_kind: 'sweep_push',
  provider_transfer_id: '4e39f67f-383f-44d4-b5f8-212d4cc29bb0',
  status: 'pending',
  amount_cents: 1,
};

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('shortfall is max(0, payout - live available) and current state is FUND_FIRST', () => {
  assert.equal(computeShortfallCents(1, 0), 1);
  assert.equal(computeShortfallCents(1, 1), 0);
  assert.equal(computeShortfallCents(1, 5), 0);
  const current = decidePayoutFunding({ payoutCents: 1, availableCents: 0 });
  assert.equal(current.decision, 'FUND_FIRST');
  assert.equal(current.shortfall_cents, 1);
  assert.equal(current.payout_cents, 1);
  assert.equal(FIRST_PRODUCTION_TRANSFER_CENTS, 1);
});

test('one funding intent and one payout intent, reused on replay, Sweep ignored', async () => {
  const store = createMemoryPayoutStore();
  const first = await orchestratePayout({
    availableCents: 0,
    payoutCents: 1,
    recipientVerified: true,
    persistMoneyIntents: true,
    store,
    existingRows: [PRIOR_FUND],
    sweepActivity: [SWEEP_ACTIVITY],
  });
  assert.equal(first.decision, 'FUND_FIRST');
  assert.equal(first.shortfall_cents, 1);
  assert.equal(first.funding_mechanism, AUTHORITATIVE_DISBURSEMENT_FUNDING);
  assert.equal(first.funding_intent.amount_cents, 1);
  assert.equal(first.funding_intent.created, true);
  assert.equal(first.payout_intent.created, true);
  assert.equal(first.payout_intent.blocked, true);
  assert.equal(first.sweep_used_as_funding, false);
  assert.equal(first.ignored_sweep_count, 1);
  assert.equal(first.unrelated_prior_funding_ignored, 1);
  assert.equal(isSweepActivity(SWEEP_ACTIVITY), true);
  assert.equal(isAuthoritativeFundingIntent(PRIOR_FUND, first.payout_operation_id), false);
  assert.equal(isAuthoritativeFundingIntent(first.funding_intent, first.payout_operation_id), true);

  const replay = await orchestratePayout({
    availableCents: 0,
    payoutCents: 1,
    recipientVerified: true,
    persistMoneyIntents: true,
    store,
    existingRows: [PRIOR_FUND],
    sweepActivity: [SWEEP_ACTIVITY],
  });
  assert.equal(replay.funding_intent.reused, true);
  assert.equal(replay.funding_intent.created, false);
  assert.equal(replay.payout_intent.reused, true);
  assert.equal(replay.payout_intent.created, false);
  assert.equal(store.inserts.filter((k) => k === 'wallet_funding').length, 1);
  assert.equal(store.inserts.filter((k) => k === 'wallet_disbursement').length, 1);
  assert.equal(replay.funding_intent.idempotency_key, fundingIdempotencyKey(firstTestPayoutOperationId(), 1));
  assert.equal(replay.payout_intent.idempotency_key, payoutIdempotencyKey(firstTestPayoutOperationId(), 1));
});

test('dark prepare does not persist money intents and payout stays blocked', async () => {
  assert.equal(PERSIST_MONEY_INTENTS_THIS_PHASE, false);
  const plan = await orchestratePayout({
    availableCents: 0,
    payoutCents: 1,
    recipientVerified: true,
    persistMoneyIntents: false,
    transferPostEnabled: false,
  });
  assert.equal(plan.persist_money_intents, false);
  assert.equal(plan.persisted_money_intents, 0);
  assert.equal(plan.created_payment_transfer, false);
  assert.equal(plan.live_provider_posted, false);
  assert.equal(plan.payout_submittable, false);
  assert.equal(plan.funding_post_allowed, false);
  assert.equal(plan.funding_state, 'funding_required');
  assert.equal(plan.payout_state, 'payout_requested');
  assert.ok(plan.blocked_reasons.includes('wallet_shortfall'));
});

test('pending funding blocks payout POST and a second fund', async () => {
  const store = createMemoryPayoutStore();
  const op = firstTestPayoutOperationId();
  await store.putIntent({
    kind: 'wallet_funding',
    leg_role: 'wallet_funding',
    payout_operation_id: op,
    idempotency_key: fundingIdempotencyKey(op, 1),
    amount_cents: 1,
    status: 'submitted',
    origin: 'checksops',
  });
  const plan = await orchestratePayout({
    availableCents: 0,
    payoutCents: 1,
    persistMoneyIntents: true,
    transferPostEnabled: true,
    totpFundPresent: true,
    totpDisbursePresent: true,
    recipientVerified: true,
    store,
  });
  assert.equal(plan.funding_state, 'funding_submitted');
  assert.equal(plan.payout_submittable, false);
  assert.equal(plan.funding_post_allowed, false);
  assert.equal(plan.may_create_second_funding, false);
  assert.ok(plan.blocked_reasons.includes('funding_pending'));
});

test('failed funding keeps payout blocked and does not mint a second fund', async () => {
  const store = createMemoryPayoutStore();
  const op = firstTestPayoutOperationId();
  await store.putIntent({
    kind: 'wallet_funding',
    payout_operation_id: op,
    idempotency_key: fundingIdempotencyKey(op, 1),
    amount_cents: 1,
    status: 'failed',
    origin: 'checksops',
  });
  const plan = await orchestratePayout({
    availableCents: 0,
    payoutCents: 1,
    persistMoneyIntents: true,
    transferPostEnabled: true,
    totpDisbursePresent: true,
    recipientVerified: true,
    store,
  });
  assert.equal(plan.funding_intent.reused, true);
  assert.equal(plan.funding_state, 'funding_failed');
  assert.equal(plan.payout_submittable, false);
  assert.equal(plan.may_create_second_funding, false);
});

test('terminal funding and payout states cannot regress', () => {
  assert.equal(canTransitionFunding('funding_completed', 'funding_required').reason, 'terminal_regression');
  assert.equal(canTransitionFunding('funding_failed', 'funding_submitted').reason, 'terminal_regression');
  assert.equal(canTransitionPayout('payout_completed', 'payout_requested').reason, 'terminal_regression');
  assert.equal(canTransitionPayout('payout_failed', 'payout_ready').reason, 'terminal_regression');
  assert.equal(canTransitionFunding('funding_submitted', 'funding_completed').ok, true);
  assert.equal(canTransitionPayout('payout_ready', 'payout_submitting').ok, true);
  assert.equal(canTransitionPayout('payout_submitted', 'payout_submitted').noop, true);
});

test('wallet sufficient skips funding and can reach payout_ready after gates', async () => {
  const plan = await orchestratePayout({
    availableCents: 1,
    payoutCents: 1,
    recipientVerified: true,
    totpDisbursePresent: true,
    transferPostEnabled: false,
  });
  assert.equal(plan.decision, 'PAYOUT_READY');
  assert.equal(plan.shortfall_cents, 0);
  assert.equal(plan.funding_intent, null);
  assert.equal(plan.payout_state, 'payout_ready');
  assert.equal(plan.payout_submittable, false);
  assert.equal(plan.ux_stage, 'ready_to_send');
});

test('TOTP actions are distinct and deposit.submit is not reused', async () => {
  const fund = firstTestFundBinding();
  const disburse = firstTestDisburseBinding();
  assert.equal(fund.actionKey, MOOV_FUND_TOTP_ACTION);
  assert.equal(disburse.actionKey, MOOV_DISBURSE_TOTP_ACTION);
  assert.equal(fund.amountCents, 1);
  assert.equal(disburse.amountCents, 1);
  assert.equal(fund.bankId, KNOWN_APPROVED_MOOV.freedom.bankId);
  assert.equal(fund.walletId, FREEDOM_WALLET);
  assert.equal(disburse.recipientId, KNOWN_APPROVED_MOOV.recipient.recipientId);
  assert.equal(disburse.recipientBankId, KNOWN_APPROVED_MOOV.recipient.bankId);
  assert.notEqual(fund.actionKey, disburse.actionKey);
  assert.notEqual(fund.actionKey, MOOV_DEPOSIT_TOTP_ACTION);
  assert.equal(FINANCIAL_OPERATIONS.wallet_fund.permission, 'wallet.fund');
  assert.equal(FINANCIAL_OPERATIONS.wallet_disburse.permission, 'wallet.disburse');
  const plan = await orchestratePayout({ availableCents: 0, payoutCents: 1 });
  assert.equal(plan.totp.funding.action, 'wallet.fund');
  assert.equal(plan.totp.payout.action, 'wallet.disburse');
  assert.equal(plan.totp.deposit_submit_reused, false);
  assert.equal(plan.totp_consumed, false);
});

test('UI never enables fund and payout together', () => {
  for (const stage of ['funding_required', 'funding_pending', 'funds_available', 'ready_to_send', 'payment_pending', 'payment_completed']) {
    const actions = exclusiveUiActions(stage);
    assert.equal(actions.both_enabled, false);
    assert.equal(actions.prepare_funding && actions.prepare_payout, false);
    assert.equal(actions.submit_funding, false);
    assert.equal(actions.submit_payout, false);
  }
});

test('webhook and GET recon cannot create money intents', () => {
  assert.equal(webhookMayCreateMoneyIntent(), false);
  assert.equal(getReconciliationMayCreateMoneyIntent(), false);
  const files = [
    '../functions/api/providers/webhook-apply-production.mjs',
    '../functions/api/providers/production/moov-transfer-status.mjs',
    '../functions/api/providers/production/moov-payout-orchestrate.mjs',
    '../functions/api/providers/production/moov-payout-orchestrator.mjs',
  ];
  for (const rel of files) {
    const src = sourceOf(rel);
    assert.doesNotMatch(src, /INSERT INTO public\.payment_transfers/i);
    if (rel.endsWith('moov-payout-orchestrate.mjs') || rel.endsWith('moov-payout-orchestrator.mjs')) {
      assert.doesNotMatch(src, /method:\s*['"]POST['"]/);
    }
  }
  assert.equal(hasProductionMoovHandler('moov-payout-orchestrate'), true);
  assert.equal(FUNCTION_BY_NAME['moov-payout-orchestrate'].class, 1);
});

test('handler uses live GET wallet, refuses persist/POST, and ignores Sweep as funding', async () => {
  const methods = [];
  const inserts = [];
  const client = {
    query: async (sql) => {
      if (String(sql).includes('INSERT INTO public.payment_transfers')) {
        inserts.push('payment_transfers');
        throw new Error('payment_transfers_insert_forbidden');
      }
      if (String(sql).includes('tenant_users') || String(sql).includes('TENANT_MEMBERSHIP')) {
        return { rows: [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }] };
      }
      if (String(sql).includes('FROM public.payment_transfers')) {
        return { rows: [PRIOR_FUND] };
      }
      if (String(sql).includes('FROM public.payment_provider_activity')) {
        return { rows: [SWEEP_ACTIVITY] };
      }
      return { rows: [] };
    },
  };
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    methods.push({ method, href });
    if (href.includes('/transfers') && method !== 'GET') {
      throw new Error('transfer_write_forbidden');
    }
    if (href.includes('/oauth2/token')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.x', expires_in: 300 }),
        json: async () => ({ access_token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.x', expires_in: 300 }),
        headers: { get: () => 'application/json' },
      };
    }
    if (href.includes('/wallets/')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ availableBalance: { currency: 'USD', valueDecimal: '0.00' } }),
        json: async () => ({ availableBalance: { currency: 'USD', valueDecimal: '0.00' } }),
        headers: { get: () => 'application/json' },
      };
    }
    if (href.includes('/bank-accounts/')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ status: 'verified', bankName: 'Chase', lastFourAccountNumber: '1506' }),
        json: async () => ({ status: 'verified', bankName: 'Chase', lastFourAccountNumber: '1506' }),
        headers: { get: () => 'application/json' },
      };
    }
    throw new Error(`unexpected fetch ${href}`);
  };

  const result = await handleProductionMoovPayoutOrchestrate({
    client,
    mapping: { application_user_id: 'user-1' },
    body: { tenant_id: FREEDOM_TENANT },
    fetchImpl,
    loadSecrets: async () => ({
      ok: true,
      credentials: {
        environment: 'production',
        host: 'https://api.moov.io',
        publicKey: 'pk',
        secretKey: 'sk',
        origin: 'https://checksops.com',
        platformAccountId: KNOWN_APPROVED_MOOV.platform.moovAccountId,
        apiVersion: 'v2024.01.00',
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.decision, 'FUND_FIRST');
  assert.equal(result.available_cents, 0);
  assert.equal(result.payout_cents, 1);
  assert.equal(result.shortfall_cents, 1);
  assert.equal(result.createdPaymentTransfer, false);
  assert.equal(result.liveProviderPosted, false);
  assert.equal(result.persistMoneyIntents, false);
  assert.equal(result.payout_submittable, false);
  assert.equal(result.sweep_used_as_funding, false);
  assert.equal(result.ux.funding_source, 'Wells Fargo ••••4573');
  assert.equal(result.ux.recipient, 'Chase ••••1506');
  assert.doesNotMatch(JSON.stringify(result.ux), /[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.equal(inserts.length, 0);
  assert.ok(methods.some((row) => row.method === 'GET' && row.href.includes('/wallets/')));
  assert.ok(methods.some((row) => row.method === 'GET' && row.href.includes('/bank-accounts/')));
  assert.equal(methods.filter((row) => row.href.includes('/transfers')).length, 0);
  assert.equal(methods.filter((row) => row.method !== 'GET' && !row.href.includes('/oauth2/token')).length, 0);
  const persistDenied = await handleProductionMoovPayoutOrchestrate({
    client,
    mapping: { application_user_id: 'user-1' },
    body: { persist_money_intents: true },
    fetchImpl,
    loadSecrets: async () => ({ ok: false, error: 'unused' }),
  });
  assert.equal(persistDenied.error, 'money_intent_persist_refused');
});
