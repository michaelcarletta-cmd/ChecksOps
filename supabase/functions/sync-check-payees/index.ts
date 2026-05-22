// Accepts payee/endorsement updates from a source app (e.g. Freedom CRM)
// for a previously-shared check. Mirrors the latest payee state into both
// check_payees and check_endorsements on the ChecksOps side so partners can
// see who has signed and who still needs to.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-bridge-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface PayeeInput {
  payee_name: string;
  payee_type?: string | null;
  endorsement_status?: string | null;
  endorsed_at?: string | null;
  signed_at?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  signature_method?: string | null;
  signature_image_url?: string | null;
}

interface Payload {
  source_check_id: string;
  payees: PayeeInput[];
}

function resolveSignedAt(payee: Pick<PayeeInput, "endorsed_at" | "signed_at">): string | null {
  return payee.endorsed_at ?? payee.signed_at ?? null;
}

function normalizePayeeStatus(s?: string | null, signedAt?: string | null): string {
  if (signedAt) return "signed";

  const v = (s ?? "").toLowerCase().trim();
  if (!v) return "pending";
  if (["signed", "endorsed", "complete", "completed", "waived", "manual_required"].includes(v)) return "signed";
  if (["viewed", "opened"].includes(v)) return "viewed";
  if (["declined", "rejected"].includes(v)) return "rejected";
  if (v === "expired") return "expired";
  return "pending";
}

function normalizeStatus(s?: string | null, signedAt?: string | null): string {
  if (signedAt) return "signed";

  const v = (s ?? "").toLowerCase().trim();
  if (!v) return "pending";
  if (["signed", "endorsed", "complete", "completed"].includes(v)) return "signed";
  if (v === "waived") return "waived";
  if (v === "manual_required") return "manual_required";
  if (["declined", "rejected"].includes(v)) return "rejected";
  if (["sent", "requested", "awaiting", "in_progress", "viewed", "opened"].includes(v)) return "sent";
  if (v === "expired") return "expired";
  return "pending";
}

function normalizeSignatureMethod(method?: string | null, signedAt?: string | null): string | null {
  const v = (method ?? "").toLowerCase().trim();
  if (["portal", "sms", "email", "internal", "manual"].includes(v)) return v;
  return signedAt ? "portal" : null;
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
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = (await req.json()) as Payload;
    if (!body?.source_check_id || !Array.isArray(body.payees)) {
      return new Response(JSON.stringify({ error: "missing source_check_id or payees" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Resolve the mirrored check by external origin.
    const { data: check, error: lookupErr } = await supabase
      .from("check_intake_items")
      .select("id, tenant_id")
      .eq("external_origin->>source_check_id", body.source_check_id)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!check) {
      return new Response(JSON.stringify({ error: "check not found for source_check_id" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const checkId = check.id as string;
    const tenantId = check.tenant_id as string;

    const cleaned = body.payees.filter(
      (p) => p && typeof p.payee_name === "string" && p.payee_name.trim().length > 0,
    );

    // Replace check_payees snapshot.
    await supabase.from("check_payees").delete().eq("check_id", checkId);
    if (cleaned.length > 0) {
      const payeeRows = cleaned.map((p) => {
        const signedAt = resolveSignedAt(p);
        return {
        check_id: checkId,
        tenant_id: tenantId,
        payee_name: p.payee_name.trim(),
        payee_type: p.payee_type ?? null,
        endorsement_status: normalizePayeeStatus(p.endorsement_status, signedAt),
        endorsed_at: signedAt,
        contact_email: p.contact_email ?? null,
        contact_phone: p.contact_phone ?? null,
        };
      });
      const { error: payeeErr } = await supabase.from("check_payees").insert(payeeRows);
      if (payeeErr) console.warn("sync-check-payees: check_payees insert failed", payeeErr);
    }

    // Replace check_endorsements snapshot so partner endorsement UI is populated.
    await supabase.from("check_endorsements").delete().eq("check_id", checkId);
    if (cleaned.length > 0) {
      const endorsementRows = cleaned.map((p) => {
        const signedAt = resolveSignedAt(p);
        return {
        check_id: checkId,
        tenant_id: tenantId,
        payee_name: p.payee_name.trim(),
        payee_type: p.payee_type ?? "other",
        status: normalizeStatus(p.endorsement_status, signedAt),
        signature_method: normalizeSignatureMethod(p.signature_method, signedAt),
        signature_image_url: p.signature_image_url ?? null,
        signed_at: signedAt,
        contact_email: p.contact_email ?? null,
        contact_phone: p.contact_phone ?? null,
        };
      });
      const { error: endErr } = await supabase
        .from("check_endorsements")
        .insert(endorsementRows);
      if (endErr) console.warn("sync-check-payees: check_endorsements insert failed", endErr);
    }

    return new Response(
      JSON.stringify({ ok: true, check_id: checkId, payees_synced: cleaned.length }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    console.error("sync-check-payees error", e);
    return new Response(JSON.stringify({ error: e.message ?? String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
