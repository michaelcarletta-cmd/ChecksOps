import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertTriangle, CheckCircle2, Building2, RotateCcw,
} from "lucide-react";
import { useTenantFilter } from "@/hooks/useTenantFilter";

interface DashboardCounts {
  manual_review: number;
  branch_deposit: number;
  reissue_requested: number;
  approved_for_deposit: number;
  total_deposited: number;
  total_deposited_value: number;
  total_checks: number;
}

export function CheckDashboardCards() {
  const { tenantId, isWhiteLabel } = useTenantFilter();

  const { data: counts } = useQuery({
    queryKey: ["check-dashboard-counts", tenantId],
    queryFn: async () => {
      if (isWhiteLabel && tenantId) {
        // Use tenant-scoped RPC
        const { data, error } = await supabase.rpc("get_check_dashboard_counts_for_tenant", {
          _tenant_id: tenantId,
        });
        if (error) throw error;
        return data as unknown as DashboardCounts;
      }
      // System tenant — use original RPC
      const { data, error } = await supabase.rpc("get_check_dashboard_counts");
      if (error) throw error;
      return data as unknown as DashboardCounts;
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
