import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle, CheckCircle2, Clock,
  Send, RefreshCw, ChevronDown, ChevronUp
} from "lucide-react";

interface Props {
  checkIntakeItemId: string;
}

const RCODE_DESCRIPTIONS: Record<string, string> = {
  R01: "Insufficient funds",
  R02: "Account closed",
  R03: "No account / unable to locate",
  R04: "Invalid account number",
  R07: "Authorization revoked",
  R08: "Payment stopped",
  R10: "Customer advises not authorized",
  R16: "Account frozen",
  R20: "Non-transaction account",
  R29: "Corporate customer advises not authorized",
};

export function CheckPaymentStatusBanner({ checkIntakeItemId }: Props) {
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  const { data: splits = [], isLoading } = useQuery({
    queryKey: ["check-payment-status", checkIntakeItemId],
    enabled: !!checkIntakeItemId && !!tenant?.id,
    refetchInterval: 30_000,
    queryFn: async () => {
      // Find the disbursement batch for this check
      const { data: batch } = await supabase
        .from("disbursement_batches")
        .select("id, status, check_amount, available_amount, debit_status")
        .eq("check_intake_item_id", checkIntakeItemId)
        .eq("tenant_id", tenant!.id)
        .order("created_at", { ascending: false })
        .limit(1);

      if (!batch?.[0]) return [];

      const { data: splits, error } = await supabase
        .from("disbursement_splits")
        .select(`
          id, amount, status, return_code, return_desc,
          submitted_at, settled_at, returned_at,
          stakeholder_accounts (nickname, custname, chk_acct, account_type)
        `)
        .eq("batch_id", batch[0].id)
        .order("amount", { ascending: false });

      if (error) throw error;
      return (splits ?? []).map((s: any) => ({ ...s, batch_id: batch[0].id }));
    },
  });

  // Resend a returned payment
  const resendPayment = useMutation({
    mutationFn: async (splitId: string) => {
      // Reset the split to pending and re-invoke actum-disburse for just this split
      const { error } = await supabase
        .from("disbursement_splits")
        .update({ status: "pending", return_code: null, return_desc: null, returned_at: null })
        .eq("id", splitId);
      if (error) throw error;

      // Get the batch id
      const split = splits.find((s: any) => s.id === splitId);
      if (!split?.batch_id) throw new Error("Batch not found");

      // Re-trigger just this split via the edge function
      const { error: invokeErr } = await supabase.functions.invoke("actum-disburse", {
        body: { batch_id: split.batch_id, split_ids: [splitId] },
      });
      if (invokeErr) throw invokeErr;
    },
    onSuccess: () => {
      toast({ title: "Payment resent", description: "The payment has been resubmitted." });
      qc.invalidateQueries({ queryKey: ["check-payment-status", checkIntakeItemId] });
      qc.invalidateQueries({ queryKey: ["global-payment-status"] });
    },
    onError: (e: any) => toast({ title: "Failed to resend", description: e.message, variant: "destructive" }),
  });

  if (isLoading || splits.length === 0) return null;

  const returned = splits.filter((s: any) => s.status === "returned");
  const inTransit = splits.filter((s: any) => s.status === "submitted");
  const settled = splits.filter((s: any) => s.status === "settled");
  const pending = splits.filter((s: any) => s.status === "pending");

  const hasReturned = returned.length > 0;
  const hasInTransit = inTransit.length > 0;
  const allSettled = settled.length === splits.length;

  const fmtAmt = (n: number) =>
    `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

  const statusColor = hasReturned
    ? "border-red-500/40 bg-red-500/10"
    : allSettled
    ? "border-emerald-500/30 bg-emerald-500/10"
    : hasInTransit
    ? "border-amber-500/30 bg-amber-500/10"
    : "border-border bg-muted/30";

  const StatusIcon = hasReturned ? AlertTriangle : allSettled ? CheckCircle2 : Clock;
  const iconColor = hasReturned ? "text-red-500" : allSettled ? "text-emerald-500" : "text-amber-500";

  const summaryText = hasReturned
    ? `${returned.length} payment${returned.length !== 1 ? "s" : ""} returned — action required`
    : allSettled
    ? `All ${settled.length} payments settled successfully`
    : hasInTransit
    ? `${inTransit.length} of ${splits.length} payments in transit`
    : `${pending.length} payments pending`;

  return (
    <div className={`rounded-md border ${statusColor} mb-3`}>

      {/* Summary row — always visible */}
      <div
        className="flex items-center justify-between px-3 py-2 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          <StatusIcon className={`h-4 w-4 ${iconColor} flex-shrink-0`} />
          <span className={`text-xs font-medium ${
            hasReturned ? "text-red-700 dark:text-red-300" :
            allSettled ? "text-emerald-700 dark:text-emerald-300" :
            "text-amber-700 dark:text-amber-300"
          }`}>
            {summaryText}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {settled.length > 0 && (
              <Badge variant="outline" className="text-[9px] px-1 text-emerald-600 border-emerald-500/30">
                {settled.length} settled
              </Badge>
            )}
            {inTransit.length > 0 && (
              <Badge variant="outline" className="text-[9px] px-1 text-amber-600 border-amber-500/30">
                {inTransit.length} transit
              </Badge>
            )}
            {returned.length > 0 && (
              <Badge variant="outline" className="text-[9px] px-1 text-red-600 border-red-500/30">
                {returned.length} returned
              </Badge>
            )}
          </div>
          {expanded
            ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
            : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          }
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t divide-y">
          {splits.map((split: any) => {
            const acct = split.stakeholder_accounts;
            const isReturned = split.status === "returned";
            const isSettled = split.status === "settled";
            const isInTransit = split.status === "submitted";

            const rCodeDesc = split.return_code
              ? RCODE_DESCRIPTIONS[split.return_code] ?? split.return_desc?.replace(/^R\d+\s*[-—]\s*/, "") ?? "Unknown return reason"
              : null;

            return (
              <div key={split.id} className={`px-3 py-2 ${isReturned ? "bg-red-500/5" : ""}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-medium">
                        {acct?.nickname ?? acct?.custname ?? "—"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {fmtAmt(split.amount)}
                      </span>
                      <Badge variant="outline" className={`text-[9px] px-1 ${
                        isSettled ? "text-emerald-600 border-emerald-500/30" :
                        isReturned ? "text-red-600 border-red-500/30" :
                        isInTransit ? "text-amber-600 border-amber-500/30" :
                        "text-muted-foreground"
                      }`}>
                        {isSettled ? "Settled" : isReturned ? "Returned" : isInTransit ? "In Transit" : "Pending"}
                      </Badge>
                      {split.return_code && (
                        <Badge variant="outline" className="text-[9px] px-1 text-red-600 border-red-500/30 font-mono">
                          {split.return_code}
                        </Badge>
                      )}
                    </div>
                    {isReturned && rCodeDesc && (
                      <p className="text-[10px] text-red-500 mt-0.5">{rCodeDesc}</p>
                    )}
                    {isInTransit && (
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        Expected to settle within 1–2 banking days
                      </p>
                    )}
                    {isSettled && split.settled_at && (
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        Settled — funds in recipient's account
                      </p>
                    )}
                  </div>

                  {isReturned && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs flex-shrink-0 border-red-500/30 text-red-600 hover:bg-red-500/10"
                      onClick={() => resendPayment.mutate(split.id)}
                      disabled={resendPayment.isPending}
                    >
                      {resendPayment.isPending
                        ? <RefreshCw className="h-3 w-3 animate-spin" />
                        : <><Send className="h-3 w-3 mr-1" />Resend</>
                      }
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
