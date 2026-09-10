/**
 * Authoritative recipient READY predicate.
 * last4, bank_linked_at, and locally stored bank metadata are NEVER sufficient.
 */

const VERIFIED = new Set(['verified']);
const ACH_RECEIVE = new Set(['ach-credit-standard', 'ach-credit-same-day']);

const statusOf = (value) => String(value || '').toLowerCase();

export const liveTosAccepted = (account = {}) => Boolean(
  account?.termsOfService?.acceptedDate
  || account?.termsOfService?.acceptedOn
  || account?.termsOfService?.accepted,
);

export const liveVerificationStatus = (account = {}) => statusOf(
  account?.verification?.status
  || account?.verificationStatus
  || account?.profile?.individual?.verification?.status
  || account?.profile?.business?.verification?.status,
);

export const liveBankVerified = (banks = []) => (banks || []).some((row) => {
  const status = statusOf(row?.verificationStatus || row?.status || row?.verification_status);
  return VERIFIED.has(status);
});

export const liveEligibleReceiveMethod = (methods = []) => (methods || []).some((row) => {
  const type = statusOf(row?.paymentMethodType || row?.type);
  const status = statusOf(row?.status);
  const enabled = status === 'enabled' || status === 'active' || status === '';
  return ACH_RECEIVE.has(type) && enabled;
});

export const liveBlockingRequirements = (account = {}, capabilities = []) => {
  const requirements = account?.requirements;
  const present = Boolean(
    (Array.isArray(requirements) && requirements.length)
    || requirements?.currentlyDue?.length
    || requirements?.errors?.length
    || account?.verification?.details,
  );
  const erroredCaps = (capabilities || []).filter((row) => {
    const status = statusOf(row?.status);
    return status === 'errored' || status === 'disabled';
  });
  return { present, errored_capabilities: erroredCaps.map((row) => row.capability || row?.capabilityID || row?.id) };
};

/**
 * Exact READY predicate for a payee / stakeholder.
 * Uses live Moov payloads only. Local RDS last4 / bank_linked_at are ignored.
 */
export const evaluateRecipientReady = ({
  account = null,
  banks = [],
  paymentMethods = [],
  capabilities = [],
} = {}) => {
  const blocked = [];
  const action = [];
  const ignoredLocal = ['last4', 'bank_linked_at', 'provider_bank_name', 'onboarding_status'];
  if (!account) {
    return {
      ready: false,
      verdict: 'RECIPIENT_NOT_CONFIRMED',
      reasons: ['account_missing'],
      blocked: ['account_missing'],
      action: [],
      ignored_local_fields: ignoredLocal,
    };
  }
  const mode = statusOf(account.mode || account.environment);
  if (mode && mode !== 'production') blocked.push('not_production');
  if (account.disabled === true) blocked.push('disabled');
  if (account.restricted === true) blocked.push('restricted');
  const verification = liveVerificationStatus(account);
  if (verification !== 'verified') action.push(`verification_${verification || 'unverified'}`);
  if (!liveTosAccepted(account)) action.push('tos_not_accepted');
  if (!liveBankVerified(banks)) action.push('bank_not_verified');
  if (!liveEligibleReceiveMethod(paymentMethods)) action.push('receive_payment_method_missing');
  const requirements = liveBlockingRequirements(account, capabilities);
  if (requirements.present) action.push('requirements_present');
  if (requirements.errored_capabilities.length) blocked.push('capability_errored');

  const reasons = [...blocked, ...action];
  const ready = blocked.length === 0 && action.length === 0;
  return {
    ready,
    verdict: ready ? 'RECIPIENT_READY' : (blocked.length ? 'RECIPIENT_BLOCKED' : 'RECIPIENT_NOT_CONFIRMED'),
    reasons,
    blocked,
    action,
    ignored_local_fields: ignoredLocal,
    live: {
      mode: account.mode || null,
      verification,
      tos_accepted: liveTosAccepted(account),
      bank_verified: liveBankVerified(banks),
      receive_method: liveEligibleReceiveMethod(paymentMethods),
      disabled: Boolean(account.disabled),
      restricted: Boolean(account.restricted),
      requirements: requirements.present,
    },
  };
};

/**
 * Single live class for M6 diagnosis. Local last4 / bank_linked_at never make READY.
 * Priority: restricted → action_required → kyc → tos → bank → payment method.
 */
export const classifyLiveRecipientClass = ({
  local = {},
  evaluation = {},
  banks = [],
} = {}) => {
  if (evaluation.ready === true) return 'READY';
  const blocked = evaluation.blocked || [];
  const action = evaluation.action || [];
  const reasons = evaluation.reasons || [];
  if (blocked.includes('disabled') || blocked.includes('restricted')) return 'RESTRICTED';
  if (action.includes('requirements_present') || blocked.includes('capability_errored')) return 'ACTION_REQUIRED';
  if (action.some((row) => String(row).startsWith('verification_') && row !== 'verification_verified')) {
    return 'AWAITING_KYC';
  }
  if (action.includes('tos_not_accepted')) return 'AWAITING_TOS';
  const localLast4 = String(local.provider_last_four || local.last4 || '').replace(/\D/g, '');
  const localClaimsBank = Boolean(local.bank_linked_at) || localLast4.length === 4;
  const liveBankCount = (banks || []).length;
  if (reasons.includes('account_missing')) {
    return localClaimsBank ? 'BROKEN_LOCAL_SYNC' : 'OTHER_BLOCKER';
  }
  if (action.includes('bank_not_verified')) {
    if (liveBankCount === 0) {
      if (localClaimsBank) return 'BROKEN_LOCAL_SYNC';
      return 'AWAITING_BANK';
    }
    return 'BANK_UNVERIFIED';
  }
  if (action.includes('receive_payment_method_missing')) return 'NO_ELIGIBLE_PAYMENT_METHOD';
  if (blocked.includes('not_production') || reasons.includes('account_missing')) return 'OTHER_BLOCKER';
  return 'OTHER_BLOCKER';
};

export const explainAwaitingBank = ({ local = {}, live = {} } = {}) => {
  const localLast4 = String(local.provider_last_four || local.last4 || '').replace(/\D/g, '');
  const localLinked = Boolean(local.bank_linked_at);
  const evaluation = evaluateRecipientReady(live);
  return {
    local_onboarding_status: local.onboarding_status || null,
    local_last4_present: localLast4.length === 4,
    local_bank_linked_at: Boolean(localLinked),
    local_insufficient_for_ready: true,
    live: evaluation,
    likely_cause: evaluation.action.includes('bank_not_verified')
      ? 'moov_bank_not_verified'
      : evaluation.action.includes('receive_payment_method_missing')
        ? 'payment_method_not_enabled'
        : evaluation.action.includes('tos_not_accepted')
          ? 'tos_not_accepted'
          : evaluation.action.find((row) => row.startsWith('verification_'))
            ? 'identity_not_verified'
            : evaluation.blocked[0] || evaluation.action[0] || 'unknown',
  };
};
