import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/hooks/usePermissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertTriangle, CheckCircle2, Send, Building2, Loader2, RefreshCw, Zap, Clock, History, ShieldAlert, ShieldCheck } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { CheckStakeholdersManager } from "./CheckStakeholdersManager";
import { VERIFICATION_LABEL, VERIFICATION_BADGE_CLASS, type VerificationStatus } from "@/lib/banking";

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
  const [adminOverride, setAdminOverride] = useState(false);
  const { isAdmin } = usePermissions();


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
            id, nickname, account_type, chk_acct, is_active, is_primary, created_at, verification_status
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

  // Unverified accounts that the user has actually allocated money to
  const unverifiedAllocated = useMemo(() => {
    return (accounts as any[]).filter((a) => {
      const v = parseFloat(allocations[a.id] || "0");
      if (isNaN(v) || v <= 0) return false;
      const status = a.verification_status as VerificationStatus | null;
      return status !== "verified" && status !== "admin_override";
    });
  }, [accounts, allocations]);
  const hasUnverifiedAllocations = unverifiedAllocated.length > 0;

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
      if (isOverAllocated) {
        const over = Math.abs(remaining);
        throw new Error(
          `Allocation exceeds available by $${over.toLocaleString("en-US", { minimumFractionDigits: 2 })}. ` +
          `Available to disburse: $${availableAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })} ` +
          `(check $${checkAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })} − already disbursed $${alreadyDisbursed.toLocaleString("en-US", { minimumFractionDigits: 2 })} − reserve $${reserveHeld.toLocaleString("en-US", { minimumFractionDigits: 2 })}).`
        );
      }
      // Race-condition guard: re-check server-side totals before insert
      if (checkIntakeItemId) {
        const { data: freshBatches } = await supabase
          .from("disbursement_batches")
          .select("disbursement_splits(amount,status)")
          .eq("check_intake_item_id", checkIntakeItemId)
          .eq("tenant_id", tenant.id);
        const freshDisbursed = (freshBatches ?? []).reduce((sum: number, b: any) => {
          for (const s of b.disbursement_splits ?? []) {
            if (!["failed", "cancelled", "returned"].includes(s.status)) sum += Number(s.amount) || 0;
          }
          return sum;
        }, 0);
        const freshAvailable = Math.max(0, checkAmount - reserveHeld - freshDisbursed);
        const allocSum = splits.reduce((s, x) => s + x.amount, 0);
        if (allocSum > freshAvailable + 0.01) {
          throw new Error(
            `Another disbursement was just sent. Only $${freshAvailable.toLocaleString("en-US", { minimumFractionDigits: 2 })} is available now (you tried $${allocSum.toLocaleString("en-US", { minimumFractionDigits: 2 })}).`
          );
        }
      }

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

      // Trigger Actum disbursement (admin_override only honored server-side if caller is admin)
      const { error: invokeErr } = await supabase.functions.invoke("actum-disburse", {
        body: { batch_id: batch.id, admin_override: adminOverride && isAdmin },
      });

      if (invokeErr) throw invokeErr;
      return batch.id;
    },
    onSuccess: () => {
      toast({ title: "Disbursements submitted", description: "Credits are on their way to each account." });
      qc.invalidateQueries({ queryKey: ["disbursement-batch-history", checkIntakeItemId ?? depositItemId] });
      qc.invalidateQueries({ queryKey: ["disbursement-batch"] });
      setAllocations({});
      setAdminOverride(false);
      onComplete?.();
    },
    onError: (e: any) => toast({ title: "Disbursement failed", description: e.message, variant: "destructive" }),
  });

  if (isLoading) return <div className="text-sm text-muted-foreground p-4">Loading accounts...</div>;

  const totalRemainingOfCheck = Math.max(0, checkAmount - alreadyDisbursed);

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

        {/* Reserve & balance summary */}
        <div className="rounded-md bg-muted/50 p-3 space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Check amount</span>
            <span className="font-medium">${checkAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
          </div>
          {alreadyDisbursed > 0 && (
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Already disbursed</span>
              <span className="text-blue-600 font-medium">− ${alreadyDisbursed.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
            </div>
          )}
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Reserve held ({Math.round(reservePct * 100)}%)</span>
            <span className="text-amber-600 font-medium">− ${reserveHeld.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
          </div>
          <div className="border-t pt-2 flex justify-between text-sm">
            <span className="font-medium">Available to disburse</span>
            <span className="font-semibold text-emerald-600">${availableAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
          </div>
          {availableAmount > 0 && (
            <Progress value={((totalAllocatedDollars / availableAmount) * 100)} className="h-1.5" />
          )}
        </div>

        {/* Previous disbursements */}
        {allSplits.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <History className="h-3 w-3" /> Previous disbursements
            </p>
            <div className="rounded-md border divide-y">
              {allSplits.map((split: any) => (
                <div key={split.id} className="flex items-center justify-between px-2.5 py-1.5 text-xs">
                  <span className="truncate">{split.stakeholder_accounts?.nickname ?? "—"}</span>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="font-medium">${Number(split.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
                    <Badge variant="outline" className={`text-[9px] ${
                      split.status === "settled" ? "text-emerald-600 border-emerald-500/30 bg-emerald-500/10" :
                      split.status === "returned" || split.status === "failed" ? "text-red-600 border-red-500/30 bg-red-500/10" :
                      split.status === "submitted" ? "text-blue-600 border-blue-500/30 bg-blue-500/10" :
                      "text-muted-foreground"
                    }`}>
                      {split.status}{split.return_code && ` · ${split.return_code}`}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Stakeholder manager (per-check) */}
        {checkIntakeItemId && <CheckStakeholdersManager checkIntakeItemId={checkIntakeItemId} />}

        {accounts.length === 0 && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300 flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            Add at least one stakeholder above to start disbursing this check.
          </div>
        )}

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
          {accounts.map((acct: any) => {
            const vStatus = (acct.verification_status ?? "unverified") as VerificationStatus;
            const isVerified = vStatus === "verified" || vStatus === "admin_override";
            return (
              <div key={acct.id} className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <p className="text-xs font-medium truncate">{acct.nickname}</p>
                    <Badge variant="outline" className={`text-[9px] px-1 flex-shrink-0 ${ACCOUNT_TYPE_COLORS[acct.account_type]}`}>
                      {ACCOUNT_TYPE_LABELS[acct.account_type] || acct.account_type}
                    </Badge>
                    <Badge
                      variant="outline"
                      className={`text-[9px] px-1 flex items-center gap-0.5 ${VERIFICATION_BADGE_CLASS[vStatus]}`}
                      title={VERIFICATION_LABEL[vStatus]}
                    >
                      {isVerified ? <ShieldCheck className="h-2.5 w-2.5" /> : <ShieldAlert className="h-2.5 w-2.5" />}
                      {VERIFICATION_LABEL[vStatus]}
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
            );
          })}
        </div>

        {/* Unverified-account warning + admin override */}
        {hasUnverifiedAllocations && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-2 text-xs">
            <div className="flex items-start gap-2 text-amber-700 dark:text-amber-300">
              <ShieldAlert className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <div className="space-y-1">
                <p className="font-medium">
                  {unverifiedAllocated.length === 1 ? "This account hasn't" : `${unverifiedAllocated.length} accounts haven't`} completed bank verification yet:
                </p>
                <ul className="list-disc pl-4 space-y-0.5">
                  {unverifiedAllocated.map((a: any) => (
                    <li key={a.id}>
                      <span className="font-medium">{a.nickname}</span>
                      <span className="text-amber-600/80"> — {VERIFICATION_LABEL[(a.verification_status ?? "unverified") as VerificationStatus]}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-[11px] opacity-90">
                  Have the recipient confirm the two micro-deposits before sending, or an admin can override below.
                </p>
              </div>
            </div>
            {isAdmin && (
              <label className="flex items-start gap-2 pt-1 cursor-pointer">
                <Checkbox
                  checked={adminOverride}
                  onCheckedChange={(v) => setAdminOverride(v === true)}
                  className="mt-0.5"
                />
                <span className="text-[11px] text-amber-800 dark:text-amber-200">
                  <span className="font-semibold">Admin override:</span> send anyway. This is audit-logged against your user and the affected accounts.
                </span>
              </label>
            )}
          </div>
        )}

        {/* Balance indicator */}
        <div className={`rounded-md p-2.5 flex items-center justify-between text-xs ${
          isBalanced ? "bg-emerald-500/10 border border-emerald-500/30" :
          isOverAllocated ? "bg-red-500/10 border border-red-500/30" :
          "bg-muted border border-border"
        }`}>
          <span className={isBalanced ? "text-emerald-700 dark:text-emerald-300" : isOverAllocated ? "text-red-700 dark:text-red-300" : "text-muted-foreground"}>
            {isBalanced ? "✓ Balanced" : isOverAllocated ? `⚠ Over by $${Math.abs(remaining).toLocaleString("en-US", { minimumFractionDigits: 2 })}` : `Remaining: $${remaining.toLocaleString("en-US", { minimumFractionDigits: 2 })}`}
          </span>
          <span className="font-medium">
            ${totalAllocatedDollars.toLocaleString("en-US", { minimumFractionDigits: 2 })} of ${availableAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })}
          </span>
        </div>

        {/* Over-allocation error */}
        {isOverAllocated && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <div className="space-y-0.5">
              <p className="font-medium">
                You're trying to send ${totalAllocatedDollars.toLocaleString("en-US", { minimumFractionDigits: 2 })}, but only ${availableAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })} is available on this check.
              </p>
              <p className="text-[11px] opacity-90">
                Check ${checkAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })} − already disbursed ${alreadyDisbursed.toLocaleString("en-US", { minimumFractionDigits: 2 })} − reserve ${reserveHeld.toLocaleString("en-US", { minimumFractionDigits: 2 })} = ${availableAmount.toLocaleString("en-US", { minimumFractionDigits: 2 })} remaining.
              </p>
            </div>
          </div>
        )}

        <Button
          className="w-full"
          onClick={() => submitBatch.mutate()}
          disabled={
            submitBatch.isPending ||
            isOverAllocated ||
            totalAllocatedDollars === 0 ||
            accounts.length === 0 ||
            availableAmount <= 0 ||
            (hasUnverifiedAllocations && !(isAdmin && adminOverride))
          }
        >
          {submitBatch.isPending ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Submitting...</>
          ) : hasUnverifiedAllocations && !adminOverride ? (
            <><ShieldAlert className="h-4 w-4 mr-2" />Verify accounts to send</>
          ) : (
            <><Send className="h-4 w-4 mr-2" />{isBalanced ? "Send all disbursements" : `Send $${totalAllocatedDollars.toLocaleString("en-US", { minimumFractionDigits: 2 })} (partial)`}{adminOverride && hasUnverifiedAllocations ? " (override)" : ""}</>
          )}
        </Button>

        <p className="text-xs text-center text-muted-foreground">
          Credits arrive same-day or next banking day via Actum ACH
        </p>
      </CardContent>
    </Card>
  );
}
