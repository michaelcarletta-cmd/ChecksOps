import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useFinancialGuard } from "@/hooks/useFinancialGuard";
import { useWallet } from "@/hooks/useWallet";
import {
  FIRST_TEST_AUTHORIZE_HELD_BUTTON,
  FIRST_TEST_AUTHORIZE_HELD_FUND_COPY,
  FIRST_TEST_FUND_TOTP,
} from "@/lib/payments/firstTestMoney";

/**
 * TOTP-only authorization for the existing held $0.01 BANK→WALLET intent.
 * Does not insert payment_transfers, does not call the fund writer,
 * and does not click Add/Transfer.
 */
export function AuthorizeHeldFundControl({
  disabled = false,
  compact = false,
}: {
  disabled?: boolean;
  compact?: boolean;
}) {
  const { tenantId, enabled, setupRequired } = useWallet("operating");
  const { toast } = useToast();
  const guardFinancial = useFinancialGuard(tenantId);
  const [pending, setPending] = useState(false);

  if (!enabled) return null;

  async function authorizeHeldFund() {
    try {
      setPending(true);
      await guardFinancial(FIRST_TEST_FUND_TOTP, {
        description:
          "Enter the current 6-digit code from your authenticator app to authorize the held $0.01 BANK→WALLET intent. This does not move money and does not create a new intent.",
      });
      toast({
        title: "Held $0.01 fund authorized",
        description: "wallet.fund Financial TOTP was recorded. Do not click Add $0.01 from bank.",
      });
    } catch (e) {
      toast({
        title: "Could not authorize held fund",
        description: (e as Error).message,
        variant: "destructive",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={compact ? "space-y-2" : "space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3"}>
      <p className="text-xs text-muted-foreground">{FIRST_TEST_AUTHORIZE_HELD_FUND_COPY}</p>
      <Button
        type="button"
        variant="secondary"
        onClick={authorizeHeldFund}
        disabled={disabled || setupRequired || pending}
      >
        {pending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
        {FIRST_TEST_AUTHORIZE_HELD_BUTTON}
      </Button>
    </div>
  );
}
