import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await authClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: roles } = await supabase.from("user_roles").select("role").eq("user_id", userData.user.id);
    if (!roles?.some((r: any) => r.role === "admin")) {
      return new Response(JSON.stringify({ error: "Forbidden: admin role required" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json();
    const { payment_id, admin_override } = body ?? {};
    if (!payment_id) throw new Error("payment_id is required");

    // Load the payment with recipient account details
    const { data: payment, error: payErr } = await supabase
      .from("claim_check_payments")
      .select(`
        *,
        stakeholder_accounts:recipient_stakeholder_account_id (
          id, chk_aba, chk_acct, acct_type, account_type, custname, consumer_unique, nickname, verification_status
        )
      `)
      .eq("id", payment_id)
      .single();

    if (payErr) throw payErr;
    if (!payment) throw new Error("Payment not found");
    if (payment.status !== "pending") throw new Error(`Payment already ${payment.status}`);

    const account = payment.stakeholder_accounts;
    if (!account) throw new Error("Recipient account not found");

    // Verification gate
    if (!admin_override && account.verification_status !== "verified" && account.verification_status !== "admin_override") {
      throw new Error(
        `Bank account "${account.nickname}" hasn't been verified yet (status: ${account.verification_status}). ` +
        `Have the recipient confirm the micro-deposits before sending, or use the admin override.`
      );
    }
    if (admin_override && account.verification_status !== "verified") {
      await supabase.from("stakeholder_account_verification_log").insert({
        stakeholder_account_id: account.id,
        tenant_id: payment.tenant_id,
        event_type: "admin_override",
        actor_user_id: userData.user.id,
        details: { payment_id, amount: payment.payment_amount },
      });
    }


    // Get tenant's Actum credentials
    const { data: tenantData, error: tenantErr } = await supabase
      .from("tenants")
      .select("actum_parent_id, actum_sub_id, actum_sub_id_ppd, actum_sub_id_ccd, actum_syspass, actum_username, actum_password")
      .eq("id", payment.tenant_id)
      .single();

    if (tenantErr) throw new Error(`Could not load tenant Actum config: ${tenantErr.message}`);

    const actumParentId = tenantData?.actum_parent_id || Deno.env.get("ACTUM_PARENT_ID");
    let actumSubId = tenantData?.actum_sub_id || Deno.env.get("ACTUM_SUB_ID");
    
    // Choose specific Sub ID if configured
    if (account.account_type === 'insured' && tenantData?.actum_sub_id_ppd) {
      actumSubId = tenantData.actum_sub_id_ppd;
    } else if (account.account_type !== 'insured' && tenantData?.actum_sub_id_ccd) {
      actumSubId = tenantData.actum_sub_id_ccd;
    }

    const actumEndpoint = "https://join.actumprocessing.com/cgi-bin/dbs/man_trans.cgi";

    if (!actumParentId || !actumSubId) {
      throw new Error(`Actum API credentials (Parent ID / Sub ID) not configured for this tenant. (Using ${account.account_type} type)`);
    }

    const syspass = (tenantData as any)?.actum_syspass;
    const apiUser = (tenantData as any)?.actum_username;
    const apiPass = (tenantData as any)?.actum_password;

    const idempotenceKey = payment.idempotence_key ?? `pay_${payment_id}_${Date.now()}`;

    const params = new URLSearchParams();
    params.append("parent_id", actumParentId!);
    params.append("sub_id", actumSubId!);
    if (syspass) params.append("syspass", syspass);
    if (apiUser) params.append("username", apiUser);
    if (apiPass) params.append("password", apiPass);

    if (account.consumer_unique) {
      // Repeat consumer — skip bank details
      params.append("consumer_code", account.consumer_unique);
      params.append("initial_amount", Number(payment.payment_amount).toFixed(2));
      params.append("billing_cycle", "-1");
      params.append("pmt_type", "chk");
    } else {
      params.append("pmt_type", "chk");
      params.append("custname", account.custname);
      params.append("chk_acct", account.chk_acct);
      params.append("chk_aba", account.chk_aba);
      params.append("acct_type", account.acct_type);
      params.append("initial_amount", Number(payment.payment_amount).toFixed(2));
      params.append("billing_cycle", "-1");
      params.append("action_code", "P");
      params.append("creditflag", "1");
      params.append("currency", "US");
      params.append("merordernumber", `payment_${payment_id}`);
      params.append("postback", "1");
      params.append("idempotence", idempotenceKey);
    }

    const actumRes = await fetch(actumEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const responseText = await actumRes.text();
    const parsed: Record<string, string> = {};
    for (const line of responseText.split("\n").map(l => l.trim()).filter(Boolean)) {
      const eq = line.indexOf("=");
      if (eq > -1) parsed[line.slice(0, eq)] = line.slice(eq + 1);
    }

    const accepted = (parsed.status ?? "").toLowerCase() === "accepted";
    const orderId = parsed.order_id;
    const historyId = parsed.history_id;
    const consumerUnique = parsed.consumer_unique;

    // Save consumer_unique for future payments
    if (consumerUnique && !account.consumer_unique) {
      await supabase
        .from("stakeholder_accounts")
        .update({ consumer_unique: consumerUnique })
        .eq("id", account.id);
    }

    // Log to actum_transactions
    await supabase.from("actum_transactions").insert({
      tenant_id: payment.tenant_id,
      batch_id: null,
      actum_order_id: orderId,
      actum_history_id: historyId,
      consumer_unique: consumer_unique,
      mer_order_number: `payment_${payment_id}`,
      transaction_type: "credit",
      amount: payment.payment_amount,
      status: accepted ? "accepted" : "declined",
      auth_code: parsed.authcode,
      response_reason: parsed.reason,
      raw_response: parsed,
      idempotence_key: idempotenceKey,
    });

    // Update payment record
    await supabase
      .from("claim_check_payments")
      .update({
        status: accepted ? "submitted" : "failed",
        actum_order_id: orderId ?? null,
        actum_history_id: historyId ?? null,
        actum_consumer_unique: consumerUnique ?? null,
        submitted_at: accepted ? new Date().toISOString() : null,
        idempotence_key: idempotenceKey,
      })
      .eq("id", payment_id);

    if (!accepted) {
      throw new Error(parsed.reason ?? parsed.authcode ?? "Actum declined the payment");
    }

    return new Response(
      JSON.stringify({ success: true, payment_id, actum_order_id: orderId, status: "submitted" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (err: any) {
    console.error("[actum-send-payment]", err);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});