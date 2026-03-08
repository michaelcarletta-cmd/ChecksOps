import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowUpRight, RefreshCw, Landmark, CheckCircle2,
  XCircle, Clock, AlertTriangle, Send, RotateCcw,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface IncreaseAccount {
  id: string;
  name: string;
  status: string;
  balance: number;
  currency: string;
}

/* ------------------------------------------------------------------ */
/*  Status badge for Increase lifecycle                                */
/* ------------------------------------------------------------------ */

const increaseStatusConfig: Record<string, { label: string; color: string; icon: typeof Clock }> = {
  pending: { label: "Pending", color: "bg-amber-500/20 text-amber-400", icon: Clock },
  submitted: { label: "Submitted to Fed", color: "bg-blue-500/20 text-blue-400", icon: Send },
  rejected: { label: "Rejected", color: "bg-destructive/20 text-destructive", icon: XCircle },
  returned: { label: "Returned", color: "bg-orange-500/20 text-orange-400", icon: RotateCcw },
};

export function IncreaseStatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const cfg = increaseStatusConfig[status];
  if (!cfg) return <Badge variant="outline" className="text-[10px]">{status}</Badge>;
  const Icon = cfg.icon;
  return (
    <Badge className={`text-[10px] gap-1 ${cfg.color}`}>
      <Icon className="h-3 w-3" />
      {cfg.label}
    </Badge>
  );
}

/* ------------------------------------------------------------------ */
/*  Account Selector                                                   */
/* ------------------------------------------------------------------ */

export function IncreaseAccountSelector() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");

  const { data: accounts, isLoading: loadingAccounts } = useQuery({
    queryKey: ["increase-accounts"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("increase-list-accounts");
      if (error) throw error;
      if (!data.success) throw new Error(data.error);
      return data.accounts as IncreaseAccount[];
    },
  });

  const { data: currentSetting } = useQuery({
    queryKey: ["increase-target-account"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("increase_settings")
        .select("setting_value")
        .eq("setting_key", "target_account_id")
        .maybeSingle();
      if (error) throw error;
      // setting_value is Json — Supabase returns it parsed already
      const raw = data?.setting_value;
      return typeof raw === 'string' ? raw : raw ? String(raw) : null;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (accountId: string) => {
      const { error } = await supabase
        .from("increase_settings")
        .upsert({
          setting_key: "target_account_id",
          setting_value: accountId,
          updated_at: new Date().toISOString(),
        }, { onConflict: "setting_key" });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Target Increase account saved" });
      qc.invalidateQueries({ queryKey: ["increase-target-account"] });
    },
    onError: (e: Error) => toast({ title: "Failed to save", description: e.message, variant: "destructive" }),
  });

  const currentAccountId = currentSetting ?? null;
  const currentAccount = accounts?.find((a) => a.id === currentAccountId);

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Landmark className="h-4 w-4 text-primary" />
          Increase Sandbox Account
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {currentAccount && (
          <div className="flex items-center gap-2 text-xs">
            <CheckCircle2 className="h-3 w-3 text-emerald-400" />
            <span>Active: <strong>{currentAccount.name}</strong></span>
            <Badge variant="outline" className="text-[10px]">{currentAccount.id.slice(0, 20)}…</Badge>
            <span className="text-muted-foreground">
              Balance: ${((currentAccount.balance ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}
            </span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Select
            value={selectedAccountId || currentAccountId || ""}
            onValueChange={setSelectedAccountId}
          >
            <SelectTrigger className="h-8 text-xs flex-1">
              <SelectValue placeholder={loadingAccounts ? "Loading accounts…" : "Select account"} />
            </SelectTrigger>
            <SelectContent>
              {(accounts ?? []).map((acc) => (
                <SelectItem key={acc.id} value={acc.id}>
                  {acc.name} — {acc.id.slice(0, 20)}… ({acc.status})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            className="text-xs h-8"
            disabled={!selectedAccountId || saveMutation.isPending}
            onClick={() => saveMutation.mutate(selectedAccountId)}
          >
            {saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Deposit to Increase button                                         */
/* ------------------------------------------------------------------ */

interface DepositToIncreaseProps {
  checkId: string;
  checkNumber: string | null;
  amount: number | null;
  carrierName: string | null;
  status: string;
  isMultiPayee: boolean;
  hasBackImage: boolean;
  hasFrontImage: boolean;
  depositItemId?: string;
  increaseStatus?: string | null;
  increaseDepositId?: string | null;
}

export function DepositToIncreaseButton({
  checkId,
  checkNumber,
  amount,
  carrierName,
  status,
  isMultiPayee,
  hasBackImage,
  hasFrontImage,
  depositItemId,
  increaseStatus,
  increaseDepositId,
}: DepositToIncreaseProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showConfirm, setShowConfirm] = useState(false);

  const { data: targetAccountId } = useQuery({
    queryKey: ["increase-target-account"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("increase_settings")
        .select("setting_value")
        .eq("setting_key", "target_account_id")
        .maybeSingle();
      if (error) throw error;
      return data?.setting_value ? JSON.parse(data.setting_value as string) : null;
    },
  });

  const depositMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("increase-create-check-deposit", {
        body: {
          check_intake_item_id: checkId,
          increase_account_id: targetAccountId,
        },
      });
      if (error) throw error;
      if (!data.success) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      toast({ title: "Deposited to Increase", description: `ID: ${data.increase_check_deposit_id}` });
      qc.invalidateQueries({ queryKey: ["deposit-items"] });
      qc.invalidateQueries({ queryKey: ["check-intake-items"] });
      qc.invalidateQueries({ queryKey: ["approved-checks-for-deposit"] });
      setShowConfirm(false);
    },
    onError: (e: Error) => {
      toast({ title: "Deposit failed", description: e.message, variant: "destructive" });
    },
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, string> = {};
      if (depositItemId) body.deposit_item_id = depositItemId;
      else if (increaseDepositId) body.increase_check_deposit_id = increaseDepositId;

      const { data, error } = await supabase.functions.invoke("increase-sync-check-deposit-status", { body });
      if (error) throw error;
      if (!data.success) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      toast({ title: "Status refreshed", description: `Increase: ${data.increase_status}` });
      qc.invalidateQueries({ queryKey: ["deposit-items"] });
    },
    onError: (e: Error) => {
      toast({ title: "Sync failed", description: e.message, variant: "destructive" });
    },
  });

  // Already submitted to Increase — show status + refresh
  if (increaseDepositId) {
    return (
      <div className="flex items-center gap-1.5">
        <IncreaseStatusBadge status={increaseStatus ?? null} />
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0"
          onClick={(e) => { e.stopPropagation(); syncMutation.mutate(); }}
          disabled={syncMutation.isPending}
          title="Refresh Increase status"
        >
          <RefreshCw className={`h-3 w-3 ${syncMutation.isPending ? "animate-spin" : ""}`} />
        </Button>
      </div>
    );
  }

  // Pre-checks
  const canDeposit =
    status === "approved_for_deposit" &&
    hasFrontImage &&
    hasBackImage &&
    !!targetAccountId;

  const blockers: string[] = [];
  if (status !== "approved_for_deposit") blockers.push("Check must be approved for deposit");
  if (!hasFrontImage) blockers.push("Front image missing");
  if (!hasBackImage) blockers.push("Back image missing");
  if (!targetAccountId) blockers.push("No Increase target account configured");

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="text-xs h-7 border-primary/50 text-primary hover:bg-primary/10"
        disabled={!canDeposit}
        onClick={(e) => { e.stopPropagation(); setShowConfirm(true); }}
        title={blockers.length > 0 ? blockers.join("; ") : "Deposit to Increase Sandbox"}
      >
        <ArrowUpRight className="h-3 w-3 mr-1" />
        Increase
      </Button>

      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deposit to Increase (Sandbox)</DialogTitle>
            <DialogDescription>
              Submit this check to the Increase sandbox for remote deposit capture.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Check #</span>
              <span className="font-mono">{checkNumber || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Carrier</span>
              <span>{carrierName || "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Amount</span>
              <span className="font-semibold">${(amount ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Target Account</span>
              <span className="font-mono text-xs">{targetAccountId?.slice(0, 24)}…</span>
            </div>
            {isMultiPayee && (
              <div className="flex items-center gap-2 text-amber-400 text-xs bg-amber-500/10 rounded p-2">
                <AlertTriangle className="h-3 w-3" />
                Multi-payee check — endorsements will be verified before submission.
              </div>
            )}
            {blockers.length > 0 && (
              <div className="space-y-1">
                {blockers.map((b) => (
                  <div key={b} className="flex items-center gap-1 text-destructive text-xs">
                    <XCircle className="h-3 w-3" />
                    {b}
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfirm(false)}>Cancel</Button>
            <Button
              onClick={() => depositMutation.mutate()}
              disabled={depositMutation.isPending || !canDeposit}
            >
              {depositMutation.isPending ? (
                <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Submitting…</>
              ) : (
                <><ArrowUpRight className="h-4 w-4 mr-2" />Submit to Increase</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Bulk Sync All Increase Deposits                                    */
/* ------------------------------------------------------------------ */

export function IncreaseSyncAllButton() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const syncAllMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("increase-sync-check-deposit-status", {
        body: {},
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      toast({ title: "Increase sync complete", description: `${data.synced ?? 0} deposit(s) refreshed` });
      qc.invalidateQueries({ queryKey: ["deposit-items"] });
    },
    onError: (e: Error) => {
      toast({ title: "Sync failed", description: e.message, variant: "destructive" });
    },
  });

  return (
    <Button
      size="sm"
      variant="outline"
      className="text-xs h-7"
      onClick={() => syncAllMutation.mutate()}
      disabled={syncAllMutation.isPending}
    >
      <RefreshCw className={`h-3 w-3 mr-1 ${syncAllMutation.isPending ? "animate-spin" : ""}`} />
      Sync Increase
    </Button>
  );
}
