import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const JOB_TYPE = "backfill_document_intelligence";
const TTL_SECONDS = 180;
const DEFAULT_BATCH_SIZE = 10;
const BATCH_MAX_RUNTIME_MS = 55_000;
const PER_FILE_TIMEOUT_MS = 45_000;
const MIN_FILE_BUDGET_MS = 3_000;

const SUPPORTED_CLASSIFICATIONS = [
  "engineering_report",
  "expert_report",
  "inspection_report",
  "denial",
  "denial_letter",
  "carrier_denial",
  "approval",
  "coverage_letter",
  "correspondence",
  "carrier_correspondence",
  "carrier_email",
  "rfi",
  "estimate",
  "carrier_estimate",
  "policy",
  "policy_document",
];

const CLASSIFICATION_TO_DOCTYPE: Record<string, string> = {
  denial: "carrier_denial",
  denial_letter: "carrier_denial",
  approval: "coverage_letter",
  correspondence: "carrier_correspondence",
  carrier_email: "carrier_correspondence",
  rfi: "carrier_correspondence",
  policy: "policy_document",
  carrier_estimate: "estimate",
  expert_report: "engineering_report",
  inspection_report: "engineering_report",
};

interface BackfillFileResult {
  file_id: string;
  claim_id: string;
  file_name: string;
  document_type: string | null;
  classification: string | null;
  text_quality_before: string | null;
  ready_for_analysis_before: boolean | null;
  intelligence_written: boolean;
  skipped: boolean;
  reason: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const cursor = body.cursor || null;
    const force = body.force === true;
    const release = body.release === true;
    const batchSize = Math.min(Number(body.batchSize ?? DEFAULT_BATCH_SIZE), 25);

    // Force-release lock if requested
    if (release) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });
      return json({ success: true, message: "Lock released" });
    }

    // Get coverage snapshot before processing
    const coverageBefore = await getCoverageSnapshot(supabase);

    // Ensure lock row exists
    const { data: existingJobRow } = await supabase
      .from("darwin_jobs")
      .select("job_type")
      .eq("job_type", JOB_TYPE)
      .maybeSingle();
    if (!existingJobRow) {
      const { error: seedErr } = await supabase
        .from("darwin_jobs")
        .insert({ job_type: JOB_TYPE, status: "idle" });
      if (seedErr && seedErr.code !== "23505") {
        console.warn(`[DocIntelBackfill] Failed to seed lock row: ${seedErr.message}`);
      }
    }

    // Acquire lock
    const { data: lockResult, error: lockErr } = await supabase.rpc("acquire_darwin_job", {
      p_job_type: JOB_TYPE,
      p_claimed_by: "backfill-document-intelligence",
      p_ttl_seconds: TTL_SECONDS,
    });

    if (lockErr) {
      return json({ success: false, error: `Lock RPC error: ${lockErr.message}` });
    }

    if (!lockResult?.acquired) {
      return json({
        success: false,
        error: "Job already running",
        error_code: "JOB_ALREADY_RUNNING",
        job: lockResult || null,
      });
    }

    // Build candidate query
    const candidates = await fetchCandidates(supabase, cursor, batchSize, force);

    if (candidates.length === 0) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });
      const coverageAfter = await getCoverageSnapshot(supabase);
      console.log(
        `[DocIntelBackfillSummary] total_candidates=0 processed=0 skipped=0 failed=0 intelligence_written=0 coverage_before=${coverageBefore.coveragePct}% coverage_after=${coverageAfter.coveragePct}%`
      );
      return json({
        success: true,
        processed: 0,
        remaining: 0,
        cursor: null,
        message: "No more files need intelligence backfill",
        coverage: coverageAfter,
      });
    }

    // Count remaining
    const remainingCount = await countCandidates(supabase, cursor, force);

    const results: BackfillFileResult[] = [];
    const batchStart = Date.now();
    let attemptedCount = 0;
    const processUrl = `${supabaseUrl}/functions/v1/darwin-process-document`;

    for (const file of candidates) {
      const elapsedMs = Date.now() - batchStart;
      const remainingBudgetMs = BATCH_MAX_RUNTIME_MS - elapsedMs;
      if (remainingBudgetMs <= MIN_FILE_BUDGET_MS) {
        console.warn(
          `[DocIntelBackfill] Approaching timeout after ${attemptedCount} files — exiting with cursor`
        );
        break;
      }

      const result = await processFile(
        supabase,
        processUrl,
        serviceKey,
        file,
        force,
        remainingBudgetMs
      );

      results.push(result);
      attemptedCount++;

      console.log(
        `[DocIntelBackfill] file_id=${result.file_id} claim_id=${result.claim_id} file_name=${result.file_name} document_type=${result.document_type} classification=${result.classification} text_quality_status=${result.text_quality_before} ready_for_analysis=${result.ready_for_analysis_before} intelligence_written=${result.intelligence_written} skipped=${result.skipped} reason=${result.reason}`
      );

      await supabase.rpc("heartbeat_darwin_job", {
        p_job_type: JOB_TYPE,
        p_claimed_by: "backfill-document-intelligence",
      });
    }

    const lastAttemptedIndex = Math.min(attemptedCount, candidates.length) - 1;
    const lastId = lastAttemptedIndex >= 0 ? candidates[lastAttemptedIndex]?.id : cursor;

    const processed = results.filter((r) => !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;
    const failed = results.filter((r) => !r.skipped && !r.intelligence_written).length;
    const intelligenceWritten = results.filter((r) => r.intelligence_written).length;

    const finalRemaining = await countCandidates(supabase, lastId, force);

    await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });

    const coverageAfter = await getCoverageSnapshot(supabase);

    console.log(
      `[DocIntelBackfillSummary] total_candidates=${candidates.length} processed=${processed} skipped=${skipped} failed=${failed} intelligence_written=${intelligenceWritten} coverage_before=${coverageBefore.coveragePct}% coverage_after=${coverageAfter.coveragePct}%`
    );

    return json({
      success: true,
      processed: results.length,
      succeeded: intelligenceWritten,
      failed,
      skipped,
      remaining: Math.max(0, finalRemaining),
      cursor: lastId,
      elapsed_ms: Date.now() - batchStart,
      coverage: coverageAfter,
      log: results,
    });
  } catch (e) {
    console.error("[DocIntelBackfill] Fatal error:", e);
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const sb = createClient(supabaseUrl, serviceKey);
      await sb.rpc("release_darwin_job", {
        p_job_type: JOB_TYPE,
        p_error_message: e instanceof Error ? e.message : "Unknown error",
      });
    } catch {
      /* best effort */
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: e instanceof Error ? e.message : "Unknown error",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function fetchCandidates(
  supabase: ReturnType<typeof createClient>,
  cursor: string | null,
  batchSize: number,
  force: boolean
): Promise<any[]> {
  // Fetch files with supported document types that are missing intelligence
  // We need a two-step approach: fetch candidate files, then check which have intelligence
  let query = supabase
    .from("claim_files")
    .select(
      "id, claim_id, file_name, document_classification, document_type, text_quality_status, ready_for_analysis, needs_reprocessing, extracted_text, clean_text"
    )
    .or(
      SUPPORTED_CLASSIFICATIONS.map((c) => `document_classification.eq.${c}`).join(",") +
        "," +
        SUPPORTED_CLASSIFICATIONS.map((c) => `document_type.eq.${c}`).join(",")
    )
    .order("ready_for_analysis", { ascending: false }) // ready files first
    .order("id", { ascending: true })
    .limit(batchSize * 3); // Over-fetch to allow filtering

  if (cursor) {
    query = query.gt("id", cursor);
  }

  const { data: files, error } = await query;
  if (error) {
    throw new Error(`Failed to fetch candidates: ${error.message}`);
  }

  if (!files || files.length === 0) return [];

  // Check which already have intelligence rows
  const fileIds = files.map((f: any) => f.id);
  const { data: existingIntel } = await supabase
    .from("claim_document_intelligence")
    .select("claim_file_id")
    .in("claim_file_id", fileIds);

  const existingIntelSet = new Set(
    (existingIntel || []).map((r: any) => r.claim_file_id)
  );

  // Filter to candidates that actually need processing.
  // Important: blocked files marked needs_reprocessing must NOT be treated as
  // perpetual candidates for intelligence backfill, or they will churn forever.
  const candidates = files.filter((f: any) => {
    if (force) return true;
    if (existingIntelSet.has(f.id)) return false; // Already has intelligence

    const textLen = Math.max(
      (f.extracted_text || "").length,
      (f.clean_text || "").length
    );

    if (textLen < 50) return false;
    if (f.ready_for_analysis !== true) return false;
    if (f.text_quality_status === "unusable") return false;
    return true;
  });

  // Sort priority: ready_for_analysis first, good/fair quality, then newest
  candidates.sort((a: any, b: any) => {
    // Ready files first
    if (a.ready_for_analysis && !b.ready_for_analysis) return -1;
    if (!a.ready_for_analysis && b.ready_for_analysis) return 1;
    // Good/fair quality before poor
    const qualityOrder: Record<string, number> = { good: 0, fair: 1, poor: 2, unusable: 3, pending: 4 };
    const aQ = qualityOrder[a.text_quality_status || "pending"] ?? 4;
    const bQ = qualityOrder[b.text_quality_status || "pending"] ?? 4;
    if (aQ !== bQ) return aQ - bQ;
    return 0;
  });

  return candidates.slice(0, batchSize);
}

async function countCandidates(
  supabase: ReturnType<typeof createClient>,
  cursor: string | null,
  force: boolean
): Promise<number> {
  // Approximate count of remaining candidates.
  // Only count files that are actually eligible for intelligence backfill.
  let query = supabase
    .from("claim_files")
    .select("id", { count: "exact", head: true })
    .eq("ready_for_analysis", true)
    .or(
      SUPPORTED_CLASSIFICATIONS.map((c) => `document_classification.eq.${c}`).join(",") +
        "," +
        SUPPORTED_CLASSIFICATIONS.map((c) => `document_type.eq.${c}`).join(",")
    );

  if (cursor) {
    query = query.gt("id", cursor);
  }

  const { count } = await query;
  return count ?? 0;
}

async function processFile(
  supabase: ReturnType<typeof createClient>,
  processUrl: string,
  serviceKey: string,
  file: any,
  force: boolean,
  remainingBudgetMs: number
): Promise<BackfillFileResult> {
  const baseResult: BackfillFileResult = {
    file_id: file.id,
    claim_id: file.claim_id,
    file_name: file.file_name || "Unknown",
    document_type: file.document_type || null,
    classification: file.document_classification || null,
    text_quality_before: file.text_quality_status || null,
    ready_for_analysis_before: file.ready_for_analysis ?? null,
    intelligence_written: false,
    skipped: false,
    reason: "",
  };

  // Skip files with no usable text
  const textLen = Math.max(
    (file.extracted_text || "").length,
    (file.clean_text || "").length
  );
  if (textLen < 50) {
    await supabase
      .from("claim_files")
      .update({ needs_reprocessing: false })
      .eq("id", file.id);

    return {
      ...baseResult,
      skipped: true,
      reason: "no_usable_text",
    };
  }

  // Skip blocked / not-ready files for intelligence backfill.
  if (!force && file.ready_for_analysis !== true) {
    await supabase
      .from("claim_files")
      .update({ needs_reprocessing: false })
      .eq("id", file.id);

    return {
      ...baseResult,
      skipped: true,
      reason: "not_ready_for_analysis",
    };
  }

  // Skip unusable quality files (unless force)
  if (!force && file.text_quality_status === "unusable") {
    await supabase
      .from("claim_files")
      .update({ needs_reprocessing: false })
      .eq("id", file.id);

    return {
      ...baseResult,
      skipped: true,
      reason: "text_quality_unusable",
    };
  }

  // Invoke darwin-process-document
  const thisFileTimeoutMs = Math.min(
    PER_FILE_TIMEOUT_MS,
    Math.max(remainingBudgetMs - 1_000, MIN_FILE_BUDGET_MS)
  );
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), thisFileTimeoutMs);

  try {
    const res = await fetch(processUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        fileId: file.id,
        claimId: file.claim_id,
        fileName: file.file_name,
        forceIntelligence: true,
      }),
    });

    const data = await res.json().catch(() => ({}));
    const appError = typeof data?.error === "string" ? data.error : null;
    const processingError = typeof data?.processing_error === "string" ? data.processing_error : null;
    const skippedReason =
      data?.intelligence && typeof data.intelligence.skipped_reason === "string"
        ? data.intelligence.skipped_reason
        : null;

    if (!res.ok) {
      const reason = appError || processingError || `HTTP ${res.status}`;
      await supabase
        .from("claim_files")
        .update({ needs_reprocessing: true, processing_error: reason })
        .eq("id", file.id);

      return {
        ...baseResult,
        reason,
      };
    }

    if (data?.success === false) {
      const reason = appError || processingError || `HTTP ${res.status}`;
      const shouldSkip =
        reason === "No readable text extracted from file" ||
        reason === "Extracted text detected as garbage/binary data" ||
        skippedReason?.startsWith("not_ready_for_analysis:") === true;

      if (shouldSkip) {
        await supabase
          .from("claim_files")
          .update({ needs_reprocessing: false })
          .eq("id", file.id);
      }

      return {
        ...baseResult,
        skipped: shouldSkip,
        reason,
      };
    }

    const { data: intelRow } = await supabase
      .from("claim_document_intelligence")
      .select("id")
      .eq("claim_file_id", file.id)
      .maybeSingle();

    const { data: queueRow } = intelRow
      ? { data: null }
      : await supabase
          .from("document_intelligence_queue")
          .select("id, status")
          .eq("file_id", file.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

    const countedAsSuccess = !!intelRow || !!queueRow;
    const shouldSkip = !countedAsSuccess && skippedReason?.startsWith("not_ready_for_analysis:") === true;

    if (countedAsSuccess || shouldSkip) {
      await supabase
        .from("claim_files")
        .update({ needs_reprocessing: false })
        .eq("id", file.id);
    }

    return {
      ...baseResult,
      intelligence_written: countedAsSuccess,
      skipped: shouldSkip,
      reason: intelRow
        ? "intelligence_extracted"
        : queueRow
        ? `queued_for_async_intelligence:${queueRow.status}`
        : skippedReason || "processed_but_no_intelligence_row",
    };
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === "AbortError";
    const reason = isTimeout
      ? `timeout_after_${thisFileTimeoutMs}ms`
      : err instanceof Error
      ? err.message
      : String(err);

    await supabase
      .from("claim_files")
      .update({ needs_reprocessing: true, processing_error: reason })
      .eq("id", file.id);

    return {
      ...baseResult,
      reason,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getCoverageSnapshot(
  supabase: ReturnType<typeof createClient>
): Promise<{
  totalSupported: number;
  withIntelligence: number;
  withoutIntelligence: number;
  readyForAnalysis: number;
  blocked: number;
  needsReprocessing: number;
  coveragePct: number;
}> {
  // Count supported files
  const { count: totalSupported } = await supabase
    .from("claim_files")
    .select("id", { count: "exact", head: true })
    .or(
      SUPPORTED_CLASSIFICATIONS.map((c) => `document_classification.eq.${c}`).join(",") +
        "," +
        SUPPORTED_CLASSIFICATIONS.map((c) => `document_type.eq.${c}`).join(",")
    );

  // Count files with intelligence
  const { count: withIntelligence } = await supabase
    .from("claim_document_intelligence")
    .select("id", { count: "exact", head: true });

  // Count ready_for_analysis
  const { count: readyForAnalysis } = await supabase
    .from("claim_files")
    .select("id", { count: "exact", head: true })
    .eq("ready_for_analysis", true)
    .or(
      SUPPORTED_CLASSIFICATIONS.map((c) => `document_classification.eq.${c}`).join(",") +
        "," +
        SUPPORTED_CLASSIFICATIONS.map((c) => `document_type.eq.${c}`).join(",")
    );

  // Count blocked
  const { count: blocked } = await supabase
    .from("claim_files")
    .select("id", { count: "exact", head: true })
    .eq("ready_for_analysis", false)
    .or(
      SUPPORTED_CLASSIFICATIONS.map((c) => `document_classification.eq.${c}`).join(",") +
        "," +
        SUPPORTED_CLASSIFICATIONS.map((c) => `document_type.eq.${c}`).join(",")
    );

  // Count needs_reprocessing
  const { count: needsReprocessing } = await supabase
    .from("claim_files")
    .select("id", { count: "exact", head: true })
    .eq("needs_reprocessing", true);

  const total = totalSupported ?? 0;
  const intel = withIntelligence ?? 0;
  const pct = total > 0 ? Math.round((intel / total) * 100) : 0;

  return {
    totalSupported: total,
    withIntelligence: intel,
    withoutIntelligence: Math.max(total - intel, 0),
    readyForAnalysis: readyForAnalysis ?? 0,
    blocked: blocked ?? 0,
    needsReprocessing: needsReprocessing ?? 0,
    coveragePct: pct,
  };
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
