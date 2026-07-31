/**
 * Deposit rail visibility.
 *
 * CheckAlt (FinCapture RDC) is the DEPOSIT rail. It is deliberately
 * independent of the disbursement rail/provider (Actum, Plaid, Moov):
 * money coming IN via mobile deposit has nothing to do with how money
 * goes OUT. CheckAlt must therefore NEVER be hidden because a tenant is
 * on Actum (or any other disbursement provider).
 *
 * This flag exists only as a platform kill-switch and stays `true`.
 * Never gate CheckAlt UI on `usePaymentRail()` / `payment_provider`.
 */
export const SHOW_CHECKALT = true;

/**
 * CheckAlt UI visibility. Takes no rail/provider argument on purpose —
 * the deposit rail is never suppressed by the disbursement rail.
 */
export function isCheckAltVisible(): boolean {
  return SHOW_CHECKALT;
}
