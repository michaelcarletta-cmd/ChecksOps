import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BATCH_SIZE = 10; // claims per invocation

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

    // Find claims that have files with extracted_text but need event rebuild
    // We pick claims where at least one file has text and processed_by_darwin = false
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
      return new Response(JSON.stringify({ success: false, error: claimError.message }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!claims || claims.length === 0) {
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
        // 1. Delete all existing derived claim_events for this claim
        const { count: deletedEvents } = await supabase
          .from("claim_events")
          .delete({ count: "exact" })
          .eq("claim_id", claim.id);

        // 2. Mark all files as unprocessed so darwin-process-document will re-run
        await supabase
          .from("claim_files")
          .update({ processed_by_darwin: false })
          .eq("claim_id", claim.id);

        // 3. Get files with extracted_text to reprocess
        const { data: files } = await supabase
          .from("claim_files")
          .select("id, file_name, file_path")
          .eq("claim_id", claim.id)
          .not("extracted_text", "is", null);

        let reprocessed = 0;
        const fileCount = files?.length || 0;

        // 4. Invoke darwin-process-document for each file
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
    return new Response(
      JSON.stringify({ success: false, error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
