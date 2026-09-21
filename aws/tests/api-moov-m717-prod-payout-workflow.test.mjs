import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MAX_PROVIDER_AMOUNT_CENTS } from '../functions/api/providers/amounts.mjs';
import { KNOWN_APPROVED_MOOV } from '../functions/api/providers/production/moov-accounts.mjs';
import {
  CONSUME_TOTP_THIS_PHASE,
  PERSIST_MONEY_INTENTS_THIS_PHASE,
  createMemoryPayoutStore,
  fundingIdempotencyKey,
  intentStatusToFundingState,
  orchestratePayout,
  payoutIdempotencyKey,
  payoutOperationIdFor,
} from '../functions/api/providers/production/moov-payout-orchestrator.mjs';
import {
  createPaymentAuthorizationGrant,
  evaluatePaymentAuthorizationGrant,
  PAYMENT_AUTHORIZATION_ACTION,
  REQUIRE_TOTP_FALSE_PRODUCTION_PATH,
  SECOND_HUMAN_AUTHORIZATION_AFTER_FUNDING,
} from '../functions/api/providers/production/moov-payout-authorization.mjs';
import {
  evaluatePaymentAmountLimits,
  RTP_MAX_CENTS,
} from '../functions/api/providers/production/moov-payout-limits.mjs';
import { executeProductionPayment } from '../functions/api/providers/production/moov-production-payment.mjs';
import { applyGetFallbackToIntent } from '../functions/api/providers/production/moov-payout-orchestrator.mjs';
import { evaluateProductionPennySweepRace } from '../functions/api/providers/production/moov-production-penny-authz.mjs';
import { handleProductionMoovPayoutOrchestrate } from '../functions/api/providers/production/moov-payout-orchestrate.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const FREEDOM = KNOWN_APPROVED_MOOV.freedom.tenantId;
const RECIPIENT = KNOWN_APPROVED_MOOV.recipient.recipientId;
const PM = KNOWN_APPROVED_MOOV.recipient.achCreditStandardPm;
const USER = '7dbb3009-f059-4767-b5dc-1c5c72379330';
const PAYOUT = 850000;
const PIPELINE = '3bef00a5-0bf4-41ba-abf8-5fb4e2b73d43';

const grantFor = (overrides = {}) => createPaymentAuthorizationGrant({
  tenantId: FREEDOM,
  environment: 'production',
  userId: USER,
  payoutOperationId: payoutOperationIdFor({
    tenantId: FREEDOM,
    environment: 'production',
    recipientId: RECIPIENT,
    payoutCents: PAYOUT,
  }),
  recipientId: RECIPIENT,
  recipientPaymentMethodId: PM,
  amountCents: PAYOUT,
  nowMs: 1_700_000_000_000,
  ...overrides,
});

const runPayment = (extra = {}) => executeProductionPayment({
  availableCents: extra.availableCents ?? 0,
  payoutCents: extra.payoutCents ?? PAYOUT,
  recipientVerified: extra.recipientVerified !== false,
  grant: extra.grant === undefined ? grantFor(extra.grantOverrides) : extra.grant,
  userId: USER,
  tenantId: extra.tenantId || FREEDOM,
  recipientId: extra.recipientId || RECIPIENT,
  recipientPaymentMethodId: extra.recipientPaymentMethodId || PM,
  environment: extra.environment || 'production',
  store: extra.store || null,
  existingRows: extra.existingRows || [],
  sweepActivity: extra.sweepActivity || [],
  persistMoneyIntents: extra.persistMoneyIntents === true,
  transferPostEnabled: extra.transferPostEnabled === true,
  totpVerified: extra.totpVerified !== false,
  identityOk: extra.identityOk !== false,
  membershipOk: extra.membershipOk !== false,
  roles: extra.roles || ['owner'],
  requestedSpeed: extra.requestedSpeed,
  checkRemainingCents: extra.checkRemainingCents,
  nowMs: extra.nowMs || 1_700_000_000_000,
});

test('A sufficient wallet skips funding and is payout eligible', async () => {
  const plan = await runPayment({ availableCents: PAYOUT });
  assert.equal(plan.ok, true);
  assert.equal(plan.decision, 'PAYOUT_READY');
  assert.equal(plan.shortfall_cents, 0);
  assert.equal(plan.funding_intent, null);
  assert.equal(plan.payout_state, 'payout_ready');
  assert.equal(plan.payment_status_label, 'Ready to send');
  assert.equal(plan.first_test_cap_applied, false);
  assert.equal(plan.liveProviderPosted, false);
});

test('B partial wallet funds exact shortfall only', async () => {
  const plan = await runPayment({ availableCents: 200000 });
  assert.equal(plan.decision, 'FUND_FIRST');
  assert.equal(plan.shortfall_cents, 650000);
  assert.equal(plan.funding_intent.amount_cents, 650000);
  assert.equal(plan.payout_intent.amount_cents, PAYOUT);
  assert.equal(plan.payment_status_label, 'Funding');
});

test('C zero wallet funds the full payout amount', async () => {
  const plan = await runPayment({ availableCents: 0 });
  assert.equal(plan.shortfall_cents, PAYOUT);
  assert.equal(plan.funding_intent.amount_cents, PAYOUT);
});

test('D pending funding does not create a second funding leg', async () => {
  const store = createMemoryPayoutStore();
  const op = payoutOperationIdFor({
    tenantId: FREEDOM, environment: 'production', recipientId: RECIPIENT, payoutCents: PAYOUT,
  });
  await store.putIntent({
    kind: 'wallet_funding',
    leg_role: 'wallet_funding',
    payout_operation_id: op,
    idempotency_key: fundingIdempotencyKey(op, PAYOUT, 'production'),
    amount_cents: PAYOUT,
    status: 'pending',
    origin: 'checksops',
  });
  const plan = await runPayment({ availableCents: 0, store, persistMoneyIntents: true });
  assert.equal(plan.funding_state, 'funding_pending');
  assert.equal(plan.funding_intent.reused, true);
  assert.equal(plan.may_create_second_funding, false);
  assert.equal(plan.funding_post_allowed, false);
});

test('E unknown funding does not retry', async () => {
  const store = createMemoryPayoutStore();
  const op = payoutOperationIdFor({
    tenantId: FREEDOM, environment: 'production', recipientId: RECIPIENT, payoutCents: PAYOUT,
  });
  await store.putIntent({
    kind: 'wallet_funding',
    leg_role: 'wallet_funding',
    payout_operation_id: op,
    idempotency_key: fundingIdempotencyKey(op, PAYOUT, 'production'),
    amount_cents: PAYOUT,
    status: 'unknown',
    origin: 'checksops',
  });
  const plan = await runPayment({ availableCents: 0, store, persistMoneyIntents: true });
  assert.equal(plan.funding_state, 'funding_unknown');
  assert.equal(plan.unknown_no_retry, true);
  assert.equal(plan.may_create_second_funding, false);
  assert.equal(plan.funding_post_allowed, false);
});

test('F funding completed with insufficient live wallet blocks payout', async () => {
  const store = createMemoryPayoutStore();
  const op = payoutOperationIdFor({
    tenantId: FREEDOM, environment: 'production', recipientId: RECIPIENT, payoutCents: PAYOUT,
  });
  await store.putIntent({
    kind: 'wallet_funding',
    leg_role: 'wallet_funding',
    payout_operation_id: op,
    idempotency_key: fundingIdempotencyKey(op, PAYOUT, 'production'),
    amount_cents: PAYOUT,
    status: 'completed',
    origin: 'checksops',
  });
  const plan = await runPayment({ availableCents: 0, store, persistMoneyIntents: true });
  assert.equal(plan.funding_state, 'funding_completed');
  assert.equal(plan.payout_state, 'payout_requested');
  assert.ok(plan.blocked_reasons.includes('funding_completed_wallet_unavailable'));
  assert.equal(plan.may_create_second_funding, false);
});

test('G funding completed with sufficient live wallet is payout eligible', async () => {
  const store = createMemoryPayoutStore();
  const op = payoutOperationIdFor({
    tenantId: FREEDOM, environment: 'production', recipientId: RECIPIENT, payoutCents: PAYOUT,
  });
  await store.putIntent({
    kind: 'wallet_funding',
    leg_role: 'wallet_funding',
    payout_operation_id: op,
    idempotency_key: fundingIdempotencyKey(op, 0, 'production'),
    amount_cents: 0,
    status: 'completed',
    origin: 'checksops',
  });
  const plan = await runPayment({ availableCents: PAYOUT, store });
  assert.equal(plan.decision, 'PAYOUT_READY');
  assert.equal(plan.payout_state, 'payout_ready');
  assert.equal(plan.sweep_race.payout_ready, true);
});

test('H Sweep race does not create a second funding loop', async () => {
  const race = evaluateProductionPennySweepRace({
    fundingState: 'funding_completed',
    liveAvailableCents: 0,
    payoutCents: PAYOUT,
    mayCreateSecondFunding: false,
  });
  assert.equal(race.payout_ready, false);
  assert.equal(race.may_create_second_funding, false);
  assert.equal(race.reason, 'funding_completed_wallet_unavailable');
  const plan = await runPayment({
    availableCents: 0,
    existingRows: [{
      kind: 'wallet_funding',
      leg_role: 'wallet_funding',
      payout_operation_id: payoutOperationIdFor({
        tenantId: FREEDOM, environment: 'production', recipientId: RECIPIENT, payoutCents: PAYOUT,
      }),
      idempotency_key: fundingIdempotencyKey(payoutOperationIdFor({
        tenantId: FREEDOM, environment: 'production', recipientId: RECIPIENT, payoutCents: PAYOUT,
      }), PAYOUT, 'production'),
      amount_cents: PAYOUT,
      status: 'completed',
      origin: 'checksops',
    }],
    sweepActivity: [{ origin: 'provider_sweep', activity_kind: 'sweep_push', amount_cents: PAYOUT }],
  });
  assert.equal(plan.may_create_second_funding, false);
  assert.equal(plan.sweep_used_as_funding, false);
});

test('I payout pending does not create a duplicate payout', async () => {
  const store = createMemoryPayoutStore();
  const op = payoutOperationIdFor({
    tenantId: FREEDOM, environment: 'production', recipientId: RECIPIENT, payoutCents: PAYOUT,
  });
  await store.putIntent({
    kind: 'wallet_disbursement',
    leg_role: 'wallet_disbursement',
    payout_operation_id: op,
    idempotency_key: payoutIdempotencyKey(op, PAYOUT, 'production'),
    amount_cents: PAYOUT,
    status: 'pending',
    origin: 'checksops',
  });
  const plan = await runPayment({ availableCents: PAYOUT, store, persistMoneyIntents: true });
  assert.equal(plan.payout_state, 'payout_pending');
  assert.equal(plan.payout_intent.reused, true);
  assert.equal(plan.may_create_second_payout, false);
});

test('J completed payout replay creates nothing', async () => {
  const store = createMemoryPayoutStore();
  const first = await runPayment({ availableCents: PAYOUT, store, persistMoneyIntents: true });
  await store.updateIntent(first.payout_intent.idempotency_key, { status: 'completed' });
  const replay = await runPayment({ availableCents: PAYOUT, store, persistMoneyIntents: true });
  assert.equal(replay.payout_state, 'payout_completed');
  assert.equal(replay.payout_intent.reused, true);
  assert.equal(replay.payout_intent.created, false);
  assert.equal(store.inserts.filter((k) => k === 'wallet_disbursement').length, 1);
});

test('K duplicate UI click reuses the same operation', async () => {
  const a = payoutOperationIdFor({
    tenantId: FREEDOM, environment: 'production', recipientId: RECIPIENT, payoutCents: PAYOUT,
  });
  const b = payoutOperationIdFor({
    tenantId: FREEDOM, environment: 'production', recipientId: RECIPIENT, payoutCents: PAYOUT,
  });
  assert.equal(a, b);
  const store = createMemoryPayoutStore();
  const first = await runPayment({ availableCents: 0, store, persistMoneyIntents: true });
  const second = await runPayment({ availableCents: 0, store, persistMoneyIntents: true });
  assert.equal(first.payout_operation_id, second.payout_operation_id);
  assert.equal(second.funding_intent.reused, true);
  assert.equal(second.payout_intent.reused, true);
});

test('L sandbox and production operation ids are isolated', () => {
  const prod = payoutOperationIdFor({
    tenantId: FREEDOM, environment: 'production', recipientId: RECIPIENT, payoutCents: PAYOUT,
  });
  const sandbox = payoutOperationIdFor({
    tenantId: PIPELINE, environment: 'sandbox', recipientId: RECIPIENT, payoutCents: PAYOUT,
  });
  assert.notEqual(prod, sandbox);
  assert.match(fundingIdempotencyKey(prod, PAYOUT, 'production'), /env:production/);
  assert.match(fundingIdempotencyKey(sandbox, PAYOUT, 'sandbox'), /env:sandbox/);
});

test('M amount over the provider ceiling is blocked and not split', () => {
  const blocked = evaluatePaymentAmountLimits({
    payoutCents: MAX_PROVIDER_AMOUNT_CENTS + 1,
    requestedSpeed: 'standard',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.split, false);
  assert.equal(blocked.error, 'invalid_amount');
  const rtp = evaluatePaymentAmountLimits({
    payoutCents: RTP_MAX_CENTS + 1,
    requestedSpeed: 'instant',
  });
  assert.equal(rtp.split, false);
  assert.ok(rtp.error === 'amount_exceeds_rtp_limit' || rtp.error === 'invalid_amount');
});

test('N expired or missing authorization is blocked', async () => {
  const expired = await runPayment({
    availableCents: PAYOUT,
    nowMs: 1_800_000_000_000,
    grant: grantFor({ nowMs: 1_700_000_000_000, ttlMs: 1000 }),
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.error, 'authorization_expired');
  const missing = await runPayment({ availableCents: PAYOUT, grant: null, totpVerified: true });
  assert.equal(missing.ok, false);
  assert.ok(['authorization_grant_required', 'totp_required'].includes(missing.error));
});

test('O authorization for a different recipient or amount cannot be reused', async () => {
  const grant = grantFor();
  const wrongAmount = await runPayment({
    availableCents: PAYOUT,
    payoutCents: PAYOUT + 1,
    grant,
  });
  assert.equal(wrongAmount.ok, false);
  assert.equal(wrongAmount.error, 'authorization_binding_mismatch');
  const wrongRecipient = evaluatePaymentAuthorizationGrant({
    grant,
    tenantId: FREEDOM,
    environment: 'production',
    userId: USER,
    payoutOperationId: grant.payout_operation_id,
    recipientId: '00000000-0000-0000-0000-000000000099',
    recipientPaymentMethodId: PM,
    amountCents: PAYOUT,
    identityOk: true,
    membershipOk: true,
    roles: ['owner'],
    nowMs: 1_700_000_000_000,
  });
  assert.equal(wrongRecipient.ok, false);
  assert.equal(wrongRecipient.error, 'authorization_binding_mismatch');
});

test('P webhook and GET reconciliation reach the same terminal result', () => {
  const intent = {
    kind: 'wallet_disbursement',
    leg_role: 'wallet_disbursement',
    status: 'pending',
    provider_transfer_id: 'xfer-1',
    provider_status: 'pending',
  };
  const webhook = applyGetFallbackToIntent({
    intent,
    providerStatus: 'completed',
    completedOn: '2026-09-21T00:00:00Z',
  });
  const get = applyGetFallbackToIntent({
    intent,
    providerStatus: 'completed',
    completedOn: '2026-09-21T00:00:00Z',
  });
  assert.equal(webhook.intent.status, get.intent.status);
  assert.equal(webhook.intent.status, 'completed');
  assert.equal(webhook.createdPaymentTransfer, false);
  assert.equal(get.liveProviderPosted, false);
});

test('canceled unsubmitted penny funding cannot execute later', () => {
  assert.equal(intentStatusToFundingState('canceled'), 'funding_failed');
  assert.equal(intentStatusToFundingState('cancelled'), 'funding_failed');
  assert.equal(intentStatusToFundingState('planned'), 'funding_required');
});

test('one human authorization covers internal legs without requireTotp false', async () => {
  assert.equal(PAYMENT_AUTHORIZATION_ACTION, 'disbursement.send');
  assert.equal(SECOND_HUMAN_AUTHORIZATION_AFTER_FUNDING, false);
  assert.equal(REQUIRE_TOTP_FALSE_PRODUCTION_PATH, false);
  assert.equal(CONSUME_TOTP_THIS_PHASE, false);
  assert.equal(PERSIST_MONEY_INTENTS_THIS_PHASE, false);
  const plan = await runPayment({ availableCents: 0 });
  assert.equal(plan.require_totp, true);
  assert.equal(plan.authorization.covers_internal_funding, true);
  assert.equal(plan.authorization.covers_internal_payout, true);
  assert.equal(plan.authorization.second_human_authorization_after_funding, false);
  assert.doesNotMatch(sourceOf('../functions/api/providers/production/moov-production-payment.mjs'), /requireTotp:\s*false/);
});

test('HTTP first-test keeps the 1 cent cap; payment workflow uses the real amount', async () => {
  const client = {
    query: async (sql) => {
      if (String(sql).includes('tenant_users') || String(sql).includes('TENANT_MEMBERSHIP')) {
        return { rows: [{ tenant_id: FREEDOM, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }] };
      }
      if (String(sql).includes('FROM public.tenants')) {
        return { rows: [{ id: FREEDOM, moov_allowlisted: true, moov_environment: 'production' }] };
      }
      return { rows: [] };
    },
  };
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    if (method !== 'GET' && !href.includes('/oauth2/token')) throw new Error('transfer_write_forbidden');
    if (href.includes('/oauth2/token')) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ access_token: 't', expires_in: 300 }),
        json: async () => ({ access_token: 't', expires_in: 300 }),
        headers: { get: () => 'application/json' },
      };
    }
    if (href.includes('/wallets/')) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ availableBalance: { currency: 'USD', value: 0 } }),
        json: async () => ({ availableBalance: { currency: 'USD', value: 0 } }),
        headers: { get: () => 'application/json' },
      };
    }
    if (href.includes('/bank-accounts/')) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ status: 'verified' }),
        json: async () => ({ status: 'verified' }),
        headers: { get: () => 'application/json' },
      };
    }
    throw new Error(`unexpected ${href}`);
  };
  const secrets = async () => ({
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
  });
  const capped = await handleProductionMoovPayoutOrchestrate({
    client,
    mapping: { application_user_id: USER },
    body: { tenant_id: FREEDOM, amount_cents: PAYOUT },
    fetchImpl,
    loadSecrets: secrets,
  });
  assert.equal(capped.error, 'first_transfer_cap');
  const payment = await handleProductionMoovPayoutOrchestrate({
    client,
    mapping: { application_user_id: USER },
    body: { tenant_id: FREEDOM, workflow: 'payment', amount_cents: PAYOUT },
    fetchImpl,
    loadSecrets: secrets,
  });
  assert.equal(payment.ok, true);
  assert.equal(payment.payout_cents, PAYOUT);
  assert.equal(payment.first_test_cap_applied, false);
  assert.equal(payment.liveProviderPosted, false);
  assert.equal(payment.persistMoneyIntents, false);
  const over = await handleProductionMoovPayoutOrchestrate({
    client,
    mapping: { application_user_id: USER },
    body: { tenant_id: FREEDOM, workflow: 'payment', amount_cents: MAX_PROVIDER_AMOUNT_CENTS + 1 },
    fetchImpl,
    loadSecrets: secrets,
  });
  assert.equal(over.ok, false);
  assert.equal(over.split, false);
});

test('normal UI uses DisbursementConsole and hides engineering labels from tenants', () => {
  const consoleSrc = sourceOf('../../src/components/disbursement/DisbursementConsole.tsx');
  const walletOps = sourceOf('../../src/pages/WalletOps.tsx');
  const orchestrate = sourceOf('../../src/lib/awsPayoutOrchestrate.ts');
  assert.match(consoleSrc, /Authorize \{amountText\} payment/);
  assert.match(consoleSrc, /invokeAwsPayoutOrchestrate/);
  assert.match(consoleSrc, /awsPayoutOrchestrateReady/);
  assert.doesNotMatch(consoleSrc, /wallet\.fund/);
  assert.doesNotMatch(consoleSrc, /wallet\.disburse/);
  assert.doesNotMatch(consoleSrc, /FUND_FIRST/);
  assert.doesNotMatch(consoleSrc, /M7\.17/);
  assert.match(orchestrate, /workflow: "payment"/);
  assert.doesNotMatch(walletOps, /WalletFundAuthorizeCard/);
  assert.doesNotMatch(walletOps, /PayoutOrchestratorPanel/);
  const oneshot = sourceOf('../providers/oneshot/m79-sandbox-tenant/index.mjs');
  assert.match(oneshot, /abandon_m716_penny_intent/);
  assert.match(oneshot, /abandoned_unsubmitted_test_intent/);
  assert.match(oneshot, /d4580db2-1a3a-4ff0-94ff-4f68af8bcd0f/);
});
