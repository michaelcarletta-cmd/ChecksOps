import { AuthentecheckVerification } from "./AuthentecheckVerification";
import { PlaidVerification } from "./PlaidVerification";
import { usePaymentRail } from "@/hooks/usePaymentRail";

interface Props {
  accountId: string;
  accountNickname: string;
  accountLast4: string;
  verificationStatus: string;
  /** Emailed verification token — set when an external account holder is linking. */
  publicToken?: string;
  /** Which rail verified this account already, if any. */
  verificationSource?: string | null;
  onVerified?: () => void;
}

/**
 * Picks the bank-verification widget for the tenant's active payment rail.
 *
 * Accounts already verified through Authentecheck keep working untouched —
 * they render the Authentecheck widget (which just shows a "Verified" badge)
 * regardless of the tenant's current rail. Only new or failed verifications
 * follow the tenant's rail.
 */
export function BankVerification({ verificationSource, ...props }: Props) {
  // Plaid is hidden/disabled
  const isPlaid = false;
  
  const alreadyVerified =
    props.verificationStatus === "verified" || props.verificationStatus === "admin_override";

  // Don't re-route an account that a rail already verified.
  if (alreadyVerified && (verificationSource === "authentecheck" || verificationSource === "moov")) {
    return <AuthentecheckVerification {...props} />;
  }

  // Always fall back to Authentecheck (or Moov in future) instead of Plaid Link
  return <AuthentecheckVerification {...props} />;
}
