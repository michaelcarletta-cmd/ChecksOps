import { AuthentecheckVerification } from "./AuthentecheckVerification";
import { AlertCircle } from "lucide-react";

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
 * Picks the bank-verification widget.
 * 
 * Actum/Authentecheck is legacy. Moov is the primary rail.
 */
export function BankVerification({ verificationSource, ...props }: Props) {
  const alreadyVerified =
    props.verificationStatus === "verified" || props.verificationStatus === "admin_override";

  if (alreadyVerified) {
    // Keep showing verification status for historical accounts
    return <AuthentecheckVerification {...props} />;
  }

  // If not verified, and it's not a Moov-supported verification (which happens 
  // via MoovBankLink/MicroDepositVerification elsewhere), show a placeholder.
  return (
    <div className="flex items-center gap-2 p-3 rounded-md bg-muted/50 border border-dashed text-xs text-muted-foreground">
      <AlertCircle className="h-4 w-4" />
      Verification currently unavailable. Please contact support to link this account.
    </div>
  );
}
