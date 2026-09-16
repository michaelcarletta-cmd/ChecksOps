import { useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Loader2, RefreshCw, Send, Wallet } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { useToast } from "@/hooks/use-toast";
import { useFinancialGuard } from "@/hooks/useFinancialGuard";
import { disburseWalletFirstTest } from "@/lib/payments/wallets";
import {
  FIRST_TEST_AUTHORIZE_HELD_FUND_COPY,
  FIRST_TEST_DISBURSE_COPY,
  FIRST_TEST_DISBURSE_TOTP,
  FIRST_TEST_FUND_COPY,
  FIRST_TEST_FUND_TOTP,
  FIRST_TEST_HELD_MESSAGE,
  FIRST_TEST_TRANSFER_CENTS,
  FIRST_TEST_TRANSFER_LABEL,
  isTransferPostHeld,
  nextFirstTestIdempotencyKey,
} from "@/lib/payments/firstTestMoney";

const money = (cents: number) =>
  (Number(cents || 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const ENTRY_LABEL: Record<string, string> = {
  funding: "Balance funded",
  payout: "Payout",
  settlement_received: "Settlement received",
  fee: "Platform fee",
  adjustment: "Adjustment",
};

/**
 * Organization balance: first-test BANK→WALLET then WALLET→RECIPIENT.
 * Amount is locked at $0.01. Server binds Freedom bank, wallet, and recipient.
 */
export function WalletPanel() {
  const { enabled, tenantId, wallet, ledger, isLoading, error, refetch, fund, setupRequired } =
    useWallet("operating");

  const { toast } = useToast();
  const [disbursePending, setDisbursePending] = useState(false);
  const [authorizeHeldPending, setAuthorizeHeldPending] = useState(false);
  const guardFinancial = useFinancialGuard(tenantId);
  const fundIdempotencyRef = useRef<string | null>(null);
  const disburseIdempotencyRef = useRef<string | null>(null);

  if (!enabled) return null;

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading balance…</div>;
  }

  async function handleFund() {
    try {
      await guardFinancial(FIRST_TEST_FUND_TOTP, {
        description: "Enter the current 6-digit code from your authenticator app to authorize BANK→WALLET funding.",
      });
      fundIdempotencyRef.current = nextFirstTestIdempotencyKey(fundIdempotencyRef.current);
      await fund.mutateAsync({
        amountCents: FIRST_TEST_TRANSFER_CENTS,
        description: "Balance funding",
        idempotencyKey: fundIdempotencyRef.current,
      });
      fundIdempotencyRef.current = null;
      toast({ title: "Funding started", description: "Your balance updates once the transfer settles." });
    } catch (e) {
      if (isTransferPostHeld(e)) {
        fundIdempotencyRef.current = null;
        toast({ title: "Dark funding intent recorded", description: FIRST_TEST_HELD_MESSAGE });
        return;
      }
      toast({ title: "Could not fund balance", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function handleAuthorizeHeldFund() {
    try {
      setAuthorizeHeldPending(true);
      await guardFinancial(FIRST_TEST_FUND_TOTP, {
        description: "Enter the current 6-digit code from your authenticator app to authorize the held $0.01 BANK→WALLET intent. This does not move money and does not create a new intent.",
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
      setAuthorizeHeldPending(false);
    }
  }

  async function handleDisburse() {
    try {
      setDisbursePending(true);
      await guardFinancial(FIRST_TEST_DISBURSE_TOTP, {
        description: "Enter the current 6-digit code from your authenticator app to authorize WALLET→RECIPIENT.",
      });
      disburseIdempotencyRef.current = nextFirstTestIdempotencyKey(disburseIdempotencyRef.current);
      await disburseWalletFirstTest({
        tenantId,
        idempotencyKey: disburseIdempotencyRef.current,
      });
      disburseIdempotencyRef.current = null;
      toast({
        title: "Wallet send submitted",
        description: "Server-bound $0.01 WALLET→RECIPIENT. Moov POST stays held until Test A is armed.",
      });
    } catch (e) {
      if (isTransferPostHeld(e)) {
        disburseIdempotencyRef.current = null;
        toast({ title: "Dark wallet send intent recorded", description: FIRST_TEST_HELD_MESSAGE });
        return;
      }
      toast({ title: "Could not send from wallet", description: (e as Error).message, variant: "destructive" });
    } finally {
      setDisbursePending(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-4 w-4" />
            Organization balance
          </CardTitle>
          <CardDescription>
            First-test Moov send is locked at {FIRST_TEST_TRANSFER_LABEL}. Server binds Freedom bank, wallet, and recipient.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="mr-2 h-3.5 w-3.5" />
          Refresh
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && !setupRequired && (
          <p className="text-sm text-destructive">{error.message}</p>
        )}
        {setupRequired && (
          <p className="text-sm text-muted-foreground">
            Your balance activates once your payment account finishes setup and approval. You can
            keep paying directly from your bank in the meantime.
          </p>
        )}

        <div className="flex flex-wrap items-end gap-6">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Available</p>
            <p className="text-2xl font-semibold">
              {wallet?.status === "sync_failed" ? "Balance unavailable" : money(wallet?.available_cents ?? 0)}
            </p>
          </div>
          {!!wallet?.pending_cents && wallet?.status !== "sync_failed" && (
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Pending</p>
              <p className="text-lg">{money(wallet.pending_cents)}</p>
            </div>
          )}
          <Badge
            variant="outline"
            className={
              wallet?.status === "active"
                ? "border-emerald-500/40 text-emerald-500"
                : wallet?.status === "sync_failed"
                ? "border-amber-500/40 text-amber-500"
                : "border-muted-foreground/30 text-muted-foreground"
            }
          >
            {wallet?.status === "active"
              ? "Active"
              : wallet?.status === "sync_failed"
              ? "Pending Sync"
              : wallet?.status ?? "Not set up"}
          </Badge>
        </div>

        <Separator />

        <p className="text-xs text-muted-foreground">{FIRST_TEST_FUND_COPY}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="text"
            inputMode="decimal"
            readOnly
            value={FIRST_TEST_TRANSFER_LABEL}
            className="w-44"
            disabled={setupRequired}
            aria-label="First-test fund amount locked at $0.01"
          />
          <Button onClick={handleFund} disabled={fund.isPending || setupRequired || disbursePending || authorizeHeldPending}>
            {fund.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Add {FIRST_TEST_TRANSFER_LABEL} from bank
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={handleAuthorizeHeldFund}
            disabled={fund.isPending || setupRequired || disbursePending || authorizeHeldPending}
          >
            {authorizeHeldPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Authorize held {FIRST_TEST_TRANSFER_LABEL} fund
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{FIRST_TEST_AUTHORIZE_HELD_FUND_COPY}</p>

        <p className="text-xs text-muted-foreground">{FIRST_TEST_DISBURSE_COPY}</p>
        <Button
          variant="outline"
          onClick={handleDisburse}
          disabled={fund.isPending || setupRequired || disbursePending || authorizeHeldPending}
        >
          {disbursePending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
          <Send className="mr-2 h-3.5 w-3.5" />
          Send {FIRST_TEST_TRANSFER_LABEL} from wallet
        </Button>

        {ledger.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Recent activity</p>
            <div className="divide-y rounded-md border">
              {ledger.slice(0, 8).map((entry) => (
                <div key={entry.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <div>
                    <p>{ENTRY_LABEL[entry.entry_type] ?? entry.entry_type}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(entry.created_at).toLocaleString()}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={entry.direction === "credit" ? "text-emerald-500" : "text-foreground"}>
                      {entry.direction === "credit" ? "+" : "−"}
                      {money(entry.amount_cents)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Balance {money(entry.balance_after_cents)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
