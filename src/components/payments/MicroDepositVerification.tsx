import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  ShieldCheck, Clock, CircleAlert, Loader2, Landmark
} from "lucide-react";

interface Props {
  tenantId: string;
  paymentMethodId?: string;
  verificationStatus: string;
  onVerified?: () => void;
}

/**
 * Moov Micro-deposit verification UI.
 * 
 * Allows users to initiate micro-deposits and confirm the amounts once they appear.
 */
export function MicroDepositVerification({
  tenantId,
  paymentMethodId,
  verificationStatus,
  onVerified
}: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [amounts, setAmounts] = useState(["", ""]);
  const [showConfirm, setShowConfirm] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["payment-account"] });
    qc.invalidateQueries({ queryKey: ["stakeholder-accounts"] });
  };

  const initiate = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("moov-micro-deposit-initiate", {
        body: { tenant_id: tenantId, payment_method_id: paymentMethodId }
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast({
        title: "Micro-deposits initiated",
        description: "Check your bank statement in 1-2 business days for two small amounts."
      });
    },
    onError: (e: any) => {
      toast({
        title: "Couldn't start verification",
        description: e.message,
        variant: "destructive"
      });
    }
  });

  const confirm = useMutation({
    mutationFn: async () => {
      const cents = amounts.map(a => Math.round(parseFloat(a) * 100));
      
      // First, find the payment method ID if we don't have it (fallback)
      let pmId = paymentMethodId;
      if (!pmId) {
        const { data: method } = await supabase
          .from("payment_provider_methods")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("provider", "moov")
          .eq("connection_status", "pending")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        pmId = method?.id;
      }

      const { data, error } = await supabase.functions.invoke("moov-micro-deposit-confirm", {
        body: { 
          tenant_id: tenantId, 
          payment_method_id: pmId,
          amounts: cents 
        }
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      invalidate();
      onVerified?.();
      toast({
        title: "Bank account verified",
        description: "Your account is now ready for payments."
      });
    },
    onError: (e: any) => {
      toast({
        title: "Verification failed",
        description: e.message,
        variant: "destructive"
      });
    }
  });

  async function getVerificationId() {
    const { data } = await supabase
      .from("payment_method_verifications")
      .select("id")
      .eq("payment_method_id", paymentMethodId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    
    if (!data?.id) throw new Error("No pending verification found. Please initiate again.");
    return data.id;
  }

  const busy = initiate.isPending || confirm.isPending;

  if (verificationStatus === "verified") {
    return (
      <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/20 px-1.5 py-0.5 flex items-center gap-1 w-fit">
        <ShieldCheck className="h-3.5 w-3.5" />
        Verified
      </Badge>
    );
  }

  if (verificationStatus === "pending_micro_deposit" || showConfirm) {
    return (
      <div className="space-y-2 mt-2">
        <div className="flex items-center gap-2 text-amber-500">
          <Clock className="h-4 w-4" />
          <span className="text-xs font-medium">Verification Pending</span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Enter the two micro-deposit amounts shown on your statement.
        </p>
        <div className="flex gap-2 max-w-[200px]">
          <Input 
            type="number" 
            placeholder="0.00" 
            step="0.01"
            className="h-8 text-xs"
            value={amounts[0]}
            onChange={(e) => setAmounts([e.target.value, amounts[1]])}
          />
          <Input 
            type="number" 
            placeholder="0.00" 
            step="0.01"
            className="h-8 text-xs"
            value={amounts[1]}
            onChange={(e) => setAmounts([amounts[0], e.target.value])}
          />
        </div>
        <div className="flex gap-2">
          <Button 
            size="sm" 
            className="h-7 text-[10px]" 
            onClick={() => confirm.mutate()}
            disabled={busy || !amounts[0] || !amounts[1]}
          >
            {confirm.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
            Confirm Amounts
          </Button>
          {!showConfirm && (
            <Button size="sm" variant="ghost" className="h-7 text-[10px]" onClick={() => initiate.mutate()}>
              Resend Deposits
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <Button 
      size="sm" 
      variant="outline" 
      className="h-7 text-[10px] gap-1.5" 
      onClick={() => initiate.mutate()}
      disabled={busy || !paymentMethodId}
    >
      <Landmark className="h-3.5 w-3.5" />
      Verify with Micro-deposits
    </Button>
  );
}
