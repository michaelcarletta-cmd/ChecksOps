import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  CONSUME_TOTP_THIS_PHASE,
  DECISION,
  PERSIST_MONEY_INTENTS_THIS_PHASE,
  applyGetFallbackToIntent,
  createMemoryPayoutStore,
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
import {
  executeProductionPayoutE2e,
  m714PayoutOperationId,
} from '../functions/api/providers/production/moov-production-payout-e2e.mjs';
import {
  evaluateProductionPennyAuthorization,
  evaluateProductionPennySweepRace,
  evaluateOneAuthorizedLegPost,
  verifyProductionPennyTotp,
} from '../functions/api/providers/production/moov-production-penny-authz.mjs';
import {
  executeProductionWalletFunding,
  persistProductionIntentCas,
  refuseIndependentMustKeepInvocation,
} from '../functions/api/providers/production/moov-production-transfer-primitives.mjs';
import { evaluateFinancialAuthorization } from '../functions/api/financial-authz.mjs';
import { generateTotpSecret, totpAt, timestepOf } from '../functions/api/financial-totp.mjs';
import { canTransition, completedAtFor } from '../functions/api/providers/moov-lifecycle.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FREEDOM = KNOWN_APPROVED_MOOV.freedom.tenantId;
const PIPELINE = PIPELINE_TEST_SANDBOX.tenantId;
const OP = m714PayoutOperationId();
const FUND_KEY = fundingIdempotencyKey(OP, 1, 'production');
const PAYOUT_KEY = payoutIdempotencyKey(OP, 1, 'production');

const dark = (overrides = {}) => executeProductionPayoutE2e({
  tenantId: FREEDOM,
  tenantEnvironment: 'production',
  liveAvailableCents: 0,
  recipientVerified: true,
  persistMoneyIntents: false,
  transferPostEnabled: false,
  sandboxTransferPostEnabled: false,
  postPhase: 'none',
  ...overrides,
});

test('A Freedom production only; C sandbox tenant rejected', async () => {
  const ok = await dark({ liveAvailableCents: 0 });
  assert.equal(ok.ok, true);
  assert.equal(ok.environment, 'production');
  assert.equal(ok.tenant_id, FREEDOM);
  const sandboxTenant = await dark({ tenantId: PIPELINE, tenantEnvironment: 'production' });
  assert.equal(sandboxTenant.error, 'refused_sandbox_tenant');
  const sandboxEnv = await dark({ tenantEnvironment: 'sandbox' });
  assert.equal(sandboxEnv.error, 'tenant_not_production');
  const sandboxE2e = await executeSandboxPayoutE2e({
    tenantId: FREEDOM,
    tenantEnvironment: 'production',
    liveAvailableCents: 1,
    persistMoneyIntents: false,
  });
  assert.equal(sandboxE2e.error, 'tenant_not_sandbox');
});

test('B amount > $0.01 rejected for first controlled test', async () => {
  const big = await dark({ payoutCents: 2 });
  assert.equal(big.error, 'amount_not_one_cent');
});

test('D no Financial TOTP → execution blocked', async () => {
  const plan = await dark({ liveAvailableCents: 0 });
  assert.equal(plan.fund_authz.firstTestLegAuthorized, false);
  assert.equal(plan.disburse_authz.firstTestLegAuthorized, false);
  assert.equal(plan.funding_post_allowed, false);
  assert.equal(plan.payout_submittable, false);
  assert.equal(plan.require_totp, true);
  assert.equal(plan.totp_consumed, false);
  assert.equal(plan.production_provider_posts, 0);
});

test('E invalid / expired / replayed TOTP → blocked', () => {
  const secret = generateTotpSecret();
  const now = Date.now();
  const valid = totpAt(secret, timestepOf(now));
  const ok = verifyProductionPennyTotp({
    action: MOOV_FUND_TOTP_ACTION,
    code: valid,
    secret,
    nowMs: now,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.consumed, false);
  const invalid = verifyProductionPennyTotp({
    action: MOOV_FUND_TOTP_ACTION,
    code: '000000',
    secret,
    nowMs: now,
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, 'totp_mismatch');
  const replay = verifyProductionPennyTotp({
    action: MOOV_FUND_TOTP_ACTION,
    code: valid,
    secret,
    nowMs: now,
    lastUsedTimestep: ok.timestep,
  });
  assert.equal(replay.ok, false);
  const expired = verifyProductionPennyTotp({
    action: MOOV_DISBURSE_TOTP_ACTION,
    code: valid,
    secret,
    nowMs: now + (120 * 1000),
  });
  assert.equal(expired.ok, false);
  const authz = evaluateProductionPennyAuthorization({
    operation: 'wallet_fund',
    tenantId: FREEDOM,
    environment: 'production',
    identityOk: true,
    membershipOk: true,
    roles: ['owner'],
    totpPresent: false,
    totpValid: false,
  });
  assert.equal(authz.canExecuteProduction, false);
  assert.equal(authz.firstTestLegAuthorized, false);
  assert.equal(authz.separateFreshStepUpsRequired, true);
});

test('F wallet short → exactly one planned funding leg', async () => {
  const plan = await dark({ liveAvailableCents: 0 });
  assert.equal(plan.decision, DECISION.FUND_FIRST);
  assert.equal(plan.shortfall_cents, 1);
  assert.equal(plan.funding_intent.amount_cents, 1);
  assert.equal(plan.funding_intent.required, true);
  assert.equal(plan.may_create_second_funding, false);
});

test('G wallet sufficient → zero funding leg', async () => {
  const plan = await dark({ liveAvailableCents: 5 });
  assert.equal(plan.decision, DECISION.PAYOUT_READY);
  assert.equal(plan.shortfall_cents, 0);
  assert.equal(plan.funding_intent, null);
});

test('H pending funding → no second funding', async () => {
  const plan = await dark({
    liveAvailableCents: 0,
    existingRows: [{
      leg_role: 'wallet_funding',
      kind: 'wallet_funding',
      payout_operation_id: OP,
      idempotency_key: FUND_KEY,
      status: 'pending',
      amount_cents: 1,
      environment: 'production',
      provider_transfer_id: '11111111-1111-4111-8111-111111111111',
    }],
  });
  assert.equal(plan.funding_intent.reused, true);
  assert.equal(plan.funding_state, 'funding_pending');
  assert.equal(plan.funding_post_allowed, false);
  assert.equal(plan.may_create_second_funding, false);
  assert.ok(plan.blocked_reasons.includes('funding_pending'));
});

test('I unknown funding → no retry', async () => {
  const exec = await executeProductionWalletFunding({
    binding: {
      ...KNOWN_APPROVED_MOOV.freedom,
      sourcePaymentMethodId: KNOWN_APPROVED_MOOV.freedom.achDebitFundPm,
      destinationPaymentMethodId: KNOWN_APPROVED_MOOV.freedom.walletPm,
      amountCents: 1,
      accountId: KNOWN_APPROVED_MOOV.freedom.moovAccountId,
      platformAccountId: KNOWN_APPROVED_MOOV.platform.moovAccountId,
    },
    intent: {
      idempotency_key: FUND_KEY,
      status: 'unknown',
      provider_metadata: { post_attempted: true, post_outcome: 'unknown' },
    },
    transferPostEnabled: false,
  });
  assert.equal(exec.outcome, 'unknown_no_retry');
  assert.equal(exec.doNotRetry, true);
  assert.equal(exec.liveProviderPosted, false);
});

test('J completed funding + wallet unavailable → payout blocked; Sweep race does not double-fund', async () => {
  const plan = await dark({
    liveAvailableCents: 0,
    existingRows: [{
      leg_role: 'wallet_funding',
      kind: 'wallet_funding',
      payout_operation_id: OP,
      idempotency_key: FUND_KEY,
      status: 'completed',
      amount_cents: 1,
      environment: 'production',
      provider_transfer_id: '22222222-2222-4222-8222-222222222222',
    }],
  });
  assert.equal(plan.funding_state, 'funding_completed');
  assert.equal(plan.payout_submittable, false);
  assert.equal(plan.may_create_second_funding, false);
  assert.ok(plan.blocked_reasons.includes('wallet_available_unconfirmed'));
  assert.equal(plan.sweep_race.reason, 'funding_completed_wallet_unavailable');
  assert.equal(plan.sweep_race.may_create_second_funding, false);
});

test('K completed funding + wallet available → payout eligible (still TOTP-gated)', async () => {
  const plan = await dark({
    liveAvailableCents: 1,
    totpFundPresent: true,
    totpFundValid: true,
    existingRows: [{
      leg_role: 'wallet_funding',
      kind: 'wallet_funding',
      payout_operation_id: OP,
      idempotency_key: FUND_KEY,
      status: 'completed',
      amount_cents: 1,
      environment: 'production',
      provider_transfer_id: '22222222-2222-4222-8222-222222222222',
    }],
  });
  assert.equal(plan.decision, DECISION.PAYOUT_READY);
  assert.equal(plan.payout_state, 'payout_ready');
  assert.equal(plan.funding_intent, null);
  assert.equal(plan.payout_submittable, false);
  assert.equal(evaluateProductionPennySweepRace({
    fundingState: 'funding_completed',
    liveAvailableCents: 1,
    payoutCents: 1,
  }).reason, 'funding_completed_wallet_available');
  assert.ok(plan.blocked_reasons.includes('wallet_disburse_totp_required'));
});

test('L payout requires wallet.disburse authorization', async () => {
  const ready = await dark({
    liveAvailableCents: 1,
    totpDisbursePresent: true,
    totpDisburseValid: true,
  });
  assert.equal(ready.disburse_authz.disburseAction, MOOV_DISBURSE_TOTP_ACTION);
  assert.equal(ready.disburse_authz.firstTestLegAuthorized, true);
  assert.equal(ready.fund_authz.fundAction, MOOV_FUND_TOTP_ACTION);
  assert.equal(ready.payout_submittable, false);
  assert.equal(ready.transfer_post_enabled, false);
});

test('M pending payout → no duplicate payout', async () => {
  const plan = await dark({
    liveAvailableCents: 1,
    totpDisbursePresent: true,
    totpDisburseValid: true,
    existingRows: [{
      leg_role: 'wallet_disbursement',
      kind: 'wallet_disbursement',
      payout_operation_id: OP,
      idempotency_key: PAYOUT_KEY,
      status: 'pending',
      amount_cents: 1,
      environment: 'production',
      provider_transfer_id: '33333333-3333-4333-8333-333333333333',
    }],
  });
  assert.equal(plan.payout_intent.reused, true);
  assert.equal(plan.payout_state, 'payout_pending');
  assert.equal(plan.payout_submittable, false);
  assert.equal(plan.may_create_second_payout, false);
});

test('N completed payout → replay creates nothing', async () => {
  const store = createMemoryPayoutStore();
  const first = await executeProductionPayoutE2e({
    tenantId: FREEDOM,
    tenantEnvironment: 'production',
    liveAvailableCents: 1,
    recipientVerified: true,
    persistMoneyIntents: true,
    store,
    totpDisbursePresent: true,
    totpDisburseValid: true,
    existingRows: [{
      leg_role: 'wallet_disbursement',
      kind: 'wallet_disbursement',
      payout_operation_id: OP,
      idempotency_key: PAYOUT_KEY,
      status: 'completed',
      amount_cents: 1,
      environment: 'production',
      provider_transfer_id: '44444444-4444-4444-8444-444444444444',
      completed_at: '2026-09-21T19:46:00.803144Z',
    }],
  });
  const replay = await persistProductionIntentCas(store, first.payout_intent);
  assert.equal(first.payout_state, 'payout_completed');
  assert.equal(replay.reused, true);
  assert.equal(replay.created, false);
  assert.equal(first.production_provider_posts, 0);
});

test('O production/sandbox IDs cannot cross', async () => {
  const crossed = await executeProductionWalletFunding({
    binding: {
      sourcePaymentMethodId: PIPELINE_TEST_SANDBOX.achDebitFundPm,
      destinationPaymentMethodId: PIPELINE_TEST_SANDBOX.walletPm,
      amountCents: 1,
      accountId: PIPELINE_TEST_SANDBOX.accountId,
      walletId: PIPELINE_TEST_SANDBOX.walletId,
      bankId: PIPELINE_TEST_SANDBOX.bankId,
      platformAccountId: PIPELINE_TEST_SANDBOX.platformAccountId,
    },
    transferPostEnabled: false,
  });
  assert.equal(crossed.error, 'sandbox_ids_blocked');
  const independent = refuseIndependentMustKeepInvocation('moov-wallet-fund');
  assert.equal(independent.error, 'independent_must_keep_writer_blocked');
});

test('P provider POST flag false → no provider POST', async () => {
  const plan = await dark({
    liveAvailableCents: 0,
    totpFundPresent: true,
    totpFundValid: true,
    transferPostEnabled: false,
  });
  assert.equal(plan.production_provider_posts, 0);
  assert.equal(plan.funding_exec.outcome, 'transfer_post_held');
  assert.equal(plan.funding_exec.liveProviderPosted, false);
  const arm = evaluateOneAuthorizedLegPost({
    productionPostFlag: true,
    sandboxPostFlag: false,
    requestedLeg: 'funding',
    totpAction: MOOV_FUND_TOTP_ACTION,
    totpPresent: true,
    totpValid: true,
    persistDone: true,
    orchestratorAllows: true,
  });
  assert.equal(arm.arm, false);
  assert.equal(arm.reason, 'totp_not_consumed_this_phase');
  assert.equal(CONSUME_TOTP_THIS_PHASE, false);
  assert.equal(PERSIST_MONEY_INTENTS_THIS_PHASE, false);
});

test('Q webhook/GET lifecycle converges on provider completedOn', () => {
  const completedOn = '2026-09-21T19:46:00.803144Z';
  const applied = applyGetFallbackToIntent({
    intent: {
      leg_role: 'wallet_disbursement',
      status: 'pending',
      provider_transfer_id: 'c7026476-42d3-43af-bfd3-6f5c4d6480e7',
    },
    providerStatus: 'completed',
    completedOn,
  });
  assert.equal(applied.intent.status, 'completed');
  assert.equal(applied.intent.completed_at, completedOn);
  assert.equal(applied.createdPaymentTransfer, false);
  const stamp = completedAtFor({
    nextStatus: 'completed',
    providerCompletedAt: completedOn,
    existingCompletedAt: null,
  });
  assert.equal(stamp, completedOn);
  const missing = completedAtFor({ nextStatus: 'completed', providerCompletedAt: null, existingCompletedAt: null });
  assert.equal(missing, null);
  const regress = canTransition('completed', 'pending');
  assert.equal(regress.ok, false);
  assert.equal(webhookMayCreateMoneyIntent(), false);
  assert.equal(getReconciliationMayCreateMoneyIntent(), false);
});

test('production wrapper uses shared orchestratePayout and never requireTotp:false', () => {
  const e2e = sourceOf('../functions/api/providers/production/moov-production-payout-e2e.mjs');
  const primitives = sourceOf('../functions/api/providers/production/moov-production-transfer-primitives.mjs');
  const dispatch = sourceOf('../functions/api/providers/production/moov-dispatch.mjs');
  assert.match(e2e, /orchestratePayout\(/);
  assert.match(e2e, /requireTotp: true/);
  assert.doesNotMatch(e2e, /requireTotp:\s*false/);
  assert.match(e2e, /executeProductionWalletFunding/);
  assert.match(e2e, /executeProductionWalletDisbursement/);
  assert.doesNotMatch(primitives, /orchestratePayout/);
  assert.doesNotMatch(dispatch, /moov-production-payout-e2e/);
  assert.equal(existsSync(path.join(ROOT, 'functions/api/providers/production/moov-wallet-fund.mjs')), false);
  assert.equal(existsSync(path.join(ROOT, 'functions/api/providers/production/moov-wallet-disburse.mjs')), false);
  const general = evaluateFinancialAuthorization({
    operation: 'wallet_fund',
    identityOk: true,
    membershipOk: true,
    roles: ['owner'],
    permissionsActivated: true,
  });
  assert.equal(general.canExecuteProduction, false);
  assert.notEqual(firstTestPayoutOperationId('production'), firstTestPayoutOperationId('sandbox'));
  const race = evaluateProductionPennySweepRace({
    fundingState: 'funding_completed',
    liveAvailableCents: 0,
    payoutCents: 1,
    mayCreateSecondFunding: false,
  });
  assert.equal(race.may_create_second_funding, false);
});

test('code refused if TOTP code is passed into the wrapper', async () => {
  const refused = await dark({ totpCode: '123456' });
  assert.equal(refused.error, 'totp_code_refused');
});

test('M7.14 runner is GET-only dark audit and never posts or writes intents', () => {
  const src = sourceOf('../providers/oneshot/m714-prod-penny-ready-run.mjs');
  assert.match(src, /mode: 'read'/);
  assert.match(src, /persistMoneyIntents: false/);
  assert.match(src, /transferPostEnabled: false/);
  assert.match(src, /STOP BEFORE WRITING/);
  assert.doesNotMatch(src, /requireTotp:\s*false,\s*$/m);
  assert.doesNotMatch(src, /overlayPrepApi/);
  assert.doesNotMatch(src, /update-function-code[\s\S]{0,120}API_FN/);
  assert.doesNotMatch(src, /method:\s*['"]POST['"]\s*,[\s\S]{0,80}\/transfers/);
  assert.doesNotMatch(src, /AWS_MOOV_TRANSFER_POST_ENABLED': 'true'/);
});
