// Public endpoint: list every check visible to a partner (by 8-char partner code),
// including checks owned by their tenant and (optionally) checks shared TO their tenant
// via shared_checks. Powers partner inbox views (e.g., Claim Wave Checks tab).
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
    const partnerCode = (url.searchParams.get("partner") ?? url.searchParams.get("partner_code") ?? "")
      .trim()
      .toUpperCase();
    const includeSharedRaw = url.searchParams.get("include_shared");
    const includeShared = includeSharedRaw === null ? true : includeSharedRaw !== "0";
    const limitRaw = parseInt(url.searchParams.get("limit") ?? "200", 10);
    const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 200, 500));

    if (!/^[A-Z0-9]{8}$/.test(partnerCode)) {
      return new Response(JSON.stringify({ error: "partner must be 8 alphanumeric chars" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error } = await supabase.rpc("list_partner_shared_checks", {
      _partner_code: partnerCode,
      _include_shared: includeShared,
      _limit: limit,
    });
    if (error) throw error;

    const signImage = async (path: string | null) => {
      if (!path) return null;
      if (/^https?:\/\//i.test(path)) return path;
      if (path.startsWith("external://")) return null;
      const { data: signed } = await supabase.storage.from("check-images").createSignedUrl(path, 3600);
      return signed?.signedUrl ?? null;
    };

    const checks = await Promise.all((data ?? []).map(async (c: any) => {
      const [frontUrl, backUrl] = await Promise.all([
        signImage(c.front_image_path),
        signImage(c.back_image_path),
      ]);
      return {
        id: c.id,
        freedom_claim_id: c.freedom_claim_id,
        claim_number: c.claim_number,
        carrier: c.carrier,
        insured_name: c.insured_name,
        check_number: c.check_number,
        amount: c.amount,
        status: c.status,
        check_stage: c.check_stage,
        partner_status: c.partner_status,
        partner_status_label: c.partner_status_label,
        front_image_url: frontUrl,
        back_image_url: backUrl,
        image_urls: [frontUrl, backUrl].filter(Boolean),
        is_shared: c.is_shared,
        created_at: c.created_at,
      };
    }));

    return new Response(
      JSON.stringify({
        ok: true,
        partner_code: partnerCode,
        count: checks.length,
        checks,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    console.error("partner-shared-checks error", e);
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
