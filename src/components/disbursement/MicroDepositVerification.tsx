import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2, AlertTriangle, Clock, XCircle,
  ShieldCheck, Loader2, DollarSign
} from "lucide-react";
import { format } from "date-fns";

interface Props {
  accountId: string;
  accountNickname: string;
  accountLast4: string;
  verificationStatus: string;
}

export function MicroDepositVerification({
  accountId,
  accountNickname,
  accountLast4,
  verificationStatus: initialStatus,
}: Props) {
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [showAmountForm, setShowAmountForm] = useState(false);
  const [amount1, setAmount1] = useState("");
  const [amount2, setAmount2] = useState("");

  // Load pending verification if exists
  const { data: pendingVerification } = useQuery({
    queryKey: ["micro-deposit-verification", accountId],
    enabled: initialStatus === "pending",
    queryFn: async () => {
      const { data } = await supabase
        .from("micro_deposit_verifications")
        .select("id, status, attempts, max_attempts, expires_at, created_at")
        .eq("stakeholder_account_id", accountId)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1);
      return data?.[0] ?? null;
    },
  });

  // Send micro deposits
  const sendDeposits = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("actum-verify-account", {
        body: { account_id: accountId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      toast({
        title: "Verification deposits sent",
        description: "Two small deposits will appear in this account within 1-2 banking days. Come back and enter the amounts to verify.",
      });
      qc.invalidateQueries({ queryKey: ["stakeholder-accounts"] });
      qc.invalidateQueries({ queryKey: ["micro-deposit-verification", accountId] });
    },
    onError: (e: any) => toast({ title: "Failed to send deposits", description: e.message, variant: "destructive" }),
  });

  // Verify amounts
  const verifyAmounts = useMutation({
    mutationFn: async () => {
      if (!pendingVerification) throw new Error("No pending verification found");
      const a1 = parseFloat(amount1);
      const a2 = parseFloat(amount2);
      if (isNaN(a1) || isNaN(a2)) throw new Error("Please enter valid amounts");

      const { data, error } = await supabase.rpc("verify_micro_deposits", {
        p_verification_id: pendingVerification.id,
        p_amount_1: a1,
        p_amount_2: a2,
      }) as { data: { success: boolean, error?: string }, error: any };

      if (error) throw error;
      if (!data.success) throw new Error(data.error || "Verification failed");
      return data;
    },
    onSuccess: () => {
      toast({ title: "Account verified!", description: "You can now disburse funds to this account." });
      qc.invalidateQueries({ queryKey: ["stakeholder-accounts"] });
      qc.invalidateQueries({ queryKey: ["micro-deposit-verification", accountId] });
      setShowAmountForm(false);
    },
    onError: (e: any) => toast({ title: "Verification failed", description: e.message, variant: "destructive" }),
  });

  if (initialStatus === "verified" || initialStatus === "admin_override") {
    return (
      <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/20 px-1.5 py-0.5 flex items-center gap-1">
        <ShieldCheck className="h-3 w-3" />
        Verified
      </Badge>
    );
  }

  if (initialStatus === "failed" || initialStatus === "locked") {
    return (
      <Badge variant="outline" className="text-[10px] bg-rose-500/10 text-rose-700 border-rose-500/20 px-1.5 py-0.5 flex items-center gap-1">
        <XCircle className="h-3 w-3" />
        Verification failed
      </Badge>
    );
  }

  if (initialStatus === "pending") {
    return (
      <div className="space-y-2 mt-2">
        <div className="flex items-center justify-between gap-2 p-2 rounded border bg-blue-50/50 border-blue-100">
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-blue-500" />
            <div className="text-[11px]">
              <p className="font-medium text-blue-700">Verification pending</p>
              <p className="text-blue-600/70">Check account for 2 small deposits in 1-2 days.</p>
            </div>
          </div>
          <Button 
            variant="outline" 
            size="sm" 
            className="h-7 text-[10px] border-blue-200 text-blue-700 hover:bg-blue-100"
            onClick={() => setShowAmountForm(!showAmountForm)}
          >
            {showAmountForm ? "Cancel" : "Enter amounts"}
          </Button>
        </div>

        {showAmountForm && (
          <div className="p-3 border rounded bg-white space-y-3 shadow-sm animate-in fade-in slide-in-from-top-1">
            <p className="text-xs font-medium">Enter the two deposit amounts:</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-[10px] text-muted-foreground uppercase">Amount 1</Label>
                <div className="relative">
                  <DollarSign className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                  <Input 
                    type="number" 
                    step="0.01" 
                    placeholder="0.00" 
                    className="h-8 pl-6 text-sm"
                    value={amount1}
                    onChange={(e) => setAmount1(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] text-muted-foreground uppercase">Amount 2</Label>
                <div className="relative">
                  <DollarSign className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                  <Input 
                    type="number" 
                    step="0.01" 
                    placeholder="0.00" 
                    className="h-8 pl-6 text-sm"
                    value={amount2}
                    onChange={(e) => setAmount2(e.target.value)}
                  />
                </div>
              </div>
            </div>
            
            {pendingVerification && (
              <p className="text-[10px] text-muted-foreground">
                Attempts: {pendingVerification.attempts} / {pendingVerification.max_attempts}
              </p>
            )}

            <Button 
              className="w-full h-8 text-xs" 
              onClick={() => verifyAmounts.mutate()}
              disabled={verifyAmounts.isPending || !amount1 || !amount2}
            >
              {verifyAmounts.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <CheckCircle2 className="h-3 w-3 mr-1" />}
              Verify account
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 p-2 rounded border border-amber-100 bg-amber-50/30">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
        <span className="text-[11px] font-medium text-amber-700">Account not verified</span>
      </div>
      <Button 
        variant="outline" 
        size="sm" 
        className="h-7 text-[10px] border-amber-200 text-amber-700 hover:bg-amber-100"
        onClick={() => sendDeposits.mutate()}
        disabled={sendDeposits.isPending}
      >
        {sendDeposits.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <DollarSign className="h-3 w-3 mr-1" />}
        Send micro-deposits
      </Button>
    </div>
  );
}
