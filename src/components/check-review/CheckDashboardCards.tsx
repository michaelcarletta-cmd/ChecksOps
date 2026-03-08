import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertTriangle, CheckCircle2, Building2, RotateCcw,
  ClipboardCheck, Banknote,
} from "lucide-react";

interface StatusCounts {
  manual_review: number;
  branch_deposit: number;
  reissue_requested: number;
  approved_for_deposit: number;
  total_deposited: number;
  total_value: number;
}

export function CheckDashboardCards() {
  const { data: counts } = useQuery({
    queryKey: ["check-dashboard-counts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("status, deposit_recommendation, amount");
      if (error) throw error;

      const result: StatusCounts = {
        manual_review: 0,
        branch_deposit: 0,
        reissue_requested: 0,
        approved_for_deposit: 0,
        total_deposited: 0,
        total_value: 0,
      };

      for (const row of data ?? []) {
        const s = row.status as string;
        const rec = row.deposit_recommendation as string | null;

        if (s === "needs_review" || s === "manual_review_required" || s === "endorsements_complete" || rec === "manual_review_required") {
          result.manual_review++;
        }
        if (s === "branch_deposit_required" || rec === "branch_deposit_recommended") {
          result.branch_deposit++;
        }
        if (s === "reissue_requested") result.reissue_requested++;
        if (s === "approved_for_deposit") result.approved_for_deposit++;
        if (s === "deposited") {
          result.total_deposited++;
          result.total_value += (row.amount as number) ?? 0;
        }
      }

      return result;
    },
    refetchInterval: 30000,
  });

  if (!counts) return null;

  const cards = [
    { label: "Manual Review", count: counts.manual_review, icon: AlertTriangle, color: "text-orange-400", bg: "bg-orange-500/10" },
    { label: "Branch Deposit", count: counts.branch_deposit, icon: Building2, color: "text-blue-400", bg: "bg-blue-500/10" },
    { label: "Reissue Requested", count: counts.reissue_requested, icon: RotateCcw, color: "text-amber-400", bg: "bg-amber-500/10" },
    { label: "Approved for Deposit", count: counts.approved_for_deposit, icon: CheckCircle2, color: "text-emerald-400", bg: "bg-emerald-500/10" },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="p-4 flex items-center gap-3">
            <div className={`p-2 rounded-lg ${c.bg} ${c.color}`}>
              <c.icon className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">{c.count}</p>
              <p className="text-xs text-muted-foreground">{c.label}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
