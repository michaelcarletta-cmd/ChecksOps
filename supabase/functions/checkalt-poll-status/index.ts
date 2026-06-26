// Polling fallback — reconciles stale checkalt_deposits using FinCapture's
// /fincapture/deposit/history endpoint. Maps numeric status codes to internal
// statuses. Safe to call from cron or manually.
//
// FinCapture status codes:
//   127 = Submitted, 40 = Pending/Manual review, 120 = Rejected, 11 = Unknown/Error
//   (cleared/settled = success codes returned by API)

import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import {
  getServiceClient,
  checkAltFetch,
  getCheckAltFiKey,
  loadTenantAccount,
  syncDepositItem,
  mapDepositStatus,
} from "../_shared/checkalt.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = getServiceClient();
    const fiKey = getCheckAltFiKey();
    const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();

    const { data: stale, error } = await supabase
      .from("checkalt_deposits")
      .select("id, tenant_id, checkalt_reference, status, check_intake_item_id, submitted_by")
      .in("status", ["submitted", "pending_approval"])
      .or(`last_polled_at.is.null,last_polled_at.lt.${cutoff}`)
      .not("checkalt_reference", "is", null)
      .limit(50);
    if (error) throw error;

    let polled = 0, updated = 0, errors = 0;

    for (const dep of stale ?? []) {
      polled++;
      try {
        const tenantAccount = await loadTenantAccount(supabase, dep.tenant_id);
        const resp = await checkAltFetch(supabase, "/fincapture/deposit/history", {
          method: "POST",
          body: JSON.stringify({
            fiKey,
            ssoKey: tenantAccount.sso_user_id,
            depositAccountNumber: tenantAccount.deposit_account_number,
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
        const internal = mapDepositStatus(code, dep.status);

        const updates: Record<string, unknown> = {
          last_polled_at: new Date().toISOString(),
          last_status_payload: json,
        };
        if (internal !== dep.status) {
          updates.status = internal;
          if (internal === "cleared") updates.cleared_at = new Date().toISOString();
          if (internal === "rejected") updates.returned_at = new Date().toISOString();
          updated++;

          if ((internal === "cleared" || internal === "rejected" || internal === "error") && dep.check_intake_item_id && dep.submitted_by) {
            const { data: depositItem } = await supabase
              .from("deposit_items")
              .select("id, provider")
              .eq("check_id", dep.check_intake_item_id)
              .maybeSingle();
            if (depositItem && depositItem.provider === "checkalt") {
              await syncDepositItem(supabase, {
                action: internal === "cleared" ? "record_success" : "record_failure",
                deposit_item_id: depositItem.id,
                actor_id: dep.submitted_by,
                extra: internal === "cleared"
                  ? { response: json }
                  : { error: internal, error_code: String(code), response: json },
              });
            }
          }
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
