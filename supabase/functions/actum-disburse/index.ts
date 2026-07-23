import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ACTUM_ENDPOINT = "https://join.actumprocessing.com/cgi-bin/dbs/man_trans.cgi";

async function callActum(params: URLSearchParams): Promise<Record<string, string>> {
  const res = await fetch(ACTUM_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const text = await res.text();
  console.log("[actum-disburse] Actum raw response:", text);
  const parsed: Record<string, string> = {};
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const eq = line.indexOf("=");
    if (eq > -1) parsed[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return parsed;
}

function isAccepted(r: Record<string, string>): boolean {
  return (r.status ?? "").toLowerCase() === "accepted";
}

function declineReason(r: Record<string, string>): string {
  const code = r.authcode ?? "unknown";
  const reason = r.reason ?? "declined";
  return `[${code}] ${reason}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { batch_id } = await req.json();
    if (!batch_id) throw new Error("batch_id is required");

    // Load batch
    const { data: batch, error: batchErr } = await supabase
      .from("disbursement_batches")
      .select("*")
      .eq("id", batch_id)
      .single();
    if (batchErr || !batch) throw new Error("Batch not found");
    if (batch.status !== "pending") throw new Error(`Batch is already ${batch.status}`);

    // Load splits with account info
    const { data: splits, error: splitsErr } = await supabase
      .from("disbursement_splits")
      .select(`*, stakeholder_accounts(id, custname, chk_aba, chk_acct, acct_type, consumer_unique, account_type, is_primary, verification_recipient_email, homeowner_email)`)
      .eq("batch_id", batch_id);
    if (splitsErr) throw splitsErr;

    // Load tenant Actum credentials
    const { data: tenant, error: tenantErr } = await supabase
      .from("tenants")
      .select("actum_parent_id, actum_sub_id_ppd, actum_sub_id_ccd, actum_syspass, actum_username, actum_password, email_reply_to, email_from_address")
      .eq("id", batch.tenant_id)
      .single();
    if (tenantErr || !tenant?.actum_parent_id) {
      throw new Error("Actum credentials not configured for this tenant.");
    }

    const parentId = tenant.actum_parent_id;
    const syspass = (tenant as any).actum_syspass ?? "";
    const username = (tenant as any).actum_username ?? "";
    const password = (tenant as any).actum_password ?? "";
    const deliverySpeed: string = batch.delivery_speed ?? "same_day"; // "same_day" | "instant"

    // Find primary account for the debit (source of funds)
    const { data: primaryAccount, error: primaryErr } = await supabase
      .from("stakeholder_accounts")
      .select("id, custname, chk_aba, chk_acct, acct_type, consumer_unique, account_type, verification_recipient_email, homeowner_email")
      .eq("tenant_id", batch.tenant_id)
      .eq("is_primary", true)
      .eq("is_active", true)
      .maybeSingle();
    if (primaryErr) throw primaryErr;
    if (!primaryAccount) throw new Error("No active primary stakeholder account found to debit funds from.");

    // Verify active ACH authorization for the primary account
    const { data: achAuth } = await supabase
      .from("ach_authorizations")
      .select("id")
      .eq("stakeholder_account_id", primaryAccount.id)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    if (!achAuth) {
      throw new Error("ACH debit authorization not found or inactive for the primary account. Please sign the authorization in Settings.");
    }

    // Fallback email if account has none
    const tenantFallbackEmail =
      (tenant as any).email_reply_to ||
      (tenant as any).email_from_address ||
      "notify@checksops.com";

    function emailFor(acct: any): string {
      return (
        acct?.verification_recipient_email ||
        acct?.homeowner_email ||
        tenantFallbackEmail
      );
    }

    function subIdFor(accountType: string): string {
      // Personal (PPD) = insured/homeowner. Everyone else (contractor, vendor, operating, sales rep, etc.) = Business (CCD).
      const isPersonal = accountType === "insured" || accountType === "homeowner";
      const sub = isPersonal
        ? (tenant as any).actum_sub_id_ppd
        : (tenant as any).actum_sub_id_ccd;
      if (!sub) {
        throw new Error(`Actum Sub ID for ${isPersonal ? "PPD (Personal)" : "CCD (Business)"} not configured for this tenant.`);
      }
      return sub;
    }

    function baseParams(acct: { custname: string; chk_aba: string; chk_acct: string; acct_type: string; account_type: string; verification_recipient_email?: string | null; homeowner_email?: string | null }): URLSearchParams {
      const p = new URLSearchParams();
      p.append("parent_id", parentId);
      p.append("sub_id", subIdFor(acct.account_type));
      p.append("pmt_type", "chk");
      if (syspass) p.append("syspass", syspass);
      if (username) p.append("username", username);
      if (password) p.append("password", password);
      p.append("custname", acct.custname);
      p.append("email", emailFor(acct));
      p.append("chk_acct", acct.chk_acct);
      p.append("chk_aba", acct.chk_aba);
      p.append("acct_type", acct.acct_type || "C");
      p.append("billing_cycle", "-1");
      p.append("currency", "US");
      return p;
    }

    // ── Step 1: Debit the primary account ───────────────────────────────────
    // Debit exactly the total being distributed in this batch (may be a partial disbursement)
    const batchTotal = (splits ?? []).reduce((sum, s) => sum + Number(s.amount), 0);
    if (batchTotal <= 0) throw new Error("Batch has no valid split amounts.");
    console.log(`[actum-disburse] Debiting $${batchTotal.toFixed(2)} from primary account (${primaryAccount.custname}), delivery=${deliverySpeed}`);

    const debitIdempotence = `debit_${batch_id.slice(0, 16)}_${Date.now()}`;
    const debitParams = baseParams({ ...primaryAccount, account_type: primaryAccount.account_type ?? "operating" });
    debitParams.append("initial_amount", batchTotal.toFixed(2));
    debitParams.append("merordernumber", `DEBIT-${batch_id.slice(0, 8)}`);
    debitParams.append("idempotence", debitIdempotence);
    // Debit is always same-day so funds are available immediately for credits
    debitParams.append("trans_modifier", "S");

    const debitRes = await callActum(debitParams);

    // Log the debit
    await supabase.from("actum_transactions").insert({
      tenant_id: batch.tenant_id,
      batch_id: batch.id,
      transaction_type: "debit",
      amount: batchTotal,
      actum_order_id: debitRes.order_id ?? null,
      actum_history_id: debitRes.history_id ?? null,
      consumer_unique: debitRes.consumer_unique ?? null,
      mer_order_number: `DEBIT-${batch_id.slice(0, 8)}`,
      idempotence_key: debitIdempotence,
      status: isAccepted(debitRes) ? "accepted" : "declined",
      raw_response: JSON.stringify(debitRes),
    });

    if (!isAccepted(debitRes)) {
      await supabase.from("disbursement_batches").update({ status: "failed" }).eq("id", batch_id);
      throw new Error(`Primary account debit failed: ${declineReason(debitRes)}`);
    }

    // Store debit order/history IDs on the batch
    await supabase.from("disbursement_batches").update({
      debit_account_id: primaryAccount.id,
      debit_actum_order_id: debitRes.order_id ?? null,
      debit_actum_history_id: debitRes.history_id ?? null,
      debit_status: "accepted",
      submitted_at: new Date().toISOString(),
    }).eq("id", batch_id);

    // ── Step 2: Credit each split ────────────────────────────────────────────
    const results: Array<{ split_id: string; status: string; order_id?: string; error?: string }> = [];

    for (const split of (splits ?? [])) {
      const acct = (split as any).stakeholder_accounts;
      if (!acct) {
        console.warn(`[actum-disburse] split ${split.id} has no account — skipping`);
        continue;
      }

      const splitIdempotence = split.idempotence_key ?? `credit_${split.id.slice(0, 16)}_${Date.now()}`;
      const merOrder = `SPLIT-${split.id.slice(0, 8)}`;

      const creditParams = baseParams({ ...acct, account_type: acct.account_type ?? "operating" });
      creditParams.append("initial_amount", Number(split.amount).toFixed(2));
      creditParams.append("action_code", "P");
      creditParams.append("creditflag", "1");
      creditParams.append("merordernumber", merOrder);
      creditParams.append("idempotence", splitIdempotence);

      if (deliverySpeed === "instant") {
        // Real-Time Payment (RTP) — funds arrive immediately
        creditParams.append("realtime", "1");
      } else {
        // Same-Day ACH credit
        creditParams.append("trans_modifier", "S");
      }

      console.log(`[actum-disburse] Crediting $${split.amount} to ${acct.custname} (split ${split.id}), mode=${deliverySpeed}`);
      const creditRes = await callActum(creditParams);
      const accepted = isAccepted(creditRes);

      // Update the split record
      await supabase.from("disbursement_splits").update({
        actum_order_id: creditRes.order_id ?? null,
        actum_history_id: creditRes.history_id ?? null,
        actum_consumer_unique: creditRes.consumer_unique ?? null,
        status: accepted ? "submitted" : "failed",
        submitted_at: accepted ? new Date().toISOString() : null,
        return_desc: accepted ? null : declineReason(creditRes),
      }).eq("id", split.id);

      // Log the credit
      await supabase.from("actum_transactions").insert({
        tenant_id: batch.tenant_id,
        batch_id: batch.id,
        split_id: split.id,
        transaction_type: "credit",
        amount: split.amount,
        actum_order_id: creditRes.order_id ?? null,
        actum_history_id: creditRes.history_id ?? null,
        consumer_unique: creditRes.consumer_unique ?? null,
        mer_order_number: merOrder,
        idempotence_key: splitIdempotence,
        status: accepted ? "accepted" : "declined",
        raw_response: JSON.stringify(creditRes),
      });

      results.push({
        split_id: split.id,
        status: accepted ? "submitted" : "failed",
        order_id: creditRes.order_id,
        ...(accepted ? {} : { error: declineReason(creditRes) }),
      });

      if (!accepted) {
        console.error(`[actum-disburse] credit failed for split ${split.id}: ${declineReason(creditRes)}`);
      }
    }

    const allSucceeded = results.every((r) => r.status === "submitted");
    const anySucceeded = results.some((r) => r.status === "submitted");

    await supabase.from("disbursement_batches").update({
      status: allSucceeded ? "completed" : anySucceeded ? "partial" : "failed",
      completed_at: new Date().toISOString(),
    }).eq("id", batch_id);

    return new Response(
      JSON.stringify({ success: true, delivery_speed: deliverySpeed, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (error: any) {
    console.error("[actum-disburse] error:", error.message);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
