// Polling fallback — reconciles any stale checkalt_deposits whose status is
// 'submitted' or 'pending_approval' and haven't been polled in >15 minutes.
// Safe to call from cron or manually from the admin UI.

import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import { getServiceClient, checkAltFetch } from "../_shared/checkalt.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = getServiceClient();
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
        const resp = await checkAltFetch(supabase, `/fincapture/deposits/${dep.checkalt_reference}`, {
          method: "GET",
        });
        const json = await resp.json().catch(() => ({}));
        const rawStatus = String(json?.status ?? "").toLowerCase();
        const statusMap: Record<string, string> = {
          submitted: "submitted",
          pending: "submitted",
          pending_approval: "pending_approval",
          approved: "cleared", cleared: "cleared", settled: "cleared",
          returned: "returned", rejected: "rejected", declined: "rejected",
        };
        const internal = statusMap[rawStatus] ?? dep.status;

        const updates: Record<string, unknown> = {
          last_polled_at: new Date().toISOString(),
          last_status_payload: json,
        };
        if (internal !== dep.status) {
          updates.status = internal;
          if (internal === "cleared") updates.cleared_at = new Date().toISOString();
          if (internal === "returned") updates.returned_at = new Date().toISOString();
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
