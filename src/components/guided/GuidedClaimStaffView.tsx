import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, MessageSquare, Clock, CheckCircle2, AlertTriangle } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Props {
  claimId: string;
}

export function GuidedClaimStaffView({ claimId }: Props) {
  const [comms, setComms] = useState<any[]>([]);
  const [claimMap, setClaimMap] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, [claimId]);

  const loadData = async () => {
    const [commsRes, mapRes] = await Promise.all([
      supabase
        .from("guided_communications")
        .select("*")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false }),
      supabase
        .from("guided_claim_map")
        .select("*")
        .eq("claim_id", claimId)
        .maybeSingle(),
    ]);
    setComms(commsRes.data || []);
    setClaimMap(mapRes.data);
    setLoading(false);
  };

  if (loading) return null;
  if (!comms.length && !claimMap) return null;

  const statusIcon = (status: string) => {
    switch (status) {
      case "sent": return <CheckCircle2 className="h-3 w-3 text-green-500" />;
      case "drafted": return <Clock className="h-3 w-3 text-muted-foreground" />;
      case "awaiting_response": return <MessageSquare className="h-3 w-3 text-primary" />;
      default: return <Clock className="h-3 w-3 text-muted-foreground" />;
    }
  };

  return (
    <Card className="border-accent bg-accent/5">
      <CardHeader className="py-3 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2 text-foreground">
          <Users className="h-4 w-4 text-primary" />
          Guided Mode Activity
          <Badge variant="outline" className="text-[9px] ml-auto">Self-Managed</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-0 space-y-3">
        {/* Claim map summary */}
        {claimMap?.issue_summary && (
          <div className="text-xs text-muted-foreground bg-muted/30 rounded p-2 border border-border">
            <p className="font-medium text-foreground text-[10px] uppercase tracking-wider mb-1">Policyholder's Claim Map</p>
            <p>{claimMap.issue_summary}</p>
          </div>
        )}

        {/* Escalation flags */}
        {claimMap?.escalation_flags?.length > 0 && (
          <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 rounded p-2 border border-destructive/20">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>Escalation flags: {claimMap.escalation_flags.join(", ")}</span>
          </div>
        )}

        {/* Communications */}
        {comms.length > 0 && (
          <div>
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
              Communications ({comms.length})
            </p>
            <ScrollArea className="max-h-[200px]">
              <div className="space-y-1.5">
                {comms.map(comm => (
                  <div key={comm.id} className="flex items-start gap-2 text-xs border border-border rounded p-2">
                    {statusIcon(comm.status)}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-foreground truncate">{comm.subject || comm.task_type || "Draft"}</p>
                      <p className="text-muted-foreground">
                        {comm.status} · {comm.sent_at
                          ? new Date(comm.sent_at).toLocaleDateString()
                          : new Date(comm.created_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
