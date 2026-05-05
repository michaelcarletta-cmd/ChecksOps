// Accepts a check shared from another Lovable Cloud app (e.g. Freedom CRM).
// Authenticates via shared bridge secret. Mirrors the check into check_intake_items
// (tagged with external_origin) and creates a shared_checks row.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bridge-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface IngestPayload {
  source_app: string;            // e.g. "freedom_crm"
  source_project_ref: string;    // e.g. "yvagrvfkeuvzjezfsbun"
  source_tenant_id: string;      // tenant uuid in the source app
  source_tenant_name: string;    // display name of the source tenant
  source_check_id: string;       // original check uuid in the source app
  target_partner_code: string;   // ChecksOps tenant partner code receiving the share
  shared_by_email?: string;      // for audit
  check: {
    carrier_name?: string;
    check_number?: string;
    amount?: number;
    issue_date?: string;
    payee_line?: string;
    front_image_url?: string;    // public/signed URL we can store as a reference
    back_image_url?: string;
    detected_claim_number?: string;
  };
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
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await req.json()) as IngestPayload;
    if (!body?.source_check_id || !body?.target_partner_code || !body?.source_tenant_id) {
      return new Response(JSON.stringify({ error: "missing required fields" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Resolve target tenant (the ChecksOps tenant receiving the share)
    const code = body.target_partner_code.trim().toUpperCase();
    const { data: lookup, error: lookupErr } = await supabase.rpc("lookup_tenant_by_partner_code", { _code: code });
    if (lookupErr) throw lookupErr;
    const targetTenant = Array.isArray(lookup) ? lookup[0] : lookup;
    if (!targetTenant) {
      return new Response(JSON.stringify({ error: "target_partner_code not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const targetTenantId = targetTenant.id ?? targetTenant.tenant_id;

    // Resolve OR auto-create a placeholder source tenant locally so FK works.
    // We mark these tenants with is_external in metadata; partner_code is set to a synthetic value.
    const externalSlug = `ext-${body.source_app}-${body.source_tenant_id.slice(0, 8)}`;
    let { data: extTenant } = await supabase
      .from("tenants")
      .select("id")
      .eq("slug", externalSlug)
      .maybeSingle();

    if (!extTenant) {
      const { data: created, error: createErr } = await supabase
        .from("tenants")
        .insert({
          name: `${body.source_tenant_name} (${body.source_app})`,
          slug: externalSlug,
          plan_tier: "external",
        })
        .select("id")
        .single();
      if (createErr) throw createErr;
      extTenant = created;
    }
    const sourceTenantId = extTenant!.id;

    // Idempotent check mirror: lookup by external_origin->>source_check_id
    const { data: existingCheck } = await supabase
      .from("check_intake_items")
      .select("id")
      .eq("external_origin->>source_check_id", body.source_check_id)
      .maybeSingle();

    let checkId: string;
    if (existingCheck) {
      checkId = existingCheck.id;
    } else {
      const { data: newCheck, error: insertErr } = await supabase
        .from("check_intake_items")
        .insert({
          tenant_id: sourceTenantId,
          front_image_path: body.check.front_image_url ?? `external://${body.source_check_id}`,
          back_image_path: body.check.back_image_url ?? null,
          carrier_name: body.check.carrier_name ?? null,
          check_number: body.check.check_number ?? null,
          amount: body.check.amount ?? null,
          issue_date: body.check.issue_date ?? null,
          payee_line: body.check.payee_line ?? null,
          detected_claim_number: body.check.detected_claim_number ?? null,
          status: "uploaded",
          ocr_status: "completed",
          external_origin: {
            source_app: body.source_app,
            source_project_ref: body.source_project_ref,
            source_tenant_id: body.source_tenant_id,
            source_tenant_name: body.source_tenant_name,
            source_check_id: body.source_check_id,
            ingested_at: new Date().toISOString(),
            shared_by_email: body.shared_by_email ?? null,
          },
        })
        .select("id")
        .single();
      if (insertErr) throw insertErr;
      checkId = newCheck.id;
    }

    // Create the share (idempotent via unique constraint)
    const { error: shareErr } = await supabase
      .from("shared_checks")
      .upsert({
        check_id: checkId,
        source_tenant_id: sourceTenantId,
        target_tenant_id: targetTenantId,
        shared_by: "00000000-0000-0000-0000-000000000000",
        access_level: "read_only",
        revoked_at: null,
      }, { onConflict: "check_id,source_tenant_id,target_tenant_id" });
    if (shareErr) throw shareErr;

    return new Response(JSON.stringify({
      ok: true,
      check_id: checkId,
      target_tenant_id: targetTenantId,
      source_tenant_id: sourceTenantId,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    console.error("ingest-shared-check error", e);
    return new Response(JSON.stringify({ error: e.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
