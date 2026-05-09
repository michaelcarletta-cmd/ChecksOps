// Accepts status sync updates from partner apps (e.g. Freedom CRM) for mirrored checks.
// Authenticated via shared bridge secret. Updates status + deposit_recommendation
// on the local mirror so partner tenants see the check move through the correct tabs.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bridge-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface SyncPayload {
  source_check_id: string;
  status?: string | null;
  deposit_recommendation?: string | null;
  ocr_status?: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: corsHeaders });
  }

  // Authenticate via shared bridge secret
  const expected = Deno.env.get("CROSS_APP_BRIDGE_SECRET");
  const provided = req.headers.get("x-bridge-secret");
  if (!expected || provided !== expected) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await req.json()) as SyncPayload;
    if (!body?.source_check_id) {
      return new Response(JSON.stringify({ error: "source_check_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Find the mirrored check by external_origin->>source_check_id
    const { data: mirroredCheck, error: lookupErr } = await supabase
      .from("check_intake_items")
      .select("id, status, deposit_recommendation, ocr_status")
      .eq("external_origin->>source_check_id", body.source_check_id)
      .maybeSingle();

    if (lookupErr) throw lookupErr;
    if (!mirroredCheck) {
      return new Response(JSON.stringify({ error: "mirrored check not found", source_check_id: body.source_check_id }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build update payload — only include fields that are actually changing
    const updates: Record<string, unknown> = {};
    if (body.status !== undefined && body.status !== mirroredCheck.status) {
      updates.status = body.status;
    }
    if (body.deposit_recommendation !== undefined && body.deposit_recommendation !== mirroredCheck.deposit_recommendation) {
      updates.deposit_recommendation = body.deposit_recommendation;
    }
    if (body.ocr_status !== undefined && body.ocr_status !== mirroredCheck.ocr_status) {
      updates.ocr_status = body.ocr_status;
    }

    if (Object.keys(updates).length === 0) {
      return new Response(JSON.stringify({ ok: true, changed: false, check_id: mirroredCheck.id }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    updates.updated_at = new Date().toISOString();

    const { error: updateErr } = await supabase
      .from("check_intake_items")
      .update(updates)
      .eq("id", mirroredCheck.id);

    if (updateErr) throw updateErr;

    return new Response(JSON.stringify({
      ok: true,
      changed: true,
      check_id: mirroredCheck.id,
      updates,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("sync-check-status error", e);
    return new Response(JSON.stringify({ error: e.message ?? String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
