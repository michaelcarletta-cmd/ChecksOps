// Public endpoint: Freedom CRM (or any partner app) calls this to list
// ChecksOps checks scoped to (partner_code, freedom_claim_id).
// Auth model: knowledge of the 8-char partner code + the Freedom claim uuid.
// Both must match — results are filtered server-side via SECURITY DEFINER RPC.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const partnerCode = (url.searchParams.get("partner") ?? url.searchParams.get("partner_code") ?? "").trim().toUpperCase();
    const freedomClaimId = (url.searchParams.get("freedom_claim_id") ?? "").trim();

    if (!/^[A-Z0-9]{8}$/.test(partnerCode)) {
      return new Response(JSON.stringify({ error: "partner must be 8 alphanumeric chars" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(freedomClaimId)) {
      return new Response(JSON.stringify({ error: "freedom_claim_id must be a uuid" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error } = await supabase.rpc("list_checks_by_freedom_claim", {
      _partner_code: partnerCode,
      _freedom_claim_id: freedomClaimId,
    });
    if (error) throw error;

    // Generate signed URLs for any non-external image paths so Freedom can render them.
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const checks = await Promise.all((data ?? []).map(async (c: any) => {
      const signImage = async (path: string | null) => {
        if (!path) return null;
        if (/^https?:\/\//i.test(path)) return path;
        if (path.startsWith("external://")) return null;
        const { data: signed } = await supabase.storage.from("claim-files").createSignedUrl(path, 3600);
        return signed?.signedUrl ?? null;
      };
      const [frontUrl, backUrl] = await Promise.all([
        signImage(c.front_image_path),
        signImage(c.back_image_path),
      ]);
      return {
        id: c.id,
        check_number: c.check_number,
        amount: c.amount,
        carrier_name: c.carrier_name,
        payee_line: c.payee_line,
        issue_date: c.issue_date,
        status: c.status,
        check_stage: c.check_stage,
        partner_status: c.partner_status,
        partner_status_label: c.partner_status_label,
        partner_status_updated_at: c.partner_status_updated_at,
        deposit_recommendation: c.deposit_recommendation,
        freedom_claim_id: c.freedom_claim_id,
        freedom_claim_number: c.freedom_claim_number,
        detected_claim_number: c.detected_claim_number,
        front_image_url: frontUrl,
        back_image_url: backUrl,
        image_urls: [frontUrl, backUrl].filter(Boolean),
        created_at: c.created_at,
        updated_at: c.updated_at,
      };
    }));

    return new Response(JSON.stringify({
      ok: true,
      partner_code: partnerCode,
      freedom_claim_id: freedomClaimId,
      count: checks.length,
      checks,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error("partner-checks-by-claim error", e);
    return new Response(JSON.stringify({ error: e.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
