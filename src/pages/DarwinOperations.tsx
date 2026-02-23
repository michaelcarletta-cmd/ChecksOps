import { useState, useCallback, useRef, useEffect } from "react";
import { DarwinOperationsCenter } from "@/components/dashboard/DarwinOperationsCenter";
import { Bot, Play, CheckCircle2, AlertTriangle, Loader2, FileText, RefreshCw, XCircle, ChevronDown, ChevronUp, Brain, Zap } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

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

interface FailedFileEntry {
  file_id: string;
  file_name: string;
  file_type: string;
  reason: string;
}

interface TextBackfillState {
  status: "idle" | "running" | "complete" | "error";
  processed: number;
  extracted: number;
  failed: number;
  remaining: number;
  cursor: string | null;
  errorMessage?: string;
  earlyExits: number;
  lastElapsedMs: number | null;
  failedFiles: FailedFileEntry[];
}

interface RebuildEventsState {
  status: "idle" | "running" | "complete" | "error";
  processed: number;
  remaining: number;
  cursor: string | null;
  errorMessage?: string;
}

interface BulkIntelState {
  status: "idle" | "running" | "complete" | "error";
  processed: number;
  classified: number;
  failed: number;
  remaining: number;
  cursor: string | null;
  totalChunks: number;
  totalEvents: number;
  deepAnalysisTriggered: number;
  classificationBreakdown: Record<string, number>;
  earlyExits: number;
  lastElapsedMs: number | null;
  errorMessage?: string;
}

const INITIAL_STATS: BatchStats = {
  deadlines_created: 0,
  overdue_detected: 0,
  states_detected: {},
  skipped_no_state: 0,
};

const BATCH_SIZE_LABEL = 5;

const DarwinOperations = () => {
  const [backfill, setBackfill] = useState<BackfillState>({
    status: "idle",
    processed: 0,
    total: 0,
    cursor: null,
    cumulativeStats: { ...INITIAL_STATS },
  });
  const abortRef = useRef(false);

  // Text extraction backfill state
  const [textBackfill, setTextBackfill] = useState<TextBackfillState>({
    status: "idle",
    processed: 0,
    extracted: 0,
    failed: 0,
    remaining: 0,
    cursor: null,
    earlyExits: 0,
    lastElapsedMs: null,
    failedFiles: [],
  });
  const textAbortRef = useRef(false);
  const textInFlightRef = useRef(false);

  // Rebuild events state
  const [rebuildEvents, setRebuildEvents] = useState<RebuildEventsState>({
    status: "idle",
    processed: 0,
    remaining: 0,
    cursor: null,
  });
  const rebuildAbortRef = useRef(false);

  // Bulk document intelligence state (Step 4)
  const [bulkIntel, setBulkIntel] = useState<BulkIntelState>({
    status: "idle",
    processed: 0,
    classified: 0,
    failed: 0,
    remaining: 0,
    cursor: null,
    totalChunks: 0,
    totalEvents: 0,
    deepAnalysisTriggered: 0,
    classificationBreakdown: {},
    earlyExits: 0,
    lastElapsedMs: null,
  });
  const bulkIntelAbortRef = useRef(false);
  const bulkIntelInFlightRef = useRef(false);

  // Darwin processing coverage for gating Step 4
  const [darwinCoverage, setDarwinCoverage] = useState<{ processed: number; total: number; pct: number } | null>(null);

  // Text coverage percentage for gating Step 2
  const [showFailedFiles, setShowFailedFiles] = useState(false);
  const [textCoverage, setTextCoverage] = useState<number | null>(null);

  const fetchTextCoverage = useCallback(async () => {
    const { count: total } = await supabase
      .from("claim_files")
      .select("id", { count: "exact", head: true });
    const { count: withText } = await supabase
      .from("claim_files")
      .select("id", { count: "exact", head: true })
      .not("extracted_text", "is", null)
      .neq("extracted_text", "");
    if (total && total > 0) {
      setTextCoverage(Math.round(((withText || 0) / total) * 100));
    } else {
      setTextCoverage(100);
    }
  }, []);

  const fetchDarwinCoverage = useCallback(async () => {
    const { count: total } = await supabase
      .from("claim_files")
      .select("id", { count: "exact", head: true })
      .not("extracted_text", "is", null);
    const { count: processed } = await supabase
      .from("claim_files")
      .select("id", { count: "exact", head: true })
      .eq("processed_by_darwin", true);
    const t = total || 0;
    const p = processed || 0;
    setDarwinCoverage({ processed: p, total: t, pct: t > 0 ? Math.round((p / t) * 100) : 100 });
  }, []);

  useEffect(() => {
    fetchTextCoverage();
    fetchDarwinCoverage();
  }, [fetchTextCoverage, fetchDarwinCoverage]);

  useEffect(() => {
    if (textBackfill.status === "complete" || textBackfill.status === "running") {
      fetchTextCoverage();
    }
  }, [textBackfill.status, textBackfill.processed, fetchTextCoverage]);

  useEffect(() => {
    if (bulkIntel.status === "complete" || bulkIntel.status === "running") {
      fetchDarwinCoverage();
    }
  }, [bulkIntel.status, bulkIntel.processed, fetchDarwinCoverage]);

  const step2Disabled = (textCoverage !== null && textCoverage < 30) || textBackfill.status === "running";
  const step4Disabled = (textCoverage !== null && textCoverage < 30) || textBackfill.status === "running" || rebuildEvents.status === "running";

  // Fetch server-side job locks on mount (heartbeat-aware)
  const [serverJobs, setServerJobs] = useState<Record<string, string>>({});
  const fetchServerJobs = useCallback(async () => {
    const { data } = await supabase
      .from("darwin_jobs")
      .select("job_type, status, heartbeat_at, ttl_seconds");
    if (data) {
      const map: Record<string, string> = {};
      data.forEach((j: any) => {
        // Treat as idle if heartbeat expired
        if (j.status === "running" && j.heartbeat_at) {
          const age = (Date.now() - new Date(j.heartbeat_at).getTime()) / 1000;
          if (age > (j.ttl_seconds || 120)) {
            map[j.job_type] = "idle"; // stale lock
            return;
          }
        }
        map[j.job_type] = j.status;
      });
      setServerJobs(map);
    }
  }, []);

  useEffect(() => {
    fetchServerJobs();
    const interval = setInterval(fetchServerJobs, 5000);
    return () => clearInterval(interval);
  }, [fetchServerJobs]);

  // === DEADLINE BACKFILL ===
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

  // === TEXT EXTRACTION BACKFILL ===
  const runTextBatch = useCallback(async (cursor: string | null, prev: TextBackfillState) => {
    if (textAbortRef.current) return;

    const { data, error } = await supabase.functions.invoke("backfill-extracted-text", {
      body: { cursor },
    });

    if (error || !data?.success) {
      setTextBackfill((s) => ({
        ...s,
        status: "error",
        errorMessage: error?.message || data?.error || "Unknown error",
      }));
      return;
    }

    const isEarlyExit = !!data.early_exit;
    const newCursor = data.cursor;
    // If remaining > 0 but cursor didn't advance, force it forward to avoid infinite loop
    const cursorAdvanced = newCursor && newCursor !== prev.cursor;
    const effectiveCursor = (data.remaining || 0) > 0 && !cursorAdvanced
      ? (newCursor || prev.cursor || "0")
      : newCursor;

    // Collect failed files from this batch's log
    const batchFailedFiles: FailedFileEntry[] = (data.log || [])
      .filter((entry: any) => !entry.success && entry.file_name)
      .map((entry: any) => ({
        file_id: entry.file_id,
        file_name: entry.file_name,
        file_type: entry.file_type || "unknown",
        reason: entry.reason || "unknown",
      }));

    const next: TextBackfillState = {
      status: (data.remaining || 0) > 0 ? "running" : "complete",
      processed: prev.processed + (data.processed || 0),
      extracted: prev.extracted + (data.extracted || 0),
      failed: prev.failed + (data.failed || 0),
      remaining: data.remaining || 0,
      cursor: effectiveCursor,
      earlyExits: prev.earlyExits + (isEarlyExit ? 1 : 0),
      lastElapsedMs: data.elapsed_ms || null,
      failedFiles: [...prev.failedFiles, ...batchFailedFiles],
    };

    setTextBackfill(next);

    if ((data.remaining || 0) === 0) {
      toast({
        title: "Text Extraction Complete",
        description: `${next.processed} files processed. ${next.extracted} texts extracted. ${next.failed} failed.`,
      });
    }
  }, []);

  // useEffect-driven loop with inFlight guard
  useEffect(() => {
    if (textBackfill.status !== "running") return;
    if ((textBackfill.remaining ?? 0) <= 0) return;
    if (textInFlightRef.current) return;

    textInFlightRef.current = true;
    (async () => {
      try {
        await runTextBatch(textBackfill.cursor, textBackfill);
      } finally {
        textInFlightRef.current = false;
      }
    })();
  }, [textBackfill.status, textBackfill.remaining, textBackfill.cursor, runTextBatch]);

  const startTextBackfill = () => {
    textAbortRef.current = false;
    const initial: TextBackfillState = {
      status: "running",
      processed: 0,
      extracted: 0,
      failed: 0,
      remaining: 1,
      cursor: null,
      earlyExits: 0,
      lastElapsedMs: null,
      failedFiles: [],
    };
    setTextBackfill(initial);
  };

  // === REBUILD EVENTS ===
  const runRebuildBatch = useCallback(async (cursor: string | null, prev: RebuildEventsState) => {
    if (rebuildAbortRef.current) return;

    const { data, error } = await supabase.functions.invoke("backfill-rebuild-events", {
      body: { cursor },
    });

    if (error || !data?.success) {
      setRebuildEvents((s) => ({
        ...s,
        status: "error",
        errorMessage: error?.message || data?.error || "Unknown error",
      }));
      return;
    }

    const next: RebuildEventsState = {
      status: (data.remaining || 0) > 0 ? "running" : "complete",
      processed: prev.processed + (data.processed || 0),
      remaining: data.remaining || 0,
      cursor: data.cursor,
    };

    setRebuildEvents(next);

    if ((data.remaining || 0) > 0 && !rebuildAbortRef.current) {
      setTimeout(() => runRebuildBatch(data.cursor, next), 500);
    } else if ((data.remaining || 0) === 0) {
      toast({
        title: "Event Rebuild Complete",
        description: `${next.processed} claims reprocessed. Timeline events regenerated.`,
      });
    }
  }, []);

  const startRebuildEvents = () => {
    rebuildAbortRef.current = false;
    const initial: RebuildEventsState = {
      status: "running",
      processed: 0,
      remaining: 0,
      cursor: null,
    };
    setRebuildEvents(initial);
    runRebuildBatch(null, initial);
  };

  // === BULK DOCUMENT INTELLIGENCE (Step 4) ===
  const runBulkIntelBatch = useCallback(async (cursor: string | null, prev: BulkIntelState) => {
    if (bulkIntelAbortRef.current) return;

    const { data, error } = await supabase.functions.invoke("bulk-document-intelligence", {
      body: { cursor },
    });

    if (error || !data?.success) {
      setBulkIntel((s) => ({
        ...s,
        status: "error",
        errorMessage: error?.message || data?.error || "Unknown error",
      }));
      return;
    }

    const isEarlyExit = !!data.early_exit;
    const newCursor = data.cursor;
    const cursorAdvanced = newCursor && newCursor !== prev.cursor;
    const effectiveCursor = (data.remaining || 0) > 0 && !cursorAdvanced
      ? (newCursor || prev.cursor || "0")
      : newCursor;

    const mergedBreakdown: Record<string, number> = { ...prev.classificationBreakdown };
    if (data.classification_breakdown) {
      for (const [cls, cnt] of Object.entries(data.classification_breakdown)) {
        mergedBreakdown[cls] = (mergedBreakdown[cls] || 0) + (cnt as number);
      }
    }

    const next: BulkIntelState = {
      status: (data.remaining || 0) > 0 ? "running" : "complete",
      processed: prev.processed + (data.processed || 0),
      classified: prev.classified + (data.classified || 0),
      failed: prev.failed + (data.failed || 0),
      remaining: data.remaining || 0,
      cursor: effectiveCursor,
      totalChunks: prev.totalChunks + (data.total_chunks_created || 0),
      totalEvents: prev.totalEvents + (data.total_events_created || 0),
      deepAnalysisTriggered: prev.deepAnalysisTriggered + (data.deep_analysis_triggered || 0),
      classificationBreakdown: mergedBreakdown,
      earlyExits: prev.earlyExits + (isEarlyExit ? 1 : 0),
      lastElapsedMs: data.elapsed_ms || null,
    };

    setBulkIntel(next);

    if ((data.remaining || 0) === 0) {
      toast({
        title: "Bulk Document Intelligence Complete",
        description: `${next.processed} files processed. ${next.totalChunks} chunks created. ${next.deepAnalysisTriggered} deep analyses triggered.`,
      });
    }
  }, []);

  useEffect(() => {
    if (bulkIntel.status !== "running") return;
    if ((bulkIntel.remaining ?? 0) <= 0) return;
    if (bulkIntelInFlightRef.current) return;

    bulkIntelInFlightRef.current = true;
    (async () => {
      try {
        await runBulkIntelBatch(bulkIntel.cursor, bulkIntel);
      } finally {
        bulkIntelInFlightRef.current = false;
      }
    })();
  }, [bulkIntel.status, bulkIntel.remaining, bulkIntel.cursor, runBulkIntelBatch]);

  const startBulkIntel = () => {
    bulkIntelAbortRef.current = false;
    const initial: BulkIntelState = {
      status: "running",
      processed: 0,
      classified: 0,
      failed: 0,
      remaining: 1,
      cursor: null,
      totalChunks: 0,
      totalEvents: 0,
      deepAnalysisTriggered: 0,
      classificationBreakdown: {},
      earlyExits: 0,
      lastElapsedMs: null,
    };
    setBulkIntel(initial);
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

      {/* ── Step 1: Text Extraction Backfill ─────────────────────────── */}
      <Card className="border-2 border-primary/30">
        <CardHeader>
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">Step 1: Backfill Extracted Text</CardTitle>
          </div>
          <CardDescription>
            Downloads every claim file from storage and extracts text (PDF parsing → OCR fallback). 
            This is required before timeline or analysis features can work. Processes 20 files per batch.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {textBackfill.status === "idle" && serverJobs.backfill_extracted_text === "running" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Text extraction is running in the background… (started from a previous session)
              </div>
              {textCoverage !== null && (
                <Progress value={textCoverage} className="h-3" />
              )}
              <p className="text-xs text-muted-foreground">
                Coverage: {textCoverage?.toFixed(1)}% — this page polls every 5s. The job will finish on its own.
              </p>
            </div>
          )}
          {textBackfill.status === "idle" && serverJobs.backfill_extracted_text !== "running" && (
            <Button 
              onClick={startTextBackfill} 
              className="gap-2"
              disabled={rebuildEvents.status === "running"}
            >
              <Play className="h-4 w-4" />
              Run Text Extraction
            </Button>
          )}
          {textBackfill.status === "running" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Extracting text… {textBackfill.processed} files processed ({textBackfill.remaining} remaining){textBackfill.earlyExits > 0 && ` · ${textBackfill.earlyExits} batch chains`}{textBackfill.lastElapsedMs != null && ` · last batch ${(textBackfill.lastElapsedMs / 1000).toFixed(1)}s`}
              </div>
              <Progress 
                value={textBackfill.remaining > 0 
                  ? (textBackfill.processed / (textBackfill.processed + textBackfill.remaining)) * 100 
                  : 100
                } 
                className="h-3" 
              />
              <div className="grid grid-cols-3 gap-3">
                <SummaryCard label="Extracted" value={textBackfill.extracted} />
                <SummaryCard label="Failed" value={textBackfill.failed} variant={textBackfill.failed > 0 ? "warning" : undefined} />
                <SummaryCard label="Remaining" value={textBackfill.remaining} />
              </div>
            </div>
          )}
          {textBackfill.status === "complete" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                Text extraction complete
              </div>
              <div className="grid grid-cols-3 gap-3">
                <SummaryCard label="Files Processed" value={textBackfill.processed} />
                <SummaryCard label="Text Extracted" value={textBackfill.extracted} />
               <SummaryCard label="Failed" value={textBackfill.failed} variant={textBackfill.failed > 0 ? "warning" : undefined} />
              </div>
              {textBackfill.failedFiles.length > 0 && (
                <div className="space-y-2">
                  <button
                    type="button"
                    className="flex items-center gap-1.5 text-sm font-medium text-destructive hover:underline"
                    onClick={() => setShowFailedFiles(!showFailedFiles)}
                  >
                    <XCircle className="h-4 w-4" />
                    {textBackfill.failedFiles.length} file{textBackfill.failedFiles.length !== 1 ? "s" : ""} failed
                    {showFailedFiles ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  </button>
                  {showFailedFiles && (
                    <div className="max-h-64 overflow-y-auto rounded-md border bg-muted/30">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-muted">
                          <tr>
                            <th className="px-3 py-1.5 text-left font-medium">File Name</th>
                            <th className="px-3 py-1.5 text-left font-medium">Type</th>
                            <th className="px-3 py-1.5 text-left font-medium">Reason</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {textBackfill.failedFiles.map((f, i) => (
                            <tr key={`${f.file_id}-${i}`}>
                              <td className="px-3 py-1.5 max-w-[200px] truncate" title={f.file_name}>{f.file_name}</td>
                              <td className="px-3 py-1.5 text-muted-foreground">{f.file_type}</td>
                              <td className="px-3 py-1.5 text-muted-foreground max-w-[250px] truncate" title={f.reason}>{f.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
              <Button variant="outline" size="sm" onClick={startTextBackfill}>
                Run Again
              </Button>
            </div>
          )}
          {textBackfill.status === "error" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" />
                {textBackfill.errorMessage}
              </div>
              <Button variant="outline" size="sm" onClick={startTextBackfill}>
                Retry
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Step 2: Rebuild Events ────────────────────────────────────── */}
      <Card className="border-2 border-primary/30">
        <CardHeader>
          <div className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">Step 2: Rebuild Timeline Events</CardTitle>
          </div>
          <CardDescription>
            Deletes derived claim_events and re-runs document processing to regenerate the timeline 
            from extracted text. Run this after text extraction is complete.
            {textCoverage !== null && (
              <span className="ml-1 font-medium">
                (Current text coverage: {textCoverage}%)
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {rebuildEvents.status === "idle" && (
            <div className="space-y-3">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-block">
                      <Button
                        onClick={startRebuildEvents}
                        className="gap-2"
                        variant="secondary"
                        disabled={step2Disabled}
                      >
                        <Play className="h-4 w-4" />
                        Rebuild All Events
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {step2Disabled && (
                    <TooltipContent>
                      <p>Run Step 1 first — not enough documents have extracted text.</p>
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
              {step2Disabled ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                  <span>
                    Text coverage is {textCoverage}% (need ≥30%).{" "}
                    <button
                      type="button"
                      className="underline font-medium text-primary hover:text-primary/80"
                      onClick={startTextBackfill}
                    >
                      Run Step 1 now
                    </button>
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  Text coverage is sufficient — you can rebuild events now.
                </div>
              )}
            </div>
          )}
          {rebuildEvents.status === "running" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Rebuilding events… {rebuildEvents.processed} claims processed ({rebuildEvents.remaining} remaining)
              </div>
              <Progress 
                value={rebuildEvents.remaining > 0 
                  ? (rebuildEvents.processed / (rebuildEvents.processed + rebuildEvents.remaining)) * 100 
                  : 100
                } 
                className="h-3" 
              />
            </div>
          )}
          {rebuildEvents.status === "complete" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                Event rebuild complete — {rebuildEvents.processed} claims reprocessed
              </div>
              <Button variant="outline" size="sm" onClick={startRebuildEvents}>
                Run Again
              </Button>
            </div>
          )}
          {rebuildEvents.status === "error" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" />
                {rebuildEvents.errorMessage}
              </div>
              <Button variant="outline" size="sm" onClick={startRebuildEvents}>
                Retry
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Deadline Backfill Card ────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Step 3: Darwin Catch-Up (Deadlines)</CardTitle>
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

      {/* ── Step 4: Bulk Document Intelligence ────────────────────────── */}
      <Card className="border-2 border-primary/30">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Brain className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">Step 4: Bulk Document Intelligence</CardTitle>
            {darwinCoverage && (
              <Badge variant={darwinCoverage.pct >= 90 ? "default" : darwinCoverage.pct >= 50 ? "secondary" : "destructive"} className="ml-auto text-xs">
                {darwinCoverage.processed} / {darwinCoverage.total} files processed ({darwinCoverage.pct}%)
              </Badge>
            )}
          </div>
          <CardDescription>
            Runs <code className="text-xs bg-muted px-1 rounded">darwin-process-document</code> logic across all unprocessed files:
            classifies documents (denial, estimate, engineering report, etc.), chunks text and generates embeddings
            for cross-claim semantic search, extracts dates to the timeline, and triggers deep AI analysis
            (denial rebuttals, estimate gap analysis) for key document types. Processes {BATCH_SIZE_LABEL} files per batch.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {bulkIntel.status === "idle" && serverJobs.bulk_document_intelligence === "running" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Bulk intelligence is running in the background (started from a previous session)
              </div>
              {darwinCoverage && (
                <Progress value={darwinCoverage.pct} className="h-3" />
              )}
            </div>
          )}
          {bulkIntel.status === "idle" && serverJobs.bulk_document_intelligence !== "running" && (
            <div className="space-y-3">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-block">
                      <Button
                        onClick={startBulkIntel}
                        className="gap-2"
                        disabled={step4Disabled}
                      >
                        <Zap className="h-4 w-4" />
                        Run Document Intelligence
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {step4Disabled && (
                    <TooltipContent>
                      <p>Complete Steps 1-2 first — text extraction or event rebuild is still in progress.</p>
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
              {darwinCoverage && darwinCoverage.pct < 100 && darwinCoverage.total > 0 && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                  <span>
                    {darwinCoverage.total - darwinCoverage.processed} files with text have not been classified, chunked, or analyzed yet.
                  </span>
                </div>
              )}
              {darwinCoverage && darwinCoverage.pct >= 100 && (
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  All files with extracted text have been processed by Darwin.
                </div>
              )}
            </div>
          )}
          {bulkIntel.status === "running" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Processing documents… {bulkIntel.processed} files classified ({bulkIntel.remaining} remaining)
                {bulkIntel.earlyExits > 0 && ` · ${bulkIntel.earlyExits} batch chains`}
                {bulkIntel.lastElapsedMs != null && ` · last batch ${(bulkIntel.lastElapsedMs / 1000).toFixed(1)}s`}
              </div>
              <Progress
                value={bulkIntel.remaining > 0
                  ? (bulkIntel.processed / (bulkIntel.processed + bulkIntel.remaining)) * 100
                  : 100
                }
                className="h-3"
              />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <SummaryCard label="Classified" value={bulkIntel.classified} />
                <SummaryCard label="Chunks Created" value={bulkIntel.totalChunks} />
                <SummaryCard label="Timeline Events" value={bulkIntel.totalEvents} />
                <SummaryCard label="Deep Analyses" value={bulkIntel.deepAnalysisTriggered} />
              </div>
              {Object.keys(bulkIntel.classificationBreakdown).length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(bulkIntel.classificationBreakdown)
                    .sort(([, a], [, b]) => b - a)
                    .map(([cls, count]) => (
                      <Badge key={cls} variant="outline" className="text-xs capitalize">
                        {cls.replace(/_/g, " ")}: {count}
                      </Badge>
                    ))}
                </div>
              )}
            </div>
          )}
          {bulkIntel.status === "complete" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                Document intelligence complete
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <SummaryCard label="Files Processed" value={bulkIntel.processed} />
                <SummaryCard label="Classified" value={bulkIntel.classified} />
                <SummaryCard label="Chunks Created" value={bulkIntel.totalChunks} />
                <SummaryCard label="Timeline Events" value={bulkIntel.totalEvents} />
                <SummaryCard label="Deep Analyses" value={bulkIntel.deepAnalysisTriggered} />
              </div>
              {bulkIntel.failed > 0 && (
                <SummaryCard label="Failed" value={bulkIntel.failed} variant="warning" />
              )}
              {Object.keys(bulkIntel.classificationBreakdown).length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">Classification Breakdown</p>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(bulkIntel.classificationBreakdown)
                      .sort(([, a], [, b]) => b - a)
                      .map(([cls, count]) => (
                        <Badge key={cls} variant="outline" className="text-xs capitalize">
                          {cls.replace(/_/g, " ")}: {count}
                        </Badge>
                      ))}
                  </div>
                </div>
              )}
              <Button variant="outline" size="sm" onClick={startBulkIntel}>
                Run Again
              </Button>
            </div>
          )}
          {bulkIntel.status === "error" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" />
                {bulkIntel.errorMessage}
              </div>
              <Button variant="outline" size="sm" onClick={startBulkIntel}>
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
