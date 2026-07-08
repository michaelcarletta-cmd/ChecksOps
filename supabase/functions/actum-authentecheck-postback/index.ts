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

    // Per Table 2 of the integration guide, the account identifier we submit
    // as "merchantdata" comes back in the postback under "orderinfo" (initial
    // flow) or "order_info" (repeat flow) — not "merchantdata" itself.
    const stakeholderId = fields.orderinfo || fields.order_info || fields.merchantdata || fields.merchant_data;
    if (!stakeholderId) {
      console.warn("[authentecheck-postback] missing orderinfo/order_info, ignoring");
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
      // Pull bank info from authdata if available — Authentecheck returns the
      // routing / account / type / bank_name fields when the user signs in via Plaid.
      if (authdata && typeof authdata === "object") {
        const a = authdata as Record<string, any>;
        const routing = a.routing_number || a.routing || a.aba || a.chk_aba;
        const account = a.account_number || a.account || a.chk_acct;
        const acctType = a.account_type || a.acct_type;
        const bankName = a.bank_name || a.bank;
        const holder = a.account_holder || a.name_on_account || a.customer_name;
        if (routing) update.chk_aba = String(routing).replace(/\D/g, "").slice(0, 9);
        if (account) update.chk_acct = String(account).replace(/\D/g, "").slice(0, 17);
        if (acctType) {
          const t = String(acctType).toUpperCase();
          update.acct_type = t.startsWith("S") ? "S" : "C";
        }
        if (bankName) update.authentecheck_bank_name = bankName;
        if (holder) update.custname = String(holder).slice(0, 100);
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
