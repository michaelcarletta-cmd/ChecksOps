import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function callActum(
  endpoint: string,
  params: URLSearchParams,
): Promise<Record<string, string>> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const text = await res.text();
  const parsed: Record<string, string> = {};
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const eq = line.indexOf("=");
    if (eq > -1) parsed[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return parsed;
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

    // Load batch + splits + accounts
    const { data: batch, error: batchErr } = await supabase
      .from("disbursement_batches")
      .select(`
        *,
        disbursement_splits (
          *,
          stakeholder_accounts (
            id, nickname, chk_aba, chk_acct, acct_type,
            custname, consumer_unique, account_type, is_primary
          )
        )
      `)
      .eq("id", batch_id)
      .single();

    if (batchErr) throw batchErr;
    if (!batch) throw new Error("Batch not found");
    if (batch.status !== "pending") throw new Error(`Batch is already ${batch.status}`);

    // Identify primary account for debit
    const primaryAccount = batch.disbursement_splits?.find(s => s.stakeholder_accounts?.is_primary)?.stakeholder_accounts;
    if (!primaryAccount) {
      throw new Error("No primary stakeholder account found to debit funds from.");
    }

    // Load tenant Actum credentials from tenants table
    const { data: settings, error: settingsErr } = await supabase
      .from("tenants")
      .select("actum_parent_id, actum_sub_id, actum_sub_id_ppd, actum_sub_id_ccd, actum_syspass, actum_username, actum_password")
      .eq("id", batch.tenant_id)
      .single();

    if (settingsErr || !settings?.actum_parent_id) {
      throw new Error("Actum credentials not configured for this tenant.");
    }

    // Authorization check: Verify active ACH authorization for the primary account
    const { data: authRecord, error: authErr } = await supabase
      .from("ach_authorizations")
      .select("*")
      .eq("stakeholder_account_id", primaryAccount.id)
      .eq("is_active", true)
      .limit(1)
      .single();

    if (authErr || !authRecord) {
      throw new Error("ACH debit authorization not found or inactive for the primary account. Please sign the authorization in Settings.");
    }

    // Step 1: Debit the primary account for the total batch amount
    console.log(`Initiating debit of $${batch.total_amount} from primary account ${primaryAccount.nickname}`);
    
    const debitSubId = primaryAccount.account_type === 'insured' 
      ? ((settings as any).actum_sub_id_ppd || settings.actum_sub_id || "")
      : ((settings as any).actum_sub_id_ccd || settings.actum_sub_id || "");

    const debitParams = new URLSearchParams({
      parent_id: settings.actum_parent_id,
      sub_id: debitSubId,
      pass_auth: (settings as any).actum_syspass || "", // Use actum_syspass as pass_auth if present
      action: "initiate",
      custname: primaryAccount.custname,
      chk_aba: primaryAccount.chk_aba,
      chk_acct: primaryAccount.chk_acct,
      acct_type: primaryAccount.acct_type,
      amount: batch.total_amount.toString(),
      trans_type: "7", // Standard ACH Debit
      trans_modifier: "S", // Same-day ACH
      merch_orderid: `DEBIT-${batch_id.slice(0, 8)}`,
      consumer_unique: primaryAccount.consumer_unique || `CUST-${primaryAccount.id.slice(0, 8)}`,
    });

    const debitResult = await callActum("https://rmapi.actumprocessing.com/cgi-bin/process.cgi", debitParams);
    
    // Log the debit transaction
    const { error: debitLogErr } = await supabase.from("actum_transactions").insert({
      tenant_id: batch.tenant_id,
      disbursement_batch_id: batch.id,
      stakeholder_account_id: primaryAccount.id,
      transaction_type: "debit",
      amount: batch.total_amount,
      actum_order_id: debitResult.orderid || "FAILED",
      status: debitResult.status === "Accepted" ? "accepted" : "declined",
      raw_response: JSON.stringify(debitResult),
    });

    if (debitLogErr) console.error("Failed to log debit transaction:", debitLogErr);

    if (debitResult.status !== "Accepted") {
      const errorMsg = debitResult.reason || "Debit declined by processor";
      await supabase.from("disbursement_batches").update({
        status: "failed",
        error_message: `Primary account debit failed: ${errorMsg}`,
      }).eq("id", batch_id);
      
      throw new Error(`Funding debit failed: ${errorMsg}`);
    }

    // Step 2: Proceed with credits to payees
    const results = [];
    const splits = batch.disbursement_splits || [];

    for (const split of splits) {
      const acct = split.stakeholder_accounts;
      if (!acct) continue;
      
      // Skip the primary account since it's the source of funds
      if (acct.is_primary) continue;

      const creditParams = new URLSearchParams({
        parent_id: settings.actum_parent_id,
        sub_id: settings.actum_sub_id || "",
        pass_auth: settings.actum_pass_auth || "",
        action: "initiate",
        custname: acct.custname,
        chk_aba: acct.chk_aba,
        chk_acct: acct.chk_acct,
        acct_type: acct.acct_type,
        amount: split.amount.toString(),
        trans_type: "7",
        creditflag: "1", // Credit transaction
        merch_orderid: `SPLIT-${split.id.slice(0, 8)}`,
        consumer_unique: acct.consumer_unique || `CUST-${acct.id.slice(0, 8)}`,
      });

      const actumRes = await callActum("https://rmapi.actumprocessing.com/cgi-bin/process.cgi", creditParams);
      
      // Update split status
      await supabase.from("disbursement_splits").update({
        actum_order_id: actumRes.orderid,
        status: actumRes.status === "Accepted" ? "processed" : "failed",
        error_message: actumRes.status === "Accepted" ? null : actumRes.reason,
      }).eq("id", split.id);

      // Log credit transaction
      await supabase.from("actum_transactions").insert({
        tenant_id: batch.tenant_id,
        disbursement_batch_id: batch.id,
        stakeholder_account_id: acct.id,
        transaction_type: "credit",
        amount: split.amount,
        actum_order_id: actumRes.orderid || "FAILED",
        status: actumRes.status === "Accepted" ? "accepted" : "declined",
        raw_response: JSON.stringify(actumRes),
      });

      results.push({ split_id: split.id, status: actumRes.status, orderid: actumRes.orderid });
    }

    // Update batch to completed
    await supabase.from("disbursement_batches").update({
      status: "completed",
      processed_at: new Date().toISOString(),
    }).eq("id", batch_id);

    return new Response(JSON.stringify({ success: true, results, debit_orderid: debitResult.orderid }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("Disbursement error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});