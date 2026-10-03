/** Tracking-link eligibility is claim-scoped and independent of payment/deposit. */

import { resolveAuthoritativeClaimId } from "@/lib/checkClaimLinkGuard";

export const HOMEOWNER_TRACKING_LINK_DISABLED_REASON = "missing_claim_id" as const;

export const HOMEOWNER_TRACKING_LINK_DISABLED_MESSAGE =
  "Link this check to a claim first";

/** Same cache key as Claim Ledger so a live link immediately enables tracking. */
export function homeownerTrackingLinkQueryKey(checkIntakeItemId: string) {
  return ["claim-ledger-check-link", checkIntakeItemId] as const;
}

export function evaluateHomeownerTrackingLinkEligibility(opts: {
  claimId?: string | null;
  liveCheckClaimId?: string | null;
  /** Ignored. Deposit is not a tracking-link gate. */
  deposited?: boolean;
  /** Ignored. Homeowner bank verification is payment-link only. */
  bankVerified?: boolean;
  /** Ignored. Disbursement readiness is not a tracking-link gate. */
  payoutEnabled?: boolean;
}) {
  const claimId = resolveAuthoritativeClaimId({
    liveCheckClaimId: opts.liveCheckClaimId ?? null,
    loadedClaimId: null,
    claimIdProp: opts.claimId ?? null,
  });
  if (!claimId) {
    return {
      enabled: false as const,
      claimId: null,
      reason: HOMEOWNER_TRACKING_LINK_DISABLED_REASON,
      message: HOMEOWNER_TRACKING_LINK_DISABLED_MESSAGE,
    };
  }
  return {
    enabled: true as const,
    claimId,
    reason: null,
    message: null,
  };
}

/** Payment-link CTA is check-scoped. It does not require claim_id or deposit. */
export function evaluateHomeownerPaymentLinkEligibility(opts: {
  readOnly?: boolean;
}) {
  if (opts.readOnly) {
    return { enabled: false as const, reason: "read_only" as const };
  }
  return { enabled: true as const, reason: null };
}
