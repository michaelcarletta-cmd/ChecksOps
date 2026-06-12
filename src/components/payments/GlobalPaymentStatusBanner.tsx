import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle, CheckCircle2, Clock, X,
  ChevronRight, ArrowRight
} from "lucide-react";
import { format } from "date-fns";

interface PaymentSummary {
  returned: ReturnedPayment[];
  in_transit: number;
  in_transit_amount: number;
  settled_today: number;
  settled_today_amount: number;
}

interface ReturnedPayment {
  id: string;
  amount: number;
  return_code: string | null;
  return_desc: string | null;
  check_number: string | null;
  recipient_name: string | null;
  batch_id: string | null;
  check_intake_item_id: string | null;
}

export function GlobalPaymentStatusBanner() {
  const { tenant } = useTenant();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);

  const { data: summary, isLoading } = useQuery({
    queryKey: ["global-payment-status", tenant?.id],
    enabled: !!tenant?.id,
    refetchInterval: 60_000, // refresh every minute
    queryFn: async () => {
      const { data: splits, error } = await supabase
        .from("disbursement_splits")
        .select(`
          id, amount, status, return_code, return_desc, settled_at,
          actum_consumer_unique,
          stakeholder_accounts (nickname, custname),
          disbursement_batches (
            id, check_intake_item_id,
            check_intake_items:check_intake_item_id (check_number)
          )
        `)
        .eq("tenant_id", tenant!.id)
        .in("status", ["submitted", "returned", "settled", "failed"])
        .order("created_at", { ascending: false })
        .limit(100);

      if (error) throw error;

      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const result: PaymentSummary = {
        returned: [],
        in_transit: 0,
        in_transit_amount: 0,
        settled_today: 0,
        settled_today_amount: 0,
      };

      for (const split of (splits ?? [])) {
        const acct = (split as any).stakeholder_accounts;
        const batch = (split as any).disbursement_batches;
        const check = batch?.check_intake_items;

        if ((split.status === "returned" || split.status === "failed") && !dismissed.has(split.id)) {
          result.returned.push({
            id: split.id,
            amount: Number(split.amount),
            return_code: split.return_code,
            return_desc: split.return_desc,
            check_number: check?.check_number ?? null,
            recipient_name: acct?.nickname ?? acct?.custname ?? null,
            batch_id: batch?.id ?? null,
            check_intake_item_id: batch?.check_intake_item_id ?? null,
          });
        }

        if (split.status === "submitted") {
          result.in_transit++;
          result.in_transit_amount += Number(split.amount);
        }

        if (split.status === "settled" && split.settled_at) {
          const settledDate = new Date((split as any).settled_at);
          if (settledDate >= todayStart) {
            result.settled_today++;
            result.settled_today_amount += Number(split.amount);
          }
        }
      }

      return result;
    },
  });

  if (isLoading || !summary) return null;

  const hasReturned = summary.returned.length > 0;
  const hasInTransit = summary.in_transit > 0;
  const hasSettledToday = summary.settled_today > 0;

  if (!hasReturned && !hasInTransit && !hasSettledToday) return null;

  const fmtAmt = (n: number) =>
    `$${n.toLocaleString("en-US", { minimumFractionDigits: 0 })}`;

  return (
    <div className="space-y-1.5 mb-3">

      {/* Returned payments — red, never auto-dismiss */}
      {hasReturned && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 flex-1 min-w-0">
              <AlertTriangle className="h-4 w-4 text-red-500 flex-shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-red-700 dark:text-red-300">
                  {summary.returned.length} payment{summary.returned.length !== 1 ? "s" : ""} returned — action required
                </p>
                {!showAll && summary.returned.slice(0, 2).map((r) => (
                  <p key={r.id} className="text-xs text-red-600 dark:text-red-400 mt-0.5">
                    {fmtAmt(r.amount)} to {r.recipient_name ?? "—"}
                    {r.check_number ? ` (Check #${r.check_number})` : ""}
                    {r.return_code ? ` · ${r.return_code}` : ""}
                    {r.return_desc ? ` — ${r.return_desc.replace(/^R\d+\s*[-—]\s*/, "")}` : ""}
                  </p>
                ))}
                {summary.returned.length > 2 && !showAll && (
                  <button
                    className="text-xs text-red-500 underline mt-0.5"
                    onClick={() => setShowAll(true)}
                  >
                    +{summary.returned.length - 2} more
                  </button>
                )}
                {showAll && summary.returned.map((r) => (
                  <div key={r.id} className="flex items-center justify-between mt-1">
                    <p className="text-xs text-red-600 dark:text-red-400">
                      {fmtAmt(r.amount)} to {r.recipient_name ?? "—"}
                      {r.return_code ? ` · ${r.return_code}` : ""}
                    </p>
                    {r.check_intake_item_id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-[10px] text-red-500 hover:text-red-600 px-2"
                        onClick={() => {
                          // Navigate to the check — CheckCommandCenter will handle opening it
                          navigate(`/check-command-center?checkId=${r.check_intake_item_id}`);
                        }}
                      >
                        View check <ChevronRight className="h-3 w-3 ml-0.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
            {showAll && (
              <button onClick={() => setShowAll(false)} className="flex-shrink-0">
                <X className="h-3.5 w-3.5 text-red-400" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* In transit + settled today — combined amber/green row */}
      {(hasInTransit || hasSettledToday) && (
        <div className={`rounded-md border px-3 py-2 flex items-center justify-between gap-2 ${
          hasInTransit && !hasSettledToday
            ? "border-amber-500/30 bg-amber-500/10"
            : hasSettledToday && !hasInTransit
            ? "border-emerald-500/30 bg-emerald-500/10"
            : "border-blue-500/30 bg-blue-500/10"
        }`}>
          <div className="flex items-center gap-3 flex-wrap text-xs">
            {hasInTransit && (
              <span className="flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
                <Clock className="h-3.5 w-3.5" />
                {summary.in_transit} payment{summary.in_transit !== 1 ? "s" : ""} in transit
                · {fmtAmt(summary.in_transit_amount)}
              </span>
            )}
            {hasInTransit && hasSettledToday && (
              <span className="text-muted-foreground">·</span>
            )}
            {hasSettledToday && (
              <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {summary.settled_today} settled today
                · {fmtAmt(summary.settled_today_amount)}
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px] text-muted-foreground hover:text-foreground px-2 flex-shrink-0"
            onClick={() => setShowAll(!showAll)}
          >
            View all <ArrowRight className="h-3 w-3 ml-0.5" />
          </Button>
        </div>
      )}

    </div>
  );
}
