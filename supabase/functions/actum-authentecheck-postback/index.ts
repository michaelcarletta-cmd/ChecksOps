import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Public webhook from Actum — no JWT verification.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
};

function parseBody(text: string, contentType: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  // Try JSON
  if (contentType?.includes("application/json")) {
    try {
      const obj = JSON.parse(text);
      for (const [k, v] of Object.entries(obj)) {
        out[k] = typeof v === "string" ? v : JSON.stringify(v);
      }
      return out;
    } catch { /* fall through */ }
  }
  // form-urlencoded or k=v lines
  if (text.includes("&") || text.includes("=")) {
    try {
      const params = new URLSearchParams(text);
      for (const [k, v] of params.entries()) out[k] = v;
      if (Object.keys(out).length > 0) return out;
    } catch { /* fall through */ }
  }
  return out;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const text = await req.text();
    const url = new URL(req.url);
    const ct = req.headers.get("content-type");

    // Merge body + query params (Actum may send via either)
    const fields: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) fields[k] = v;
    Object.assign(fields, parseBody(text, ct));

    console.log("[authentecheck-postback] payload:", JSON.stringify(fields).slice(0, 2000));

    const stakeholderId = fields.merchantdata || fields.merchant_data;
    if (!stakeholderId) {
      console.warn("[authentecheck-postback] missing merchantdata, ignoring");
      return new Response("ok", { headers: corsHeaders });
    }

    const { data: account } = await supabase
      .from("stakeholder_accounts")
      .select("id, tenant_id")
      .eq("id", stakeholderId)
      .maybeSingle();

    if (!account) {
      console.warn("[authentecheck-postback] account not found", stakeholderId);
      return new Response("ok", { headers: corsHeaders });
    }

    const status = (fields.status || fields.trans_status || "").toLowerCase();
    const accepted = status === "accepted" || status === "approved" || status === "success" || !!fields.consumer_code;

    let authdata: any = null;
    if (fields.authdata) {
      try { authdata = JSON.parse(fields.authdata); } catch { authdata = fields.authdata; }
    }

    const update: Record<string, unknown> = {
      authentecheck_postback: fields,
      authentecheck_completed_at: new Date().toISOString(),
    };

    if (accepted) {
      update.verification_status = "verified";
      update.verified_at = new Date().toISOString();
      if (fields.consumer_code) {
        update.authentecheck_consumer_code = fields.consumer_code;
        update.consumer_unique = fields.consumer_code;
      }
      if (fields.orderid || fields.order_id) {
        update.authentecheck_order_id = fields.orderid || fields.order_id;
      }
      // Pull bank info from authdata if available
      if (authdata && typeof authdata === "object") {
        if (authdata.bank_name) update.authentecheck_bank_name = authdata.bank_name;
      }
    } else {
      update.verification_status = "failed";
      update.verification_failure_reason = fields.reason || fields.decline_reason || fields.error || "Authentecheck declined";
    }

    await supabase.from("stakeholder_accounts").update(update).eq("id", account.id);

    await supabase.from("stakeholder_account_verification_log").insert({
      stakeholder_account_id: account.id,
      tenant_id: account.tenant_id,
      event_type: accepted ? "authentecheck_verified" : "authentecheck_failed",
      details: fields,
    });

    return new Response("ok", { headers: corsHeaders });
  } catch (err: any) {
    console.error("[authentecheck-postback]", err);
    return new Response("error", { status: 200, headers: corsHeaders }); // 200 to avoid Actum retries on parsing
  }
});
