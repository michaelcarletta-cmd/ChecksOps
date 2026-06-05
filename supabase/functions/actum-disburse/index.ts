import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // Require admin auth
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

    const { batch_id } = await req.json();
    if (!batch_id) throw new Error("batch_id is required");

    // Load the batch and all its splits with account details
    const { data: batch, error: batchErr } = await supabase
      .from("disbursement_batches")
      .select(`
        *,
        disbursement_splits (
          *,
          stakeholder_accounts (
            id, nickname, chk_aba, chk_acct, acct_type,
            custname, consumer_unique, account_type
          )
        )
      `)
      .eq("id", batch_id)
      .single();

    if (batchErr) throw batchErr;
    if (!batch) throw new Error("Batch not found");
    if (batch.status !== "pending") throw new Error(`Batch is already ${batch.status}`);

    // Get tenant's Actum credentials
    const { data: tenantData, error: tenantErr } = await supabase
      .from("tenants")
      .select("actum_parent_id, actum_sub_id")
      .eq("id", batch.tenant_id)
      .single();

    if (tenantErr) throw new Error(`Could not load tenant Actum config: ${tenantErr.message}`);

    const actumParentId = tenantData?.actum_parent_id || Deno.env.get("ACTUM_PARENT_ID");
    const actumSubId = tenantData?.actum_sub_id || Deno.env.get("ACTUM_SUB_ID");
    const actumEndpoint = "https://join.actumprocessing.com/cgi-bin/dbs/man_trans.cgi";

    if (!actumParentId || !actumSubId) {
      throw new Error("Actum API credentials (Parent ID / Sub ID) not configured for this tenant.");
    }

    const results: Array<{
      split_id: string;
      status: "accepted" | "declined";
      actum_order_id?: string;
      actum_history_id?: string;
      consumer_unique?: string;
      error?: string;
    }> = [];

    // Mark batch as submitted
    await supabase
      .from("disbursement_batches")
      .update({ status: "submitted", submitted_at: new Date().toISOString() })
      .eq("id", batch_id);

    // Send each split as a separate Actum credit
    for (const split of batch.disbursement_splits) {
      const account = split.stakeholder_accounts;
      if (!account) {
        results.push({ split_id: split.id, status: "declined", error: "Account not found" });
        continue;
      }

      // Build idempotence key so retries are safe
      const idempotenceKey = split.idempotence_key ?? `split_${split.id}_${Date.now()}`;

      // Use consumer_unique for repeat accounts (skips re-sending bank details)
      const params = new URLSearchParams();
      if (account.consumer_unique) {
        params.append("parent_id", actumParentId!);
        params.append("sub_id", actumSubId!);
        params.append("consumer_code", account.consumer_unique);
        params.append("initial_amount", split.amount.toFixed(2));
        params.append("billing_cycle", "-1");
        params.append("pmt_type", "chk");
      } else {
        params.append("parent_id", actumParentId!);
        params.append("sub_id", actumSubId!);
        params.append("pmt_type", "chk");
        params.append("custname", account.custname);
        params.append("chk_acct", account.chk_acct);
        params.append("chk_aba", account.chk_aba);
        params.append("acct_type", account.acct_type);
        params.append("initial_amount", split.amount.toFixed(2));
        params.append("billing_cycle", "-1");
        params.append("action_code", "P");
        params.append("creditflag", "1");
        params.append("currency", "US");
        // Store claim/check reference in addenda for bank statement
        params.append("merordernumber", `split_${split.id}`);
        params.append("postback", "1");
        params.append("idempotence", idempotenceKey);
      }

      let actumStatus: "accepted" | "declined" = "declined";
      let orderId: string | undefined;
      let historyId: string | undefined;
      let consumerUnique: string | undefined;
      let errorMsg: string | undefined;

      try {
        const actumRes = await fetch(actumEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        });

        const responseText = await actumRes.text();
        const lines = responseText.split("\n").map((l) => l.trim()).filter(Boolean);
        const parsed: Record<string, string> = {};
        for (const line of lines) {
          const eq = line.indexOf("=");
          if (eq > -1) parsed[line.slice(0, eq)] = line.slice(eq + 1);
        }

        actumStatus = (parsed.status ?? "").toLowerCase() === "accepted" ? "accepted" : "declined";
        orderId = parsed.order_id;
        historyId = parsed.history_id;
        consumerUnique = parsed.consumer_unique;
        if (actumStatus === "declined") errorMsg = parsed.reason ?? parsed.authcode ?? "Declined by Actum";

        // Save consumer_unique for future repeat transactions
        if (consumerUnique && !account.consumer_unique) {
          await supabase
            .from("stakeholder_accounts")
            .update({ consumer_unique: consumerUnique })
            .eq("id", account.id);
        }

        // Log to actum_transactions
        await supabase.from("actum_transactions").insert({
          tenant_id: batch.tenant_id,
          split_id: split.id,
          batch_id: batch.id,
          actum_order_id: orderId,
          actum_history_id: historyId,
          consumer_unique: consumerUnique,
          mer_order_number: `split_${split.id}`,
          transaction_type: "credit",
          amount: split.amount,
          status: actumStatus,
          raw_response: parsed,
          idempotence_key: idempotenceKey,
        });

        // Update split status
        await supabase
          .from("disbursement_splits")
          .update({
            status: actumStatus === "accepted" ? "submitted" : "failed",
            actum_order_id: orderId,
            actum_history_id: historyId,
            actum_consumer_unique: consumerUnique,
            submitted_at: new Date().toISOString(),
            idempotence_key: idempotenceKey,
          })
          .eq("id", split.id);

      } catch (fetchErr: any) {
        errorMsg = fetchErr.message;
        await supabase
          .from("disbursement_splits")
          .update({ status: "failed" })
          .eq("id", split.id);
      }

      results.push({ split_id: split.id, status: actumStatus, actum_order_id: orderId, actum_history_id: historyId, consumer_unique: consumerUnique, error: errorMsg });
    }

    // Update batch status based on results
    const allAccepted = results.every((r) => r.status === "accepted");
    const anyAccepted = results.some((r) => r.status === "accepted");
    const batchFinalStatus = allAccepted ? "completed" : anyAccepted ? "partially_returned" : "failed";

    await supabase
      .from("disbursement_batches")
      .update({
        status: batchFinalStatus,
        completed_at: allAccepted ? new Date().toISOString() : null,
      })
      .eq("id", batch_id);

    return new Response(
      JSON.stringify({ success: true, batch_id, status: batchFinalStatus, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );

  } catch (err: any) {
    console.error("[actum-disburse]", err);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
