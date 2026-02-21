import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { BookOpen, Loader2, RefreshCw, Target, TrendingUp, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";

interface CarrierScenarioPlaybookProps {
  claimId: string;
  claim: any;
}

interface PlaybookMatch {
  playbook: any;
  tactics: any[];
  matchType: "exact" | "partial" | "broad";
  matchLabel: string;
}

export const CarrierScenarioPlaybook = ({ claimId, claim }: CarrierScenarioPlaybookProps) => {
  const [matches, setMatches] = useState<PlaybookMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const carrier = claim?.insurance_company || "";
  const state = claim?.property_state || (() => {
    const m = (claim?.policyholder_address || "").match(/\b([A-Z]{2})\b\s*\d{5}/);
    return m ? m[1] : null;
  })();
  const lossType = claim?.loss_type || null;

  const loadPlaybooks = async () => {
    if (!carrier) return;
    setLoading(true);
    try {
      const results: PlaybookMatch[] = [];

      // Tier 1: Exact match (carrier + state + loss_type)
      const { data: exact } = await supabase
        .from("carrier_scenario_playbooks")
        .select("*")
        .eq("carrier", carrier)
        .eq("state_code", state)
        .order("sample_size_total", { ascending: false })
        .limit(5);

      for (const pb of (exact || [])) {
        const { data: tactics } = await supabase
          .from("carrier_scenario_tactics")
          .select("*")
          .eq("scenario_key", pb.scenario_key)
          .order("recency_weighted_score", { ascending: false })
          .limit(5);
        results.push({
          playbook: pb,
          tactics: tactics || [],
          matchType: "exact",
          matchLabel: `${carrier} · ${state} · ${pb.denial_rationale || "all rationales"}`,
        });
      }

      // Tier 2: Partial (carrier + loss_type, any state)
      if (results.length < 3) {
        const { data: partial } = await supabase
          .from("carrier_scenario_playbooks")
          .select("*")
          .eq("carrier", carrier)
          .is("state_code", null)
          .order("sample_size_total", { ascending: false })
          .limit(3);

        const existingKeys = new Set(results.map(r => r.playbook.scenario_key));
        for (const pb of (partial || [])) {
          if (existingKeys.has(pb.scenario_key)) continue;
          const { data: tactics } = await supabase
            .from("carrier_scenario_tactics")
            .select("*")
            .eq("scenario_key", pb.scenario_key)
            .order("recency_weighted_score", { ascending: false })
            .limit(5);
          results.push({
            playbook: pb,
            tactics: tactics || [],
            matchType: "partial",
            matchLabel: `${carrier} · any state · ${pb.denial_rationale || "all rationales"} (state mismatch)`,
          });
        }
      }

      // Tier 3: Broad (carrier only)
      if (results.length < 2) {
        const { data: broad } = await supabase
          .from("carrier_scenario_playbooks")
          .select("*")
          .ilike("carrier", `%${carrier.split(" ")[0]}%`)
          .order("sample_size_total", { ascending: false })
          .limit(3);

        const existingKeys = new Set(results.map(r => r.playbook.scenario_key));
        for (const pb of (broad || [])) {
          if (existingKeys.has(pb.scenario_key)) continue;
          const { data: tactics } = await supabase
            .from("carrier_scenario_tactics")
            .select("*")
            .eq("scenario_key", pb.scenario_key)
            .order("recency_weighted_score", { ascending: false })
            .limit(5);
          results.push({
            playbook: pb,
            tactics: tactics || [],
            matchType: "broad",
            matchLabel: `${pb.carrier} · broad match`,
          });
        }
      }

      setMatches(results);
    } catch (err) {
      console.error("Error loading playbooks:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPlaybooks();
  }, [claimId, carrier]);

  const getMatchBadge = (type: "exact" | "partial" | "broad") => {
    switch (type) {
      case "exact": return <Badge className="bg-green-500/20 text-green-700 dark:text-green-400 border-0">Exact Match</Badge>;
      case "partial": return <Badge className="bg-amber-500/20 text-amber-700 dark:text-amber-400 border-0">Partial Match</Badge>;
      case "broad": return <Badge variant="outline">Broad Match</Badge>;
    }
  };

  const getConfidenceBadge = (pb: any) => {
    const label = pb.confidence_label || "low";
    const color = label === "high" ? "bg-green-500/20 text-green-700 dark:text-green-400" :
                  label === "medium" ? "bg-amber-500/20 text-amber-700 dark:text-amber-400" :
                  "bg-muted text-muted-foreground";
    return (
      <span className={`text-[10px] px-1.5 py-0.5 rounded ${color}`}>
        {label} conf. (n={pb.sample_size_total}, 12mo={pb.sample_size_recent_12mo})
      </span>
    );
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-primary" />
            Carrier × Scenario Playbook
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={loadPlaybooks} disabled={loading}>
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          </Button>
        </div>
        <CardDescription className="text-xs">
          Data-driven tactics from historical outcomes for {carrier || "this carrier"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-primary mr-2" />
            <span className="text-sm text-muted-foreground">Loading playbooks...</span>
          </div>
        )}

        {!loading && matches.length === 0 && (
          <div className="text-center py-6 text-sm text-muted-foreground">
            <AlertTriangle className="h-5 w-5 mx-auto mb-2 text-amber-500" />
            No playbook data yet for {carrier}. Playbooks auto-populate as claims close.
          </div>
        )}

        {matches.map((match, idx) => {
          const pb = match.playbook;
          const isExpanded = expanded === pb.scenario_key;
          return (
            <Card key={pb.scenario_key || idx} className="border-border/50">
              <CardContent className="p-3 space-y-2">
                {/* Header */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    {getMatchBadge(match.matchType)}
                    {getConfidenceBadge(pb)}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0"
                    onClick={() => setExpanded(isExpanded ? null : pb.scenario_key)}
                  >
                    {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">{match.matchLabel}</p>

                {/* Quick stats */}
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="p-2 bg-muted/50 rounded">
                    <div className="text-lg font-bold text-primary">{pb.win_rate}%</div>
                    <div className="text-[10px] text-muted-foreground">Win Rate</div>
                  </div>
                  <div className="p-2 bg-muted/50 rounded">
                    <div className="text-lg font-bold">
                      {pb.avg_indemnity_delta > 0 ? "+" : ""}${Math.abs(pb.avg_indemnity_delta || 0).toLocaleString()}
                    </div>
                    <div className="text-[10px] text-muted-foreground">Avg Delta</div>
                  </div>
                  <div className="p-2 bg-muted/50 rounded">
                    <div className="text-lg font-bold">{pb.sample_size_total}</div>
                    <div className="text-[10px] text-muted-foreground">Sample Size</div>
                  </div>
                </div>

                {/* Resolution paths */}
                {pb.top_resolution_paths && (pb.top_resolution_paths as any[]).length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[10px] font-medium text-muted-foreground">Resolution Paths</div>
                    <div className="flex flex-wrap gap-1">
                      {(pb.top_resolution_paths as any[]).map((rp: any, i: number) => (
                        <Badge key={i} variant="outline" className="text-[10px]">
                          {rp.path}: {rp.pct}%
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Expanded: Top Tactics */}
                {isExpanded && (
                  <div className="space-y-2 pt-2 border-t">
                    <div className="text-xs font-medium flex items-center gap-1">
                      <Target className="h-3 w-3" />
                      Top Tactics
                    </div>
                    {match.tactics.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No tactic data yet.</p>
                    ) : (
                      <ScrollArea className="max-h-[200px]">
                        <div className="space-y-2">
                          {match.tactics.map((t, ti) => (
                            <div key={ti} className="p-2 bg-muted/30 rounded space-y-1">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-medium capitalize">{t.tactic_name.replace(/_/g, " ")}</span>
                                <Badge variant="outline" className="text-[10px]">{t.tactic_type}</Badge>
                              </div>
                              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                                <span>Used {t.support_count}×</span>
                                {t.success_lift !== 0 && (
                                  <span className={t.success_lift > 0 ? "text-green-600" : "text-red-500"}>
                                    <TrendingUp className="h-3 w-3 inline mr-0.5" />
                                    {t.success_lift > 0 ? "+" : ""}{t.success_lift}% lift
                                  </span>
                                )}
                                {t.median_delta_when_present !== 0 && (
                                  <span>
                                    Median: {t.median_delta_when_present > 0 ? "+" : ""}${Math.abs(t.median_delta_when_present).toLocaleString()}
                                  </span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </CardContent>
    </Card>
  );
};
