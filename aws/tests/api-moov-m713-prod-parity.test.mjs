import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  CONSUME_TOTP_THIS_PHASE,
  DECISION,
  FIRST_PAYOUT_CENTS,
  PERSIST_MONEY_INTENTS_THIS_PHASE,
  decidePayoutFunding,
  firstTestPayoutOperationId,
  fundingIdempotencyKey,
  getReconciliationMayCreateMoneyIntent,
  orchestratePayout,
  payoutIdempotencyKey,
  webhookMayCreateMoneyIntent,
} from '../functions/api/providers/production/moov-payout-orchestrator.mjs';
import { executeSandboxPayoutE2e } from '../functions/api/providers/production/moov-sandbox-payout-e2e.mjs';
import { PIPELINE_TEST_SANDBOX } from '../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import { KNOWN_APPROVED_MOOV } from '../functions/api/providers/production/moov-accounts.mjs';
import {
  MOOV_DISBURSE_TOTP_ACTION,
  MOOV_FUND_TOTP_ACTION,
} from '../functions/api/providers/production/moov-first-test.mjs';
import { evaluateFinancialAuthorization } from '../functions/api/financial-authz.mjs';
import {
  canTransition,
  completedAtFor,
} from '../functions/api/providers/moov-lifecycle.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const FREEDOM = KNOWN_APPROVED_MOOV.freedom.tenantId;
const PIPELINE = PIPELINE_TEST_SANDBOX.tenantId;

test('M7.12 sandbox e2e refuses Freedom production and requireTotp:false is sandbox-only', async () => {
  const refusedEnv = await executeSandboxPayoutE2e({
    tenantId: FREEDOM,
    tenantEnvironment: 'production',
    liveAvailableCents: 1,
    persistMoneyIntents: false,
    transferPostEnabled: false,
  });
  assert.equal(refusedEnv.error, 'tenant_not_sandbox');
  const refusedTenant = await executeSandboxPayoutE2e({
    tenantId: FREEDOM,
    tenantEnvironment: 'sandbox',
    liveAvailableCents: 1,
    persistMoneyIntents: false,
    transferPostEnabled: false,
  });
  assert.equal(refusedTenant.error, 'refused_production_tenant');
  const e2e = sourceOf('../functions/api/providers/production/moov-sandbox-payout-e2e.mjs');
  const orchestrate = sourceOf('../functions/api/providers/production/moov-payout-orchestrate.mjs');
  const orchestrator = sourceOf('../functions/api/providers/production/moov-payout-orchestrator.mjs');
  assert.equal([...e2e.matchAll(/requireTotp:\s*false/g)].length, 1);
  assert.doesNotMatch(orchestrate, /requireTotp:\s*false/);
  assert.match(orchestrator, /requireTotp = true/);
});

test('Freedom production dark path uses the same orchestratePayout state machine', async () => {
  const orchestrate = sourceOf('../functions/api/providers/production/moov-payout-orchestrate.mjs');
  const e2e = sourceOf('../functions/api/providers/production/moov-sandbox-payout-e2e.mjs');
  assert.match(orchestrate, /const plan = await orchestratePayout\(/);
  assert.match(e2e, /orchestratePayout\(/);
  assert.match(orchestrate, /environment: 'production'/);
  assert.match(orchestrate, /totpFundPresent: false/);
  assert.match(orchestrate, /totpDisbursePresent: false/);
  assert.match(orchestrate, /persistMoneyIntents: PERSIST_MONEY_INTENTS_THIS_PHASE/);
  assert.equal(PERSIST_MONEY_INTENTS_THIS_PHASE, false);
  assert.equal(CONSUME_TOTP_THIS_PHASE, false);
  assert.equal(FIRST_PAYOUT_CENTS, 1);
});

test('dark production decision uses live available and does not persist intents', async () => {
  const sufficient = await orchestratePayout({
    availableCents: 5,
    payoutCents: 1,
    recipientVerified: true,
    environment: 'production',
    tenantId: FREEDOM,
    persistMoneyIntents: false,
    store: null,
    transferPostEnabled: false,
    requireTotp: true,
  });
  assert.equal(sufficient.decision, DECISION.PAYOUT_READY);
  assert.equal(sufficient.shortfall_cents, 0);
  assert.equal(sufficient.funding_intent, null);
  assert.equal(sufficient.persist_money_intents, false);
  assert.equal(sufficient.created_payment_transfer, false);
  assert.equal(sufficient.live_provider_posted, false);
  assert.equal(sufficient.require_totp, true);
  assert.ok(sufficient.blocked_reasons.includes('wallet_disburse_totp_required'));
  assert.equal(sufficient.payout_submittable, false);
  assert.equal(sufficient.funding_post_allowed, false);

  const short = await orchestratePayout({
    availableCents: 0,
    payoutCents: 1,
    recipientVerified: true,
    environment: 'production',
    tenantId: FREEDOM,
    persistMoneyIntents: false,
    store: null,
    transferPostEnabled: false,
    requireTotp: true,
  });
  assert.equal(short.decision, DECISION.FUND_FIRST);
  assert.equal(short.shortfall_cents, 1);
  assert.equal(short.funding_intent?.created, false);
  assert.equal(short.payout_intent?.created, false);
  assert.equal(short.blocked_reasons.includes('wallet_shortfall'), true);
});

test('production and sandbox idempotency keys cannot collide', () => {
  const prodOp = firstTestPayoutOperationId('production');
  const sandOp = firstTestPayoutOperationId('sandbox');
  assert.notEqual(prodOp, sandOp);
  const prodFund = fundingIdempotencyKey(prodOp, 1, 'production');
  const sandFund = fundingIdempotencyKey(prodOp, 1, 'sandbox');
  assert.match(prodFund, /env:production/);
  assert.match(sandFund, /env:sandbox/);
  assert.notEqual(prodFund, sandFund);
  const prodPay = payoutIdempotencyKey(prodOp, 1, 'production');
  const sandPay = payoutIdempotencyKey(sandOp, 1, 'sandbox');
  assert.notEqual(prodPay, sandPay);
  assert.notEqual(FREEDOM, PIPELINE);
});

test('webhook and GET reconciliation cannot create money intents', () => {
  assert.equal(webhookMayCreateMoneyIntent(), false);
  assert.equal(getReconciliationMayCreateMoneyIntent(), false);
  const apply = sourceOf('../functions/api/providers/webhook-apply.mjs');
  const prodApply = sourceOf('../functions/api/providers/webhook-apply-production.mjs');
  assert.doesNotMatch(apply, /INSERT INTO public\.payment_transfers/i);
  assert.doesNotMatch(prodApply, /INSERT INTO public\.payment_transfers/i);
  assert.equal(canTransition('completed', 'processing').ok, false);
  assert.equal(completedAtFor({
    nextStatus: 'completed',
    providerCompletedAt: '2026-09-21T19:46:00.803144Z',
    existingCompletedAt: null,
  }), '2026-09-21T19:46:00.803144Z');
});

test('production financial TOTP actions stay required and are not bypassed', () => {
  assert.equal(MOOV_FUND_TOTP_ACTION, 'wallet.fund');
  assert.equal(MOOV_DISBURSE_TOTP_ACTION, 'wallet.disburse');
  const fund = evaluateFinancialAuthorization({
    operation: 'wallet_fund',
    identityOk: true,
    membershipOk: true,
    roles: ['owner'],
    permissionsActivated: true,
  });
  const disburse = evaluateFinancialAuthorization({
    operation: 'wallet_disburse',
    identityOk: true,
    membershipOk: true,
    roles: ['owner'],
    permissionsActivated: true,
  });
  assert.equal(fund.canExecuteProduction, false);
  assert.equal(disburse.canExecuteProduction, false);
  assert.equal(fund.spec.activated, false);
  assert.equal(disburse.spec.activated, false);
});

test('M7.13 runner is GET-only dark audit and never posts or writes intents', () => {
  const src = sourceOf('../providers/oneshot/m713-prod-parity-run.mjs');
  const oneshot = sourceOf('../providers/oneshot/m79-sandbox-tenant/index.mjs');
  assert.match(src, /inspect_freedom_production/);
  assert.match(src, /assertGetOnly/);
  assert.match(src, /requireTotp: true/);
  assert.match(src, /persistMoneyIntents: false/);
  assert.match(src, /STOP BEFORE WRITING/);
  assert.match(oneshot, /inspect_freedom_production/);
  assert.doesNotMatch(src, /requireTotp:\s*false,\s*$/m);
  assert.doesNotMatch(src, /setSandboxPostFlag/);
  assert.doesNotMatch(src, /AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
  assert.doesNotMatch(src, /persist_orchestrator_intent/);
  assert.doesNotMatch(src, /persist_payout_intent/);
  assert.doesNotMatch(src, /persist_funding_intent/);
  assert.doesNotMatch(src, /overlayPrepApi/);
  assert.doesNotMatch(src, /update-function-code[\s\S]{0,120}API_FN/);
  assert.doesNotMatch(src, /method:\s*['"]POST['"]\s*,[\s\S]{0,80}\/transfers/);
  assert.equal(decidePayoutFunding({ payoutCents: 1, availableCents: 0 }).decision, DECISION.FUND_FIRST);
  assert.equal(decidePayoutFunding({ payoutCents: 1, availableCents: 1 }).decision, DECISION.PAYOUT_READY);
});
