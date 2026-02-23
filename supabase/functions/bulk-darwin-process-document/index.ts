import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BATCH_SIZE = 5; // Small batch: each file runs AI classification + chunking + embeddings
const JOB_TYPE = "bulk_darwin_process_document";
const TTL_SECONDS = 120;
const BATCH_MAX_RUNTIME_MS = 55_000; // Safe exit before edge timeout
const PER_FILE_TIMEOUT_MS = 45_000; // Prevent single-file hangs from blocking the batch
const MIN_FILE_BUDGET_MS = 3_000; // Leave enough budget to return/release lock

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const cursor = body.cursor || null;
    const release = body.release || false;

    // Force-release lock if requested
    if (release) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });
      return new Response(JSON.stringify({ success: true, message: "Lock released" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Ensure Step 1 (text extraction) is not running
    const { data: step1Row } = await supabase
      .from("darwin_jobs")
      .select("status, heartbeat_at, ttl_seconds")
      .eq("job_type", "backfill_extracted_text")
      .single();
    if (step1Row?.status === "running") {
      const heartbeatAge = step1Row.heartbeat_at
        ? (Date.now() - new Date(step1Row.heartbeat_at).getTime()) / 1000
        : Infinity;
      if (heartbeatAge < (step1Row.ttl_seconds || 120)) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Step 1 (text extraction) is still running. Wait for it to finish.",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Ensure lock row exists. If a migration was skipped, acquire_darwin_job can otherwise
    // return "already running" with empty metadata forever.
    const { data: existingJobRow, error: existingJobErr } = await supabase
      .from("darwin_jobs")
      .select("job_type")
      .eq("job_type", JOB_TYPE)
      .maybeSingle();
    if (existingJobErr) {
      console.warn(`[BulkDarwin] Unable to verify lock row before acquire: ${existingJobErr.message}`);
    }
    if (!existingJobRow) {
      const { error: seedErr } = await supabase
        .from("darwin_jobs")
        .insert({ job_type: JOB_TYPE, status: "idle" });
      if (seedErr && seedErr.code !== "23505") {
        console.warn(`[BulkDarwin] Failed to seed lock row for ${JOB_TYPE}: ${seedErr.message}`);
      }
    }

    // Atomic acquire via RPC
    const { data: lockResult, error: lockErr } = await supabase.rpc("acquire_darwin_job", {
      p_job_type: JOB_TYPE,
      p_claimed_by: "bulk-darwin-process-document",
      p_ttl_seconds: TTL_SECONDS,
    });

    if (lockErr) {
      return new Response(JSON.stringify({ success: false, error: `Lock RPC error: ${lockErr.message}` }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!lockResult?.acquired) {
      const hasLockMetadata =
        !!lockResult?.claimed_by ||
        !!lockResult?.heartbeat_at ||
        !!lockResult?.started_at ||
        !!lockResult?.status;
      return new Response(
        JSON.stringify({
          success: false,
          error: hasLockMetadata
            ? "Job already running"
            : "Job lock metadata missing; fallback mode recommended",
          error_code: hasLockMetadata ? "JOB_ALREADY_RUNNING" : "JOB_LOCK_METADATA_MISSING",
          job: lockResult || null,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch unprocessed files with extracted_text (length > 50)
    let query = supabase
      .from("claim_files")
      .select("id, claim_id, file_name")
      .not("extracted_text", "is", null)
      .neq("extracted_text", "")
      .or("processed_by_darwin.is.null,processed_by_darwin.eq.false")
      .order("id", { ascending: true })
      .limit(BATCH_SIZE);

    if (cursor) {
      query = query.gt("id", cursor);
    }

    const { data: candidates, error: fetchErr } = await query;

    if (fetchErr) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE, p_error_message: fetchErr.message });
      return new Response(JSON.stringify({ success: false, error: fetchErr.message }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const files = candidates || [];

    console.log(`[BulkDarwin] Found ${files.length} files to process`);

    if (files.length === 0) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });
      return new Response(
        JSON.stringify({
          success: true,
          processed: 0,
          remaining: 0,
          cursor: null,
          message: "No more files to process",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Count remaining
    let countQuery = supabase
      .from("claim_files")
      .select("id", { count: "exact", head: true })
      .not("extracted_text", "is", null)
      .neq("extracted_text", "")
      .or("processed_by_darwin.is.null,processed_by_darwin.eq.false");
    if (cursor) countQuery = countQuery.gt("id", cursor);
    const { count: totalRemaining } = await countQuery;

    const log: Array<{ file_id: string; file_name: string; success: boolean; error?: string }> = [];
    const batchStart = Date.now();
    let attemptedCount = 0;

    const processUrl = `${supabaseUrl}/functions/v1/darwin-process-document`;

    for (const file of files) {
      const elapsedMs = Date.now() - batchStart;
      const remainingBudgetMs = BATCH_MAX_RUNTIME_MS - elapsedMs;
      if (remainingBudgetMs <= MIN_FILE_BUDGET_MS) {
        console.warn(
          `[BulkDarwin] Approaching timeout after ${attemptedCount} attempted files — exiting with cursor`
        );
        break;
      }

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
          }),
        });

        const data = await res.json().catch(() => ({}));
        const ok = res.ok && (data.success !== false);

        if (ok) {
          log.push({ file_id: file.id, file_name: file.file_name, success: true });
          console.log(`[BulkDarwin] Processed ${file.file_name} (${file.id})`);
        } else {
          log.push({
            file_id: file.id,
            file_name: file.file_name,
            success: false,
            error: data.error || `HTTP ${res.status}`,
          });
          console.error(`[BulkDarwin] Failed ${file.file_name}: ${data.error || res.status}`);
        }
      } catch (err) {
        const isTimeout = err instanceof DOMException && err.name === "AbortError";
        log.push({
          file_id: file.id,
          file_name: file.file_name,
          success: false,
          error: isTimeout ? `Timeout after ${thisFileTimeoutMs}ms` : err instanceof Error ? err.message : String(err),
        });
        console.error(`[BulkDarwin] Error processing ${file.file_name}:`, err);
      } finally {
        clearTimeout(timeoutId);
      }

      attemptedCount++;
      await supabase.rpc("heartbeat_darwin_job", { p_job_type: JOB_TYPE, p_claimed_by: "bulk-darwin-process-document" });
    }

    // Cursor must advance by attempted rows (not successful rows), otherwise failed files
    // can cause the batch to revisit almost the same window repeatedly.
    const lastAttemptedIndex = Math.min(attemptedCount, files.length) - 1;
    const lastId = lastAttemptedIndex >= 0 ? files[lastAttemptedIndex]?.id : cursor;
    const successCount = log.filter((l) => l.success).length;

    let finalCountQuery = supabase
      .from("claim_files")
      .select("id", { count: "exact", head: true })
      .not("extracted_text", "is", null)
      .neq("extracted_text", "")
      .or("processed_by_darwin.is.null,processed_by_darwin.eq.false");
    if (lastId) finalCountQuery = finalCountQuery.gt("id", lastId);
    const { count: finalRemaining } = await finalCountQuery;

    await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });

    return new Response(
      JSON.stringify({
        success: true,
        processed: log.length,
        succeeded: successCount,
        failed: log.length - successCount,
        remaining: Math.max(0, finalRemaining || 0),
        cursor: lastId,
        elapsed_ms: Date.now() - batchStart,
        log,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("bulk-darwin-process-document error:", e);
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
