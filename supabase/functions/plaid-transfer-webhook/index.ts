import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callPlaid } from "../_shared/plaidClient.ts";

// Plaid Transfer webhook receiver + event syncer.
//
// Plaid's TRANSFER_EVENTS_UPDATE webhook carries no payload details on purpose —
// it just says "there are new events". We then pull everything since our stored
// cursor with /transfer/event/sync, which makes the flow replay-safe and
// gap-free even if a webhook delivery is missed. This endpoint can also be
// called manually (no body) to force a reconciliation sweep.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const CURSOR_ID = "transfer_events";

/** Terminal-failure event types — the money did not land. */
const FAILED_EVENTS = new Set(["failed", "returned", "cancelled"]);
/** The money is confirmed out the door. */
const SETTLED_EVENTS = new Set(["settled", "posted"]);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // Body is optional — a manual sweep can post nothing at all.
    let webhookCode = "MANUAL_SYNC";
    try {
      const body = await req.json();
      webhookCode = body?.webhook_code ?? webhookCode;
    } catch { /* no body */ }

    console.log("[plaid-transfer-webhook] received", webhookCode);

    const { data: cursorRow } = await supabase
      .from("plaid_webhook_cursors")
      .select("cursor_value")
      .eq("id", CURSOR_ID)
      .maybeSingle();

    let afterId = Number(cursorRow?.cursor_value ?? 0);
    let processed = 0;

    // Page through until Plaid stops returning events.
    for (let page = 0; page < 20; page++) {
      const res = await callPlaid<any>("/transfer/event/sync", {
        after_id: afterId,
        count: 25,
      });
      const events: any[] = res?.transfer_events ?? [];
      if (!events.length) break;

      for (const evt of events) {
        afterId = Math.max(afterId, Number(evt.event_id));
        const transferId = evt.transfer_id;
        if (!transferId) continue;

        const { data: split } = await supabase
          .from("disbursement_splits")
          .select("id, tenant_id, amount, status")
          .eq("plaid_transfer_id", transferId)
          .maybeSingle();

        await supabase.from("plaid_transfer_events").upsert(
          {
            tenant_id: split?.tenant_id ?? null,
            split_id: split?.id ?? null,
            plaid_event_id: Number(evt.event_id),
            plaid_transfer_id: transferId,
            event_type: evt.event_type ?? null,
            transfer_status: evt.event_type ?? null,
            sweep_status: evt.sweep_id ? "swept" : null,
            failure_reason:
              evt.failure_reason?.description ?? evt.failure_reason?.ach_return_code ?? null,
            amount: evt.transfer_amount ? Number(evt.transfer_amount) : split?.amount ?? null,
            raw_payload: evt,
          },
          { onConflict: "plaid_event_id", ignoreDuplicates: true },
        );

        if (!split) continue;

        const type = String(evt.event_type ?? "").toLowerCase();
        const update: Record<string, unknown> = { plaid_transfer_status: type };

        if (FAILED_EVENTS.has(type)) {
          const reason =
            evt.failure_reason?.description ??
            evt.failure_reason?.ach_return_code ??
            `Transfer ${type}`;
          update.status = "failed";
          update.returned_at = new Date().toISOString();
          update.return_code = evt.failure_reason?.ach_return_code ?? null;
          update.return_desc = String(reason).slice(0, 300);
          update.plaid_failure_reason = String(reason).slice(0, 300);
        } else if (SETTLED_EVENTS.has(type)) {
          update.status = "settled";
          update.settled_at = new Date().toISOString();
        }

        await supabase.from("disbursement_splits").update(update).eq("id", split.id);
        processed++;
      }

      if (events.length < 25) break;
    }

    await supabase
      .from("plaid_webhook_cursors")
      .upsert({ id: CURSOR_ID, cursor_value: afterId }, { onConflict: "id" });

    return json({ success: true, processed, cursor: afterId });
  } catch (err: any) {
    console.error("[plaid-transfer-webhook]", err);
    // Non-2xx so Plaid retries the notification.
    return json({ success: false, error: err.message }, 500);
  }
});
