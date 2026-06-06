import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { AlertTriangle, CheckCircle2, Send, Building2, Loader2, RefreshCw, Zap, Clock, History } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { CheckStakeholdersManager } from "./CheckStakeholdersManager";

interface Props {
  checkIntakeItemId?: string;
  depositItemId?: string;
  checkAmount: number;
  checkNumber?: string;
  carrierName?: string;
  onComplete?: () => void;
}

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  operating: "Operating",
  vendor: "Vendor",
  subcontractor: "Subcontractor",
  overhead: "Overhead",
  insured: "Insured",
  contractor: "Contractor",
  supplier: "Supplier",
  other: "Other",
};

const ACCOUNT_TYPE_COLORS: Record<string, string> = {
  operating: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20",
  vendor: "bg-blue-500/10 text-blue-700 border-blue-500/20",
  subcontractor: "bg-purple-500/10 text-purple-700 border-purple-500/20",
  overhead: "bg-amber-500/10 text-amber-700 border-amber-500/20",
  insured: "bg-rose-500/10 text-rose-700 border-rose-500/20",
  contractor: "bg-indigo-500/10 text-indigo-700 border-indigo-500/20",
  supplier: "bg-cyan-500/10 text-cyan-700 border-cyan-500/20",
  other: "bg-muted text-muted-foreground border-border",
};

export function DisbursementConsole({
  checkIntakeItemId,
  depositItemId,
  checkAmount,
  checkNumber,
  carrierName,
  onComplete,
}: Props) {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [usePercent, setUsePercent] = useState(false);
  const [deliverySpeed, setDeliverySpeed] = useState<"same_day" | "instant">("same_day");

  // Load reserve config
  const { data: reserveConfig } = useQuery({
    queryKey: ["reserve-config", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data } = await supabase
        .from("reserve_config")
        .select("*")
        .eq("tenant_id", tenant!.id)
        .single();
      return data;
    },
  });

  // Load stakeholder accounts whitelisted for THIS check
  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ["disbursement-accounts", checkIntakeItemId, tenant?.id],
    enabled: !!tenant?.id && !!checkIntakeItemId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_stakeholders")
        .select(`
          added_via,
          stakeholder_accounts:stakeholder_account_id (
            id, nickname, account_type, chk_acct, is_active, is_primary, created_at
          )
        `)
        .eq("check_intake_item_id", checkIntakeItemId!);
      if (error) throw error;
      return (data ?? [])
        .map((row: any) => row.stakeholder_accounts ? { ...row.stakeholder_accounts, added_via: row.added_via } : null)
        .filter((a: any) => a && a.is_active)
        .sort((a: any, b: any) => Number(b.is_primary) - Number(a.is_primary));
    },
  });

  // Load all past splits for this check (running total of what's already disbursed)
  const { data: pastBatches = [] } = useQuery({
    queryKey: ["disbursement-batch-history", checkIntakeItemId ?? depositItemId],
    enabled: !!(checkIntakeItemId || depositItemId),
    queryFn: async () => {
      const query = supabase
        .from("disbursement_batches")
        .select(`id, status, created_at, delivery_speed, disbursement_splits(id, amount, status, return_code, stakeholder_accounts(nickname, account_type))`)
        .order("created_at", { ascending: false });
      if (checkIntakeItemId) query.eq("check_intake_item_id", checkIntakeItemId);
      else if (depositItemId) query.eq("deposit_item_id", depositItemId);
      const { data } = await query;
      return data ?? [];
    },
  });

  const reservePct = reserveConfig?.reserve_pct ?? 0.10;
  const reserveHeld = checkAmount * reservePct;

  // Sum all prior split amounts that aren't failed/cancelled (counts pending + submitted + settled)
  const alreadyDisbursed = useMemo(() => {
    let total = 0;
    for (const b of pastBatches as any[]) {
      for (const s of (b.disbursement_splits ?? [])) {
        if (s.status !== "failed" && s.status !== "cancelled" && s.status !== "returned") {
          total += Number(s.amount) || 0;
        }
      }
    }
    return total;
  }, [pastBatches]);

  const availableAmount = Math.max(0, checkAmount - reserveHeld - alreadyDisbursed);

  const allSplits = useMemo(() => {
    const rows: any[] = [];
    for (const b of pastBatches as any[]) {
      for (const s of (b.disbursement_splits ?? [])) {
        rows.push({ ...s, batch_created_at: b.created_at, batch_id: b.id });
      }
    }
    return rows;
  }, [pastBatches]);

  const totalAllocated = useMemo(() => {
    return Object.values(allocations).reduce((sum, v) => {
      const n = parseFloat(v || "0");
      return sum + (isNaN(n) ? 0 : n);
    }, 0);
  }, [allocations]);

  const totalAllocatedDollars = usePercent
    ? (totalAllocated / 100) * availableAmount
    : totalAllocated;

  const remaining = availableAmount - totalAllocatedDollars;
  const isBalanced = Math.abs(remaining) < 0.01;
  const isOverAllocated = remaining < -0.01;

  const submitBatch = useMutation({
    mutationFn: async () => {
      if (!user || !tenant) throw new Error("Not authenticated");

      // Build splits array
      const splits = accounts
        .filter((a: any) => {
          const val = parseFloat(allocations[a.id] || "0");
          return !isNaN(val) && val > 0;
        })
        .map((a: any) => {
          const val = parseFloat(allocations[a.id]);
          const dollarAmount = usePercent ? (val / 100) * availableAmount : val;
          return {
            stakeholder_account_id: a.id,
            tenant_id: tenant.id,
            amount: Math.round(dollarAmount * 100) / 100,
            pct_of_total: usePercent ? val : (dollarAmount / availableAmount) * 100,
            idempotence_key: `split_${a.id}_${Date.now()}`,
          };
        });

      if (splits.length === 0) throw new Error("No allocations entered");
      if (isOverAllocated) throw new Error("Total exceeds available amount");

      // Create the batch
      const { data: batch, error: batchErr } = await supabase
        .from("disbursement_batches")
        .insert({
          tenant_id: tenant.id,
          check_intake_item_id: checkIntakeItemId ?? null,
          deposit_item_id: depositItemId ?? null,
          created_by: user.id,
          check_amount: checkAmount,
          reserve_held: reserveHeld,
          available_amount: availableAmount,
          delivery_speed: deliverySpeed,
          status: "pending",
        })
        .select("id")
        .single();

      if (batchErr) throw batchErr;

      // Insert splits
      const { error: splitsErr } = await supabase
        .from("disbursement_splits")
        .insert(splits.map((s) => ({ ...s, batch_id: batch.id })));

      if (splitsErr) throw splitsErr;

      // Trigger Actum disbursement
      const { error: invokeErr } = await supabase.functions.invoke("actum-disburse", {
        body: { batch_id: batch.id },
      });

      if (invokeErr) throw invokeErr;
      return batch.id;
    },
    onSuccess: () => {
      toast({ title: "Disbursements submitted", description: "Credits are on their way to each account." });
      qc.invalidateQueries({ queryKey: ["disbursement-batch"] });
      onComplete?.();
    },
    onError: (e: any) => toast({ title: "Disbursement failed", description: e.message, variant: "destructive" }),
  });

  if (isLoading) return <div className="text-sm text-muted-foreground p-4">Loading accounts...</div>;

  if (accounts.length === 0) {
    return (
      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 text-sm text-amber-600">
            <AlertTriangle className="h-4 w-4" />
            No stakeholder accounts set up. Go to Settings → Stakeholder Accounts to add them.
          </div>
        </CardContent>
      </Card>
    );
  }

  // Show existing batch if already submitted
  if (existingBatch && existingBatch.status !== "pending") {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            Disbursement {existingBatch.status === "completed" ? "Complete" : existingBatch.status}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {(existingBatch.disbursement_splits ?? []).map((split: any) => (
            <div key={split.id} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{split.stakeholder_accounts?.nickname ?? "—"}</span>
              <div className="flex items-center gap-2">
                <span className="font-medium">${Number(split.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
                <Badge variant="outline" className={`text-[10px] ${
                  split.status === "settled" ? "text-emerald-600 border-emerald-500/30 bg-emerald-500/10" :
                  split.status === "returned" ? "text-red-600 border-red-500/30 bg-red-500/10" :
                  split.status === "submitted" ? "text-blue-600 border-blue-500/30 bg-blue-500/10" :
                  "text-muted-foreground"
                }`}>
                  {split.status}
                  {split.return_code && ` · ${split.return_code}`}
                </Badge>
              </div>
            </div>
          ))}
          <div className="pt-2 border-t flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Reserve held: ${Number(existingBatch.reserve_held).toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </span>
            {!existingBatch.reserve_released_at && existingBatch.status === "submitted" && (
              <Button 
                size="sm" 
                variant="outline" 
                className="h-7 text-xs border-amber-500/50 text-amber-600 hover:bg-amber-50"
                onClick={() => {
                  if (confirm("Release reserve funds? This should only be done if the 3-day return window has passed.")) {
                    supabase.rpc("deposit_action", {
                      p_action: "release_reserve",
                      p_actor_id: user?.id,
                      p_extra: { batch_id: existingBatch.id }
                    }).then(({ error }) => {
                      if (error) toast({ title: "Release failed", description: error.message, variant: "destructive" });
                      else {
                        toast({ title: "Reserve released" });
                        qc.invalidateQueries({ queryKey: ["disbursement-batch"] });
                      }
                    });
                  }
                }}
              >
                Release Funds
              </Button>
            )}
            {existingBatch.reserve_released_at && (
              <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-600">
                Reserve Released
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Building2 className="h-4 w-4 text-blue-400" />
            Disburse Funds
            {checkNumber && <span className="text-muted-foreground font-normal">— Check #{checkNumber}</span>}
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setUsePercent(!usePercent)}
          >
            {usePercent ? "Switch to $" : "Switch to %"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* Reserve summary */}
        <div className="rounded-md bg-muted/50 p-3 space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Check amount</span>
            <span className="font-medium">${checkAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Reserve held ({Math.round(reservePct * 100)}%)</span>
            <span className="text-amber-600 font-medium">− ${reserveHeld.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
          </div>
          <div className="border-t pt-2 flex justify-between text-sm">
            <span className="font-medium">Available to disburse</span>
            <span className="font-semibold text-emerald-600">${availableAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
          </div>
          <Progress value={((totalAllocatedDollars / availableAmount) * 100)} className="h-1.5" />
        </div>

        {/* Delivery Speed Selector */}
        <div className="space-y-3 pt-2 border-t">
          <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
            <Clock className="h-3 w-3" /> Delivery Speed
          </p>
          <RadioGroup 
            value={deliverySpeed} 
            onValueChange={(v) => setDeliverySpeed(v as any)}
            className="grid grid-cols-2 gap-3"
          >
            <div>
              <RadioGroupItem
                value="same_day"
                id="same_day"
                className="peer sr-only"
              />
              <Label
                htmlFor="same_day"
                className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-3 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary cursor-pointer"
              >
                <Clock className="mb-2 h-5 w-5" />
                <span className="text-[11px] font-semibold">Same Day</span>
                <span className="text-[10px] text-muted-foreground">$1.00 fee</span>
              </Label>
            </div>
            <div>
              <RadioGroupItem
                value="instant"
                id="instant"
                className="peer sr-only"
              />
              <Label
                htmlFor="instant"
                className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-3 hover:bg-accent hover:text-accent-foreground peer-data-[state=checked]:border-primary [&:has([data-state=checked])]:border-primary cursor-pointer"
              >
                <Zap className="mb-2 h-5 w-5 text-amber-500" />
                <span className="text-[11px] font-semibold">Instant</span>
                <span className="text-[10px] text-muted-foreground">$1.50 fee</span>
              </Label>
            </div>
          </RadioGroup>
        </div>

        {/* Allocation inputs */}
        <div className="space-y-2">
          {accounts.map((acct: any) => (
            <div key={acct.id} className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="text-xs font-medium truncate">{acct.nickname}</p>
                  <Badge variant="outline" className={`text-[9px] px-1 flex-shrink-0 ${ACCOUNT_TYPE_COLORS[acct.account_type]}`}>
                    {ACCOUNT_TYPE_LABELS[acct.account_type] || acct.account_type}
                  </Badge>
                </div>
                <p className="text-[10px] text-muted-foreground font-mono">••••{acct.chk_acct.slice(-4)}</p>
              </div>
              <div className="flex items-center gap-1 w-28 flex-shrink-0">
                <span className="text-xs text-muted-foreground">{usePercent ? "%" : "$"}</span>
                <Input
                  type="number"
                  min="0"
                  step={usePercent ? "1" : "0.01"}
                  placeholder="0"
                  className="h-8 text-sm text-right"
                  value={allocations[acct.id] ?? ""}
                  onChange={(e) => setAllocations({ ...allocations, [acct.id]: e.target.value })}
                />
              </div>
              {allocations[acct.id] && parseFloat(allocations[acct.id]) > 0 && (
                <span className="text-xs text-muted-foreground w-20 text-right flex-shrink-0">
                  {usePercent
                    ? `$${((parseFloat(allocations[acct.id]) / 100) * availableAmount).toLocaleString("en-US", { minimumFractionDigits: 2 })}`
                    : `${((parseFloat(allocations[acct.id]) / availableAmount) * 100).toFixed(1)}%`
                  }
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Balance indicator */}
        <div className={`rounded-md p-2.5 flex items-center justify-between text-xs ${
          isBalanced ? "bg-emerald-500/10 border border-emerald-500/30" :
          isOverAllocated ? "bg-red-500/10 border border-red-500/30" :
          "bg-muted border border-border"
        }`}>
          <span className={isBalanced ? "text-emerald-700 dark:text-emerald-300" : isOverAllocated ? "text-red-700 dark:text-red-300" : "text-muted-foreground"}>
            {isBalanced ? "✓ Balanced" : isOverAllocated ? "⚠ Over-allocated" : `Remaining: $${remaining.toLocaleString("en-US", { minimumFractionDigits: 2 })}`}
          </span>
          <span className="font-medium">
            ${totalAllocatedDollars.toLocaleString("en-US", { minimumFractionDigits: 2 })} of ${availableAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
          </span>
        </div>

        <Button
          className="w-full"
          onClick={() => submitBatch.mutate()}
          disabled={submitBatch.isPending || isOverAllocated || totalAllocatedDollars === 0}
        >
          {submitBatch.isPending ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Submitting...</>
          ) : (
            <><Send className="h-4 w-4 mr-2" />{isBalanced ? "Send all disbursements" : `Send $${totalAllocatedDollars.toLocaleString("en-US", { minimumFractionDigits: 2 })} (partial)`}</>
          )}
        </Button>

        <p className="text-xs text-center text-muted-foreground">
          Credits arrive same-day or next banking day via Actum ACH
        </p>
      </CardContent>
    </Card>
  );
}
