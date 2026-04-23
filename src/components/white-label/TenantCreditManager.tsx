import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenantFilter } from "@/hooks/useTenantFilter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { AlertTriangle, Coins, CreditCard, History, Loader2, ShieldAlert, Zap } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

interface CreditPack {
  credits: number;
  price: number;
  label: string;
  description: string;
  popular?: boolean;
}

const CREDIT_PACKS: CreditPack[] = [
  { credits: 50, price: 25, label: "Starter", description: "~50 check scans" },
  { credits: 150, price: 50, label: "Standard", description: "~150 check scans" },
  { credits: 500, price: 100, label: "Bulk", description: "~500 check scans", popular: true },
];

export function TenantCreditManager() {
  const { tenantId } = useTenantFilter();
  const { toast } = useToast();
  const qc = useQueryClient();

  // Current balance
  const { data: balance, isLoading: balLoading } = useQuery({
    queryKey: ["tenant-credit-balance", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_credit_balances")
        .select("*")
        .eq("tenant_id", tenantId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!tenantId,
  });

  // Transaction history
  const { data: transactions = [] } = useQuery({
    queryKey: ["tenant-credit-transactions", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenant_credit_transactions")
        .select("*")
        .eq("tenant_id", tenantId!)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!tenantId,
  });

  // Purchase credits (for now simulates — will integrate Stripe later)
  const purchaseMutation = useMutation({
    mutationFn: async (pack: typeof CREDIT_PACKS[number]) => {
      if (!balance?.has_payment_method) {
        throw new Error("Please add a payment method (credit card or bank account) in the Banking tab before purchasing credits.");
      }
      // For now, add credits directly — real Stripe integration coming
      const newBalance = (balance?.balance ?? 0) + pack.credits;
      const { error: updateErr } = await supabase
        .from("tenant_credit_balances")
        .update({
          balance: newBalance,
          lifetime_purchased: (balance?.lifetime_purchased ?? 0) + pack.credits,
          updated_at: new Date().toISOString(),
        })
        .eq("tenant_id", tenantId!);
      if (updateErr) throw updateErr;

      const { error: txErr } = await supabase
        .from("tenant_credit_transactions")
        .insert({
          tenant_id: tenantId!,
          transaction_type: "purchase",
          amount: pack.credits,
          balance_after: newBalance,
          description: `Purchased ${pack.label} pack — ${pack.credits} credits ($${pack.price})`,
          reference_type: "manual_purchase",
        });
      if (txErr) throw txErr;
    },
    onSuccess: () => {
      toast({ title: "Credits purchased!" });
      qc.invalidateQueries({ queryKey: ["tenant-credit-balance", tenantId] });
      qc.invalidateQueries({ queryKey: ["tenant-credit-transactions", tenantId] });
    },
    onError: (e: any) => {
      toast({ title: "Purchase failed", description: e.message, variant: "destructive" });
    },
  });

  const currentBalance = balance?.balance ?? 0;
  const isLow = currentBalance < 10;
  const isEmpty = currentBalance === 0;

  return (
    <div className="space-y-6">
      {/* Disclaimer */}
      <Card className="border-amber-500/30 bg-amber-500/5">
        <CardContent className="pt-4 pb-3">
          <div className="flex items-start gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
            <div className="text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-amber-300">AI Usage Disclaimer</p>
              <p>
                AI processing credits are billed separately per tenant. Freedom Claims Group is not responsible 
                for AI usage costs incurred by your organization. Each check processed through the system consumes 
                approximately 1 credit for OCR, matching, and eligibility analysis. You are solely responsible for 
                maintaining a sufficient credit balance and for all charges associated with your account's AI usage.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Balance card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Coins className="h-4 w-4" /> Credit Balance
          </CardTitle>
        </CardHeader>
        <CardContent>
          {balLoading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <div className="space-y-3">
              <div className="flex items-baseline gap-3">
                <span className={`text-3xl font-bold tabular-nums ${isEmpty ? "text-destructive" : isLow ? "text-amber-400" : "text-emerald-400"}`}>
                  {currentBalance.toLocaleString()}
                </span>
                <span className="text-sm text-muted-foreground">credits remaining</span>
              </div>
              {(isEmpty || isLow) && (
                <div className={`flex items-center gap-1.5 text-xs ${isEmpty ? "text-destructive" : "text-amber-400"}`}>
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {isEmpty ? "No credits remaining — check processing is paused" : "Low credit balance — consider purchasing more"}
                </div>
              )}
              <div className="grid grid-cols-3 gap-3 text-center pt-2">
                <div>
                  <div className="text-lg font-semibold tabular-nums">{(balance?.lifetime_purchased ?? 0).toLocaleString()}</div>
                  <div className="text-[10px] text-muted-foreground">Total Purchased</div>
                </div>
                <div>
                  <div className="text-lg font-semibold tabular-nums">{(balance?.lifetime_used ?? 0).toLocaleString()}</div>
                  <div className="text-[10px] text-muted-foreground">Total Used</div>
                </div>
                <div>
                  <div className="text-lg font-semibold tabular-nums">
                    {balance?.has_payment_method ? "✓" : "—"}
                  </div>
                  <div className="text-[10px] text-muted-foreground">Payment Method</div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Payment method notice */}
      {!balance?.has_payment_method && (
        <Card className="border-border/60">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-start gap-2">
              <CreditCard className="h-4 w-4 text-muted-foreground mt-0.5" />
              <div className="text-xs text-muted-foreground">
                <p className="font-medium text-foreground">Payment method required</p>
                <p>Add a credit card or bank account in the <strong>Banking</strong> tab to enable credit purchases. 
                Your linked bank account can also be used as a payment method.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Credit packs */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Zap className="h-4 w-4" /> Purchase Credits
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-4">
            Each credit covers approximately 1 check scan (OCR + claim matching + eligibility check).
          </p>
          <div className="grid gap-3">
            {CREDIT_PACKS.map((pack) => (
              <div
                key={pack.credits}
                className={`flex items-center justify-between rounded-lg border px-4 py-3 ${
                  pack.popular ? "border-primary/50 bg-primary/5" : "border-border/60"
                }`}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{pack.label}</span>
                    {pack.popular && <Badge className="text-[9px] px-1.5 py-0">Best Value</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {pack.credits} credits · {pack.description}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={pack.popular ? "default" : "outline"}
                  disabled={purchaseMutation.isPending}
                  onClick={() => purchaseMutation.mutate(pack)}
                >
                  {purchaseMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    `$${pack.price}`
                  )}
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Transaction history */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <History className="h-4 w-4" /> Transaction History
          </CardTitle>
        </CardHeader>
        <CardContent>
          {transactions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No transactions yet.</p>
          ) : (
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {transactions.map((tx: any) => (
                <div key={tx.id} className="flex items-center justify-between text-xs py-1.5 border-b border-border/30 last:border-0">
                  <div>
                    <span className="text-foreground">{tx.description || tx.transaction_type}</span>
                    <span className="text-muted-foreground ml-2">
                      {format(new Date(tx.created_at), "MMM d, h:mm a")}
                    </span>
                  </div>
                  <span className={`font-mono font-medium ${tx.amount > 0 ? "text-emerald-400" : "text-destructive"}`}>
                    {tx.amount > 0 ? "+" : ""}{tx.amount}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
