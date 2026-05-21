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
