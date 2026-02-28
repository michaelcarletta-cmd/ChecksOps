import { useState, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
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
  Target,
  TrendingUp,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface DarwinCockpitProps {
  claimId: string;
  claim: any;
  onNavigateSection?: (section: string) => void;
}

interface MasterState {
  phase: string;
  health: "green" | "yellow" | "red";
  resistance: "low" | "med" | "high";
  next_action: {
    type: string;
    summary: string;
    due_at: string | null;
    draft_id: string | null;
    why: string;
    priority: number;
    bullets: string[];
  };
  payment_snapshot: {
    claimed: number;
    paid: number;
    rd_available: number;
    gap: number;
  };
  gap_analysis: any[];
  last_contact_at: string | null;
  last_payment_at: string | null;
}

const healthColors: Record<string, string> = {
  green: "bg-green-500",
  yellow: "bg-yellow-500",
  red: "bg-red-500",
};

const healthLabels: Record<string, string> = {
  green: "Healthy",
  yellow: "Attention",
  red: "Critical",
};

const resistanceColors: Record<string, string> = {
  low: "text-green-600",
  med: "text-yellow-600",
  high: "text-red-600",
};

export function DarwinCockpit({ claimId, claim, onNavigateSection }: DarwinCockpitProps) {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Fetch master state
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

  // Realtime subscription for instant updates
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

  // Auto-trigger autopilot on mount if no state exists
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

  // Quick-link chips
  const chips = [
    { label: "View Missing Docs", section: "document-analysis", icon: FileText },
    { label: "Open Rebuttal Draft", section: "rebuttals", icon: Shield },
    { label: "View Timeline", section: "timeline-history", icon: Clock },
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
        {/* Phase */}
        <div className="flex items-center gap-1.5">
          <Layers className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Phase</span>
          <Badge variant="outline" className="text-xs font-semibold">{state?.phase || "—"}</Badge>
        </div>

        {/* Health */}
        <div className="flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Health</span>
          <span className={cn("inline-block h-2.5 w-2.5 rounded-full", healthColors[state?.health || "yellow"])} />
          <span className="text-xs font-medium">{healthLabels[state?.health || "yellow"]}</span>
        </div>

        {/* Gap $ */}
        <div className="flex items-center gap-1.5">
          <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Gap</span>
          <span className="text-xs font-semibold">
            {ps ? `$${ps.gap.toLocaleString()}` : "—"}
          </span>
        </div>

        {/* Resistance */}
        <div className="flex items-center gap-1.5">
          <Shield className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Resistance</span>
          <span className={cn("text-xs font-semibold uppercase", resistanceColors[state?.resistance || "low"])}>
            {state?.resistance || "—"}
          </span>
        </div>

        {/* Next Action (inline summary) */}
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <Zap className="h-3.5 w-3.5 text-primary shrink-0" />
          <span className="text-xs truncate font-medium text-primary">
            {state?.next_action?.summary || "No actions"}
          </span>
          {state?.next_action?.due_at && (
            <Badge variant="secondary" className="text-[10px] shrink-0">
              {new Date(state.next_action.due_at).toLocaleDateString()}
            </Badge>
          )}
        </div>

        {/* Refresh */}
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={runAutopilot} disabled={refreshing}>
          {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>

        {/* Drawer trigger */}
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
            <IntelligenceDrawer state={state} claimId={claimId} />
          </SheetContent>
        </Sheet>
      </div>

      {/* B) Payment Progress Widget */}
      {ps && (
        <Card className="border-primary/20">
          <CardContent className="pt-4 pb-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <PaymentStat label="Claimed (RCV)" value={ps.claimed} />
              <PaymentStat label="Paid" value={ps.paid} accent />
              <PaymentStat label="RD Available" value={ps.rd_available} />
              <PaymentStat label="Outstanding Gap" value={ps.gap} warn={ps.gap > 0} />
            </div>
            {ps.claimed > 0 && (
              <div className="mt-3">
                <div className="flex justify-between text-xs text-muted-foreground mb-1">
                  <span>Payment Progress</span>
                  <span>{ps.claimed > 0 ? Math.round((ps.paid / ps.claimed) * 100) : 0}%</span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all"
                    style={{ width: `${Math.min(100, ps.claimed > 0 ? (ps.paid / ps.claimed) * 100 : 0)}%` }}
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* C) Next Action Card */}
      {state?.next_action && (
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Zap className="h-4 w-4 text-primary" />
                Next Action
              </CardTitle>
              {state.next_action.due_at && (
                <Badge variant="outline" className="text-xs">
                  Due {new Date(state.next_action.due_at).toLocaleDateString()}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm font-medium">{state.next_action.summary}</p>
            
            {state.next_action.bullets.length > 0 && (
              <ul className="space-y-1">
                {state.next_action.bullets.slice(0, 4).map((b, i) => (
                  <li key={i} className="text-xs text-muted-foreground flex items-start gap-2">
                    <ArrowRight className="h-3 w-3 mt-0.5 shrink-0 text-primary" />
                    {b}
                  </li>
                ))}
              </ul>
            )}

            {/* Why this action */}
            <p className="text-[11px] text-muted-foreground italic">
              {state.next_action.why}
            </p>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" variant="default" className="gap-1 text-xs">
                <CheckCircle2 className="h-3.5 w-3.5" /> Mark Done
              </Button>
              <Button size="sm" variant="outline" className="gap-1 text-xs">
                <Clock className="h-3.5 w-3.5" /> Snooze
              </Button>
              {state.next_action.type.includes("follow_up") || state.next_action.type.includes("contact") ? (
                <Button size="sm" variant="outline" className="gap-1 text-xs" onClick={() => onNavigateSection?.("rebuttals")}>
                  <FileText className="h-3.5 w-3.5" /> Review Draft
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function PaymentStat({ label, value, accent, warn }: { label: string; value: number; accent?: boolean; warn?: boolean }) {
  return (
    <div className="text-center">
      <p className="text-[11px] text-muted-foreground mb-0.5">{label}</p>
      <p className={cn(
        "text-lg font-bold tabular-nums",
        accent && "text-primary",
        warn && "text-destructive"
      )}>
        ${value.toLocaleString()}
      </p>
    </div>
  );
}

function IntelligenceDrawer({ state, claimId }: { state: MasterState | null; claimId: string }) {
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
            {(state?.gap_analysis || []).length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">No evidence gaps detected</p>
            )}
            {(state?.gap_analysis || []).map((gap: any, i: number) => (
              <div key={i} className="p-3 bg-muted/50 rounded-lg border text-sm">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
                  <span>{typeof gap === "string" ? gap : gap.description || gap.item || JSON.stringify(gap)}</span>
                </div>
              </div>
            ))}
          </TabsContent>

          <TabsContent value="strategy" className="mt-0 space-y-3">
            {/* Warnings */}
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
            {/* Leverage */}
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
            {/* Next Moves */}
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
              onClick={() => {/* navigate handled by parent */}}
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
