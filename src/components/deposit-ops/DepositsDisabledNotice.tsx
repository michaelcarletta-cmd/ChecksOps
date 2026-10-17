import { Ban } from "lucide-react";
import { DEPOSITS_DISABLED_MESSAGE } from "@/lib/tenantDeposits";

/** Shown wherever a tenant's deposit actions are disabled by the deposits switch. */
export function DepositsDisabledNotice({ className = "" }: { className?: string }) {
  return (
    <div
      role="alert"
      data-testid="deposits-disabled-notice"
      className={`flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive ${className}`}
    >
      <Ban className="h-4 w-4 mt-0.5 shrink-0" />
      <span>{DEPOSITS_DISABLED_MESSAGE}</span>
    </div>
  );
}
