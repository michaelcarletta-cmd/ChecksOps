import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const payload = await req.json();
    console.log("[actum-webhook] received:", JSON.stringify(payload));

    // Try to identify tenant from orderinfo (merordernumber)
    let tenantId: string | null = null;
    const orderInfo = payload.orderinfo || "";

    if (orderInfo.startsWith("split_")) {
      const splitId = orderInfo.replace("split_", "");
      const { data } = await supabase.from("disbursement_splits").select("tenant_id").eq("id", splitId).single();
      tenantId = data?.tenant_id;
    } else if (orderInfo.startsWith("payment_")) {
      const paymentId = orderInfo.replace("payment_", "");
      const { data } = await supabase.from("claim_check_payments").select("tenant_id").eq("id", paymentId).single();
      tenantId = data?.tenant_id;
    }

    // Validate signature
    const provided =
      req.headers.get("x-actum-signature") ||
      req.headers.get("x-webhook-secret") ||
      new URL(req.url).searchParams.get("secret");

    if (tenantId) {
      const { data: tenant } = await supabase.from("tenants").select("actum_webhook_secret").eq("id", tenantId).single();
      const expectedSecret = tenant?.actum_webhook_secret || Deno.env.get("ACTUM_WEBHOOK_SECRET");
      if (!expectedSecret || provided !== expectedSecret) {
        console.warn(`[actum-webhook] unauthorized for tenant ${tenantId}`);
        return new Response("unauthorized", { status: 401 });
      }
    } else {
      // Fallback to global secret if tenant not yet known
      const globalSecret = Deno.env.get("ACTUM_WEBHOOK_SECRET");
      if (!globalSecret || provided !== globalSecret) {
        console.warn("[actum-webhook] unauthorized (no tenant context)");
        return new Response("unauthorized", { status: 401 });
      }
    }

    // --- Origination webhook ---
    if (payload.originations) {
      for (const orig of payload.originations) {
        const { trans_id, clear_date, orderinfo } = orig;
        if (!trans_id) continue;

        await supabase
          .from("actum_transactions")
          .update({ status: "accepted", updated_at: new Date().toISOString() })
          .eq("actum_history_id", String(trans_id));

        // Update split to "submitted" with clear date in notes
        if (orderinfo?.startsWith("split_")) {
          const splitId = orderinfo.replace("split_", "");
          await supabase
            .from("disbursement_splits")
            .update({
              status: "submitted",
              submitted_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", splitId);
        }

        // Also update claim_check_payments
        if (orderinfo?.startsWith("payment_")) {
          await supabase
            .from("claim_check_payments")
            .update({ status: "submitted", submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq("id", orderinfo.replace("payment_", ""));
        }
      }
    }


    // --- Return webhook ---
    if (payload.trans_id && payload.return_desc) {
      const { trans_id, order_id, return_desc, orderinfo } = payload;

      await supabase
        .from("actum_transactions")
        .update({
          status: "returned",
          raw_response: payload,
          updated_at: new Date().toISOString(),
        })
        .eq("actum_history_id", String(trans_id));

      if (orderinfo?.startsWith("split_")) {
        const splitId = orderinfo.replace("split_", "");

        // Extract R-code from return_desc e.g. "R03 - No Account/Unable to Locate"
        const rCodeMatch = return_desc?.match(/^(R\d+)/);
        const returnCode = rCodeMatch?.[1] ?? null;

        await supabase
          .from("disbursement_splits")
          .update({
            status: "returned",
            returned_at: new Date().toISOString(),
            return_code: returnCode,
            return_desc: return_desc,
            updated_at: new Date().toISOString(),
          })
          .eq("id", splitId);

        // Check if whole batch is now in partial return state
        const { data: split } = await supabase
          .from("disbursement_splits")
          .select("batch_id")
          .eq("id", splitId)
          .single();

        if (split?.batch_id) {
          await supabase
            .from("disbursement_batches")
            .update({ status: "partially_returned", updated_at: new Date().toISOString() })
            .eq("id", split.batch_id);
        }
      }

      // Also check claim_check_payments
      if (orderinfo?.startsWith("payment_")) {
        const paymentId = orderinfo.replace("payment_", "");
        const rCode = return_desc?.match(/^(R\d+)/)?.[1] ?? null;
        await supabase
          .from("claim_check_payments")
          .update({
            status: "returned",
            returned_at: new Date().toISOString(),
            return_code: rCode,
            return_desc: return_desc,
            updated_at: new Date().toISOString(),
          })
          .eq("id", paymentId);
      }
    }


    // --- RTP reject webhook ---
    if (payload.trans_id && payload.return_desc?.includes("originating for ACH")) {
      // RTP cascaded to ACH — update transaction log
      await supabase
        .from("actum_transactions")
        .update({
          raw_response: { ...payload, note: "RTP failed, cascaded to ACH" },
          updated_at: new Date().toISOString(),
        })
        .eq("actum_history_id", String(payload.trans_id));
    }

    return new Response("*success*", { status: 200 });

  } catch (err: any) {
    console.error("[actum-webhook] error:", err);
    return new Response("error", { status: 500 });
  }
});
