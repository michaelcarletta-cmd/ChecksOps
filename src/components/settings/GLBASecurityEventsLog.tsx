import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/contexts/TenantContext";
import { Badge } from "@/components/ui/badge";
import { Loader2, ShieldAlert } from "lucide-react";
import { format } from "date-fns";
import { SectionCard } from "./SectionCard";

export function GLBASecurityEventsLog() {
  const { tenant } = useTenant();

  const { data, isLoading } = useQuery({
    queryKey: ["glba-security-events", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("glba_security_events")
        .select("id, event_type, actor_user_id, metadata, severity, created_at")
        .eq("tenant_id", tenant!.id)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data as any[];
    },
  });

  return (
    <SectionCard
      title="Security & Compliance Events"
      icon={<ShieldAlert className="h-4 w-4 text-rose-500" />}
      accent="bg-gradient-to-r from-rose-500/60 to-rose-500/10"
      description="Append-only log of GLBA, AML, and ACH compliance events (most recent 200)."
    >
      <div className="pt-2">
        {isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : !data?.length ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No events recorded yet.</p>
        ) : (
          <div className="space-y-2">
            {data.map((e) => (
              <div key={e.id} className="flex items-start justify-between gap-3 p-2.5 rounded-md border bg-muted/20 hover:bg-muted/30 transition-colors">
                <div className="space-y-0.5 min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="text-[11px] font-mono text-foreground">{e.event_type}</code>
                    {e.severity && <SeverityBadge severity={e.severity} />}
                  </div>
                  {e.metadata && Object.keys(e.metadata).length > 0 && (
                    <p className="text-[11px] text-muted-foreground font-mono truncate">{JSON.stringify(e.metadata)}</p>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
                  {format(new Date(e.created_at), "MMM d, p")}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    critical: "bg-rose-500/10 text-rose-700 border-rose-500/20",
    high: "bg-orange-500/10 text-orange-700 border-orange-500/20",
    medium: "bg-amber-500/10 text-amber-700 border-amber-500/20",
    low: "bg-blue-500/10 text-blue-700 border-blue-500/20",
    info: "bg-muted text-muted-foreground border-border",
  };
  return <Badge variant="outline" className={`text-[10px] ${map[severity] || map.info}`}>{severity}</Badge>;
}
