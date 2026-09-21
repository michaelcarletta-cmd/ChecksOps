/**
 * Real-amount payment limits for the normal payout workflow.
 * Never splits a payment into multiple transfers to bypass a ceiling.
 * First-test $0.01 cap is not applied here.
 */
import {
  MAX_PROVIDER_AMOUNT_CENTS,
  MIN_PROVIDER_AMOUNT_CENTS,
  validateProviderCents,
} from '../amounts.mjs';

/** RTP network per-transfer ceiling ($1,000,000). Same as supabase railRouter. */
export const RTP_MAX_CENTS = 100_000_000;
/** NACHA same-day ACH per-transfer ceiling ($1,000,000). */
export const SAME_DAY_MAX_CENTS = 100_000_000;
/** Standard ACH uses the provider ceiling. No separate ChecksOps daily limit exists. */
export const ACH_STANDARD_MAX_CENTS = MAX_PROVIDER_AMOUNT_CENTS;

export const PAYMENT_LIMIT_SOURCES = Object.freeze([
  'MIN_PROVIDER_AMOUNT_CENTS',
  'MAX_PROVIDER_AMOUNT_CENTS',
  'RTP_MAX_CENTS',
  'SAME_DAY_MAX_CENTS',
  'ACH_STANDARD_MAX_CENTS',
  'check_remaining_cents',
  'financial_role',
]);

const fail = (error, extra = {}) => ({
  ok: false,
  error,
  blocked: true,
  split: false,
  ...extra,
});

export const normalizeRequestedSpeed = (value) => {
  const v = String(value ?? 'standard').toLowerCase().replace(/[\s-]/g, '_');
  if (v === 'instant' || v === 'rtp' || v === 'fednow') return 'instant';
  if (v === 'same_day' || v === 'sameday') return 'same_day';
  return 'standard';
};

export const railLimitCentsForSpeed = (speed) => {
  const normalized = normalizeRequestedSpeed(speed);
  if (normalized === 'instant') return RTP_MAX_CENTS;
  if (normalized === 'same_day') return SAME_DAY_MAX_CENTS;
  return ACH_STANDARD_MAX_CENTS;
};

/**
 * Block (never split) when the authorized payout exceeds an applicable limit.
 */
export const evaluatePaymentAmountLimits = ({
  payoutCents,
  requestedSpeed = 'standard',
  checkRemainingCents = null,
} = {}) => {
  const cents = Number(payoutCents);
  const provider = validateProviderCents(Number.isInteger(cents) ? cents : NaN);
  if (provider.error) {
    return fail(provider.error, {
      message: provider.message,
      payout_cents: cents,
      source: 'MAX_PROVIDER_AMOUNT_CENTS',
      min_cents: MIN_PROVIDER_AMOUNT_CENTS,
      max_cents: MAX_PROVIDER_AMOUNT_CENTS,
    });
  }
  const speed = normalizeRequestedSpeed(requestedSpeed);
  const railMax = railLimitCentsForSpeed(speed);
  if (provider.cents > railMax) {
    const error = speed === 'instant'
      ? 'amount_exceeds_rtp_limit'
      : (speed === 'same_day' ? 'amount_exceeds_same_day_limit' : 'amount_exceeds_ach_limit');
    return fail(error, {
      message: `Amount exceeds the ${speed} rail limit. The payment is blocked and will not be split.`,
      payout_cents: provider.cents,
      limit_cents: railMax,
      requested_speed: speed,
      source: speed === 'instant' ? 'RTP_MAX_CENTS' : (speed === 'same_day' ? 'SAME_DAY_MAX_CENTS' : 'ACH_STANDARD_MAX_CENTS'),
    });
  }
  if (checkRemainingCents != null) {
    const remaining = Number(checkRemainingCents);
    if (Number.isFinite(remaining) && provider.cents > remaining) {
      return fail('amount_exceeds_check_remaining', {
        message: 'Amount exceeds the remaining amount on this check. The payment is blocked and will not be split.',
        payout_cents: provider.cents,
        limit_cents: remaining,
        source: 'check_remaining_cents',
      });
    }
  }
  return {
    ok: true,
    blocked: false,
    split: false,
    payout_cents: provider.cents,
    requested_speed: speed,
    rail_limit_cents: railMax,
    provider_max_cents: MAX_PROVIDER_AMOUNT_CENTS,
    provider_min_cents: MIN_PROVIDER_AMOUNT_CENTS,
    sources: PAYMENT_LIMIT_SOURCES,
  };
};
