import { useState, useEffect, useMemo, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { Shield, AlertTriangle, Info, ChevronDown, FileText, Scale, Loader2, Zap, Copy, Send, CheckCircle2, Clock, History } from "lucide-react";
import { toast } from "sonner";

interface EscalationRule {
  id: string;
  state_code: string;
  trigger_category: string;
  trigger_name: string;
  condition_logic: Record<string, any>;
  escalation_strength: string;
  regulation_citation: string;
  regulation_summary: string;
  recommended_action: string;
  recommended_artifact: string | null;
  priority_order: number;
}

interface EscalationAlert extends EscalationRule {
  fired: boolean;
  playbook_backing?: { confidence: string; n: number; label: string } | null;
}

interface EscalationAction {
  id: string;
  claim_id: string;
  state_code: string;
  fired_rule_ids: string[];
  escalation_strength: string;
  artifact_type: string;
  artifact_document_id: string | null;
  draft_content: string | null;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface ClaimState {
  days_since_filed: number;
  deadlines: Array<{ deadline_type: string; status: string }>;
  carrier_deadlines: Array<{ deadline_type: string; status: string; days_overdue: number | null; bad_faith_potential: boolean }>;
  has_coverage_determination: boolean;
  has_written_position: boolean;
  coverage_accepted: boolean;
  scope_disputed: boolean;
  missed_deadline_count: number;
  trade: string | null;
  denial_rationale: string | null;
  playbook_data: { appraisal_delta: number; sample_size: number; label: string } | null;
}

interface DarwinEscalationEngineProps {
  claimId: string;
  claim: any;
}

const strengthConfig = {
  soft_leverage: { label: "Soft Leverage", color: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300", icon: Info, borderColor: "border-l-blue-500" },
  formal_leverage: { label: "Formal Leverage", color: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300", icon: AlertTriangle, borderColor: "border-l-amber-500" },
  regulatory_leverage: { label: "Regulatory Leverage", color: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300", icon: Shield, borderColor: "border-l-red-500" },
};

const artifactLabels: Record<string, string> = {
  engineer_rebuttal: "Draft Engineer Rebuttal",
  supplement: "Draft Supplement Narrative",
  position_request: "Draft Position Request",
  ia_rebuttal: "Draft IA Rebuttal",
  rebuttal: "Draft Rebuttal",
  rfi: "Draft RFI",
  doi_complaint: "Draft DOI Complaint",
  formal_position_request: "Draft Position Request",
  appraisal_demand: "Draft Appraisal Demand",
};

const artifactTypeMap: Record<string, string> = {
  rebuttal: "engineer_rebuttal",
  formal_position_request: "position_request",
  rfi: "position_request",
  doi_complaint: "position_request",
  appraisal_demand: "position_request",
};

const statusConfig: Record<string, { label: string; color: string; icon: typeof Clock }> = {
  drafted: { label: "Drafted", color: "bg-muted text-muted-foreground", icon: FileText },
  sent: { label: "Sent", color: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300", icon: Send },
  acknowledged: { label: "Acknowledged", color: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300", icon: CheckCircle2 },
  resolved: { label: "Resolved", color: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300", icon: CheckCircle2 },
};

// --- State detection ---
const STATE_PATTERNS: Array<{ code: string; regex: RegExp }> = [
  { code: "NJ", regex: /(^|[\s,])NJ([\s,]|$)/i },
  { code: "NJ", regex: /\bNEW\s+JERSEY\b/i },
  { code: "PA", regex: /(^|[\s,])PA([\s,]|$)/i },
  { code: "PA", regex: /\bPENNSYLVANIA\b/i },
];
const ZIP_STATE_REGEX = /\b([A-Z]{2})\s+\d{5}\b/;

function detectStateFromClaim(claim: any): string | null {
  const structuredState = (claim?.client_state || claim?.property_state || "").toUpperCase().trim();
  if (structuredState === "PA" || structuredState === "PENNSYLVANIA") return "PA";
  if (structuredState === "NJ" || structuredState === "NEW JERSEY") return "NJ";

  const address = (claim?.policyholder_address || "");
  if (!address) return null;

  const zipMatch = address.toUpperCase().match(ZIP_STATE_REGEX);
  if (zipMatch) {
    if (zipMatch[1] === "PA") return "PA";
    if (zipMatch[1] === "NJ") return "NJ";
  }

  for (const { code, regex } of STATE_PATTERNS) {
    if (regex.test(address)) return code;
  }
  return null;
}

// --- Rule evaluation ---
function evaluateRule(rule: EscalationRule, claimState: ClaimState): boolean {
  const c = rule.condition_logic;
  if (c.days_since_claim_filed_gt && claimState.days_since_filed <= c.days_since_claim_filed_gt) return false;
  if (c.deadline_type && c.deadline_status_not) {
    const allDeadlines = [...claimState.deadlines, ...claimState.carrier_deadlines];
    const matching = allDeadlines.filter(d => d.deadline_type === c.deadline_type);
    if (matching.some(d => d.status === c.deadline_status_not)) return false;
  }
  if (c.no_coverage_determination && claimState.has_coverage_determination) return false;
  if (c.no_written_coverage_position && claimState.has_written_position) return false;
  if (c.coverage_accepted && !claimState.coverage_accepted) return false;
  if (c.scope_disputed && !claimState.scope_disputed) return false;
  if (c.missed_deadlines_gt && claimState.missed_deadline_count <= c.missed_deadlines_gt) return false;
  if (c.trade_in && (!claimState.trade || !c.trade_in.includes(claimState.trade.toLowerCase()))) return false;
  if (c.denial_rationale_contains && (!claimState.denial_rationale || !claimState.denial_rationale.toLowerCase().includes(c.denial_rationale_contains.toLowerCase()))) return false;
  if (c.playbook_appraisal_delta_gt !== undefined && (!claimState.playbook_data || claimState.playbook_data.appraisal_delta <= c.playbook_appraisal_delta_gt)) return false;
  if (c.playbook_sample_size_gt !== undefined && (!claimState.playbook_data || claimState.playbook_data.sample_size <= c.playbook_sample_size_gt)) return false;
  return true;
}

// --- Routing logic: recommend best artifact ---
function recommendArtifact(claimState: ClaimState, alerts: EscalationAlert[]): string | null {
  const categories = new Set(alerts.map(a => a.trigger_category));
  if (!claimState.has_written_position || categories.has("delay") || categories.has("coverage_demand")) return "position_request";
  if (claimState.scope_disputed && categories.has("scope_reduction")) return "supplement";
  if (categories.has("matching")) return "supplement";
  if (alerts.some(a => a.trigger_name.toLowerCase().includes("engineer"))) return "engineer_rebuttal";
  return alerts[0]?.recommended_artifact ? (artifactTypeMap[alerts[0].recommended_artifact] || alerts[0].recommended_artifact) : null;
}

export const DarwinEscalationEngine = ({ claimId, claim }: DarwinEscalationEngineProps) => {
  const [rules, setRules] = useState<EscalationRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRegulations, setShowRegulations] = useState(false);
  const [regulations, setRegulations] = useState<any[]>([]);
  const [enrichedState, setEnrichedState] = useState<{
    deadlines: Array<{ deadline_type: string; status: string }>;
    carrier_deadlines: Array<{ deadline_type: string; status: string; days_overdue: number | null; bad_faith_potential: boolean }>;
    missed_deadline_count: number;
    has_coverage_determination: boolean;
    playbook_data: { appraisal_delta: number; sample_size: number; label: string } | null;
  }>({
    deadlines: [],
    carrier_deadlines: [],
    missed_deadline_count: 0,
    has_coverage_determination: false,
    playbook_data: null,
  });

  // Draft drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftContent, setDraftContent] = useState("");
  const [draftActionId, setDraftActionId] = useState<string | null>(null);
  const [draftArtifactType, setDraftArtifactType] = useState<string>("");

  // Actions timeline state
  const [actions, setActions] = useState<EscalationAction[]>([]);
  const [showTimeline, setShowTimeline] = useState(false);

  const detectedState = useMemo(() => detectStateFromClaim(claim), [claim]);

  // Load rules + regulations + actions
  useEffect(() => {
    if (!detectedState) { setLoading(false); return; }

    const fetchData = async () => {
      const [rulesRes, regsRes, actionsRes] = await Promise.all([
        supabase.from("escalation_trigger_rules").select("*").eq("state_code", detectedState).eq("is_active", true).order("priority_order"),
        supabase.from("state_insurance_regulations").select("*").eq("state_code", detectedState).order("regulation_type"),
        supabase.from("escalation_actions").select("*").eq("claim_id", claimId).order("created_at", { ascending: false }).limit(20),
      ]);

      if (rulesRes.error) {
        console.error("Error loading escalation rules:", rulesRes.error);
        toast.error("Failed to load escalation rules");
      } else {
        setRules((rulesRes.data || []) as EscalationRule[]);
      }
      setRegulations(regsRes.data || []);
      setActions((actionsRes.data || []) as EscalationAction[]);
      setLoading(false);
    };
    fetchData();
  }, [detectedState, claimId]);

  // Load deadline + playbook data
  useEffect(() => {
    if (!claimId) return;
    const loadDeadlineData = async () => {
      const carrier = claim?.insurance_company || "";
      const trade = claim?.loss_type?.toLowerCase()?.includes("roof") ? "roof"
        : claim?.loss_type?.toLowerCase()?.includes("siding") ? "siding" : null;

      const [deadlinesRes, carrierDeadlinesRes] = await Promise.all([
        supabase.from("claim_deadlines").select("deadline_type, status").eq("claim_id", claimId),
        supabase.from("claim_carrier_deadlines").select("deadline_type, status, days_overdue, bad_faith_potential").eq("claim_id", claimId),
      ]);

      const carrierDeadlines = (carrierDeadlinesRes.data || []) as any[];
      const missed = carrierDeadlines.filter((d: any) => d.status === "overdue" || d.status === "missed");

      let playbookData: { appraisal_delta: number; sample_size: number; label: string } | null = null;
      if (carrier) {
        let q = supabase.from("carrier_scenario_playbooks").select("win_rate, avg_indemnity_delta, sample_size_total, state_code, trade").eq("carrier", carrier);
        if (detectedState) q = q.eq("state_code", detectedState);
        if (trade) q = q.eq("trade", trade);
        const { data: scenarioData } = await q.order("sample_size_total", { ascending: false }).limit(1);
        if (scenarioData?.length) {
          const pb = scenarioData[0];
          playbookData = { appraisal_delta: pb.avg_indemnity_delta || 0, sample_size: pb.sample_size_total || 0, label: (pb.state_code && pb.trade) ? "Scenario-specific" : "Carrier-level aggregate" };
        } else {
          const { data: fallback } = await supabase.from("carrier_scenario_playbooks").select("avg_indemnity_delta, sample_size_total").eq("carrier", carrier).order("sample_size_total", { ascending: false }).limit(1);
          if (fallback?.length) {
            playbookData = { appraisal_delta: fallback[0].avg_indemnity_delta || 0, sample_size: fallback[0].sample_size_total || 0, label: "Carrier-level aggregate (not scenario-specific)" };
          }
        }
      }

      setEnrichedState({
        deadlines: deadlinesRes.data || [],
        carrier_deadlines: carrierDeadlines,
        missed_deadline_count: missed.length,
        has_coverage_determination: carrierDeadlines.some((d: any) => d.deadline_type === "coverage_determination" && d.status === "met"),
        playbook_data: playbookData,
      });
    };
    loadDeadlineData();
  }, [claimId, claim?.insurance_company, detectedState, claim?.loss_type]);

  const claimState = useMemo((): ClaimState => {
    const createdAt = claim?.created_at ? new Date(claim.created_at) : new Date();
    const daysSinceFiled = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
    return {
      days_since_filed: daysSinceFiled,
      deadlines: enrichedState.deadlines,
      carrier_deadlines: enrichedState.carrier_deadlines,
      has_coverage_determination: enrichedState.has_coverage_determination,
      has_written_position: false,
      coverage_accepted: claim?.status === "Coverage Accepted" || claim?.status === "Supplement Submitted",
      scope_disputed: claim?.status === "Supplement Submitted" || claim?.status === "Under Review",
      missed_deadline_count: enrichedState.missed_deadline_count,
      trade: claim?.loss_type?.toLowerCase()?.includes("roof") ? "roof" : claim?.loss_type?.toLowerCase()?.includes("siding") ? "siding" : null,
      denial_rationale: null,
      playbook_data: enrichedState.playbook_data,
    };
  }, [claim, enrichedState]);

  const firedAlerts = useMemo((): EscalationAlert[] => {
    return rules
      .map(rule => ({
        ...rule,
        fired: evaluateRule(rule, claimState),
        playbook_backing: claimState.playbook_data && claimState.playbook_data.sample_size > 0
          ? { confidence: claimState.playbook_data.sample_size >= 25 ? "High" : claimState.playbook_data.sample_size >= 10 ? "Medium" : "Low", n: claimState.playbook_data.sample_size, label: claimState.playbook_data.label }
          : null,
      }))
      .filter(a => a.fired)
      .sort((a, b) => {
        const order = { regulatory_leverage: 0, formal_leverage: 1, soft_leverage: 2 };
        const aO = order[a.escalation_strength as keyof typeof order] ?? 3;
        const bO = order[b.escalation_strength as keyof typeof order] ?? 3;
        return aO !== bO ? aO - bO : a.priority_order - b.priority_order;
      });
  }, [rules, claimState]);

  const recommendedArtifact = useMemo(() => recommendArtifact(claimState, firedAlerts), [claimState, firedAlerts]);

  // Draft artifact handler
  const handleDraft = useCallback(async (artifactType: string, alertIds: string[]) => {
    setDrafting(true);
    setDraftArtifactType(artifactType);
    setDrawerOpen(true);
    setDraftContent("");
    setDraftActionId(null);

    try {
      const resolvedType = artifactTypeMap[artifactType] || artifactType;
      const { data, error } = await supabase.functions.invoke("draft-escalation-artifact", {
        body: { claimId, artifactType: resolvedType, firedRuleIds: alertIds },
      });

      if (error || !data?.success) {
        toast.error(data?.error || "Failed to generate draft");
        setDrawerOpen(false);
      } else {
        setDraftContent(data.draftContent || "");
        setDraftActionId(data.actionId || null);
        toast.success("Draft generated and saved to claim files");
        // Refresh actions
        const { data: updated } = await supabase.from("escalation_actions").select("*").eq("claim_id", claimId).order("created_at", { ascending: false }).limit(20);
        if (updated) setActions(updated as EscalationAction[]);
      }
    } catch (err) {
      console.error(err);
      toast.error("Error generating draft");
      setDrawerOpen(false);
    } finally {
      setDrafting(false);
    }
  }, [claimId]);

  // Status update handler
  const handleStatusUpdate = useCallback(async (actionId: string, newStatus: string) => {
    const { error } = await supabase.from("escalation_actions").update({ status: newStatus }).eq("id", actionId);
    if (error) {
      toast.error("Failed to update status");
    } else {
      toast.success(`Status updated to ${newStatus}`);
      setActions(prev => prev.map(a => a.id === actionId ? { ...a, status: newStatus, updated_at: new Date().toISOString() } : a));
      if (actionId === draftActionId) setDraftActionId(null);
    }
  }, [draftActionId]);

  const handleCopyDraft = useCallback(async () => {
    await navigator.clipboard.writeText(draftContent);
    toast.success("Draft copied to clipboard");
  }, [draftContent]);

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-primary mr-2" />
            <span className="text-sm text-muted-foreground">Loading escalation engine...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!detectedState || (detectedState !== "PA" && detectedState !== "NJ")) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-amber-600" />
            Regulatory Leverage Engine
          </CardTitle>
          <CardDescription>
            Escalation intelligence is available for PA and NJ claims. This claim's state could not be detected or is not yet supported.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const grouped = firedAlerts.reduce((acc, alert) => {
    const key = alert.escalation_strength;
    if (!acc[key]) acc[key] = [];
    acc[key].push(alert);
    return acc;
  }, {} as Record<string, EscalationAlert[]>);

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5 text-amber-600" />
                Regulatory Leverage Engine
              </CardTitle>
              <CardDescription className="mt-1">
                Deterministic escalation triggers for {detectedState === "PA" ? "Pennsylvania" : "New Jersey"} claims
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {actions.length > 0 && (
                <Button variant="outline" size="sm" onClick={() => setShowTimeline(!showTimeline)} className="text-xs gap-1">
                  <History className="h-3 w-3" />
                  Actions ({actions.length})
                </Button>
              )}
              <Badge variant="outline" className="text-sm font-semibold">{detectedState}</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Escalation Actions Timeline */}
          {showTimeline && actions.length > 0 && (
            <div className="border rounded-lg p-3 bg-muted/20 space-y-2">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <History className="h-4 w-4" />
                Escalation Actions Timeline
              </h4>
              <ScrollArea className="max-h-[200px]">
                <div className="space-y-2 pr-2">
                  {actions.map(action => {
                    const sc = statusConfig[action.status] || statusConfig.drafted;
                    const StatusIcon = sc.icon;
                    return (
                      <div key={action.id} className="flex items-center justify-between border rounded-md p-2 bg-card text-sm">
                        <div className="flex items-center gap-2 min-w-0">
                          <StatusIcon className="h-3.5 w-3.5 flex-shrink-0" />
                          <span className="font-medium truncate">{artifactLabels[action.artifact_type] || action.artifact_type}</span>
                          <Badge variant="secondary" className={`text-xs ${sc.color}`}>{sc.label}</Badge>
                          <Badge variant="outline" className="text-xs">{strengthConfig[action.escalation_strength as keyof typeof strengthConfig]?.label || action.escalation_strength}</Badge>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-xs text-muted-foreground">{new Date(action.created_at).toLocaleDateString()}</span>
                          {action.status === "drafted" && (
                            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => handleStatusUpdate(action.id, "sent")}>
                              Mark Sent
                            </Button>
                          )}
                          {action.status === "sent" && (
                            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => handleStatusUpdate(action.id, "acknowledged")}>
                              Mark Ack'd
                            </Button>
                          )}
                          {action.status === "acknowledged" && (
                            <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => handleStatusUpdate(action.id, "resolved")}>
                              Resolve
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>
          )}

          {firedAlerts.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground">
              <Shield className="h-8 w-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No escalation triggers fired for this claim's current state.</p>
              <p className="text-xs mt-1">Triggers activate based on deadlines, carrier behavior, and claim timeline.</p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <AlertTriangle className="h-4 w-4" />
                  <span>{firedAlerts.length} active trigger{firedAlerts.length !== 1 ? "s" : ""} detected</span>
                </div>
                {recommendedArtifact && (
                  <Button
                    size="sm"
                    className="gap-1"
                    onClick={() => handleDraft(recommendedArtifact, firedAlerts.map(a => a.id))}
                    disabled={drafting}
                  >
                    {drafting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
                    {artifactLabels[recommendedArtifact] || "Draft Primary Artifact"}
                  </Button>
                )}
              </div>

              <ScrollArea className="max-h-[500px]">
                <div className="space-y-3 pr-2">
                  {(["regulatory_leverage", "formal_leverage", "soft_leverage"] as const).map(strength => {
                    const alerts = grouped[strength];
                    if (!alerts || alerts.length === 0) return null;
                    const config = strengthConfig[strength];
                    const Icon = config.icon;

                    return (
                      <div key={strength} className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Icon className="h-4 w-4" />
                          <span className="text-xs font-semibold uppercase tracking-wider">{config.label}</span>
                          <Badge variant="secondary" className="text-xs">{alerts.length}</Badge>
                        </div>
                        {alerts.map(alert => (
                          <div key={alert.id} className={`border-l-4 ${config.borderColor} rounded-lg border bg-card p-4 space-y-2`}>
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-medium text-sm">{alert.trigger_name}</span>
                                  <Badge variant="outline" className={`text-xs ${config.color}`}>{config.label}</Badge>
                                </div>
                                <p className="text-xs text-muted-foreground mt-1 font-mono">{alert.regulation_citation}</p>
                              </div>
                            </div>
                            <p className="text-sm text-muted-foreground">{alert.regulation_summary}</p>
                            <div className="bg-muted/50 rounded-md p-3 text-sm">
                              <p className="font-medium text-foreground">{alert.recommended_action}</p>
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                              {alert.recommended_artifact && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="text-xs h-7"
                                  disabled={drafting}
                                  onClick={() => handleDraft(alert.recommended_artifact!, [alert.id])}
                                >
                                  {drafting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <FileText className="h-3 w-3 mr-1" />}
                                  {artifactLabels[alert.recommended_artifact] || alert.recommended_artifact}
                                </Button>
                              )}
                              {alert.playbook_backing && (
                                <Badge variant="secondary" className="text-xs">
                                  Playbook: {alert.playbook_backing.confidence} (n={alert.playbook_backing.n}) — {alert.playbook_backing.label}
                                </Badge>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>
          )}

          {/* Collapsible full regulation reference */}
          <Collapsible open={showRegulations} onOpenChange={setShowRegulations}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" className="w-full justify-between text-sm text-muted-foreground">
                <span className="flex items-center gap-2">
                  <Scale className="h-4 w-4" />
                  Full {detectedState} Regulation Reference ({regulations.length} entries)
                </span>
                <ChevronDown className={`h-4 w-4 transition-transform ${showRegulations ? "rotate-180" : ""}`} />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ScrollArea className="h-[300px] mt-2">
                <div className="space-y-2 pr-2">
                  {regulations.map((reg: any) => (
                    <div key={reg.id} className="border rounded-md p-3 bg-muted/20 text-sm space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{reg.regulation_title}</span>
                        <Badge variant="outline" className="text-xs">{reg.regulation_citation}</Badge>
                        {reg.deadline_days && <Badge variant="secondary" className="text-xs">{reg.deadline_days} days</Badge>}
                      </div>
                      <p className="text-muted-foreground text-xs">{reg.description}</p>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>

      {/* Draft Preview Drawer */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent className="sm:max-w-xl w-full overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              {artifactLabels[draftArtifactType] || "Escalation Artifact"}
            </SheetTitle>
            <SheetDescription>
              Review, edit, and send the generated draft. Auto-saved to claim files.
            </SheetDescription>
          </SheetHeader>
          <div className="py-4 space-y-4">
            {drafting ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-primary mr-2" />
                <span className="text-sm text-muted-foreground">Generating draft...</span>
              </div>
            ) : (
              <Textarea
                value={draftContent}
                onChange={e => setDraftContent(e.target.value)}
                className="min-h-[400px] font-mono text-sm"
                placeholder="Draft content will appear here..."
              />
            )}
          </div>
          <SheetFooter className="flex-row gap-2 sm:justify-start">
            <Button variant="outline" size="sm" onClick={handleCopyDraft} disabled={!draftContent}>
              <Copy className="h-3 w-3 mr-1" />
              Copy
            </Button>
            {draftActionId && (
              <Button
                size="sm"
                onClick={() => handleStatusUpdate(draftActionId, "sent")}
              >
                <Send className="h-3 w-3 mr-1" />
                Mark as Sent
              </Button>
            )}
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
};

export default DarwinEscalationEngine;
