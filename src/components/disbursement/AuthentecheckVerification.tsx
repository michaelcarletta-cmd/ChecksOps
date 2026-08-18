import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2, AlertTriangle, Clock, XCircle,
  ShieldCheck, Loader2, Banknote, ExternalLink,
} from "lucide-react";

interface Props {
  accountId: string;
  accountNickname: string;
  accountLast4: string;
  verificationStatus: string;
}

/**
 * Authentecheck verification — replaces micro-deposits.
 * User clicks "Verify with bank login", we initiate a Plaid-backed Actum
 * Authentecheck session and open it in a new tab. Postback finalizes status.
 */
export function AuthentecheckVerification({
  accountId,
  verificationStatus: status,
}: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const startSession = useMutation({
    mutationFn: async () => {
      // Actum is disabled globally.
      throw new Error("Actum verification is no longer available. Please use the Moov connection flow.");
    },
    onError: (e: any) =>
      toast({ title: "Couldn't start verification", description: e.message, variant: "destructive" }),
  });

  if (status === "verified" || status === "admin_override") {
    return (
      <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/20 px-1.5 py-0.5 flex items-center gap-1 w-fit">
        <ShieldCheck className="h-3 w-3" />
        Verified
      </Badge>
    );
  }

  if (status === "failed" || status === "locked") {
    return (
      <div className="space-y-2 mt-2">
        <div className="flex items-center justify-between gap-2 p-2 rounded border border-rose-100 bg-rose-50/40">
          <div className="flex items-center gap-2">
            <XCircle className="h-3.5 w-3.5 text-rose-500" />
            <span className="text-[11px] font-medium text-rose-700">
              Verification failed — retry with bank login
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px] border-rose-200 text-rose-700 hover:bg-rose-100"
            onClick={() => startSession.mutate()}
            disabled={startSession.isPending}
          >
            {startSession.isPending
              ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
              : <Banknote className="h-3 w-3 mr-1" />}
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (status === "pending") {
    return (
      <div className="flex items-center justify-between gap-2 p-2 rounded border bg-blue-50/50 border-blue-100 mt-2">
        <div className="flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-blue-500" />
          <div className="text-[11px]">
            <p className="font-medium text-blue-700">Awaiting bank login</p>
            <p className="text-blue-600/70">Complete the bank sign-in to finish verifying.</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[10px] border-blue-200 text-blue-700 hover:bg-blue-100"
          onClick={() => startSession.mutate()}
          disabled={startSession.isPending}
        >
          {startSession.isPending
            ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
            : <ExternalLink className="h-3 w-3 mr-1" />}
          Reopen
        </Button>
      </div>
    );
  }

  // unverified / default
  return (
    <div className="flex items-center justify-between gap-2 p-2 rounded border border-amber-100 bg-amber-50/30 mt-2">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
        <span className="text-[11px] font-medium text-amber-700">Account not verified</span>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-[10px] border-amber-200 text-amber-700 hover:bg-amber-100"
        disabled
      >
        Unavailable
      </Button>
    </div>
  );
}
