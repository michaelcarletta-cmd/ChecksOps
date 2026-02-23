import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BATCH_SIZE = 5;
const JOB_TYPE = "backfill_document_intelligence";
const CLAIMED_BY = "backfill-document-intelligence";
const TTL_SECONDS = 120;
const BATCH_MAX_RUNTIME_MS = 50_000;
const FILE_TIMEOUT_MS = 45_000;

type CandidateFile = {
  id: string;
  claim_id: string;
  file_name: string;
};

type ProcessLogEntry = {
  file_id: string;
  claim_id: string;
  file_name: string;
  success: boolean;
  classification?: string | null;
  confidence?: number | null;
  reason?: string;
};

async function processViaDarwin(
  supabaseUrl: string,
  serviceRoleKey: string,
  file: CandidateFile,
): Promise<ProcessLogEntry> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FILE_TIMEOUT_MS);

  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/darwin-process-document`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fileId: file.id }),
      signal: controller.signal,
    });

    const rawBody = await response.text();
    let parsedBody: any = null;
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        // Non-JSON body; keep raw snippet in reason below.
      }
    }

    if (!response.ok) {
      const reason =
        parsedBody?.error ||
        `darwin_process_document_http_${response.status}: ${rawBody.slice(0, 200)}`;
      return {
        file_id: file.id,
        claim_id: file.claim_id,
        file_name: file.file_name,
        success: false,
        reason,
      };
    }

    if (!parsedBody?.success) {
      return {
        file_id: file.id,
        claim_id: file.claim_id,
        file_name: file.file_name,
        success: false,
        reason: parsedBody?.error || "darwin_process_document_returned_unsuccessful",
      };
    }

    return {
      file_id: file.id,
      claim_id: file.claim_id,
      file_name: file.file_name,
      success: true,
      classification: parsedBody?.classification ?? null,
      confidence: parsedBody?.confidence ?? null,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        file_id: file.id,
        claim_id: file.claim_id,
        file_name: file.file_name,
        success: false,
        reason: "timeout",
      };
    }

    return {
      file_id: file.id,
      claim_id: file.claim_id,
      file_name: file.file_name,
      success: false,
      reason: error instanceof Error ? error.message : "unknown_error",
    };
  } finally {
    clearTimeout(timeout);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const body = await req.json().catch(() => ({}));
    const cursor = body.cursor || null;
    const release = body.release || false;

    if (release) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });
      return new Response(JSON.stringify({ success: true, message: "Lock released" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Avoid running while Step 1 is actively extracting text.
    const { data: step1Job } = await supabase
      .from("darwin_jobs")
      .select("status, heartbeat_at, ttl_seconds")
      .eq("job_type", "backfill_extracted_text")
      .maybeSingle();

    if (step1Job?.status === "running") {
      const heartbeatAgeSeconds = step1Job.heartbeat_at
        ? (Date.now() - new Date(step1Job.heartbeat_at).getTime()) / 1000
        : Infinity;
      if (heartbeatAgeSeconds < (step1Job.ttl_seconds || 120)) {
        return new Response(
          JSON.stringify({
            success: false,
            error: "Step 1 (text extraction) is still running. Wait for it to finish.",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    const { data: lockResult, error: lockError } = await supabase.rpc("acquire_darwin_job", {
      p_job_type: JOB_TYPE,
      p_claimed_by: CLAIMED_BY,
      p_ttl_seconds: TTL_SECONDS,
    });

    if (lockError) {
      return new Response(
        JSON.stringify({ success: false, error: `Lock RPC error: ${lockError.message}` }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!lockResult?.acquired) {
      return new Response(
        JSON.stringify({ success: false, error: "Job already running", job: lockResult }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let candidatesQuery = supabase
      .from("claim_files")
      .select("id, claim_id, file_name")
      .or("processed_by_darwin.is.false,processed_by_darwin.is.null")
      .not("extracted_text", "is", null)
      .neq("extracted_text", "")
      .order("id", { ascending: true })
      .limit(BATCH_SIZE);

    if (cursor) {
      candidatesQuery = candidatesQuery.gt("id", cursor);
    }

    const { data: candidates, error: candidatesError } = await candidatesQuery;
    if (candidatesError) {
      await supabase.rpc("release_darwin_job", {
        p_job_type: JOB_TYPE,
        p_error_message: candidatesError.message,
      });
      return new Response(JSON.stringify({ success: false, error: candidatesError.message }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!candidates || candidates.length === 0) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });
      return new Response(
        JSON.stringify({
          success: true,
          processed: 0,
          enriched: 0,
          failed: 0,
          remaining: 0,
          cursor: null,
          message: "No unprocessed files with extracted text",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const batchStart = Date.now();
    const log: ProcessLogEntry[] = [];
    let earlyExit = false;

    for (const file of candidates as CandidateFile[]) {
      if (Date.now() - batchStart > BATCH_MAX_RUNTIME_MS) {
        earlyExit = true;
        break;
      }

      const result = await processViaDarwin(supabaseUrl, serviceRoleKey, file);
      log.push(result);

      await supabase.rpc("heartbeat_darwin_job", {
        p_job_type: JOB_TYPE,
        p_claimed_by: CLAIMED_BY,
      });
    }

    const lastProcessedId = log.length > 0
      ? candidates[Math.min(log.length, candidates.length) - 1].id
      : cursor;

    let remainingQuery = supabase
      .from("claim_files")
      .select("id", { count: "exact", head: true })
      .or("processed_by_darwin.is.false,processed_by_darwin.is.null")
      .not("extracted_text", "is", null)
      .neq("extracted_text", "");
    if (lastProcessedId) {
      remainingQuery = remainingQuery.gt("id", lastProcessedId);
    }
    const { count: remainingCount } = await remainingQuery;

    const enriched = log.filter((entry) => entry.success).length;

    await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });

    return new Response(
      JSON.stringify({
        success: true,
        processed: log.length,
        enriched,
        failed: log.length - enriched,
        remaining: Math.max(0, remainingCount || 0),
        cursor: lastProcessedId,
        early_exit: earlyExit,
        elapsed_ms: Date.now() - batchStart,
        log,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("backfill-document-intelligence error:", error);
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
      const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const supabase = createClient(supabaseUrl, serviceRoleKey);
      await supabase.rpc("release_darwin_job", {
        p_job_type: JOB_TYPE,
        p_error_message: error instanceof Error ? error.message : "Unknown error",
      });
    } catch {
      // Best effort lock release.
    }

    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
