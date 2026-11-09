import { useWallet } from "@/hooks/useWallet";
import { checksHeaderBalanceView } from "@/lib/payments/operatingBalance";

export const WHITE_LABEL_CHECKS_SUBTITLE = "Manage checks, endorsements & deposits";

/**
 * White-label Checks page subtitle. Shows the WalletOps "Available operating
 * balance" (same hook, same query, same format) in place of the subtitle when
 * the tenant's wallet is available. While the balance is still loading it
 * shows the label with a placeholder bar, so the old subtitle does not flash
 * on a refresh; the subtitle stays only when no balance can be shown.
 * The label and the amount are one sentence, so a screen reader reads
 * "Available operating balance $12,480.35".
 */
export function ChecksHeaderOperatingBalance() {
  const { tenantId, enabled, wallet, isPending, error } = useWallet("operating");
  const view = checksHeaderBalanceView({ tenantId, enabled, isPending, error, wallet });

  if (view.kind === "subtitle") {
    return <p className="text-sm text-muted-foreground">{WHITE_LABEL_CHECKS_SUBTITLE}</p>;
  }

  if (view.kind === "pending") {
    return (
      <p className="text-sm" data-testid="checks-header-operating-balance" aria-busy="true">
        <span className="text-muted-foreground">Available operating balance</span>{" "}
        <span aria-hidden="true" className="ml-1.5 inline-block h-4 w-20 animate-pulse rounded bg-muted align-middle" />
      </p>
    );
  }

  return (
    <p className="text-sm" data-testid="checks-header-operating-balance">
      <span className="text-muted-foreground">Available operating balance</span>{" "}
      <span className="ml-1.5 text-base font-bold tabular-nums text-foreground">{view.amount}</span>
    </p>
  );
}
