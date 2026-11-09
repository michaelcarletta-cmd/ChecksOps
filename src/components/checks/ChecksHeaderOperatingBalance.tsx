import { useWallet } from "@/hooks/useWallet";
import { checksHeaderOperatingBalance } from "@/lib/payments/operatingBalance";

export const WHITE_LABEL_CHECKS_SUBTITLE = "Manage checks, endorsements & deposits";

/**
 * White-label Checks page subtitle. Shows the WalletOps "Available operating
 * balance" (same hook, same query, same format) in place of the subtitle when
 * the tenant's wallet is available; otherwise the subtitle stays as it was.
 * The label and the amount are one sentence, so a screen reader reads
 * "Available operating balance $12,480.35".
 */
export function ChecksHeaderOperatingBalance() {
  const { enabled, wallet, isLoading, error } = useWallet("operating");
  const amount = checksHeaderOperatingBalance({ enabled, isLoading, error, wallet });

  if (!amount) {
    return <p className="text-sm text-muted-foreground">{WHITE_LABEL_CHECKS_SUBTITLE}</p>;
  }

  return (
    <p className="text-sm" data-testid="checks-header-operating-balance">
      <span className="text-muted-foreground">Available operating balance</span>{" "}
      <span className="ml-1.5 text-base font-bold tabular-nums text-foreground">{amount}</span>
    </p>
  );
}
