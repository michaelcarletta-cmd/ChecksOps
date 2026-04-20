import { useState, useEffect, lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  Swords, Clock, Shield, FileText, Zap, Target,
  AlertTriangle, Loader2, Brain
} from "lucide-react";
import { differenceInDays } from "date-fns";

import { WSIBreakdown } from "./war-room/WSIBreakdown";
import { LitigationReadiness } from "./war-room/LitigationReadiness";
import { PressureIndex } from "./war-room/PressureIndex";
import { PredictedCarrierMove } from "./war-room/PredictedCarrierMove";
import { ScenarioSimulator } from "./war-room/ScenarioSimulator";
import { StrategicMemo } from "./war-room/StrategicMemo";
import { GapIntelligenceEngine } from "./war-room/GapIntelligenceEngine";
import { AdaptiveCounterTactics } from "./war-room/AdaptiveCounterTactics";
import { CarrierArgumentRebuttals } from "./war-room/CarrierArgumentRebuttals";

const WarRoomTimeline = lazy(() => import("./war-room/WarRoomTimeline").then(m => ({ default: m.WarRoomTimeline })));

interface ClaimWarRoomProps {
  claimId: string;
  claim: any;
}

export const ClaimWarRoom = ({ claimId, claim }: ClaimWarRoomProps) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [isOpen, setIsOpen] = useState(() => searchParams.get("tab") === "warroom");

  // Auto-open when navigated with ?tab=warroom
  useEffect(() => {
    if (searchParams.get("tab") === "warroom") {
      setIsOpen(true);
      // Clean up the query param
      searchParams.delete("tab");
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);
  const [insights, setInsights] = useState<any>(null);
  const [deadlines, setDeadlines] = useState<any[]>([]);
  const [strategySimulations, setStrategySimulations] = useState<any[]>([]);
  const [photoIntelSummary, setPhotoIntelSummary] = useState<any>(null);
  const [argumentMapCount, setArgumentMapCount] = useState(0);
  const [intelligenceSummary, setIntelligenceSummary] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (isOpen) loadWarRoomData();
  }, [isOpen, claimId]);

  const loadWarRoomData = async () => {
    setLoading(true);
    try {
      const start = performance.now();
      const [insightsResult, deadlinesResult, strategiesResult, photoFindingsResult, argMapResult, intelSummaryResult] = await Promise.all([
        supabase.from('claim_strategic_insights').select('*').eq('claim_id', claimId).single(),
        supabase.from('claim_carrier_deadlines').select('*').eq('claim_id', claimId).order('deadline_date', { ascending: true }),
        supabase.from('claim_strategy_simulations').select('*').eq('claim_id', claimId).order('score', { ascending: false }),
        supabase.from('claim_photo_findings').select('finding_type, evidence_strength, severity').eq('claim_id', claimId),
        supabase.from('claim_argument_map').select('id').eq('claim_id', claimId),
        supabase.from('claim_intelligence_summary').select('*').eq('claim_id', claimId).order('version', { ascending: false }).limit(1).maybeSingle(),
      ]);
      console.log(`[query] loadWarRoomData (6 parallel): ${(performance.now() - start).toFixed(2)}ms`);
      if (insightsResult.data) setInsights(insightsResult.data);
      if (deadlinesResult.data) setDeadlines(deadlinesResult.data);
      if (strategiesResult.data) setStrategySimulations(strategiesResult.data);
      if (argMapResult.data) setArgumentMapCount(argMapResult.data.length);
      if (intelSummaryResult.data) setIntelligenceSummary(intelSummaryResult.data);
      if (photoFindingsResult.data && photoFindingsResult.data.length > 0) {
        const byType: Record<string, number> = {};
        const strongCount = photoFindingsResult.data.filter((f: any) => f.evidence_strength === 'strong').length;
        photoFindingsResult.data.forEach((f: any) => { byType[f.finding_type] = (byType[f.finding_type] || 0) + 1; });
        setPhotoIntelSummary({ total: photoFindingsResult.data.length, byType, strongEvidence: strongCount });
      }
    } catch (error) {
      console.error("Error loading war room data:", error);
    } finally {
      setLoading(false);
    }
  };

  const runAnalysis = async () => {
    setLoading(true);
    try {
      // Run strategic intelligence + strategy simulation + orchestrator in parallel
      const [stratResult, simResult, orchResult] = await Promise.all([
        supabase.functions.invoke('darwin-strategic-intelligence', {
          body: { claimId, analysisType: 'war_room_2' }
        }),
        supabase.functions.invoke('darwin-strategy-simulation', {
          body: { claimId }
        }),
        supabase.functions.invoke('darwin-intelligence-orchestrator', {
          body: { claimId, triggerEvent: 'war_room_opened' }
        }),
      ]);
      if (stratResult.error) throw stratResult.error;
      toast({ title: "War Room 2.0 Analysis Complete", description: "Strategic intelligence + orchestrator updated" });
      await loadWarRoomData();
    } catch (error: any) {
      toast({ title: "Analysis Failed", description: error.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const daysOpen = claim?.created_at ? differenceInDays(new Date(), new Date(claim.created_at)) : 0;
  const overdueDeadlines = deadlines.filter(d => d.days_overdue && d.days_overdue > 0);
  const badFaithIndicators = deadlines.filter(d => d.bad_faith_potential);

  // War Room 2.0 data
  const wsiScore = insights?.wsi_score ?? insights?.overall_health_score ?? null;
  const wsiComponents = insights?.wsi_components ?? null;
  const litScore = insights?.litigation_readiness_score ?? null;
  const litFactors = insights?.litigation_readiness_factors ?? null;
  const pressureScore = insights?.pressure_index_score ?? null;
  const pressureLevel = insights?.pressure_index_level ?? null;
  const pressureFactors = insights?.pressure_index_factors ?? null;
  const predictedMove = insights?.predicted_carrier_move ?? null;
  const strategicMemo = insights?.strategic_memo ?? null;
  const scenarioSims = insights?.scenario_simulations ?? null;
  const confidenceScores = insights?.confidence_scores ?? null;
  const evidenceAssessment = insights ? {
    strong_evidence: Array.isArray(insights.leverage_points) ? insights.leverage_points.map((p: any) => typeof p === 'string' ? p : p.title || p.description) : [],
    weak_missing_evidence: Array.isArray(insights.evidence_gaps) ? insights.evidence_gaps : [],
    recommendations: Array.isArray(insights.recommended_next_moves) ? insights.recommended_next_moves.map((m: any) => typeof m === 'string' ? m : m.action || m.title) : [],
    ...((insights as any)?.evidence_assessment_extended || {}),
  } : null;
  const counterTactics = (insights?.counter_strategies as any[]) ?? null;

  // Drift detection from latest snapshot
  const [driftDetected, setDriftDetected] = useState(false);
  const [driftReason, setDriftReason] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !claimId) return;
    supabase
      .from('claim_strategic_snapshots')
      .select('strategic_drift_flag, drift_reason')
      .eq('claim_id', claimId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setDriftDetected(!!data.strategic_drift_flag);
          setDriftReason(data.drift_reason);
        }
      });
  }, [isOpen, claimId, insights]);

  const getScoreColor = (score: number | null) => {
    if (score === null) return "text-muted-foreground";
    if (score >= 75) return "text-success";
    if (score >= 50) return "text-warning";
    return "text-destructive";
  };

  const pressureBadgeColor =
    pressureLevel === "high" ? "bg-destructive text-destructive-foreground" :
    pressureLevel === "moderate" ? "bg-warning text-warning-foreground" :
    "bg-success/20 text-success";

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2 border-primary/50 hover:bg-primary/10">
          <Swords className="h-4 w-4 text-primary" />
          War Room
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-7xl max-h-[90vh] p-0">
        <DialogHeader className="p-6 pb-4 border-b bg-gradient-to-r from-primary/5 to-transparent">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Swords className="h-6 w-6 text-primary" />
              </div>
              <div>
                <DialogTitle className="text-xl">Strategic Command Center</DialogTitle>
                <p className="text-sm text-muted-foreground">
                  {claim?.claim_number} • War Room 2.0
                </p>
              </div>
            </div>
            <Button onClick={runAnalysis} disabled={loading} size="sm">
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Zap className="h-4 w-4 mr-2" />}
              {insights ? "Refresh Analysis" : "Run Analysis"}
            </Button>
          </div>
        </DialogHeader>

        <ScrollArea className="max-h-[calc(90vh-120px)]">
          <div className="p-6 space-y-6">
            {/* === TOP STATS BAR === */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3">
              {/* WSI */}
              <WSIBreakdown wsiScore={wsiScore} components={wsiComponents} confidenceScores={confidenceScores}>
                <Card className="bg-gradient-to-br from-primary/10 to-primary/5 cursor-pointer hover:from-primary/15 transition-colors">
                  <CardContent className="p-3 text-center">
                    <div className={`text-3xl font-bold ${getScoreColor(wsiScore)}`}>{wsiScore ?? "--"}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">WSI Score</div>
                    {confidenceScores?.overall && (
                      <div className="text-[9px] text-muted-foreground capitalize">{confidenceScores.overall} conf.</div>
                    )}
                  </CardContent>
                </Card>
              </WSIBreakdown>

              {/* Litigation Readiness */}
              <LitigationReadiness score={litScore} factors={litFactors}>
                <Card className="cursor-pointer hover:bg-accent/50 transition-colors">
                  <CardContent className="p-3 text-center">
                    <div className={`text-3xl font-bold ${getScoreColor(litScore)}`}>{litScore ?? "--"}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">Lit. Readiness</div>
                  </CardContent>
                </Card>
              </LitigationReadiness>

              {/* Pressure Index */}
              <PressureIndex score={pressureScore} level={pressureLevel} factors={pressureFactors} confidenceLevel={confidenceScores?.pressure_index?.level}>
                <Card className="cursor-pointer hover:bg-accent/50 transition-colors">
                  <CardContent className="p-3 text-center">
                    {pressureLevel ? (
                      <Badge className={`text-sm px-2 py-1 ${pressureBadgeColor}`}>
                        {pressureLevel.toUpperCase()}
                      </Badge>
                    ) : (
                      <div className="text-3xl font-bold text-muted-foreground">--</div>
                    )}
                    <div className="text-[10px] text-muted-foreground mt-1">Pressure</div>
                  </CardContent>
                </Card>
              </PressureIndex>

              {/* Days Open */}
              <Card>
                <CardContent className="p-3 text-center">
                  <div className="text-3xl font-bold">{daysOpen}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">Days Open</div>
                </CardContent>
              </Card>

              {/* Overdue Deadlines */}
              <Card>
                <CardContent className="p-3 text-center">
                  <div className="text-3xl font-bold text-destructive">{overdueDeadlines.length}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">Overdue</div>
                </CardContent>
              </Card>

              {/* Bad Faith Flags */}
              <Card>
                <CardContent className="p-3 text-center">
                  <div className="text-3xl font-bold text-warning">{badFaithIndicators.length}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">Bad Faith</div>
                </CardContent>
              </Card>
            </div>

            {/* === INTELLIGENCE ORCHESTRATOR BRIEFING === */}
            {intelligenceSummary && (
              <Card className="border-2 border-primary/30 bg-gradient-to-r from-primary/5 to-transparent">
                <CardHeader className="py-3 px-4 bg-primary/5">
                   <CardTitle className="text-sm flex items-center gap-2">
                    <Brain className="h-4 w-4 text-primary" />
                    Darwin Intelligence Briefing
                    {intelligenceSummary.version && (
                      <Badge variant="outline" className="text-[9px]">v{intelligenceSummary.version}</Badge>
                    )}
                    <Badge variant="secondary" className="ml-auto text-[10px]">
                      Confidence: {intelligenceSummary.confidence_score}%
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-3">
                  {/* Change Reason */}
                  {intelligenceSummary.change_reason && intelligenceSummary.version > 1 && (
                    <div className="text-[10px] text-muted-foreground italic border-b border-border/40 pb-2">
                      Changed: {intelligenceSummary.change_reason}
                    </div>
                  )}

                  {/* Decomposed Confidence */}
                  {(intelligenceSummary.evidence_confidence != null) && (
                    <div className="grid grid-cols-5 gap-1">
                      {[
                        { label: 'Evidence', val: intelligenceSummary.evidence_confidence },
                        { label: 'Financial', val: intelligenceSummary.financial_confidence },
                        { label: 'Strategy', val: intelligenceSummary.strategy_confidence },
                        { label: 'Rebuttal', val: intelligenceSummary.rebuttal_confidence },
                        { label: 'Learning', val: intelligenceSummary.learning_confidence },
                      ].map(d => (
                        <div key={d.label} className="text-center">
                          <div className="text-[9px] text-muted-foreground">{d.label}</div>
                          <Progress value={d.val} className="h-1 mt-0.5" />
                          <div className="text-[9px] font-medium">{d.val}%</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Priority Issue */}
                  {intelligenceSummary.most_important_issue && (
                    <div className="p-3 rounded-lg bg-destructive/5 border border-destructive/20">
                      <div className="text-[10px] font-semibold text-destructive uppercase tracking-wide mb-1">Priority Issue</div>
                      <p className="text-sm">{intelligenceSummary.most_important_issue}</p>
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {/* Recovery Opportunity */}
                    {intelligenceSummary.largest_recovery_opportunity?.description && (
                      <div className="p-3 rounded-lg bg-success/5 border border-success/20">
                        <div className="text-[10px] font-semibold text-success uppercase tracking-wide mb-1">Largest Recovery Opportunity</div>
                        <p className="text-xs">{intelligenceSummary.largest_recovery_opportunity.description}</p>
                        {intelligenceSummary.largest_recovery_opportunity.estimated_delta > 0 && (
                          <div className="mt-1 text-sm font-bold text-success">
                            +${Number(intelligenceSummary.largest_recovery_opportunity.estimated_delta).toLocaleString()}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Carrier Weakness */}
                    {intelligenceSummary.carrier_weakest_argument?.argument_summary && (
                      <div className="p-3 rounded-lg bg-warning/5 border border-warning/20">
                        <div className="text-[10px] font-semibold text-warning uppercase tracking-wide mb-1">Carrier Weak Point</div>
                        <p className="text-xs">{intelligenceSummary.carrier_weakest_argument.argument_summary}</p>
                        <Badge variant="outline" className="text-[9px] mt-1 capitalize">
                          {(intelligenceSummary.carrier_weakest_argument.weakness_type || '').replace(/_/g, ' ')}
                        </Badge>
                      </div>
                    )}
                  </div>

                  {/* Recommended Action */}
                  {intelligenceSummary.recommended_next_action?.action && (
                    <div className="p-3 rounded-lg bg-primary/5 border border-primary/20">
                      <div className="text-[10px] font-semibold text-primary uppercase tracking-wide mb-1">
                        Recommended Next Action
                        {intelligenceSummary.recommended_next_action.priority && (
                          <Badge variant="outline" className="ml-2 text-[9px] capitalize">{intelligenceSummary.recommended_next_action.priority}</Badge>
                        )}
                      </div>
                      <p className="text-xs">{intelligenceSummary.recommended_next_action.action}</p>
                      {intelligenceSummary.recommended_next_action.expected_impact && (
                        <p className="text-[10px] text-muted-foreground mt-1">Impact: {intelligenceSummary.recommended_next_action.expected_impact}</p>
                      )}
                    </div>
                  )}

                  {/* Missing Evidence */}
                  {Array.isArray(intelligenceSummary.missing_evidence) && intelligenceSummary.missing_evidence.length > 0 && (
                    <div>
                      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Missing Evidence</div>
                      <div className="flex flex-wrap gap-1">
                        {(intelligenceSummary.missing_evidence as any[]).slice(0, 5).map((e: any, i: number) => (
                          <Badge key={i} variant="outline" className={`text-[9px] ${e.priority === 'critical' ? 'border-destructive text-destructive' : 'border-warning/50 text-warning'}`}>
                            {typeof e === 'string' ? e : e.item}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Strongest Evidence */}
                  {Array.isArray(intelligenceSummary.strongest_evidence) && intelligenceSummary.strongest_evidence.length > 0 && (
                    <div>
                      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Strongest Evidence</div>
                      <div className="flex flex-wrap gap-1">
                        {(intelligenceSummary.strongest_evidence as any[]).slice(0, 5).map((e: any, i: number) => (
                          <Badge key={i} variant="secondary" className="text-[9px]">
                            {e.type}: {e.description?.slice(0, 60)}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* === FOUR QUADRANTS === */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Q1: Evidence-Linked Timeline */}
              <Card className="border-2 md:col-span-2">
                <CardHeader className="py-3 px-4 bg-muted/30">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Clock className="h-4 w-4 text-chart-2" />
                    AI Claim Timeline
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  <Suspense fallback={<div className="flex items-center justify-center h-full"><Loader2 className="h-6 w-6 animate-spin" /></div>}>
                    <WarRoomTimeline claimId={claimId} claim={claim} />
                  </Suspense>
                </CardContent>
              </Card>

              {/* Q2: Strategic Position + Predicted Move */}
              <Card className="border-2">
                <CardHeader className="py-3 px-4 bg-muted/30">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Shield className="h-4 w-4 text-success" />
                    Strategic Position
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 min-h-[300px]">
                  {wsiComponents ? (
                    <div className="space-y-4">
                      <div className="space-y-3">
                        {Object.entries(wsiComponents).map(([key, comp]: [string, any]) => (
                          <div key={key} className="space-y-1">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground capitalize">{key.replace(/_/g, " ")} ({comp.weight}%)</span>
                              <span className="font-medium">{comp.score}</span>
                            </div>
                            <Progress value={comp.score} className={`h-2 ${comp.score >= 75 ? "bg-success" : comp.score >= 50 ? "bg-warning" : "bg-destructive"}`} />
                          </div>
                        ))}
                      </div>
                      <PredictedCarrierMove prediction={predictedMove} confidenceLevel={confidenceScores?.predicted_move?.level} />
                    </div>
                  ) : insights ? (
                    <div className="space-y-3">
                      <ScoreBar label="Coverage Strength" score={insights.coverage_strength_score} />
                      <ScoreBar label="Evidence Quality" score={insights.evidence_quality_score} />
                      <ScoreBar label="Leverage" score={insights.leverage_score} />
                      <ScoreBar label="Timeline Risk" score={insights.timeline_risk_score} />
                    </div>
                  ) : (
                    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                      Run analysis to see strategic position
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Q3: Gap Intelligence Engine */}
              <Card className="border-2">
                <CardHeader className="py-3 px-4 bg-muted/30">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <FileText className="h-4 w-4 text-chart-5" />
                    Gap Intelligence Engine
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 min-h-[300px]">
                  <GapIntelligenceEngine
                    claimId={claimId}
                    insights={insights}
                    evidenceAssessment={evidenceAssessment}
                  />
                </CardContent>
              </Card>

              {/* Q4: Adaptive Counter-Tactics */}
              <Card className="border-2">
                <CardHeader className="py-3 px-4 bg-muted/30">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Target className="h-4 w-4 text-warning" />
                    Adaptive Counter-Tactics
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 min-h-[300px]">
                  {insights ? (
                    <AdaptiveCounterTactics
                      insights={insights}
                      claim={claim}
                      counterTactics={counterTactics}
                      onExecuteAction={(tactic) => console.log("Execute", tactic)}
                      onGenerateLetter={(tactic) => console.log("Generate Letter", tactic)}
                      onAddToTimeline={(tactic) => console.log("Add to Timeline", tactic)}
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                      Run analysis to see counter-tactics
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* === CARRIER ARGUMENT REBUTTALS === */}
            <Card className="border-2">
              <CardHeader className="py-3 px-4 bg-muted/30">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Shield className="h-4 w-4 text-destructive" />
                  Carrier Argument Detection & Rebuttals
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                <CarrierArgumentRebuttals claimId={claimId} />
              </CardContent>
            </Card>

            {/* === STRATEGY SIMULATIONS (Decision Engine) === */}
            {strategySimulations.length > 0 && (
              <Card className="border-2">
                <CardHeader className="py-3 px-4 bg-muted/30">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Brain className="h-4 w-4 text-primary" />
                    Strategy Decision Engine
                    <Badge variant="secondary" className="ml-auto text-[10px]">{strategySimulations.length} options scored</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-3">
                  {strategySimulations.map((sim: any) => (
                    <div key={sim.id} className={`p-3 rounded-lg border ${sim.is_recommended ? 'border-primary bg-primary/5' : 'border-border'}`}>
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm capitalize">{(sim.strategy_type || '').replace(/_/g, ' ')}</span>
                          {sim.is_recommended && <Badge className="text-[10px] bg-primary">Recommended</Badge>}
                          {sim.risk_level && (
                            <Badge variant="outline" className={`text-[10px] ${sim.risk_level === 'high' ? 'border-destructive text-destructive' : sim.risk_level === 'medium' ? 'border-warning text-warning' : 'border-success text-success'}`}>
                              {sim.risk_level} risk
                            </Badge>
                          )}
                        </div>
                        <span className="text-lg font-bold">{sim.score}</span>
                      </div>
                      <p className="text-xs text-muted-foreground mb-1">{sim.recommended_action}</p>
                      {sim.predicted_recovery_delta && (
                        <div className="flex gap-4 text-[10px] text-muted-foreground">
                          <span>Recovery: +${Number(sim.predicted_recovery_delta).toLocaleString()}</span>
                          {sim.predicted_timeline_days && <span>Timeline: ~{sim.predicted_timeline_days}d</span>}
                          {sim.evidence_completeness_pct && <span>Evidence: {sim.evidence_completeness_pct}%</span>}
                        </div>
                      )}
                      {sim.required_missing_evidence?.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {(sim.required_missing_evidence as string[]).slice(0, 3).map((e: string, i: number) => (
                            <Badge key={i} variant="outline" className="text-[9px] border-warning/50 text-warning">{e}</Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* === PHOTO INTELLIGENCE SUMMARY === */}
            {photoIntelSummary && (
              <Card className="border-2">
                <CardHeader className="py-3 px-4 bg-muted/30">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Target className="h-4 w-4 text-chart-3" />
                    Photo Intelligence
                    <Badge variant="secondary" className="ml-auto text-[10px]">{photoIntelSummary.total} findings</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(photoIntelSummary.byType).map(([type, count]: [string, any]) => (
                      <Badge key={type} variant="outline" className="text-xs capitalize">
                        {type.replace(/_/g, ' ')}: {count}
                      </Badge>
                    ))}
                    <Badge className="bg-success/20 text-success text-xs">
                      {photoIntelSummary.strongEvidence} strong evidence
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* === ARGUMENT MAP SUMMARY === */}
            {argumentMapCount > 0 && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/5 border border-destructive/20">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                <span className="text-sm font-medium">{argumentMapCount} carrier arguments mapped and classified</span>
              </div>
            )}

            {/* === SCENARIO SIMULATION === */}
            <ScenarioSimulator scenarios={scenarioSims} confidenceLevel={confidenceScores?.scenarios?.level} />

            {/* === STRATEGIC MEMO === */}
            <StrategicMemo memo={strategicMemo} claimNumber={claim?.claim_number} driftDetected={driftDetected} driftReason={driftReason} />

            {/* Legacy Senior PA Opinion fallback */}
            {!strategicMemo && insights?.senior_pa_opinion && (
              <Card className="border-primary/30 bg-gradient-to-r from-primary/5 to-transparent">
                <CardHeader className="py-3 px-4">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Shield className="h-4 w-4 text-primary" />
                    Senior PA Strategic Assessment
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4">
                  <p className="text-sm italic text-muted-foreground leading-relaxed">
                    "{insights.senior_pa_opinion}"
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};

const ScoreBar = ({ label, score }: { label: string; score: number | null }) => {
  const getColor = () => {
    if (!score) return "bg-muted";
    if (score >= 75) return "bg-success";
    if (score >= 50) return "bg-warning";
    return "bg-destructive";
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{score ?? "--"}</span>
      </div>
      <Progress value={score ?? 0} className={`h-2 ${getColor()}`} />
    </div>
  );
};
