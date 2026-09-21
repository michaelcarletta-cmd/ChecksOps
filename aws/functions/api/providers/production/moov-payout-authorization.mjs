/**
 * One business authorization for a complete payout.
 *
 * User-facing action is disbursement.send. Internal wallet.fund and
 * wallet.disburse legs of THAT operation are covered by the durable grant.
 * TOTP codes are never stored. requireTotp stays true.
 */
import { evaluateFinancialAuthorization } from '../../financial-authz.mjs';
import { MOOV_DISBURSE_TOTP_ACTION, MOOV_FUND_TOTP_ACTION } from './moov-first-test.mjs';
import { CONSUME_TOTP_THIS_PHASE } from './moov-payout-orchestrator.mjs';

export const PAYMENT_AUTHORIZATION_ACTION = 'disbursement.send';
export const PAYMENT_AUTHORIZATION_PURPOSE = 'payout';
export const INTERNAL_FUND_ACTION = MOOV_FUND_TOTP_ACTION;
export const INTERNAL_DISBURSE_ACTION = MOOV_DISBURSE_TOTP_ACTION;
export const PAYMENT_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SECOND_HUMAN_AUTHORIZATION_AFTER_FUNDING = false;
export const REQUIRE_TOTP_FALSE_PRODUCTION_PATH = false;

const fail = (error, extra = {}) => ({
  ok: false,
  error,
  authorized: false,
  covers_internal_funding: false,
  covers_internal_payout: false,
  totp_code_stored: false,
  require_totp: true,
  second_human_authorization_after_funding: SECOND_HUMAN_AUTHORIZATION_AFTER_FUNDING,
  ...extra,
});

export const paymentAuthorizationFingerprint = ({
  tenantId,
  environment,
  userId,
  payoutOperationId,
  recipientId,
  recipientPaymentMethodId,
  amountCents,
  purpose = PAYMENT_AUTHORIZATION_PURPOSE,
} = {}) => ([
  String(tenantId || ''),
  String(environment || 'production'),
  String(userId || ''),
  String(payoutOperationId || ''),
  String(recipientId || ''),
  String(recipientPaymentMethodId || ''),
  String(Number(amountCents)),
  String(purpose || PAYMENT_AUTHORIZATION_PURPOSE),
].join(':'));

export const createPaymentAuthorizationGrant = ({
  tenantId,
  environment = 'production',
  userId,
  payoutOperationId,
  recipientId,
  recipientPaymentMethodId,
  amountCents,
  purpose = PAYMENT_AUTHORIZATION_PURPOSE,
  nowMs = Date.now(),
  ttlMs = PAYMENT_GRANT_TTL_MS,
  nonce = null,
} = {}) => {
  const expiresAt = nowMs + Number(ttlMs || PAYMENT_GRANT_TTL_MS);
  return {
    action: PAYMENT_AUTHORIZATION_ACTION,
    tenant_id: tenantId,
    environment: String(environment || 'production'),
    user_id: userId,
    payout_operation_id: payoutOperationId,
    recipient_id: recipientId,
    recipient_payment_method_id: recipientPaymentMethodId || null,
    amount_cents: Number(amountCents),
    purpose,
    expires_at: new Date(expiresAt).toISOString(),
    expires_at_ms: expiresAt,
    nonce: nonce || `grant:${payoutOperationId}:${amountCents}`,
    covers_internal_legs: [INTERNAL_FUND_ACTION, INTERNAL_DISBURSE_ACTION],
    totp_code: null,
    reusable: false,
  };
};

export const grantMatchesPayment = (grant, expected) => {
  if (!grant) return { ok: false, error: 'authorization_missing' };
  const want = paymentAuthorizationFingerprint(expected);
  const have = paymentAuthorizationFingerprint({
    tenantId: grant.tenant_id,
    environment: grant.environment,
    userId: grant.user_id,
    payoutOperationId: grant.payout_operation_id,
    recipientId: grant.recipient_id,
    recipientPaymentMethodId: grant.recipient_payment_method_id,
    amountCents: grant.amount_cents,
    purpose: grant.purpose,
  });
  if (want !== have) {
    return {
      ok: false,
      error: 'authorization_binding_mismatch',
      message: 'Authorization is bound to one payout operation, recipient, and amount and cannot be reused.',
    };
  }
  return { ok: true };
};

export const evaluatePaymentAuthorizationGrant = ({
  grant = null,
  tenantId,
  environment = 'production',
  userId,
  payoutOperationId,
  recipientId,
  recipientPaymentMethodId,
  amountCents,
  purpose = PAYMENT_AUTHORIZATION_PURPOSE,
  identityOk = false,
  membershipOk = false,
  roles = [],
  totpVerified = false,
  nowMs = Date.now(),
} = {}) => {
  const general = evaluateFinancialAuthorization({
    operation: 'disbursement',
    identityOk,
    membershipOk,
    roles,
    permissionsActivated: true,
  });
  if (REQUIRE_TOTP_FALSE_PRODUCTION_PATH === true) {
    return fail('require_totp_false_forbidden');
  }
  if (CONSUME_TOTP_THIS_PHASE === true && !grant) {
    return fail('consume_totp_not_this_phase');
  }
  if (!identityOk || !membershipOk || !general.roleOk) {
    return fail('financial_unauthorized', { roleOk: general.roleOk });
  }
  if (!grant) {
    if (totpVerified !== true) return fail('totp_required', { action: PAYMENT_AUTHORIZATION_ACTION });
    return fail('authorization_grant_required', {
      message: 'A durable operation-scoped grant is required after TOTP. The TOTP code is not stored.',
    });
  }
  if (grant.totp_code) return fail('totp_code_must_not_be_stored');
  const match = grantMatchesPayment(grant, {
    tenantId,
    environment,
    userId,
    payoutOperationId,
    recipientId,
    recipientPaymentMethodId,
    amountCents,
    purpose,
  });
  if (!match.ok) return fail(match.error, match);
  const expiresAt = Number(grant.expires_at_ms || Date.parse(grant.expires_at || '') || 0);
  if (!expiresAt || nowMs > expiresAt) {
    return fail('authorization_expired', { message: 'Payment authorization has expired.' });
  }
  const covers = Array.isArray(grant.covers_internal_legs) ? grant.covers_internal_legs : [];
  const coversFunding = covers.includes(INTERNAL_FUND_ACTION);
  const coversPayout = covers.includes(INTERNAL_DISBURSE_ACTION);
  return {
    ok: true,
    authorized: true,
    action: PAYMENT_AUTHORIZATION_ACTION,
    payout_operation_id: payoutOperationId,
    amount_cents: Number(amountCents),
    covers_internal_funding: coversFunding,
    covers_internal_payout: coversPayout,
    totp_fund_present: coversFunding,
    totp_disburse_present: coversPayout,
    totp_code_stored: false,
    totp_consumed: false,
    require_totp: true,
    second_human_authorization_after_funding: SECOND_HUMAN_AUTHORIZATION_AFTER_FUNDING,
    second_human_authorization_reason:
      'TOTP proves presence for at most minutes. ACH funding can take hours or days. A durable grant bound to this payout operation, recipient, and exact amount covers the internal funding and payout legs. It is not a reusable blank authorization.',
    canExecuteProduction: false,
    reusable: false,
  };
};
