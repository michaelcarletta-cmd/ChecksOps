import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  ShieldCheck, Clock, Loader2, Landmark, RotateCcw
} from "lucide-react";

interface Props {
  tenantId: string;
  paymentMethodId?: string;
  verificationStatus: string;
  onVerified?: () => void;
}

/**
 * Moov Instant Micro-deposit verification UI.
 *
 * Codes are always submitted to Moov — there is no local bypass. In Moov test
 * mode the documented success code is 0001, surfaced here only when the
 * provider environment is authoritatively sandbox.
 */
export function MicroDepositVerification({
  tenantId,
  paymentMethodId,
  verificationStatus,
  onVerified
}: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);

  // Provider environment as recorded on the tenant's payment account row.
  const { data: environment } = useQuery({
    queryKey: ["payment-account-environment", tenantId],
    enabled: !!tenantId,
    queryFn: async () => {
      const { data } = await supabase
        .from("payment_provider_accounts")
        .select("environment")
        .eq("tenant_id", tenantId)
        .eq("provider", "moov")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return (data?.environment as string | undefined) ?? null;
    },
  });

  const isSandbox = environment === "sandbox";

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["payment-account"] });
    qc.invalidateQueries({ queryKey: ["stakeholder-accounts"] });
  };

  const initiate = useMutation({
    retry: false,
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("moov-micro-deposit-initiate", {
        body: { tenant_id: tenantId, payment_method_id: paymentMethodId }
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).message ?? (data as any).error);
      return data;
    },
    onSuccess: () => {
      setNeedsRestart(false);
      setCode("");
      invalidate();
      toast({
        title: "Verification started",
        description: "A $0.01 deposit is on its way. Its descriptor contains your MV•••• code."
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
    // Never auto-retry: each submission consumes a provider attempt.
    retry: false,
    mutationFn: async () => {
      const verificationId = await getVerificationId();

      const { data, error } = await supabase.functions.invoke("moov-micro-deposit-confirm", {
        body: {
          tenant_id: tenantId,
          verification_id: verificationId,
          code: code
        }
      });
      if (error) {
        let payload: any = null;
        try { payload = await (error as any).context?.json?.(); } catch { /* ignore */ }
        if (payload?.requires_restart) setNeedsRestart(true);
        throw new Error(payload?.message ?? error.message);
      }
      if ((data as any)?.error) {
        if ((data as any).requires_restart) setNeedsRestart(true);
        throw new Error((data as any).message ?? (data as any).error);
      }
      return data;
    },
    onSuccess: async () => {
      setCode("");
      // Provider state is authoritative — reconcile before the UI updates.
      await supabase.functions.invoke("moov-sync", { body: { tenant_id: tenantId } });
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
    let pmId = paymentMethodId;

    // If we don't have a paymentMethodId (e.g. from state), look for a pending Moov one
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

    if (!pmId) throw new Error("No pending payment method found.");

    const { data } = await supabase
      .from("payment_method_verifications")
      .select("id")
      .eq("payment_method_id", pmId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data?.id) {
      setNeedsRestart(true);
      throw new Error("No open verification. Restart verification to receive a new code.");
    }
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

  if (needsRestart) {
    return (
      <div className="space-y-2 mt-2">
        <p className="text-[11px] text-destructive">
          This verification can no longer accept codes. Start a new verification to receive a fresh deposit code.
        </p>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[10px] gap-1.5"
          onClick={() => initiate.mutate()}
          disabled={busy}
        >
          {initiate.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
          Restart verification
        </Button>
      </div>
    );
  }

  if (verificationStatus === "pending_micro_deposit" || showConfirm) {
    return (
      <div className="space-y-2 mt-2">
        <div className="flex items-center gap-2 text-amber-500">
          <Clock className="h-4 w-4" />
          <span className="text-xs font-medium">Verification pending</span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Enter the 4 digits shown after MV on the $0.01 deposit in your bank account (MV••••).
        </p>
        {isSandbox && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-500">Test mode</p>
            <p className="text-[11px] text-muted-foreground">Sandbox test code: 0001</p>
          </div>
        )}
        <div className="flex gap-2 max-w-[200px]">
          <Input
            type="text"
            inputMode="numeric"
            placeholder="4-digit code"
            maxLength={4}
            className="h-8 text-xs font-mono"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
          />
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            className="h-7 text-[10px]"
            onClick={() => confirm.mutate()}
            disabled={busy || code.length !== 4}
          >
            {confirm.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
            Confirm code
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-[10px] gap-1"
            onClick={() => initiate.mutate()}
            disabled={busy}
          >
            <RotateCcw className="h-3 w-3" />
            Restart verification
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 text-[10px] gap-1.5"
      onClick={() => { setShowConfirm(true); initiate.mutate(); }}
      disabled={busy}
    >
      <Landmark className="h-3.5 w-3.5" />
      Verify with instant micro-deposit
    </Button>
  );
}
