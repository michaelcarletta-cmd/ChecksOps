import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const partner = (url.searchParams.get("partner") || "").trim().toUpperCase();
    const includeShared = url.searchParams.get("include_shared") !== "0";
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "200"), 500);

    if (!/^[A-Z0-9]{8}$/.test(partner)) {
      return new Response(JSON.stringify({ ok: false, error: "Invalid partner code" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Owned by partner
    const { data: owned = [] } = await supabase
      .from("check_intake_items")
      .select("id, freedom_claim_id, claim_number, carrier_name, insured_name, check_number, amount, status, check_stage, partner_status, partner_status_label, front_image_url, back_image_url, image_urls, created_at")
      .eq("partner_code", partner)
      .order("created_at", { ascending: false })
      .limit(limit);

    let shared: any[] = [];
    if (includeShared) {
      const { data } = await supabase
        .from("shared_checks")
        .select("check:check_intake_items(*)")
        .eq("target_partner_code", partner)
        .limit(limit);
      shared = (data || []).map((r: any) => ({ ...r.check, is_shared: true }));
    }

    const map = new Map<string, any>();
    [...(owned || []).map((c: any) => ({ ...c, is_shared: false })), ...shared].forEach((c: any) => {
      if (c?.id && !map.has(c.id)) map.set(c.id, c);
    });

    const checks = [...map.values()]
      .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
      .slice(0, limit);

    return new Response(JSON.stringify({ ok: true, partner_code: partner, count: checks.length, checks }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
