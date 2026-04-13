import { useState, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  DollarSign,
  Eye,
  FileText,
  Layers,
  Loader2,
  RefreshCw,
  Shield,
  Sparkles,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface DarwinCockpitProps {
  claimId: string;
  claim: any;
  onNavigateSection?: (section: string) => void;
}

interface NextAction {
  type: string;
  summary: string;
  due_at: string | null;
  draft_id: string | null;
  why: string;
  priority: number;
  confidence: "high" | "medium" | "low";
  bullets: string[];
  scores?: {
    money_impact: number;
    deadline_risk: number;
    aging: number;
    resistance: number;
  };
}

interface PaymentSnapshot {
  claimed_rcv?: number;
  acv_value?: number | null;
  dep_total?: number | null;
  paid_total?: number;
  paid_acv?: number;
  paid_rd?: number;
  rd_available?: number | null;
  gap: number;
  unclassified_payment_total?: number;
  money_confidence?: "high" | "medium" | "low";
  pct_paid?: number;
  gap_stale_days?: number | null;
  // Legacy aliases
  claimed: number;
  paid: number;
}

interface MasterState {
  phase: string;
  phase_label?: string;
  health: "green" | "yellow" | "red";
  resistance: "low" | "med" | "high";
  next_action: NextAction;
  payment_snapshot: PaymentSnapshot;
  gap_analysis: any[];
  last_contact_at: string | null;
  last_payment_at: string | null;
  days_open?: number;
  days_since_carrier?: number | null;
}

const healthColors: Record<string, string> = {
  green: "bg-emerald-500",
  yellow: "bg-amber-400",
  red: "bg-red-500",
};

const healthLabels: Record<string, string> = {
  green: "On Track",
  yellow: "Needs Attention",
  red: "At Risk",
};

const resistanceColors: Record<string, string> = {
  low: "text-emerald-600",
  med: "text-amber-600",
  high: "text-red-600",
};

const confidenceColors: Record<string, string> = {
  high: "bg-emerald-500",
  medium: "bg-amber-400",
  low: "bg-muted-foreground/30",
};

const confidenceLabels: Record<string, string> = {
  high: "High confidence – deterministic trigger",
  medium: "Medium confidence – inferred from patterns",
  low: "Low confidence – weak signal",
};

export function DarwinCockpit({ claimId, claim, onNavigateSection }: DarwinCockpitProps) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const { data: masterState, isLoading } = useQuery({
    queryKey: ["claim-master-state", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_master_state")
        .select("state_json, updated_at")
        .eq("claim_id", claimId)
        .maybeSingle();
      if (error) throw error;
      return data?.state_json as unknown as MasterState | null;
    },
    staleTime: 10000,
  });

  useEffect(() => {
    const channel = supabase
      .channel(`master-state-${claimId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "claim_master_state", filter: `claim_id=eq.${claimId}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ["claim-master-state", claimId] });
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [claimId, queryClient]);

  useEffect(() => {
    if (!isLoading && !masterState) {
      runAutopilot();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, masterState]);

  const runAutopilot = useCallback(async () => {
    setRefreshing(true);
    try {
      const { data, error } = await supabase.functions.invoke("run-claim-autopilot", {
        body: { claimId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      queryClient.invalidateQueries({ queryKey: ["claim-master-state", claimId] });
    } catch (e: any) {
      console.error("Autopilot error:", e);
      toast.error("Failed to refresh claim state");
    } finally {
      setRefreshing(false);
    }
  }, [claimId, queryClient]);

  // Track feedback with context for contextual pattern memory
  const trackFeedback = useCallback(async (userAction: "done" | "snooze" | "override" | "dismiss") => {
    if (!na || !masterState) return;
    const ps = masterState.payment_snapshot;
    const gapPct = ps && ps.claimed > 0 ? Math.round((ps.gap / ps.claimed) * 100) : 0;
    try {
      const { error } = await supabase.from("autopilot_action_feedback").insert({
        claim_id: claimId,
        action_type: na.type,
        action_summary: na.summary,
        confidence: na.confidence || "medium",
        user_action: userAction,
        priority_score: na.priority ?? null,
      });
      if (error) console.error("Feedback insert error:", error);
    } catch (e) {
      console.error("Feedback tracking error:", e);
    }
  }, [claimId, masterState]);

  const na = masterState?.next_action;

  const handleMarkDone = useCallback(async () => {
    await trackFeedback("done");
    toast.success("Action marked done");
    await runAutopilot();
  }, [runAutopilot, trackFeedback]);

  const handleSnooze = useCallback(async () => {
    await trackFeedback("snooze");
    toast("Action snoozed – will resurface later");
  }, [trackFeedback]);

  const chips = [
    { label: "View Missing Docs", section: "document-analysis", icon: FileText },
    { label: "Open Rebuttal Draft", section: "rebuttals", icon: Shield },
    { label: "Open Package Builder", section: "package-building", icon: Sparkles },
  ];

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const state = masterState;
  const ps = state?.payment_snapshot;

  return (
    <TooltipProvider>
      <div className="space-y-4">
        {/* Quick-link Chips */}
        <div className="flex flex-wrap gap-2">
          {chips.map((chip) => (
            <Button
              key={chip.section}
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() => onNavigateSection?.(chip.section)}
            >
              <chip.icon className="h-3.5 w-3.5" />
              {chip.label}
            </Button>
          ))}
        </div>

        {/* A) Sticky Claim Control Strip */}
        <div className="sticky top-14 z-20 bg-background/95 backdrop-blur border rounded-lg px-4 py-2.5 flex flex-wrap items-center gap-3 md:gap-6 shadow-sm">
          {/* Phase (contextual label) */}
          <div className="flex items-center gap-1.5">
            <Layers className="h-3.5 w-3.5 text-muted-foreground" />
            <Badge variant="outline" className="text-xs font-semibold">
              {state?.phase_label || state?.phase || "—"}
            </Badge>
          </div>

          {/* Health */}
          <div className="flex items-center gap-1.5">
            <span className={cn("inline-block h-2.5 w-2.5 rounded-full", healthColors[state?.health || "yellow"])} />
            <span className="text-xs font-medium">{healthLabels[state?.health || "yellow"]}</span>
          </div>

          {/* Gap $ */}
          <div className="flex items-center gap-1.5">
            <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold">
              {ps ? `$${ps.gap.toLocaleString()}` : "—"}
            </span>
          </div>

          {/* Resistance */}
          <span className={cn("text-xs font-semibold uppercase", resistanceColors[state?.resistance || "low"])}>
            {state?.resistance || "—"}
          </span>

          {/* Next Action (sharper inline summary with confidence dot) */}
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            {na?.confidence && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={cn("inline-block h-2 w-2 rounded-full shrink-0", confidenceColors[na.confidence])} />
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs max-w-xs">
                  {confidenceLabels[na.confidence]}
                </TooltipContent>
              </Tooltip>
            )}
            <span className="text-xs truncate font-medium text-primary">
              {na?.summary || "No actions"}
            </span>
            {na?.due_at && (
              <Badge variant="secondary" className="text-[10px] shrink-0">
                {new Date(na.due_at).toLocaleDateString()}
              </Badge>
            )}
          </div>

          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={runAutopilot} disabled={refreshing}>
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>

          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
                <Eye className="h-3.5 w-3.5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-full sm:max-w-lg">
              <SheetHeader>
                <SheetTitle>Intelligence Drawer</SheetTitle>
              </SheetHeader>
              <IntelligenceDrawer state={state} claimId={claimId} onNavigateSection={onNavigateSection} />
            </SheetContent>
          </Sheet>
        </div>

        {/* B) Payment Progress Widget */}
        {ps && (
          <Card className="border-primary/20">
            <CardContent className="pt-4 pb-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <PaymentStat label="RCV (Claimed)" value={ps.claimed_rcv ?? ps.claimed} />
                <PaymentStat label="Paid" value={ps.paid_total ?? ps.paid} accent />
                <PaymentStat
                  label="RD Available"
                  value={ps.rd_available}
                  tooltip={ps.rd_available == null ? "Needs ACV/Dep split — review estimate or payment categories." : undefined}
                />
                <PaymentStat label="Outstanding Gap" value={ps.gap} warn={ps.gap > 0} />
              </div>
              {ps.money_confidence && ps.money_confidence !== "high" && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-2 italic">
                  ⚠ ACV/RD split incomplete — review estimate or payment categories.
                </p>
              )}
              {(ps.claimed_rcv ?? ps.claimed) > 0 && (
                <div className="mt-3">
                  <div className="flex justify-between text-xs text-muted-foreground mb-1">
                    <span>Payment Progress</span>
                    <span>{ps.pct_paid ?? ((ps.claimed_rcv ?? ps.claimed) > 0 ? Math.round(((ps.paid_total ?? ps.paid) / (ps.claimed_rcv ?? ps.claimed)) * 100) : 0)}%</span>
                  </div>
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all"
                      style={{ width: `${Math.min(100, ps.pct_paid ?? ((ps.claimed_rcv ?? ps.claimed) > 0 ? ((ps.paid_total ?? ps.paid) / (ps.claimed_rcv ?? ps.claimed)) * 100 : 0))}%` }}
                    />
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* C) Next Action Card */}
        {na && (
          <Card className="border-primary/30 bg-primary/5">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <Zap className="h-4 w-4 text-primary" />
                  Next Action
                  {/* Confidence dot */}
                  {na.confidence && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className={cn("inline-block h-2.5 w-2.5 rounded-full", confidenceColors[na.confidence])} />
                      </TooltipTrigger>
                      <TooltipContent side="right" className="text-xs max-w-xs">
                        {confidenceLabels[na.confidence]}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </CardTitle>
                {na.due_at && (
                  <Badge variant="outline" className="text-xs">
                    Due {new Date(na.due_at).toLocaleDateString()}
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm font-medium">{na.summary}</p>

              {na.bullets.length > 0 && (
                <ul className="space-y-1">
                  {na.bullets.slice(0, 4).map((b, i) => (
                    <li key={i} className="text-xs text-muted-foreground flex items-start gap-2">
                      <ArrowRight className="h-3 w-3 mt-0.5 shrink-0 text-primary" />
                      {b}
                    </li>
                  ))}
                </ul>
              )}

              <p className="text-[11px] text-muted-foreground italic">
                {na.why}
              </p>

              <div className="flex flex-wrap gap-2 pt-1">
                <Button size="sm" variant="default" className="gap-1 text-xs" onClick={handleMarkDone}>
                  <CheckCircle2 className="h-3.5 w-3.5" /> Mark Done
                </Button>
                <Button size="sm" variant="outline" className="gap-1 text-xs" onClick={handleSnooze}>
                  <Clock className="h-3.5 w-3.5" /> Snooze
                </Button>
                {(na.type.includes("follow_up") || na.type.includes("contact") || na.type.includes("deadline")) && (
                  <Button size="sm" variant="outline" className="gap-1 text-xs" onClick={() => onNavigateSection?.("rebuttals")}>
                    <FileText className="h-3.5 w-3.5" /> Review Draft
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </TooltipProvider>
  );
}

function PaymentStat({ label, value, accent, warn, tooltip }: { label: string; value: number | null | undefined; accent?: boolean; warn?: boolean; tooltip?: string }) {
  const displayValue = value != null ? `$${value.toLocaleString()}` : "—";
  const content = (
    <div className="text-center">
      <p className="text-[11px] text-muted-foreground mb-0.5">{label}</p>
      <p className={cn(
        "text-lg font-bold tabular-nums",
        accent && "text-primary",
        warn && "text-destructive",
        value == null && "text-muted-foreground italic text-sm"
      )}>
        {value == null ? "Needs Data" : displayValue}
      </p>
    </div>
  );
  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs max-w-xs">{tooltip}</TooltipContent>
      </Tooltip>
    );
  }
  return content;
}

function IntelligenceDrawer({ state, claimId, onNavigateSection }: { state: MasterState | null; claimId: string; onNavigateSection?: (s: string) => void }) {
  const { data: insights } = useQuery({
    queryKey: ["darwin-insights", claimId],
    queryFn: async () => {
      const { data } = await supabase
        .from("claim_strategic_insights")
        .select("*")
        .eq("claim_id", claimId)
        .maybeSingle();
      return data;
    },
    staleTime: 60000,
  });

  const gaps = state?.gap_analysis || [];

  return (
    <div className="mt-4 h-[calc(100vh-120px)] overflow-hidden">
      <Tabs defaultValue="gaps" className="h-full flex flex-col">
        <TabsList className="w-full">
          <TabsTrigger value="gaps" className="flex-1 text-xs">Gaps</TabsTrigger>
          <TabsTrigger value="strategy" className="flex-1 text-xs">Strategy</TabsTrigger>
          <TabsTrigger value="sources" className="flex-1 text-xs">Sources</TabsTrigger>
        </TabsList>

        <div className="flex-1 overflow-y-auto mt-3">
          <TabsContent value="gaps" className="mt-0 space-y-2">
            {gaps.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">No evidence gaps detected</p>
            )}
            {gaps.map((gap: any, i: number) => (
              <div key={i} className="p-3 bg-muted/50 rounded-lg border text-sm">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span>{gap.description || (typeof gap === "string" ? gap : JSON.stringify(gap))}</span>
                    {/* Badges for sorted gaps */}
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {gap.money_impact > 0 && (
                        <Badge variant="secondary" className="text-[10px] gap-0.5">
                          <DollarSign className="h-2.5 w-2.5" /> ${gap.money_impact?.toLocaleString?.() || gap.money_impact}
                        </Badge>
                      )}
                      {gap.evidence_completeness !== undefined && gap.evidence_completeness < 50 && (
                        <Badge variant="destructive" className="text-[10px]">Evidence Missing</Badge>
                      )}
                      {gap.legal_strength > 0 && (
                        <Badge variant="outline" className="text-[10px] gap-0.5">
                          <Shield className="h-2.5 w-2.5" /> Statutory
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </TabsContent>

          <TabsContent value="strategy" className="mt-0 space-y-3">
            {Array.isArray(insights?.warnings) && insights.warnings.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase">Warnings</h4>
                {insights.warnings.map((w: any, i: number) => (
                  <div key={i} className="p-2 bg-destructive/10 rounded border border-destructive/20 text-xs">
                    <span className="font-medium">{w.title || w.message}</span>
                    {w.suggested_action && <p className="text-muted-foreground mt-1">{w.suggested_action}</p>}
                  </div>
                ))}
              </div>
            )}
            {Array.isArray(insights?.leverage_points) && insights.leverage_points.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase">Leverage Points</h4>
                {insights.leverage_points.map((lp: any, i: number) => (
                  <div key={i} className="p-2 bg-green-500/10 rounded border border-green-500/20 text-xs">
                    {typeof lp === "string" ? lp : lp.title || lp.description}
                  </div>
                ))}
              </div>
            )}
            {Array.isArray(insights?.recommended_next_moves) && insights.recommended_next_moves.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase">Recommended Moves</h4>
                {insights.recommended_next_moves.map((m: any, i: number) => (
                  <div key={i} className="p-2 bg-primary/5 rounded border border-primary/20 text-xs flex items-start gap-2">
                    <span className="bg-primary text-primary-foreground rounded-full h-4 w-4 flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                      {i + 1}
                    </span>
                    <span>{typeof m === "string" ? m : m.action || m.title || m.description}</span>
                  </div>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="sources" className="mt-0 space-y-2">
            <p className="text-xs text-muted-foreground">
              Document extractions and evidence sources are available in the Document Analysis section.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="w-full text-xs gap-1"
              onClick={() => onNavigateSection?.("document-analysis")}
            >
              <FileText className="h-3.5 w-3.5" />
              Open Document Analysis
            </Button>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
