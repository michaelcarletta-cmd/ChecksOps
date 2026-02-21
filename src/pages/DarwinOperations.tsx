import { useState, useCallback, useRef } from "react";
import { DarwinOperationsCenter } from "@/components/dashboard/DarwinOperationsCenter";
import { Bot, Play, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

interface BatchStats {
  deadlines_created: number;
  overdue_detected: number;
  states_detected: Record<string, number>;
  skipped_no_state: number;
}

interface BackfillState {
  status: "idle" | "running" | "complete" | "error";
  processed: number;
  total: number;
  cursor: string | null;
  cumulativeStats: BatchStats;
  errorMessage?: string;
}

const INITIAL_STATS: BatchStats = {
  deadlines_created: 0,
  overdue_detected: 0,
  states_detected: {},
  skipped_no_state: 0,
};

const DarwinOperations = () => {
  const [backfill, setBackfill] = useState<BackfillState>({
    status: "idle",
    processed: 0,
    total: 0,
    cursor: null,
    cumulativeStats: { ...INITIAL_STATS },
  });
  const abortRef = useRef(false);

  const runBatch = useCallback(async (cursor: string | null, prev: BackfillState) => {
    if (abortRef.current) return;

    const { data, error } = await supabase.functions.invoke("darwin-backfill-claims", {
      body: { cursor },
    });

    if (error || !data?.success) {
      setBackfill((s) => ({
        ...s,
        status: "error",
        errorMessage: error?.message || data?.error || "Unknown error",
      }));
      return;
    }

    const batch: BatchStats = data.batch_stats || INITIAL_STATS;
    const cumulative: BatchStats = {
      deadlines_created: prev.cumulativeStats.deadlines_created + batch.deadlines_created,
      overdue_detected: prev.cumulativeStats.overdue_detected + batch.overdue_detected,
      skipped_no_state: prev.cumulativeStats.skipped_no_state + batch.skipped_no_state,
      states_detected: { ...prev.cumulativeStats.states_detected },
    };
    for (const [st, cnt] of Object.entries(batch.states_detected)) {
      cumulative.states_detected[st] = (cumulative.states_detected[st] || 0) + (cnt as number);
    }

    const newProcessed = prev.processed + (data.processed || 0);
    const total = data.total || prev.total;
    const remaining = data.remaining || 0;

    const next: BackfillState = {
      status: remaining > 0 ? "running" : "complete",
      processed: newProcessed,
      total,
      cursor: data.cursor,
      cumulativeStats: cumulative,
    };

    setBackfill(next);

    if (remaining > 0 && !abortRef.current) {
      // Small delay to let UI update
      setTimeout(() => runBatch(data.cursor, next), 200);
    } else if (remaining === 0) {
      toast({
        title: "Darwin Backfill Complete",
        description: `${newProcessed} claims processed. ${cumulative.deadlines_created} deadlines created. ${cumulative.overdue_detected} overdue.`,
      });
    }
  }, []);

  const startBackfill = () => {
    abortRef.current = false;
    const initial: BackfillState = {
      status: "running",
      processed: 0,
      total: 0,
      cursor: null,
      cumulativeStats: { ...INITIAL_STATS },
    };
    setBackfill(initial);
    runBatch(null, initial);
  };

  const pct = backfill.total > 0 ? Math.round((backfill.processed / backfill.total) * 100) : 0;
  const stats = backfill.cumulativeStats;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-3 bg-primary/10 rounded-lg">
          <Bot className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Darwin Operations Center</h1>
          <p className="text-muted-foreground">
            Monitor and control Darwin's autonomous claim management
          </p>
        </div>
      </div>

      {/* ── Backfill Card ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Darwin Catch-Up</CardTitle>
          <CardDescription>
            Backfill regulatory deadlines and state codes for all existing claims. Safe to run multiple times — skips claims that already have deadlines.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {backfill.status === "idle" && (
            <Button onClick={startBackfill} className="gap-2">
              <Play className="h-4 w-4" />
              Run Backfill
            </Button>
          )}

          {backfill.status === "running" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Processing claims… {backfill.processed} / {backfill.total || "?"}
              </div>
              <Progress value={pct} className="h-3" />
              <p className="text-xs text-muted-foreground">{pct}% complete</p>
            </div>
          )}

          {backfill.status === "complete" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                Backfill complete
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <SummaryCard label="Claims Processed" value={backfill.processed} />
                <SummaryCard label="Deadlines Created" value={stats.deadlines_created} />
                <SummaryCard label="Overdue Detected" value={stats.overdue_detected} variant="warning" />
                <SummaryCard label="No State Found" value={stats.skipped_no_state} />
              </div>
              {Object.keys(stats.states_detected).length > 0 && (
                <div className="text-xs text-muted-foreground">
                  By state:{" "}
                  {Object.entries(stats.states_detected)
                    .map(([s, c]) => `${s}: ${c}`)
                    .join(" · ")}
                </div>
              )}
              <Button variant="outline" size="sm" onClick={startBackfill}>
                Run Again
              </Button>
            </div>
          )}

          {backfill.status === "error" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" />
                {backfill.errorMessage}
              </div>
              <Button variant="outline" size="sm" onClick={startBackfill}>
                Retry
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <DarwinOperationsCenter />
    </div>
  );
};

function SummaryCard({ label, value, variant }: { label: string; value: number; variant?: "warning" }) {
  return (
    <div className="rounded-md border p-3 text-center">
      <p className={`text-2xl font-bold ${variant === "warning" ? "text-destructive" : ""}`}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

export default DarwinOperations;
