import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Brain, ArrowRight, ArrowLeft, Clock, AlertCircle, CheckCircle } from "lucide-react";
import { format } from "date-fns";
import { useNavigate } from "react-router-dom";

interface DarwinSMSActivityLogProps {
  claimId?: string;
  limit?: number;
}

export function DarwinSMSActivityLog({ claimId, limit = 50 }: DarwinSMSActivityLogProps) {
  const navigate = useNavigate();

  const { data: activities, isLoading } = useQuery({
    queryKey: ["darwin-sms-activity", claimId],
    queryFn: async () => {
      let query = supabase
        .from("darwin_sms_activity")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (claimId) {
        query = query.eq("claim_id", claimId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data;
    },
  });

  const statusIcon = (status: string) => {
    switch (status) {
      case "completed": return <CheckCircle className="h-3.5 w-3.5 text-green-500" />;
      case "failed": return <AlertCircle className="h-3.5 w-3.5 text-destructive" />;
      case "processing": return <Clock className="h-3.5 w-3.5 text-yellow-500 animate-pulse" />;
      case "needs_context": return <AlertCircle className="h-3.5 w-3.5 text-yellow-500" />;
      default: return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
    }
  };

  const intentBadge = (intent: string | null) => {
    if (!intent) return null;
    const colors: Record<string, string> = {
      analyze: "bg-blue-500/20 text-blue-500 border-blue-500/30",
      financial_qa: "bg-green-500/20 text-green-500 border-green-500/30",
      switch_claim: "bg-purple-500/20 text-purple-500 border-purple-500/30",
      help: "bg-muted text-muted-foreground border-border",
      unknown: "bg-yellow-500/20 text-yellow-500 border-yellow-500/30",
      legacy_inbound: "bg-muted text-muted-foreground border-border",
    };
    return (
      <Badge className={`text-xs border ${colors[intent] || "bg-muted text-muted-foreground border-border"}`}>
        {intent.replace(/_/g, " ")}
      </Badge>
    );
  };

  if (isLoading) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="flex items-center justify-center py-10">
          <Clock className="h-6 w-6 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  if (!activities || activities.length === 0) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="flex flex-col items-center justify-center py-10">
          <Brain className="h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-muted-foreground">No Darwin SMS activity yet</p>
          <p className="text-sm text-muted-foreground mt-1">
            Link your phone in Settings to start sending commands via SMS
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {activities.map((activity) => {
        const isInbound = activity.direction === "inbound";
        return (
          <Card key={activity.id} className={`bg-card border-border ${isInbound ? "border-l-4 border-l-primary" : "border-l-4 border-l-green-500"}`}>
            <CardContent className="py-3 px-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  {isInbound ? (
                    <ArrowRight className="h-4 w-4 text-primary shrink-0" />
                  ) : (
                    <ArrowLeft className="h-4 w-4 text-green-500 shrink-0" />
                  )}
                  <span className="text-xs text-muted-foreground">
                    {activity.phone_number}
                  </span>
                  {intentBadge(activity.parsed_intent)}
                  {statusIcon(activity.status)}
                </div>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {format(new Date(activity.created_at), "MMM d, h:mm a")}
                </span>
              </div>
              <p className="text-sm text-foreground whitespace-pre-wrap">
                {activity.message_text}
              </p>
              {activity.darwin_response && isInbound && (
                <div className="bg-muted/50 rounded p-2 mt-1">
                  <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                    <Brain className="h-3 w-3" /> Darwin response:
                  </p>
                  <p className="text-sm text-foreground whitespace-pre-wrap">
                    {activity.darwin_response.substring(0, 500)}
                    {activity.darwin_response.length > 500 && "..."}
                  </p>
                </div>
              )}
              {activity.error_message && (
                <p className="text-xs text-destructive">{activity.error_message}</p>
              )}
              {!claimId && activity.claim_id && (
                <button
                  onClick={() => navigate(`/claims/${activity.claim_id}`)}
                  className="text-xs text-primary hover:underline"
                >
                  View claim →
                </button>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
