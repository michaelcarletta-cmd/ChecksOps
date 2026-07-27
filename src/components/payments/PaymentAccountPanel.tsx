import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Banknote, CreditCard, ShieldCheck, RefreshCw } from "lucide-react";
import { usePaymentAccount } from "@/hooks/usePaymentAccount";
import {
  BANK_STATUS_LABEL,
  PAYMENT_STATUS_LABEL,
  VERIFICATION_STATUS_LABEL,
  type PaymentAccountStatus,
} from "@/lib/payments/types";

const STATUS_CLASS: Record<PaymentAccountStatus, string> = {
  not_connected: "border-muted-foreground/30 text-muted-foreground",
  pending_verification: "border-amber-500/40 text-amber-500",
  verification_required: "border-amber-500/40 text-amber-500",
  active: "border-emerald-500/40 text-emerald-500",
  suspended: "border-destructive/40 text-destructive",
};

/**
 * Provider-neutral payment account summary. Deliberately never names the
 * underlying rail — the same panel serves every provider.
 */
export function PaymentAccountPanel() {
  const { account, isLoading } = usePaymentAccount();

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading payment account…</div>;
  }

  const status = account?.status ?? "not_connected";

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <CreditCard className="h-4 w-4 text-primary" />
          Connected Payment Account
        </CardTitle>
        <CardDescription className="text-xs">
          Your organization's payment account and connected bank. Funds stay in your own bank
          account until you send a payment.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Payment Status</span>
          <Badge variant="outline" className={`text-[10px] ${STATUS_CLASS[status]}`}>
            {PAYMENT_STATUS_LABEL[status]}
          </Badge>
        </div>

        <Separator />

        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" /> Verification
          </span>
          <span className="text-xs">
            {VERIFICATION_STATUS_LABEL[account?.verificationStatus ?? "not_started"]}
          </span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Banknote className="h-3.5 w-3.5" /> Connected Bank
          </span>
          <span className="text-xs">
            {account?.bankName
              ? `${account.bankName}${account.bankLastFour ? ` ••${account.bankLastFour}` : ""}`
              : BANK_STATUS_LABEL[account?.bankConnectionStatus ?? "not_connected"]}
          </span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" /> Last Sync
          </span>
          <span className="text-xs">
            {account?.lastSync ? new Date(account.lastSync).toLocaleString() : "—"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
