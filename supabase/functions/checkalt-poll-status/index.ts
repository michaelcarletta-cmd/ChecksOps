// Polling fallback — reconciles stale checkalt_deposits using FinCapture's
// /fincapture/deposit/history endpoint. Maps numeric status codes to internal
// statuses. Safe to call from cron or manually.
//
// FinCapture status codes:
//   127 = Submitted, 40 = Pending/Manual review, 120 = Rejected, 11 = Unknown/Error
//   (cleared/settled = success codes returned by API)

import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import { getServiceClient, checkAltFetch, getCheckAltFiKey, loadConfig } from "../_shared/checkalt.ts";

function mapStatus(code: number, current: string): string {
  switch (code) {
    case 127: return "submitted";
    case 40:  return "pending_approval";
    case 120: return "rejected";
    case 11:  return "error";
    // Treat any other terminal/success code as cleared
    default:  return code >= 200 ? "cleared" : current;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = getServiceClient();
    const cfg = await loadConfig(supabase);
    const fiKey = getCheckAltFiKey();
    const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();

    const { data: stale, error } = await supabase
      .from("checkalt_deposits")
      .select("id, checkalt_reference, status, check_intake_item_id")
      .in("status", ["submitted", "pending_approval"])
      .or(`last_polled_at.is.null,last_polled_at.lt.${cutoff}`)
      .not("checkalt_reference", "is", null)
      .limit(50);
    if (error) throw error;

    let polled = 0, updated = 0, errors = 0;

    for (const dep of stale ?? []) {
      polled++;
      try {
        const resp = await checkAltFetch(supabase, "/fincapture/deposit/history", {
          method: "POST",
          body: JSON.stringify({
            fiKey,
            ssoKey: cfg.business_unit || cfg.depositor_account_id,
            depositAccountNumber: cfg.depositor_account_id,
            referenceId: dep.checkalt_reference,
          }),
        });
        const json = await resp.json().catch(() => ({}));
        const items: any[] = Array.isArray(json?.items) ? json.items
          : Array.isArray(json?.deposits) ? json.deposits
          : Array.isArray(json) ? json : [];
        const match = items.find((it) =>
          it?.referenceId === dep.checkalt_reference ||
          it?.reference === dep.checkalt_reference ||
          it?.id === dep.checkalt_reference,
        ) ?? items[0] ?? json;

        const code = Number(match?.status ?? match?.statusCode ?? 0);
        const internal = mapStatus(code, dep.status);

        const updates: Record<string, unknown> = {
          last_polled_at: new Date().toISOString(),
          last_status_payload: json,
        };
        if (internal !== dep.status) {
          updates.status = internal;
          if (internal === "cleared") updates.cleared_at = new Date().toISOString();
          if (internal === "rejected") updates.returned_at = new Date().toISOString();
          updated++;
        }
        await supabase.from("checkalt_deposits").update(updates).eq("id", dep.id);
      } catch (e) {
        errors++;
        console.error("[checkalt-poll-status]", dep.checkalt_reference, e instanceof Error ? e.message : e);
      }
    }

    return new Response(JSON.stringify({ polled, updated, errors }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
