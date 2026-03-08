import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Landmark, Send, ArrowRightLeft, CheckCircle2, AlertTriangle, DollarSign, Clock, FileWarning } from "lucide-react";

export function LossDraftDashboardCards() {
  const { data: counts } = useQuery({
    queryKey: ["loss-draft-counts"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_loss_draft_dashboard_counts");
      if (error) throw error;
      return data as Record<string, number>;
    },
    refetchInterval: 30_000,
  });

  const cards = [
    { label: "Active Files", value: counts?.total_active ?? 0, icon: Landmark, color: "text-amber-400" },
    { label: "Pending Send", value: counts?.pending_send ?? 0, icon: Send, color: "text-blue-400" },
    { label: "Draw Requested", value: counts?.draw_requested ?? 0, icon: ArrowRightLeft, color: "text-orange-400" },
    { label: "Partial Release", value: counts?.partial_release ?? 0, icon: DollarSign, color: "text-emerald-400" },
    { label: "Stale Files", value: counts?.stale_count ?? 0, icon: AlertTriangle, color: "text-red-400" },
    { label: "Overdue Follow-up", value: counts?.overdue_followup ?? 0, icon: Clock, color: "text-orange-400" },
    {
      label: "Total Unreleased",
      value: `$${((counts?.total_unreleased ?? 0) as number).toLocaleString("en-US", { minimumFractionDigits: 0 })}`,
      icon: Landmark,
      color: "text-amber-400",
      isText: true,
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
      {cards.map(c => (
        <Card key={c.label}>
          <CardContent className="p-3 flex items-center gap-2">
            <c.icon className={`h-4 w-4 ${c.color} shrink-0`} />
            <div className="min-w-0">
              <p className={`font-bold ${c.isText ? "text-sm" : "text-lg"} leading-tight`}>
                {c.value}
              </p>
              <p className="text-[10px] text-muted-foreground truncate">{c.label}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
