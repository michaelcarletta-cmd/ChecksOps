// Public endpoint: list every check visible to a partner by 8-char partner code.
// Includes checks owned by their tenant + (optionally) checks shared TO their tenant
// via the shared_checks table. Partner code resolves to tenant_id via tenants.partner_code.
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
    const partner = (url.searchParams.get("partner") ?? url.searchParams.get("partner_code") ?? "").trim().toUpperCase();
    const includeShared = url.searchParams.get("include_shared") !== "0";
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 500);

    if (!/^[A-Z0-9]{8}$/.test(partner)) {
      return new Response(JSON.stringify({ error: "partner must be 8 alphanumeric chars" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Resolve partner code -> tenant_id
    const { data: tenant, error: tErr } = await supabase
      .from("tenants")
      .select("id")
      .eq("partner_code", partner)
      .maybeSingle();
    if (tErr) throw tErr;
    if (!tenant) {
      return new Response(JSON.stringify({ ok: true, partner_code: partner, count: 0, checks: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const tenantId = tenant.id as string;

    const cols = "id, freedom_claim_id, freedom_claim_number, detected_claim_number, carrier_name, payee_line, check_number, amount, issue_date, status, check_stage, partner_status, partner_status_label, partner_status_updated_at, front_image_path, back_image_path, created_at, updated_at";

    // Checks owned by the partner's tenant
    const { data: owned, error: oErr } = await supabase
      .from("check_intake_items")
      .select(cols)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (oErr) throw oErr;

    // Checks shared TO the partner's tenant
    let sharedRows: any[] = [];
    if (includeShared) {
      const { data, error: sErr } = await supabase
        .from("shared_checks")
        .select(`check:check_intake_items!shared_checks_check_id_fkey(${cols})`)
        .eq("target_tenant_id", tenantId)
        .is("revoked_at", null)
        .limit(limit);
      if (sErr) throw sErr;
      sharedRows = (data || [])
        .map((r: any) => r.check)
        .filter(Boolean);
    }

    // Dedupe by id (owned wins over shared)
    const map = new Map<string, any>();
    (owned || []).forEach((c: any) => map.set(c.id, { ...c, is_shared: false }));
    sharedRows.forEach((c: any) => { if (!map.has(c.id)) map.set(c.id, { ...c, is_shared: true }); });

    const merged = [...map.values()]
      .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
      .slice(0, limit);

    const signImage = async (path: string | null) => {
      if (!path) return null;
      if (/^https?:\/\//i.test(path)) return path;
      if (path.startsWith("external://")) return null;
      const { data: signed } = await supabase.storage.from("claim-files").createSignedUrl(path, 3600);
      return signed?.signedUrl ?? null;
    };

    const checks = await Promise.all(merged.map(async (c: any) => {
      const [frontUrl, backUrl] = await Promise.all([
        signImage(c.front_image_path),
        signImage(c.back_image_path),
      ]);
      return {
        id: c.id,
        freedom_claim_id: c.freedom_claim_id,
        claim_number: c.freedom_claim_number ?? c.detected_claim_number ?? null,
        carrier_name: c.carrier_name,
        insured_name: c.payee_line,
        check_number: c.check_number,
        amount: c.amount,
        issue_date: c.issue_date,
        status: c.status,
        check_stage: c.check_stage,
        partner_status: c.partner_status,
        partner_status_label: c.partner_status_label,
        partner_status_updated_at: c.partner_status_updated_at,
        front_image_url: frontUrl,
        back_image_url: backUrl,
        image_urls: [frontUrl, backUrl].filter(Boolean),
        is_shared: c.is_shared === true,
        created_at: c.created_at,
        updated_at: c.updated_at,
      };
    }));

    return new Response(JSON.stringify({
      ok: true,
      partner_code: partner,
      count: checks.length,
      checks,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error("partner-shared-checks error", e);
    return new Response(JSON.stringify({ ok: false, error: e?.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
