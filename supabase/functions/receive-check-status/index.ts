// Inbound endpoint: FreedomClaims POSTs here when a check's status changes on their side.
// Authenticated via shared CROSS_APP_BRIDGE_SECRET. Updates partner_status fields on the
// mirrored check_intake_items row so ChecksOps users see the current Freedom workflow state.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bridge-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ReceivePayload {
  source_check_id: string;
  source_partner_code?: string;
  freedom_status: string;
  freedom_status_label?: string | null;
  updated_at?: string | null;
  // Optional context fields Freedom may include — used to backfill the mirror if blank
  check_number?: string | null;
  carrier_name?: string | null;
  amount?: number | null;
}

function humanize(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: corsHeaders });
  }

  const expected = Deno.env.get("CROSS_APP_BRIDGE_SECRET");
  const provided = req.headers.get("x-bridge-secret");
  if (!expected || provided !== expected) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await req.json()) as ReceivePayload;
    if (!body?.source_check_id || !body?.freedom_status) {
      return new Response(JSON.stringify({ error: "source_check_id and freedom_status are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: check, error: lookupErr } = await supabase
      .from("check_intake_items")
      .select("id, partner_status")
      .eq("external_origin->>source_check_id", body.source_check_id)
      .maybeSingle();

    if (lookupErr) throw lookupErr;
    if (!check) {
      return new Response(JSON.stringify({ error: "mirrored check not found", source_check_id: body.source_check_id }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const label = body.freedom_status_label?.trim() || humanize(body.freedom_status);
    const stampedAt = body.updated_at ?? new Date().toISOString();

    const updates: Record<string, unknown> = {
      partner_status: body.freedom_status,
      partner_status_label: label,
      partner_status_updated_at: stampedAt,
      updated_at: new Date().toISOString(),
    };
    if (body.check_number) updates.check_number = body.check_number;
    if (body.carrier_name) updates.carrier_name = body.carrier_name;
    if (typeof body.amount === "number") updates.amount = body.amount;

    const { error: updErr } = await supabase
      .from("check_intake_items")
      .update(updates)
      .eq("id", check.id);
    if (updErr) throw updErr;

    return new Response(JSON.stringify({
      ok: true,
      updated: 1,
      check_id: check.id,
      partner_status: body.freedom_status,
      label,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error("receive-check-status error", e);
    return new Response(JSON.stringify({ error: e.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
