import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Landmark, Send, ArrowRightLeft, AlertTriangle, DollarSign, Clock, ShieldAlert, FileWarning, CheckCircle2 } from "lucide-react";
import { useTenantFilter } from "@/hooks/useTenantFilter";

export function LossDraftDashboardCards() {
  const { tenantId } = useTenantFilter();
  const { data: counts } = useQuery({
    queryKey: ["loss-draft-counts", tenantId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_loss_draft_dashboard_counts_for_tenant" as any, {
        _tenant_id: tenantId!,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, number>;
    },
    enabled: !!tenantId,
    refetchInterval: 30_000,
  });

  const cards = [
    { label: "Active Files",       value: counts?.total_active ?? 0,              icon: Landmark,      color: "text-amber-400" },
    { label: "Lender-Held",        value: counts?.checks_blocked_in_lender ?? 0,  icon: ShieldAlert,   color: "text-destructive" },
    { label: "Awaiting Docs",      value: counts?.checks_awaiting_docs ?? 0,      icon: FileWarning,   color: "text-orange-400" },
    { label: "Ready for Release",  value: counts?.checks_ready_for_release ?? 0,  icon: CheckCircle2,  color: "text-emerald-400" },
    { label: "Draw Requested",     value: counts?.draw_requested ?? 0,            icon: ArrowRightLeft, color: "text-blue-400" },
    {
      label: "Total Unreleased",
      value: `$${((counts?.total_unreleased ?? 0) as number).toLocaleString("en-US", { minimumFractionDigits: 0 })}`,
      icon: DollarSign,
      color: "text-amber-400",
      isText: true,
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
      {cards.map(c => (
        <Card key={c.label} className={c.label === "Lender-Held" && (counts?.checks_blocked_in_lender ?? 0) > 0 ? "border-destructive/40" : ""}>
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

