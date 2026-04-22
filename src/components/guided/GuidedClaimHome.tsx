import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, AlertTriangle, FileText, MessageSquare, Clock, Upload, ChevronRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useReferralAlerts } from "@/hooks/useReferralAlerts";
import { GuidedReferralAlert } from "./GuidedReferralAlert";

interface Props {
  claimId: string;
  onSelectTask: (taskType: string) => void;
}

const TASK_OPTIONS = [
  { key: "respond_to_email", label: "Respond to Carrier Email", icon: MessageSquare },
  { key: "challenge_estimate", label: "Challenge Estimate / Scope", icon: FileText },
  { key: "respond_to_denial", label: "Respond to Denial", icon: AlertTriangle },
  { key: "repairability_issue", label: "Explain Repairability Issue", icon: FileText },
  { key: "send_contractor_estimate", label: "Send Contractor Estimate", icon: FileText },
  { key: "request_reconsideration", label: "Request Reconsideration", icon: MessageSquare },
  { key: "request_reinspect", label: "Request Reinspection", icon: Clock },
  { key: "follow_up_delay", label: "Follow Up on Delay", icon: Clock },
  { key: "respond_to_engineer", label: "Respond to Engineer Report", icon: FileText },
];

interface ClaimMap {
  issue_summary?: string;
  missing_documents?: string[];
  pressure_points?: string[];
  recommended_next_step?: string;
  escalation_flags?: string[];
  confidence?: number;
}

export function GuidedClaimHome({ claimId, onSelectTask }: Props) {
  const [claim, setClaim] = useState<any>(null);
  const [claimMap, setClaimMap] = useState<ClaimMap | null>(null);
  const [comms, setComms] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [buildingMap, setBuildingMap] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    loadClaimData();
  }, [claimId]);

  const loadClaimData = async () => {
    setLoading(true);
    const [claimRes, mapRes, commsRes] = await Promise.all([
      supabase.from("claims").select("*").eq("id", claimId).single(),
      supabase.from("guided_claim_map").select("*").eq("claim_id", claimId).single(),
      supabase.from("guided_communications").select("*").eq("claim_id", claimId).order("created_at", { ascending: false }).limit(5),
    ]);
    setClaim(claimRes.data);
    setClaimMap(mapRes.data as any);
    setComms(commsRes.data || []);
    setLoading(false);
  };

  const buildClaimMap = async () => {
    setBuildingMap(true);
    try {
      const { data, error } = await supabase.functions.invoke("darwin-guided-mode", {
        body: { action: "build_claim_map", claimId },
      });
      if (error) throw error;

      // Upsert the claim map
      const mapData = {
        claim_id: claimId,
        issue_summary: data.issue_summary || "",
        timeline: data.timeline || [],
        missing_documents: data.missing_documents || [],
        pressure_points: data.pressure_points || [],
        recommended_next_step: data.recommended_next_step || "",
        escalation_flags: data.escalation_flags || [],
        confidence: data.confidence || 0,
      };

      await supabase.from("guided_claim_map").upsert(mapData, { onConflict: "claim_id" });
      setClaimMap(mapData);
      toast({ title: "Claim map built", description: "Darwin analyzed your claim." });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setBuildingMap(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const escalationActive = claimMap?.escalation_flags && claimMap.escalation_flags.length > 0;

  return (
    <div className="space-y-6">
      {/* Claim header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold text-foreground">{claim?.claim_number || "Claim"}</h2>
          <p className="text-sm text-muted-foreground">
            {claim?.carrier} — {claim?.property_address || "No address"}
          </p>
        </div>
        <Badge variant="outline" className="text-primary border-primary/30">
          {claim?.status || "New"}
        </Badge>
      </div>

      {/* Escalation banner */}
      {escalationActive && (
        <div className="border border-destructive/30 bg-destructive/10 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-destructive text-sm">This file appears more disputed</p>
              <p className="text-xs text-muted-foreground mt-1">
                The carrier's response suggests a more contested posture. More formal escalation may become appropriate if the issue is not resolved.
              </p>
              <ul className="mt-2 space-y-1">
                {claimMap?.escalation_flags?.map((flag, i) => (
                  <li key={i} className="text-xs text-destructive/80">• {flag}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Claim Map */}
      <Card className="border-border bg-card">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-foreground text-base">Darwin's Claim Analysis</CardTitle>
          <Button variant="outline" size="sm" onClick={buildClaimMap} disabled={buildingMap}>
            {buildingMap ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
            {claimMap ? "Refresh Analysis" : "Build Claim Map"}
          </Button>
        </CardHeader>
        <CardContent>
          {claimMap ? (
            <div className="space-y-4">
              {claimMap.issue_summary && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Where the Claim Stands</p>
                  <p className="text-sm text-foreground">{claimMap.issue_summary}</p>
                </div>
              )}
              {claimMap.pressure_points && claimMap.pressure_points.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">What Darwin Sees</p>
                  <ul className="space-y-1">
                    {claimMap.pressure_points.map((p, i) => (
                      <li key={i} className="text-sm text-foreground">• {p}</li>
                    ))}
                  </ul>
                </div>
              )}
              {claimMap.recommended_next_step && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">What to Do Next</p>
                  <p className="text-sm text-primary font-medium">{claimMap.recommended_next_step}</p>
                </div>
              )}
              {claimMap.missing_documents && claimMap.missing_documents.length > 0 && (
                <div className="border border-warning/30 bg-warning/10 rounded p-3">
                  <p className="text-xs font-medium text-warning mb-1">Missing Documents</p>
                  <ul className="space-y-0.5">
                    {claimMap.missing_documents.map((d, i) => (
                      <li key={i} className="text-xs text-foreground">• {d}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-sm text-muted-foreground mb-3">
                Darwin hasn't analyzed this claim yet. Build the claim map to get recommendations.
              </p>
              <Button onClick={buildClaimMap} disabled={buildingMap}>
                {buildingMap && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Build Claim Map
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Choose Task */}
      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle className="text-foreground text-base">What Do You Want to Do?</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {TASK_OPTIONS.map(task => (
              <button
                key={task.key}
                className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-accent/50 hover:border-primary/30 transition-colors text-left"
                onClick={() => onSelectTask(task.key)}
              >
                <task.icon className="h-4 w-4 text-primary shrink-0" />
                <span className="text-sm text-foreground flex-1">{task.label}</span>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Recent Communications */}
      {comms.length > 0 && (
        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle className="text-foreground text-base">Recent Communications</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {comms.map(comm => (
                <div key={comm.id} className="flex items-center justify-between border border-border rounded p-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">{comm.subject || comm.task_type || "Draft"}</p>
                    <p className="text-xs text-muted-foreground">
                      {comm.sent_at ? `Sent ${new Date(comm.sent_at).toLocaleDateString()}` : `Drafted ${new Date(comm.created_at).toLocaleDateString()}`}
                    </p>
                  </div>
                  <Badge variant={comm.status === "sent" ? "default" : "secondary"} className="text-xs">
                    {comm.status}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
