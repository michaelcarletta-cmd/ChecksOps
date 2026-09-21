/**
 * Dark production payment wrapper. Same orchestratePayout machine.
 * Skips the first-test $0.01 cap. Never POSTs. Never persists money intents.
 */
import { evaluatePaymentAuthorizationGrant } from './moov-payout-authorization.mjs';
import { evaluatePaymentAmountLimits } from './moov-payout-limits.mjs';
import {
  CONSUME_TOTP_THIS_PHASE,
  PERSIST_MONEY_INTENTS_THIS_PHASE,
  orchestratePayout,
  payoutOperationIdFor,
} from './moov-payout-orchestrator.mjs';
import { evaluateProductionPennySweepRace } from './moov-production-penny-authz.mjs';
import { KNOWN_APPROVED_MOOV } from './moov-accounts.mjs';

export const M717_PHASE = 'M7.17';
export const PAYMENT_WORKFLOW = 'payment';

const fail = (error, extra = {}) => ({
  ok: false,
  error,
  phase: M717_PHASE,
  workflow: PAYMENT_WORKFLOW,
  liveProviderPosted: false,
  createdPaymentTransfer: false,
  persistMoneyIntents: false,
  first_test_cap_applied: false,
  require_totp: true,
  totp_consumed: false,
  ...extra,
});

export const executeProductionPayment = async ({
  availableCents,
  payoutCents,
  requestedSpeed = 'standard',
  checkRemainingCents = null,
  recipientVerified = false,
  transferPostEnabled = false,
  sandboxTransferPostEnabled = false,
  persistMoneyIntents = PERSIST_MONEY_INTENTS_THIS_PHASE,
  store = null,
  existingRows = [],
  sweepActivity = [],
  environment = 'production',
  tenantId = KNOWN_APPROVED_MOOV.freedom.tenantId,
  recipientId = KNOWN_APPROVED_MOOV.recipient.recipientId,
  recipientPaymentMethodId = KNOWN_APPROVED_MOOV.recipient.achCreditStandardPm,
  userId = null,
  roles = ['owner'],
  identityOk = true,
  membershipOk = true,
  grant = null,
  totpVerified = false,
  labels = null,
  requireTotp = true,
  nowMs = Date.now(),
} = {}) => {
  if (sandboxTransferPostEnabled === true) {
    return fail('sandbox_post_flag_must_stay_false');
  }
  if (CONSUME_TOTP_THIS_PHASE === true) {
    return fail('consume_totp_not_this_phase');
  }
  if (requireTotp !== true) {
    return fail('require_totp_false_forbidden');
  }
  const limits = evaluatePaymentAmountLimits({
    payoutCents,
    requestedSpeed,
    checkRemainingCents,
  });
  if (!limits.ok) return fail(limits.error, limits);

  const env = String(environment || 'production').toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
  const operationId = payoutOperationIdFor({
    tenantId,
    environment: env,
    recipientId,
    payoutCents: limits.payout_cents,
  });
  const authz = evaluatePaymentAuthorizationGrant({
    grant,
    tenantId,
    environment: env,
    userId,
    payoutOperationId: operationId,
    recipientId,
    recipientPaymentMethodId,
    amountCents: limits.payout_cents,
    identityOk,
    membershipOk,
    roles,
    totpVerified,
    nowMs,
  });
  if (!authz.ok) return fail(authz.error, authz);

  const plan = await orchestratePayout({
    availableCents,
    payoutCents: limits.payout_cents,
    recipientVerified,
    totpFundPresent: authz.covers_internal_funding === true,
    totpDisbursePresent: authz.covers_internal_payout === true,
    requireTotp: true,
    transferPostEnabled: transferPostEnabled === true && sandboxTransferPostEnabled !== true,
    persistMoneyIntents: persistMoneyIntents === true,
    store,
    existingRows,
    sweepActivity,
    environment: env,
    tenantId,
    operationId,
    labels,
  });

  const sweep = plan.decision === 'PAYOUT_READY'
    ? {
      payout_ready: true,
      may_create_second_funding: false,
      reason: 'wallet_already_sufficient',
      expected: 'Live wallet covers the authorized payout. No BANK→WALLET transfer.',
      double_fund_protection: true,
    }
    : evaluateProductionPennySweepRace({
      fundingState: plan.funding_state,
      liveAvailableCents: plan.available_cents,
      payoutCents: plan.payout_cents,
      mayCreateSecondFunding: plan.may_create_second_funding,
    });

  return {
    ...plan,
    ok: true,
    phase: M717_PHASE,
    workflow: PAYMENT_WORKFLOW,
    first_test_cap_applied: false,
    liveProviderPosted: false,
    persistMoneyIntents: persistMoneyIntents === true,
    require_totp: true,
    totp_consumed: false,
    authorization: {
      action: authz.action,
      payout_operation_id: operationId,
      amount_cents: limits.payout_cents,
      covers_internal_funding: authz.covers_internal_funding,
      covers_internal_payout: authz.covers_internal_payout,
      second_human_authorization_after_funding: authz.second_human_authorization_after_funding,
      reusable: false,
    },
    limits,
    sweep_race: sweep,
    unknown_no_retry: plan.funding_state === 'funding_unknown' || plan.payout_state === 'payout_unknown',
  };
};
