import { useState, useEffect, useMemo, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { supabase } from "@/integrations/supabase/client";
import { Shield, AlertTriangle, Info, ChevronDown, FileText, Scale, Loader2, Zap } from "lucide-react";
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
  rebuttal: "Draft Rebuttal",
  rfi: "Draft RFI",
  supplement: "Draft Supplement",
  doi_complaint: "Draft DOI Complaint",
  formal_position_request: "Draft Position Request",
  appraisal_demand: "Draft Appraisal Demand",
};

// --- FIX #1: Robust state detection with word-boundary regex ---
const STATE_PATTERNS: Array<{ code: string; regex: RegExp }> = [
  { code: "NJ", regex: /(^|[\s,])NJ([\s,]|$)/i },
  { code: "NJ", regex: /\bNEW\s+JERSEY\b/i },
  { code: "PA", regex: /(^|[\s,])PA([\s,]|$)/i },
  { code: "PA", regex: /\bPENNSYLVANIA\b/i },
];

// Match state abbreviation preceding a ZIP code (e.g. "NJ 08050")
const ZIP_STATE_REGEX = /\b([A-Z]{2})\s+\d{5}\b/;

function detectStateFromClaim(claim: any): string | null {
  // Prefer structured field first
  const structuredState = (claim?.client_state || claim?.property_state || "").toUpperCase().trim();
  if (structuredState === "PA" || structuredState === "PENNSYLVANIA") return "PA";
  if (structuredState === "NJ" || structuredState === "NEW JERSEY") return "NJ";

  const address = (claim?.policyholder_address || "");
  if (!address) return null;

  // Try ZIP-based detection first (most reliable)
  const zipMatch = address.toUpperCase().match(ZIP_STATE_REGEX);
  if (zipMatch) {
    const abbr = zipMatch[1];
    if (abbr === "PA") return "PA";
    if (abbr === "NJ") return "NJ";
  }

  // Fallback: word-boundary regex patterns
  for (const { code, regex } of STATE_PATTERNS) {
    if (regex.test(address)) return code;
  }

  return null;
}

// --- FIX #3 & #5: Cleaned up rule evaluation ---
function evaluateRule(rule: EscalationRule, claimState: ClaimState): boolean {
  const c = rule.condition_logic;
  
  if (c.days_since_claim_filed_gt && claimState.days_since_filed <= c.days_since_claim_filed_gt) return false;
  
  // FIX #3: Renamed semantics — "deadline_status_not" means "fire if no deadline has this status"
  // i.e., if any deadline of the given type HAS this status, suppress the trigger.
  if (c.deadline_type && c.deadline_status_not) {
    const allDeadlines = [...claimState.deadlines, ...claimState.carrier_deadlines];
    const matching = allDeadlines.filter(d => d.deadline_type === c.deadline_type);
    // If a matching deadline exists with the "not" status, rule doesn't fire
    if (matching.some(d => d.status === c.deadline_status_not)) return false;
    // If no deadlines tracked at all for this type, rule fires (absence = not met)
  }
  
  if (c.no_coverage_determination && claimState.has_coverage_determination) return false;
  if (c.no_written_coverage_position && claimState.has_written_position) return false;
  if (c.coverage_accepted && !claimState.coverage_accepted) return false;
  if (c.scope_disputed && !claimState.scope_disputed) return false;
  if (c.missed_deadlines_gt && claimState.missed_deadline_count <= c.missed_deadlines_gt) return false;
  
  if (c.trade_in) {
    if (!claimState.trade || !c.trade_in.includes(claimState.trade.toLowerCase())) return false;
  }
  
  if (c.denial_rationale_contains) {
    if (!claimState.denial_rationale || !claimState.denial_rationale.toLowerCase().includes(c.denial_rationale_contains.toLowerCase())) return false;
  }
  
  // FIX #5: state_supports_matching — PA and NJ both support matching.
  // If a rule requires this, it's already baked into the state_code filter.
  // Explicitly: if condition requires matching support and state is PA/NJ, pass. Otherwise fail.
  if (c.state_supports_matching === true) {
    // Both PA and NJ support matching — this is enforced by the state_code column on the rule.
    // No additional check needed since rules are already filtered by state_code.
  }
  
  if (c.playbook_appraisal_delta_gt !== undefined) {
    if (!claimState.playbook_data || claimState.playbook_data.appraisal_delta <= c.playbook_appraisal_delta_gt) return false;
  }
  
  if (c.playbook_sample_size_gt !== undefined) {
    if (!claimState.playbook_data || claimState.playbook_data.sample_size <= c.playbook_sample_size_gt) return false;
  }

  return true;
}

export const DarwinEscalationEngine = ({ claimId, claim }: DarwinEscalationEngineProps) => {
  const [rules, setRules] = useState<EscalationRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRegulations, setShowRegulations] = useState(false);
  const [regulations, setRegulations] = useState<any[]>([]);
  // FIX #2: Use useState for mutable claim state instead of mutating useMemo
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

  const detectedState = useMemo(() => detectStateFromClaim(claim), [claim]);

  // Load rules + regulations
  useEffect(() => {
    if (!detectedState) {
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      const [rulesRes, regsRes] = await Promise.all([
        supabase
          .from("escalation_trigger_rules")
          .select("*")
          .eq("state_code", detectedState)
          .eq("is_active", true)
          .order("priority_order"),
        supabase
          .from("state_insurance_regulations")
          .select("*")
          .eq("state_code", detectedState)
          .order("regulation_type"),
      ]);

      if (rulesRes.error) {
        console.error("Error loading escalation rules:", rulesRes.error);
        toast.error("Failed to load escalation rules");
      } else {
        setRules((rulesRes.data || []) as EscalationRule[]);
      }

      setRegulations(regsRes.data || []);
      setLoading(false);
    };

    fetchData();
  }, [detectedState]);

  // FIX #2: Build base claim state immutably from claim prop + enriched state
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

  // FIX #2 & #4: Load deadline + scenario-specific playbook data into state properly
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

      // FIX #4: Scenario-specific playbook query with tiered broadening
      let playbookData: { appraisal_delta: number; sample_size: number; label: string } | null = null;
      if (carrier) {
        let playbookQuery = supabase
          .from("carrier_scenario_playbooks")
          .select("win_rate, avg_indemnity_delta, sample_size_total, state_code, trade, loss_type")
          .eq("carrier", carrier);

        if (detectedState) playbookQuery = playbookQuery.eq("state_code", detectedState);
        if (trade) playbookQuery = playbookQuery.eq("trade", trade);

        const { data: scenarioData } = await playbookQuery.order("sample_size_total", { ascending: false }).limit(1);

        if (scenarioData && scenarioData.length > 0) {
          const pb = scenarioData[0];
          playbookData = {
            appraisal_delta: pb.avg_indemnity_delta || 0,
            sample_size: pb.sample_size_total || 0,
            label: (pb.state_code && pb.trade) ? "Scenario-specific" : "Carrier-level aggregate",
          };
        } else {
          // Tier 2: carrier-only fallback
          const { data: fallback } = await supabase
            .from("carrier_scenario_playbooks")
            .select("win_rate, avg_indemnity_delta, sample_size_total")
            .eq("carrier", carrier)
            .order("sample_size_total", { ascending: false })
            .limit(1);

          if (fallback && fallback.length > 0) {
            playbookData = {
              appraisal_delta: fallback[0].avg_indemnity_delta || 0,
              sample_size: fallback[0].sample_size_total || 0,
              label: "Carrier-level aggregate (not scenario-specific)",
            };
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

  // Evaluate which rules fire
  const firedAlerts = useMemo((): EscalationAlert[] => {
    return rules
      .map(rule => ({
        ...rule,
        fired: evaluateRule(rule, claimState),
        playbook_backing: claimState.playbook_data && claimState.playbook_data.sample_size > 0
          ? { 
              confidence: claimState.playbook_data.sample_size >= 25 ? "High" : claimState.playbook_data.sample_size >= 10 ? "Medium" : "Low", 
              n: claimState.playbook_data.sample_size,
              label: claimState.playbook_data.label,
            }
          : null,
      }))
      .filter(a => a.fired)
      .sort((a, b) => {
        const strengthOrder = { regulatory_leverage: 0, formal_leverage: 1, soft_leverage: 2 };
        const aOrder = strengthOrder[a.escalation_strength as keyof typeof strengthOrder] ?? 3;
        const bOrder = strengthOrder[b.escalation_strength as keyof typeof strengthOrder] ?? 3;
        return aOrder !== bOrder ? aOrder - bOrder : a.priority_order - b.priority_order;
      });
  }, [rules, claimState]);

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
          <Badge variant="outline" className="text-sm font-semibold">
            {detectedState}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {firedAlerts.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            <Shield className="h-8 w-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No escalation triggers fired for this claim's current state.</p>
            <p className="text-xs mt-1">Triggers activate based on deadlines, carrier behavior, and claim timeline.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <AlertTriangle className="h-4 w-4" />
              <span>{firedAlerts.length} active trigger{firedAlerts.length !== 1 ? "s" : ""} detected</span>
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
                                <Badge variant="outline" className={`text-xs ${config.color}`}>
                                  {config.label}
                                </Badge>
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
                              <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => toast.info(`${artifactLabels[alert.recommended_artifact!] || alert.recommended_artifact} — use Darwin chat or the appropriate tool to draft this document.`)}>
                                <FileText className="h-3 w-3 mr-1" />
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
  );
};

export default DarwinEscalationEngine;
