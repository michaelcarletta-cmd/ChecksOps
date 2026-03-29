import { useState, useCallback, useRef, useEffect } from "react";
import { DarwinOperationsCenter } from "@/components/dashboard/DarwinOperationsCenter";

import { Bot, Play, CheckCircle2, AlertTriangle, Loader2, FileText, RefreshCw, XCircle, ChevronDown, ChevronUp, Brain, Database } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
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

interface BulkDarwinState {
  status: "idle" | "running" | "complete" | "error";
  processed: number;
  succeeded: number;
  failed: number;
  remaining: number;
  cursor: string | null;
  errorMessage?: string;
  failedFiles: BulkDarwinFailureEntry[];
}

interface BulkDarwinLiveStats {
  withText: number;
  processedByDarwin: number;
  remaining: number;
}

interface BulkDarwinFailureEntry {
  file_id: string;
  file_name: string;
  reason: string;
}

interface DarwinJobInfo {
  status: string;
  heartbeat_at: string | null;
  ttl_seconds: number;
  claimed_by: string | null;
  started_at: string | null;
  error_message: string | null;
}

interface BulkDarwinDiagnostics {
  phase: "idle" | "invoking" | "waiting_lock" | "processing" | "error";
  lastAttemptAt: number | null;
  lastResponseAt: number | null;
  lastBatchElapsedMs: number | null;
  lastMessage: string | null;
}

interface BulkDarwinCandidate {
  id: string;
  claim_id: string;
  file_name: string;
}

interface IntelBackfillState {
  status: "idle" | "running" | "complete" | "error";
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  remaining: number;
  cursor: string | null;
  errorMessage?: string;
}

interface IntelCoverage {
  totalSupported: number;
  withIntelligence: number;
  withoutIntelligence: number;
  readyForAnalysis: number;
  blocked: number;
  needsReprocessing: number;
  coveragePct: number;
}

interface IntelCoverageByType {
  type: string;
  total: number;
  withIntel: number;
  missing: number;
  coveragePct: number;
}

const INITIAL_STATS: BatchStats = {
  deadlines_created: 0,
  overdue_detected: 0,
  states_detected: {},
  skipped_no_state: 0,
};

const BULK_DARWIN_FALLBACK_BATCH_SIZE = 5;

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

  // Step 4: Bulk Darwin Document Intelligence
  const [bulkDarwin, setBulkDarwin] = useState<BulkDarwinState>({
    status: "idle",
    processed: 0,
    succeeded: 0,
    failed: 0,
    remaining: 0,
    cursor: null,
    failedFiles: [],
  });
  const bulkDarwinAbortRef = useRef(false);
  const [bulkDarwinLiveStats, setBulkDarwinLiveStats] = useState<BulkDarwinLiveStats | null>(null);
  const [bulkDarwinWaitingForLock, setBulkDarwinWaitingForLock] = useState(false);
  const [bulkDarwinLockHint, setBulkDarwinLockHint] = useState<DarwinJobInfo | null>(null);
  const [unlockingStep4, setUnlockingStep4] = useState(false);
  const [bulkDarwinDiagnostics, setBulkDarwinDiagnostics] = useState<BulkDarwinDiagnostics>({
    phase: "idle",
    lastAttemptAt: null,
    lastResponseAt: null,
    lastBatchElapsedMs: null,
    lastMessage: null,
  });

  // Text coverage percentage for gating Step 2
  const [showFailedFiles, setShowFailedFiles] = useState(false);
  const [showBulkDarwinFailedFiles, setShowBulkDarwinFailedFiles] = useState(false);
  const [textCoverage, setTextCoverage] = useState<number | null>(null);

  // Step 5: Document Intelligence Backfill
  const [intelBackfill, setIntelBackfill] = useState<IntelBackfillState>({
    status: "idle",
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    remaining: 0,
    cursor: null,
  });
  const intelBackfillAbortRef = useRef(false);
  const [intelCoverage, setIntelCoverage] = useState<IntelCoverage | null>(null);
  const [intelCoverageByType, setIntelCoverageByType] = useState<IntelCoverageByType[]>([]);

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

  useEffect(() => {
    fetchTextCoverage();
  }, [fetchTextCoverage]);

  useEffect(() => {
    if (textBackfill.status === "complete" || textBackfill.status === "running") {
      fetchTextCoverage();
    }
  }, [textBackfill.status, textBackfill.processed, fetchTextCoverage]);

  const step2Disabled = (textCoverage !== null && textCoverage < 30) || textBackfill.status === "running";

  // === STEP 5: INTELLIGENCE COVERAGE ===
  const INTEL_DOC_TYPES = [
    "engineering_report", "carrier_denial", "denial_letter", "denial",
    "coverage_letter", "approval", "carrier_correspondence", "correspondence",
    "carrier_email", "rfi", "estimate", "carrier_estimate",
    "policy_document", "policy", "expert_report", "inspection_report",
  ];

  const fetchIntelCoverage = useCallback(async () => {
    try {
      const [{ count: totalSupported }, { count: withIntel }, { count: readyCount }, { count: blockedCount }, { count: reprocessCount }] = await Promise.all([
        supabase.from("claim_files").select("id", { count: "exact", head: true })
          .or(INTEL_DOC_TYPES.map((t) => `document_classification.eq.${t}`).join(",") + "," + INTEL_DOC_TYPES.map((t) => `document_type.eq.${t}`).join(",")),
        supabase.from("claim_document_intelligence").select("id", { count: "exact", head: true }),
        supabase.from("claim_files").select("id", { count: "exact", head: true }).eq("ready_for_analysis", true)
          .or(INTEL_DOC_TYPES.map((t) => `document_classification.eq.${t}`).join(",") + "," + INTEL_DOC_TYPES.map((t) => `document_type.eq.${t}`).join(",")),
        supabase.from("claim_files").select("id", { count: "exact", head: true }).eq("ready_for_analysis", false)
          .or(INTEL_DOC_TYPES.map((t) => `document_classification.eq.${t}`).join(",") + "," + INTEL_DOC_TYPES.map((t) => `document_type.eq.${t}`).join(",")),
        supabase.from("claim_files").select("id", { count: "exact", head: true }).eq("needs_reprocessing", true),
      ]);

      const total = totalSupported ?? 0;
      const intel = withIntel ?? 0;
      setIntelCoverage({
        totalSupported: total,
        withIntelligence: intel,
        withoutIntelligence: Math.max(total - intel, 0),
        readyForAnalysis: readyCount ?? 0,
        blocked: blockedCount ?? 0,
        needsReprocessing: reprocessCount ?? 0,
        coveragePct: total > 0 ? Math.round((intel / total) * 100) : 0,
      });

      // Per-type coverage for key types
      const keyTypes = [
        { label: "Engineering Report", types: ["engineering_report", "expert_report", "inspection_report"] },
        { label: "Denial / Coverage Letter", types: ["denial", "denial_letter", "carrier_denial", "coverage_letter", "approval"] },
        { label: "Carrier Email / Correspondence", types: ["carrier_email", "correspondence", "carrier_correspondence", "rfi"] },
        { label: "Estimate", types: ["estimate", "carrier_estimate"] },
        { label: "Policy Document", types: ["policy", "policy_document"] },
      ];

      const byTypeResults: IntelCoverageByType[] = [];
      for (const kt of keyTypes) {
        const orFilter = kt.types.map((t) => `document_classification.eq.${t}`).join(",") + "," + kt.types.map((t) => `document_type.eq.${t}`).join(",");
        const { count: typeTotal } = await supabase.from("claim_files").select("id", { count: "exact", head: true }).or(orFilter);
        // For per-type intel, we need to match document_type in claim_document_intelligence
        const { count: typeIntel } = await supabase.from("claim_document_intelligence").select("id", { count: "exact", head: true })
          .or(kt.types.map((t) => `document_type.eq.${t}`).join(","));
        const tt = typeTotal ?? 0;
        const ti = typeIntel ?? 0;
        byTypeResults.push({
          type: kt.label,
          total: tt,
          withIntel: ti,
          missing: Math.max(tt - ti, 0),
          coveragePct: tt > 0 ? Math.round((ti / tt) * 100) : 0,
        });
      }
      setIntelCoverageByType(byTypeResults);
    } catch (err) {
      console.error("[IntelCoverage] fetch error:", err);
    }
  }, []);

  useEffect(() => {
    fetchIntelCoverage();
  }, [fetchIntelCoverage]);

  useEffect(() => {
    if (intelBackfill.status === "complete" || intelBackfill.status === "running") {
      fetchIntelCoverage();
    }
  }, [intelBackfill.status, intelBackfill.processed, fetchIntelCoverage]);

  const runIntelBackfillBatch = useCallback(async (cursor: string | null, prev: IntelBackfillState) => {
    if (intelBackfillAbortRef.current) return;

    const { data, error } = await supabase.functions.invoke("backfill-document-intelligence", {
      body: { cursor },
    });

    if (error || !data?.success) {
      setIntelBackfill((s) => ({
        ...s,
        status: "error",
        errorMessage: error?.message || data?.error || "Unknown error",
      }));
      return;
    }

    const next: IntelBackfillState = {
      status: (data.remaining || 0) > 0 ? "running" : "complete",
      processed: prev.processed + (data.processed || 0),
      succeeded: prev.succeeded + (data.succeeded || 0),
      failed: prev.failed + (data.failed || 0),
      skipped: prev.skipped + (data.skipped || 0),
      remaining: data.remaining || 0,
      cursor: data.cursor,
    };

    if (data.coverage) {
      setIntelCoverage(data.coverage);
    }

    setIntelBackfill(next);

    if ((data.remaining || 0) > 0 && !intelBackfillAbortRef.current) {
      setTimeout(() => runIntelBackfillBatch(data.cursor, next), 500);
    } else if ((data.remaining || 0) === 0) {
      toast({
        title: "Intelligence Backfill Complete",
        description: `${next.succeeded} files now have document intelligence. ${next.failed} failed. ${next.skipped} skipped.`,
      });
      fetchIntelCoverage();
    }
  }, [fetchIntelCoverage]);

  const startIntelBackfill = () => {
    intelBackfillAbortRef.current = false;
    const initial: IntelBackfillState = {
      status: "running",
      processed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      remaining: 1,
      cursor: null,
    };
    setIntelBackfill(initial);
    runIntelBackfillBatch(null, initial);
  };

  // Fetch server-side job locks on mount (heartbeat-aware)
  const [serverJobs, setServerJobs] = useState<Record<string, string>>({});
  const [serverJobDetails, setServerJobDetails] = useState<Record<string, DarwinJobInfo>>({});
  const fetchServerJobs = useCallback(async () => {
    const { data } = await supabase
      .from("darwin_jobs")
      .select("job_type, status, heartbeat_at, ttl_seconds, claimed_by, started_at, error_message");
    if (data) {
      const map: Record<string, string> = {};
      const details: Record<string, DarwinJobInfo> = {};
      data.forEach((j: any) => {
        const ttlSeconds = j.ttl_seconds || 120;
        let status = j.status;
        // Treat as idle if heartbeat expired
        if (j.status === "running" && j.heartbeat_at) {
          const age = (Date.now() - new Date(j.heartbeat_at).getTime()) / 1000;
          if (age > ttlSeconds) {
            status = "idle"; // stale lock
          }
        }
        map[j.job_type] = status;
        details[j.job_type] = {
          status,
          heartbeat_at: j.heartbeat_at ?? null,
          ttl_seconds: ttlSeconds,
          claimed_by: j.claimed_by ?? null,
          started_at: j.started_at ?? null,
          error_message: j.error_message ?? null,
        };
      });
      setServerJobs(map);
      setServerJobDetails(details);
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

  // === STEP 4: BULK DARWIN DOCUMENT INTELLIGENCE ===
  const step4Disabled = (textCoverage !== null && textCoverage < 30) || textBackfill.status === "running";

  // === STEP 4: BULK DOCUMENT INTELLIGENCE ===
  const fetchBulkDarwinLiveStats = useCallback(async (): Promise<BulkDarwinLiveStats | null> => {
    const [{ count: withText }, { count: processedByDarwin }] = await Promise.all([
      supabase
        .from("claim_files")
        .select("id", { count: "exact", head: true })
        .not("extracted_text", "is", null)
        .neq("extracted_text", ""),
      supabase
        .from("claim_files")
        .select("id", { count: "exact", head: true })
        .not("extracted_text", "is", null)
        .neq("extracted_text", "")
        .eq("processed_by_darwin", true),
    ]);

    const stats: BulkDarwinLiveStats = {
      withText: withText || 0,
      processedByDarwin: processedByDarwin || 0,
      remaining: Math.max((withText || 0) - (processedByDarwin || 0), 0),
    };
    setBulkDarwinLiveStats(stats);
    return stats;
  }, []);

  const mergeBulkDarwinFailures = useCallback(
    (existing: BulkDarwinFailureEntry[], incoming: BulkDarwinFailureEntry[]) => {
      if (incoming.length === 0) return existing;
      const merged = [...existing, ...incoming];
      // Keep recent diagnostics and avoid unbounded UI growth.
      return merged.slice(-100);
    },
    []
  );

  const parseDarwinJobInfo = useCallback((raw: unknown): DarwinJobInfo | null => {
    if (!raw || typeof raw !== "object") return null;
    const job = raw as Record<string, unknown>;
    const statusRaw = typeof job.status === "string" ? job.status : null;
    const heartbeat_at = typeof job.heartbeat_at === "string" ? job.heartbeat_at : null;
    const claimed_by = typeof job.claimed_by === "string" ? job.claimed_by : null;
    const started_at = typeof job.started_at === "string" ? job.started_at : null;
    const ttl_seconds = typeof job.ttl_seconds === "number" && Number.isFinite(job.ttl_seconds) ? job.ttl_seconds : 120;
    const error_message = typeof job.error_message === "string" ? job.error_message : null;

    // If nothing is populated, treat as missing lock metadata.
    if (!heartbeat_at && !claimed_by && !started_at && !statusRaw) return null;

    return {
      status: statusRaw || "running",
      heartbeat_at,
      ttl_seconds,
      claimed_by,
      started_at,
      error_message,
    };
  }, []);

  const invokeFunctionWithTimeout = useCallback(
    async (fnName: string, body: Record<string, unknown>, timeoutMs = 65000) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<{ data: any; error: { message: string } }>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            data: {
              success: false,
              error: `Timed out after ${Math.round(timeoutMs / 1000)}s calling ${fnName}`,
            },
            error: { message: `Timed out after ${Math.round(timeoutMs / 1000)}s calling ${fnName}` },
          });
        }, timeoutMs);
      });

      try {
        const result = await Promise.race([
          supabase.functions.invoke(fnName, { body }),
          timeoutPromise,
        ]);
        return result as { data: any; error: any };
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    },
    []
  );

  const runBulkDarwinClientFallback = useCallback(async (cursor: string | null) => {
    let query = supabase
      .from("claim_files")
      .select("id, claim_id, file_name")
      .not("extracted_text", "is", null)
      .neq("extracted_text", "")
      .or("processed_by_darwin.is.null,processed_by_darwin.eq.false")
      .order("id", { ascending: true })
      .limit(BULK_DARWIN_FALLBACK_BATCH_SIZE);

    if (cursor) {
      query = query.gt("id", cursor);
    }

    const { data: candidates, error: queryError } = await query;
    if (queryError) {
      return { success: false, error: queryError.message };
    }

    const files = (candidates || []) as BulkDarwinCandidate[];
    if (files.length === 0) {
      return {
        success: true,
        processed: 0,
        succeeded: 0,
        failed: 0,
        remaining: 0,
        cursor: null,
        log: [],
      };
    }

    let succeeded = 0;
    let failed = 0;
    const log: Array<{ file_id: string; file_name: string; success: boolean; error?: string }> = [];
    for (const file of files) {
      const { data, error } = await supabase.functions.invoke("darwin-process-document", {
        body: {
          fileId: file.id,
          claimId: file.claim_id,
          fileName: file.file_name,
        },
      });
      if (error || data?.success === false) {
        failed++;
        log.push({
          file_id: file.id,
          file_name: file.file_name,
          success: false,
          error: data?.error || error?.message || "Unknown processing error",
        });
      } else {
        succeeded++;
        log.push({
          file_id: file.id,
          file_name: file.file_name,
          success: true,
        });
      }
    }

    const lastId = files[files.length - 1]?.id || cursor;
    let remainingQuery = supabase
      .from("claim_files")
      .select("id", { count: "exact", head: true })
      .not("extracted_text", "is", null)
      .neq("extracted_text", "")
      .or("processed_by_darwin.is.null,processed_by_darwin.eq.false");
    if (lastId) {
      remainingQuery = remainingQuery.gt("id", lastId);
    }
    const { count: remainingCount } = await remainingQuery;

    return {
      success: true,
      processed: files.length,
      succeeded,
      failed,
      remaining: Math.max(0, remainingCount || 0),
      cursor: lastId,
      log,
    };
  }, []);

  const runBulkDarwinBatch = useCallback(async (cursor: string | null, prev: BulkDarwinState) => {
    if (bulkDarwinAbortRef.current) return;
    setBulkDarwinDiagnostics((d) => ({
      ...d,
      phase: "invoking",
      lastAttemptAt: Date.now(),
      lastMessage: "Contacting Step 4 edge function...",
    }));

    let data: any = null;
    let error: any = null;
    const candidateFunctions = ["bulk-darwin-process-document", "backfill-document-intelligence"];

    for (const fnName of candidateFunctions) {
      setBulkDarwinDiagnostics((d) => ({
        ...d,
        phase: "invoking",
        lastMessage: `Trying ${fnName}...`,
      }));
      const result = await invokeFunctionWithTimeout(fnName, { cursor }, 70000);
      data = result.data;
      error = result.error;
      if (!error) break;
    }

    if (error) {
      setBulkDarwinDiagnostics((d) => ({
        ...d,
        phase: "processing",
        lastMessage: "Edge function unavailable, using client fallback...",
      }));
      const fallbackResult = await runBulkDarwinClientFallback(cursor);
      if (fallbackResult.success) {
        data = fallbackResult;
        error = null;
      }
    }

    const lockBusyReason = String(data?.error || error?.message || "").toLowerCase();
    const lockErrorCode = String(data?.error_code || "").toUpperCase();
    const isJobAlreadyRunning =
      lockBusyReason.includes("job already running") || lockErrorCode === "JOB_ALREADY_RUNNING";
    const isLockMetadataMissing =
      lockBusyReason.includes("lock metadata missing") || lockErrorCode === "JOB_LOCK_METADATA_MISSING";
    const lockReportedBusy = isJobAlreadyRunning || isLockMetadataMissing;
    const lockInfoFromResponse = parseDarwinJobInfo(data?.job);
    if (lockInfoFromResponse) {
      setBulkDarwinLockHint(lockInfoFromResponse);
    }

    if (lockReportedBusy) {
      const appearsRunningOnServer =
        serverJobs.bulk_darwin_process_document === "running" ||
        serverJobs.backfill_document_intelligence === "running";
      const lockMetadataMissing = isLockMetadataMissing || !lockInfoFromResponse;

      // If lock is reported but no metadata is available anywhere, keep progress moving via client fallback.
      if (lockMetadataMissing && !appearsRunningOnServer) {
        setBulkDarwinWaitingForLock(false);
        setBulkDarwinDiagnostics((d) => ({
          ...d,
          phase: "processing",
          lastResponseAt: Date.now(),
          lastMessage: "Lock reported without metadata; running client fallback batch to continue processing.",
        }));
        const fallbackResult = await runBulkDarwinClientFallback(cursor);
        if (fallbackResult.success) {
          data = fallbackResult;
          error = null;
          setBulkDarwinLockHint(null);
        } else {
          setBulkDarwinDiagnostics((d) => ({
            ...d,
            phase: "error",
            lastResponseAt: Date.now(),
            lastMessage: fallbackResult.error || "Fallback batch failed after lock metadata was missing.",
          }));
          setBulkDarwin((s) => ({
            ...s,
            status: "error",
            errorMessage: fallbackResult.error || "Step 4 lock reported without metadata, and fallback batch failed.",
          }));
          return;
        }
      } else {
        const liveStats = await fetchBulkDarwinLiveStats();
        setBulkDarwinWaitingForLock(true);
        setBulkDarwinDiagnostics((d) => ({
          ...d,
          phase: "waiting_lock",
          lastResponseAt: Date.now(),
          lastMessage: lockInfoFromResponse?.claimed_by
            ? `Another Step 4 worker currently holds the lock (${lockInfoFromResponse.claimed_by}).`
            : "Another Step 4 worker currently holds the lock.",
        }));
        // Another session holds the lock. Keep a running state and poll until available.
        const waitingState: BulkDarwinState = {
          status: "running",
          processed: liveStats?.processedByDarwin ?? prev.processed,
          succeeded: liveStats?.processedByDarwin ?? prev.succeeded,
          failed: prev.failed,
          remaining: liveStats ? liveStats.remaining : prev.remaining > 0 ? prev.remaining : 1,
          cursor: prev.cursor ?? cursor,
          failedFiles: prev.failedFiles,
        };
        setBulkDarwin(waitingState);
        if (!bulkDarwinAbortRef.current) {
          setTimeout(() => runBulkDarwinBatch(cursor, waitingState), 2000);
        }
        return;
      }
    }
    if (error || !data?.success) {
      setBulkDarwinWaitingForLock(false);
      setBulkDarwinDiagnostics((d) => ({
        ...d,
        phase: "error",
        lastResponseAt: Date.now(),
        lastMessage: data?.error || error?.message || "Step 4 request failed.",
      }));
      setBulkDarwin((s) => ({
        ...s,
        status: "error",
        errorMessage:
          data?.error ||
          error?.message ||
          "Failed to reach Step 4 edge function. Deploy bulk-darwin-process-document (or backfill-document-intelligence), then retry.",
      }));
      return;
    }

    const batchFailedFiles: BulkDarwinFailureEntry[] = Array.isArray(data?.log)
      ? (data.log as Array<{ file_id?: string; file_name?: string; success?: boolean; error?: string }>)
          .filter((entry) => entry?.success === false)
          .map((entry) => ({
            file_id: entry.file_id || "unknown",
            file_name: entry.file_name || "Unknown file",
            reason: entry.error || "Unknown processing error",
          }))
      : [];

    const next: BulkDarwinState = {
      status: (data.remaining || 0) > 0 ? "running" : "complete",
      processed: prev.processed + (data.processed || 0),
      succeeded: prev.succeeded + (data.succeeded || 0),
      failed: prev.failed + (data.failed || 0),
      remaining: data.remaining || 0,
      cursor: data.cursor,
      failedFiles: mergeBulkDarwinFailures(prev.failedFiles, batchFailedFiles),
    };

    setBulkDarwinWaitingForLock(false);
    setBulkDarwinLockHint(null);
    setBulkDarwinDiagnostics((d) => ({
      ...d,
      phase: (data.remaining || 0) > 0 ? "processing" : "idle",
      lastResponseAt: Date.now(),
      lastBatchElapsedMs: typeof data?.elapsed_ms === "number" ? data.elapsed_ms : d.lastBatchElapsedMs,
      lastMessage: `Batch result: ${data.processed || 0} attempted, ${data.succeeded || 0} succeeded, ${data.failed || 0} failed.`,
    }));
    await fetchBulkDarwinLiveStats();
    setBulkDarwin(next);

    if ((data.remaining || 0) > 0 && !bulkDarwinAbortRef.current) {
      setTimeout(() => runBulkDarwinBatch(data.cursor, next), 500);
    } else if ((data.remaining || 0) === 0) {
      toast({
        title: "Bulk Document Intelligence Complete",
        description: `${next.processed} files processed. ${next.succeeded} classified/chunked/embedded. ${next.failed} failed.`,
      });
    }
  }, [fetchBulkDarwinLiveStats, invokeFunctionWithTimeout, mergeBulkDarwinFailures, parseDarwinJobInfo, runBulkDarwinClientFallback, serverJobs]);

  const startBulkDarwin = () => {
    bulkDarwinAbortRef.current = false;
    const initial: BulkDarwinState = {
      status: "running",
      processed: 0,
      succeeded: 0,
      failed: 0,
      remaining: 1,
      cursor: null,
      failedFiles: [],
    };
    setShowBulkDarwinFailedFiles(false);
    setBulkDarwinWaitingForLock(false);
    setBulkDarwinLockHint(null);
    setBulkDarwinLiveStats(null);
    setBulkDarwinDiagnostics({
      phase: "invoking",
      lastAttemptAt: Date.now(),
      lastResponseAt: null,
      lastBatchElapsedMs: null,
      lastMessage: "Starting Step 4 run...",
    });
    setBulkDarwin(initial);
    runBulkDarwinBatch(null, initial);
  };

  const forceUnlockStep4 = useCallback(async () => {
    if (unlockingStep4) return;

    setUnlockingStep4(true);
    // Stop local polling loops while unlocking.
    bulkDarwinAbortRef.current = true;

    const candidateFunctions = ["bulk-darwin-process-document", "backfill-document-intelligence"];
    let released = false;
    let lastError: string | undefined;

    for (const fnName of candidateFunctions) {
      const { data, error } = await supabase.functions.invoke(fnName, { body: { release: true } });
      if (!error && data?.success !== false) {
        released = true;
      } else {
        lastError = data?.error || error?.message || lastError;
      }
    }

    // Final fallback: release directly via RPC in case function endpoints are unavailable.
    if (!released) {
      const [{ error: primaryReleaseError }, { error: legacyReleaseError }] = await Promise.all([
        supabase.rpc("release_darwin_job", {
          p_job_type: "bulk_darwin_process_document",
          p_error_message: "Manual unlock from Darwin Operations UI",
        }),
        supabase.rpc("release_darwin_job", {
          p_job_type: "backfill_document_intelligence",
          p_error_message: "Manual unlock from Darwin Operations UI",
        }),
      ]);

      if (!primaryReleaseError || !legacyReleaseError) {
        released = true;
      } else {
        lastError = primaryReleaseError.message || legacyReleaseError.message || lastError;
      }
    }

    await fetchServerJobs();
    const liveStats = await fetchBulkDarwinLiveStats();

    if (released) {
      setBulkDarwinWaitingForLock(false);
      setBulkDarwinLockHint(null);
      setBulkDarwin((prev) => ({
        ...prev,
        status: "idle",
        processed: liveStats?.processedByDarwin ?? prev.processed,
        succeeded: liveStats?.processedByDarwin ?? prev.succeeded,
        remaining: liveStats?.remaining ?? prev.remaining,
        cursor: null,
        errorMessage: undefined,
      }));
      toast({
        title: "Step 4 lock released",
        description: "You can run Bulk Document Intelligence again now.",
      });
      setBulkDarwinDiagnostics((d) => ({
        ...d,
        phase: "idle",
        lastResponseAt: Date.now(),
        lastMessage: "Lock released from UI.",
      }));
    } else {
      setBulkDarwin((prev) => ({
        ...prev,
        status: "error",
        errorMessage: lastError || "Failed to force unlock Step 4 lock.",
      }));
      toast({
        title: "Unable to release Step 4 lock",
        description: lastError || "Try releasing the lock from SQL editor and retry.",
      });
      setBulkDarwinDiagnostics((d) => ({
        ...d,
        phase: "error",
        lastResponseAt: Date.now(),
        lastMessage: lastError || "Failed to release Step 4 lock.",
      }));
    }

    bulkDarwinAbortRef.current = false;
    setUnlockingStep4(false);
  }, [fetchBulkDarwinLiveStats, fetchServerJobs, unlockingStep4]);

  const pct = backfill.total > 0 ? Math.round((backfill.processed / backfill.total) * 100) : 0;
  const stats = backfill.cumulativeStats;
  const step4ServerRunning =
    serverJobs.bulk_darwin_process_document === "running" ||
    serverJobs.backfill_document_intelligence === "running" ||
    (bulkDarwinWaitingForLock && bulkDarwinLockHint?.status === "running");
  const step4PrimaryJob = serverJobDetails.bulk_darwin_process_document;
  const step4LegacyJob = serverJobDetails.backfill_document_intelligence;
  const step4JobDetail =
    (step4PrimaryJob?.status === "running" ? step4PrimaryJob : null) ||
    (step4LegacyJob?.status === "running" ? step4LegacyJob : null) ||
    step4PrimaryJob ||
    step4LegacyJob ||
    bulkDarwinLockHint ||
    null;
  const displayBulkProcessed = bulkDarwinLiveStats?.processedByDarwin ?? bulkDarwin.processed;
  const displayBulkRemaining = bulkDarwinLiveStats?.remaining ?? bulkDarwin.remaining;
  const displayBulkProgressPct =
    displayBulkRemaining > 0
      ? (displayBulkProcessed / (displayBulkProcessed + displayBulkRemaining)) * 100
      : 100;
  const sessionBulkProgressPct =
    bulkDarwin.remaining > 0
      ? (bulkDarwin.processed / (bulkDarwin.processed + bulkDarwin.remaining)) * 100
      : 100;
  const formatAgeFromIso = (iso: string | null) => {
    if (!iso) return "n/a";
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s ago`;
  };
  const formatAgeFromMs = (ms: number | null) => {
    if (!ms) return "n/a";
    const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s ago`;
  };
  const step4HeartbeatAgeSeconds = step4JobDetail?.heartbeat_at
    ? Math.max(0, Math.floor((Date.now() - new Date(step4JobDetail.heartbeat_at).getTime()) / 1000))
    : null;
  const step4HeartbeatStale =
    step4HeartbeatAgeSeconds !== null && step4HeartbeatAgeSeconds > (step4JobDetail?.ttl_seconds || 120);
  const secondsSinceLastStep4Attempt = bulkDarwinDiagnostics.lastAttemptAt
    ? Math.max(0, Math.floor((Date.now() - bulkDarwinDiagnostics.lastAttemptAt) / 1000))
    : null;
  const secondsSinceLastStep4Response = bulkDarwinDiagnostics.lastResponseAt
    ? Math.max(0, Math.floor((Date.now() - bulkDarwinDiagnostics.lastResponseAt) / 1000))
    : null;
  const step4LikelyStalled =
    bulkDarwin.status === "running" &&
    !bulkDarwinWaitingForLock &&
    secondsSinceLastStep4Response !== null &&
    secondsSinceLastStep4Response > 90;
  const step4HoldUpReason = (() => {
    if (bulkDarwinWaitingForLock) {
      if (!step4JobDetail?.claimed_by && !step4JobDetail?.heartbeat_at && !step4JobDetail?.started_at) {
        return "Hold-up: lock reported without metadata; UI is attempting fallback batches.";
      }
      if (step4HeartbeatStale) {
        return "Hold-up: lock heartbeat is stale; worker may be orphaned.";
      }
      return `Hold-up: another worker holds the lock${step4JobDetail?.claimed_by ? ` (${step4JobDetail.claimed_by})` : ""}.`;
    }
    if (step4LikelyStalled) {
      if (step4ServerRunning && !step4HeartbeatStale) {
        return "Hold-up: worker heartbeat is alive, but no batch response yet (likely a long/hung file).";
      }
      return "Hold-up: no active worker heartbeat; this run may be orphaned.";
    }
    if (bulkDarwin.status === "running" && secondsSinceLastStep4Attempt !== null && secondsSinceLastStep4Attempt > 30) {
      return "Hold-up: waiting on Step 4 edge function response.";
    }
    if (step4ServerRunning) {
      return "Hold-up visibility: worker heartbeat is active.";
    }
    return "Hold-up visibility: awaiting next batch update.";
  })();

  useEffect(() => {
    if (bulkDarwin.status !== "running" && !step4ServerRunning) return;

    fetchBulkDarwinLiveStats();
    const interval = setInterval(fetchBulkDarwinLiveStats, 5000);
    return () => clearInterval(interval);
  }, [bulkDarwin.status, fetchBulkDarwinLiveStats, step4ServerRunning]);

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

      {/* ── Step 3: Darwin Catch-Up (Deadlines) ───────────────────────── */}
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
          </div>
          <CardDescription>
            Runs darwin-process-document on all files that have extracted text but haven&apos;t been fully processed.
            This classifies documents, chunks text, generates embeddings for cross-claim semantic search,
            extracts dates to timeline events, and triggers deep analysis (denial rebuttals, estimate gaps, etc.).
            Required for Denial Analyzer, Dismantler, and Rebuttal Drafter to have rich context.
            Processes 5 files per batch (AI-heavy).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {bulkDarwin.status === "idle" && step4ServerRunning && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Bulk document intelligence is running in the background…
              </div>
              <p className="text-xs font-medium text-amber-700">{step4HoldUpReason}</p>
              <Progress value={displayBulkProgressPct} className="h-3" />
              <p className="text-xs text-muted-foreground">
                Live progress: {displayBulkProcessed} processed ({displayBulkRemaining} remaining). Updates every 5s.
              </p>
              <p className="text-xs text-muted-foreground">
                Last request: {formatAgeFromMs(bulkDarwinDiagnostics.lastAttemptAt)} · Last response: {formatAgeFromMs(bulkDarwinDiagnostics.lastResponseAt)}
              </p>
              <p className="text-xs text-muted-foreground">
                Lock holder: {step4JobDetail?.claimed_by || "unknown"} · last heartbeat {formatAgeFromIso(step4JobDetail?.heartbeat_at || null)}
                {step4JobDetail?.ttl_seconds ? ` (TTL ${step4JobDetail.ttl_seconds}s)` : ""}
              </p>
              {step4HeartbeatStale && (
                <p className="text-xs text-amber-600">
                  Heartbeat appears stale. Use Force Unlock if this does not recover.
                </p>
              )}
            </div>
          )}
          {bulkDarwin.status === "idle" && !step4ServerRunning && (
            <div className="space-y-3">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-block">
                      <Button
                        onClick={startBulkDarwin}
                        className="gap-2"
                        variant="secondary"
                        disabled={step4Disabled}
                      >
                        <Play className="h-4 w-4" />
                        Run Bulk Document Intelligence
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {step4Disabled && (
                    <TooltipContent>
                      <p>Run Step 1 first — not enough documents have extracted text.</p>
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
              {step4Disabled ? (
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
                  Ready — run to process unprocessed files with extracted text.
                </div>
              )}
            </div>
          )}
          {bulkDarwin.status === "running" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {bulkDarwinWaitingForLock
                  ? "Step 4 is already running in another session… waiting for lock."
                  : `Processing… ${bulkDarwin.processed} files attempted this run (${bulkDarwin.remaining} remaining in this pass)`}
              </div>
              <p className="text-xs font-medium text-amber-700">{step4HoldUpReason}</p>
              <Progress
                value={bulkDarwinWaitingForLock ? displayBulkProgressPct : sessionBulkProgressPct}
                className="h-3"
              />
              <div className="grid grid-cols-3 gap-3">
                <SummaryCard
                  label={bulkDarwinWaitingForLock ? "Processed (live)" : "Attempted (this run)"}
                  value={bulkDarwinWaitingForLock ? displayBulkProcessed : bulkDarwin.processed}
                />
                <SummaryCard label="Failed" value={bulkDarwin.failed} variant={bulkDarwin.failed > 0 ? "warning" : undefined} />
                <SummaryCard
                  label={bulkDarwinWaitingForLock ? "Remaining (live)" : "Remaining (this pass)"}
                  value={bulkDarwinWaitingForLock ? displayBulkRemaining : bulkDarwin.remaining}
                />
              </div>
              {!bulkDarwinWaitingForLock && (
                <p className="text-xs text-muted-foreground">
                  Live total fully processed by Darwin: {displayBulkProcessed} ({displayBulkRemaining} still unprocessed overall).
                </p>
              )}
              <div className="rounded-md border bg-muted/20 p-2 text-xs text-muted-foreground space-y-1">
                <p>
                  Phase: {bulkDarwinDiagnostics.phase}
                  {step4LikelyStalled ? " · possible stall detected" : ""}
                </p>
                <p>
                  Last request: {formatAgeFromMs(bulkDarwinDiagnostics.lastAttemptAt)} · Last response: {formatAgeFromMs(bulkDarwinDiagnostics.lastResponseAt)}
                </p>
                <p>
                  Last batch runtime: {bulkDarwinDiagnostics.lastBatchElapsedMs != null
                    ? `${(bulkDarwinDiagnostics.lastBatchElapsedMs / 1000).toFixed(1)}s`
                    : "n/a"}
                </p>
                <p>
                  Lock holder: {step4JobDetail?.claimed_by || "unknown"} · heartbeat {formatAgeFromIso(step4JobDetail?.heartbeat_at || null)}
                </p>
                {bulkDarwinDiagnostics.lastMessage && <p>Last note: {bulkDarwinDiagnostics.lastMessage}</p>}
              </div>
              {step4LikelyStalled && (
                <p className="text-xs text-amber-600">
                  No response for {secondsSinceLastStep4Response}s. If this persists, use Force Unlock and retry.
                </p>
              )}
            </div>
          )}
          {bulkDarwin.status === "complete" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                Bulk document intelligence complete
              </div>
              <div className="grid grid-cols-3 gap-3">
                <SummaryCard label="Files Processed" value={bulkDarwin.processed} />
                <SummaryCard label="Succeeded" value={bulkDarwin.succeeded} />
                <SummaryCard label="Failed" value={bulkDarwin.failed} variant={bulkDarwin.failed > 0 ? "warning" : undefined} />
              </div>
              <Button variant="outline" size="sm" onClick={startBulkDarwin}>
                Run Again
              </Button>
            </div>
          )}
          {bulkDarwin.status === "error" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" />
                {bulkDarwin.errorMessage}
              </div>
              <Button variant="outline" size="sm" onClick={startBulkDarwin}>
                Retry
              </Button>
            </div>
          )}
          {bulkDarwin.failedFiles.length > 0 && (
            <div className="space-y-2 rounded-md border bg-muted/20 p-3">
              <button
                type="button"
                className="flex items-center gap-1.5 text-sm font-medium text-destructive hover:underline"
                onClick={() => setShowBulkDarwinFailedFiles(!showBulkDarwinFailedFiles)}
              >
                <XCircle className="h-4 w-4" />
                {bulkDarwin.failedFiles.length} failed file diagnostic{bulkDarwin.failedFiles.length !== 1 ? "s" : ""}
                {showBulkDarwinFailedFiles ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </button>
              {showBulkDarwinFailedFiles && (
                <div className="max-h-64 overflow-y-auto rounded-md border bg-background">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted">
                      <tr>
                        <th className="px-3 py-1.5 text-left font-medium">File Name</th>
                        <th className="px-3 py-1.5 text-left font-medium">Reason</th>
                        <th className="px-3 py-1.5 text-left font-medium">File ID</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {bulkDarwin.failedFiles.map((f, i) => (
                        <tr key={`${f.file_id}-${i}`}>
                          <td className="px-3 py-1.5 max-w-[220px] truncate" title={f.file_name}>
                            {f.file_name}
                          </td>
                          <td className="px-3 py-1.5 max-w-[360px] truncate text-muted-foreground" title={f.reason}>
                            {f.reason}
                          </td>
                          <td className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground max-w-[220px] truncate" title={f.file_id}>
                            {f.file_id}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          {(step4ServerRunning || bulkDarwin.status === "running") && (
            <div className="space-y-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                className="gap-2 border-destructive/40 text-destructive hover:bg-destructive/10"
                onClick={forceUnlockStep4}
                disabled={unlockingStep4}
              >
                {unlockingStep4 ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <AlertTriangle className="h-4 w-4" />
                )}
                {unlockingStep4 ? "Unlocking Step 4…" : "Force Unlock Step 4"}
              </Button>
              <p className="text-xs text-muted-foreground">
                Use only if Step 4 appears stuck with no progress for several minutes.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Step 5: Document Intelligence Coverage & Backfill ────────── */}
      <Card className="border-2 border-primary/30">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">Step 5: Document Intelligence Backfill</CardTitle>
          </div>
          <CardDescription>
            Backfills structured document intelligence for supported file types (engineering reports,
            denials, estimates, correspondence, policies). This enables intelligence-first analysis
            in Darwin rebuttals, gap analysis, and email drafting.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Coverage Metrics */}
          {intelCoverage && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Intelligence Coverage</p>
                <span className={`text-sm font-bold ${intelCoverage.coveragePct >= 50 ? "text-green-600" : intelCoverage.coveragePct >= 20 ? "text-amber-600" : "text-destructive"}`}>
                  {intelCoverage.coveragePct}%
                </span>
              </div>
              <Progress value={intelCoverage.coveragePct} className="h-3" />
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                <SummaryCard label="Supported Files" value={intelCoverage.totalSupported} />
                <SummaryCard label="With Intel" value={intelCoverage.withIntelligence} />
                <SummaryCard label="Missing Intel" value={intelCoverage.withoutIntelligence} variant={intelCoverage.withoutIntelligence > 0 ? "warning" : undefined} />
                <SummaryCard label="Ready" value={intelCoverage.readyForAnalysis} />
                <SummaryCard label="Blocked" value={intelCoverage.blocked} variant={intelCoverage.blocked > 0 ? "warning" : undefined} />
                <SummaryCard label="Needs Reprocess" value={intelCoverage.needsReprocessing} variant={intelCoverage.needsReprocessing > 0 ? "warning" : undefined} />
              </div>
            </div>
          )}

          {/* Per-type breakdown */}
          {intelCoverageByType.length > 0 && (
            <div className="rounded-md border bg-muted/20">
              <table className="w-full text-xs">
                <thead className="bg-muted">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Document Type</th>
                    <th className="px-3 py-1.5 text-right font-medium">Total</th>
                    <th className="px-3 py-1.5 text-right font-medium">With Intel</th>
                    <th className="px-3 py-1.5 text-right font-medium">Missing</th>
                    <th className="px-3 py-1.5 text-right font-medium">Coverage</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {intelCoverageByType.map((row) => (
                    <tr key={row.type}>
                      <td className="px-3 py-1.5">{row.type}</td>
                      <td className="px-3 py-1.5 text-right">{row.total}</td>
                      <td className="px-3 py-1.5 text-right">{row.withIntel}</td>
                      <td className={`px-3 py-1.5 text-right ${row.missing > 0 ? "text-destructive font-medium" : ""}`}>
                        {row.missing}
                      </td>
                      <td className={`px-3 py-1.5 text-right font-medium ${row.coveragePct >= 50 ? "text-green-600" : row.coveragePct >= 20 ? "text-amber-600" : "text-destructive"}`}>
                        {row.coveragePct}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Backfill controls */}
          {intelBackfill.status === "idle" && (
            <div className="flex gap-2">
              <Button onClick={startIntelBackfill} className="gap-2" variant="secondary">
                <Play className="h-4 w-4" />
                Run Intelligence Backfill
              </Button>
              <Button onClick={fetchIntelCoverage} variant="outline" size="sm" className="gap-2">
                <RefreshCw className="h-4 w-4" />
                Refresh
              </Button>
            </div>
          )}
          {intelBackfill.status === "running" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Backfilling intelligence… {intelBackfill.processed} files processed ({intelBackfill.remaining} remaining)
              </div>
              <Progress
                value={intelBackfill.remaining > 0
                  ? (intelBackfill.processed / (intelBackfill.processed + intelBackfill.remaining)) * 100
                  : 100
                }
                className="h-3"
              />
              <div className="grid grid-cols-4 gap-3">
                <SummaryCard label="Processed" value={intelBackfill.processed} />
                <SummaryCard label="Intel Written" value={intelBackfill.succeeded} />
                <SummaryCard label="Skipped" value={intelBackfill.skipped} />
                <SummaryCard label="Failed" value={intelBackfill.failed} variant={intelBackfill.failed > 0 ? "warning" : undefined} />
              </div>
            </div>
          )}
          {intelBackfill.status === "complete" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                Intelligence backfill complete
              </div>
              <div className="grid grid-cols-4 gap-3">
                <SummaryCard label="Processed" value={intelBackfill.processed} />
                <SummaryCard label="Intel Written" value={intelBackfill.succeeded} />
                <SummaryCard label="Skipped" value={intelBackfill.skipped} />
                <SummaryCard label="Failed" value={intelBackfill.failed} variant={intelBackfill.failed > 0 ? "warning" : undefined} />
              </div>
              <Button variant="outline" size="sm" onClick={startIntelBackfill}>
                Run Again
              </Button>
            </div>
          )}
          {intelBackfill.status === "error" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" />
                {intelBackfill.errorMessage}
              </div>
              <Button variant="outline" size="sm" onClick={startIntelBackfill}>
                Retry
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <DarwinRoofTuningDashboard />

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
