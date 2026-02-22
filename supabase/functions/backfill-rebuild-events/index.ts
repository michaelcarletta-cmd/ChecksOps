import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BATCH_SIZE = 10;
const JOB_TYPE = "backfill_rebuild_events";
const TTL_SECONDS = 120;

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

    // Force-release lock
    if (release) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });
      return new Response(JSON.stringify({ success: true, message: "Lock released" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Check that Step 1 is not running (heartbeat-aware)
    const { data: step1Row } = await supabase.from("darwin_jobs").select("status, heartbeat_at, ttl_seconds").eq("job_type", "backfill_extracted_text").single();
    if (step1Row?.status === "running") {
      // Only block if heartbeat is fresh
      const heartbeatAge = step1Row.heartbeat_at
        ? (Date.now() - new Date(step1Row.heartbeat_at).getTime()) / 1000
        : Infinity;
      if (heartbeatAge < (step1Row.ttl_seconds || 120)) {
        return new Response(
          JSON.stringify({ success: false, error: "Step 1 (text extraction) is still running. Wait for it to finish." }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Atomic acquire via RPC (handles TTL-based steal)
    const { data: lockResult, error: lockErr } = await supabase.rpc("acquire_darwin_job", {
      p_job_type: JOB_TYPE,
      p_claimed_by: "backfill-rebuild-events",
      p_ttl_seconds: TTL_SECONDS,
    });

    if (lockErr) {
      return new Response(JSON.stringify({ success: false, error: `Lock RPC error: ${lockErr.message}` }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!lockResult?.acquired) {
      return new Response(
        JSON.stringify({ success: false, error: "Job already running", job: lockResult }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Find claims to process
    let query = supabase
      .from("claims")
      .select("id, claim_number")
      .eq("is_closed", false)
      .order("id", { ascending: true })
      .limit(BATCH_SIZE);

    if (cursor) {
      query = query.gt("id", cursor);
    }

    const { data: claims, error: claimError } = await query;

    if (claimError) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE, p_error_message: claimError.message });
      return new Response(JSON.stringify({ success: false, error: claimError.message }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!claims || claims.length === 0) {
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });
      return new Response(
        JSON.stringify({ success: true, processed: 0, remaining: 0, cursor: null }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Count remaining
    const { count: totalRemaining } = await supabase
      .from("claims")
      .select("id", { count: "exact", head: true })
      .eq("is_closed", false);

    const log: any[] = [];

    for (const claim of claims) {
      try {
        const derivedSources = ["document_extracted", "document_text_regex", "system_upload"];
        const { count: deletedEvents } = await supabase
          .from("claim_events")
          .delete({ count: "exact" })
          .eq("claim_id", claim.id)
          .in("date_source", derivedSources);

        await supabase
          .from("claim_files")
          .update({ processed_by_darwin: false })
          .eq("claim_id", claim.id);

        const { data: files } = await supabase
          .from("claim_files")
          .select("id, file_name, file_path")
          .eq("claim_id", claim.id)
          .not("extracted_text", "is", null);

        let reprocessed = 0;
        const fileCount = files?.length || 0;

        if (files && files.length > 0) {
          for (const file of files) {
            try {
              const { error: invokeErr } = await supabase.functions.invoke("darwin-process-document", {
                body: { fileId: file.id, claimId: claim.id, fileName: file.file_name },
              });
              if (!invokeErr) reprocessed++;
            } catch {
              // continue on individual file failures
            }
          }
        }

        log.push({
          claim_id: claim.id,
          claim_number: claim.claim_number,
          events_deleted: deletedEvents || 0,
          files_with_text: fileCount,
          files_reprocessed: reprocessed,
          success: true,
        });
      } catch (err) {
        log.push({
          claim_id: claim.id,
          claim_number: claim.claim_number,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const lastId = claims[claims.length - 1].id;
    const remaining = Math.max(0, (totalRemaining || 0) - (cursor ? 0 : claims.length));

    if (remaining <= 0) {
      // Done — release lock
      await supabase.rpc("release_darwin_job", { p_job_type: JOB_TYPE });
    } else {
      // More work — heartbeat
      await supabase.rpc("heartbeat_darwin_job", { p_job_type: JOB_TYPE, p_claimed_by: "backfill-rebuild-events" });
    }

    return new Response(
      JSON.stringify({
        success: true,
        processed: claims.length,
        remaining,
        cursor: lastId,
        log,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("backfill-rebuild-events error:", e);
    try {
      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const sb = createClient(supabaseUrl, serviceKey);
      await sb.rpc("release_darwin_job", { p_job_type: JOB_TYPE, p_error_message: e instanceof Error ? e.message : "Unknown error" });
    } catch { /* best effort */ }
    return new Response(
      JSON.stringify({ success: false, error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
