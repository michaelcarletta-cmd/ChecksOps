// Polling fallback — reconciles any stale checkalt_deposits whose status is
// 'submitted' or 'pending_approval' and haven't been polled in >15 minutes.
// Safe to call from cron or manually from the admin UI.
//
// Uses POST /fincapture/deposit/item with body { fiKey, referenceNumber }
// per the Clearingworks FinCapture API spec (not a GET endpoint).
//
// /fincapture/deposit/item does not reliably return a status/statusCode for
// every reference (confirmed in production — a deposit CheckAlt had already
// approved came back with ruleDetails only, no status field at all). When
// that happens we fall back to POST /fincapture/deposit/history, which has
// been confirmed to carry a resolvable status for the same reference.

import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2/cors";
import { getServiceClient, loadConfig, checkAltFetch, loadTenantAccount } from "../_shared/checkalt.ts";

const NUMERIC_STATUS_MAP: Record<number, string> = {
  40: "pending_approval",
  120: "rejected",
  127: "submitted",
  200: "cleared",
};
const STRING_STATUS_MAP: Record<string, string> = {
  submitted: "submitted",
  pending: "submitted",
  pending_approval: "pending_approval",
  approved: "cleared",
  cleared: "cleared",
  settled: "cleared",
  returned: "returned",
  rejected: "rejected",
  declined: "rejected",
};

function resolveStatus(json: any): string | undefined {
  const rawStatus = String(json?.status ?? "").toLowerCase();
  const numericStatus = Number(json?.statusCode ?? json?.status);
  return NUMERIC_STATUS_MAP[numericStatus] ?? STRING_STATUS_MAP[rawStatus];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = getServiceClient();
    const cfg = await loadConfig(supabase);

    if (!cfg.fi_key) {
      return new Response(
        JSON.stringify({ error: "checkalt_config.fi_key not set" }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();

    const { data: stale, error } = await supabase
      .from("checkalt_deposits")
      .select("id, tenant_id, checkalt_reference, status, check_intake_item_id")
      .in("status", ["submitted", "pending_approval"])
      .or(`last_polled_at.is.null,last_polled_at.lt.${cutoff}`)
      .not("checkalt_reference", "is", null)
      .limit(50);
    if (error) throw error;

    let polled = 0,
      updated = 0,
      errors = 0;

    for (const dep of stale ?? []) {
      polled++;
      try {
        // POST /fincapture/deposit/item with { fiKey, referenceNumber }
        // referenceNumber is stored as string but API expects int64
        const refNum = Number(dep.checkalt_reference);

        const resp = await checkAltFetch(
          supabase,
          "/fincapture/deposit/item",
          {
            method: "POST",
            body: JSON.stringify({
              fiKey: cfg.fi_key,
              referenceNumber: isNaN(refNum) ? dep.checkalt_reference : refNum,
            }),
          },
        );
        const json = await resp.json().catch(() => ({}));

        // Response schema: FinCaptureAPIDepositItemResponse. CheckAlt
        // returns numeric statusCode AND/OR string status depending on
        // endpoint version — but not always either (see file header).
        let resolved = resolveStatus(json);
        let statusPayload = json;

        // Fall back to /fincapture/deposit/history, which has been confirmed
        // to carry a resolvable status even when /deposit/item doesn't.
        if (resolved === undefined) {
          try {
            const tenant = await loadTenantAccount(supabase, dep.tenant_id);
            const today = new Date();
            const startDate = new Date(today.getTime() - 30 * 86_400_000)
              .toISOString().slice(0, 10);
            const endDate = today.toISOString().slice(0, 10);
            const histResp = await checkAltFetch(supabase, "/fincapture/deposit/history", {
              method: "POST",
              body: JSON.stringify({
                fiKey: cfg.fi_key,
                ssoKey: tenant.sso_user_id,
                accountNumber: tenant.deposit_account_number,
                startDate,
                endDate,
              }),
            });
            const histJson = await histResp.json().catch(() => ({}));
            const items: any[] =
              histJson?.depositHistoryList ??
              histJson?.depositList ??
              histJson?.history ??
              (Array.isArray(histJson) ? histJson : []);
            const match = items.find(
              (it) => String(it?.referenceNumber) === String(dep.checkalt_reference),
            );
            if (match) {
              const histResolved = resolveStatus(match);
              if (histResolved !== undefined) {
                resolved = histResolved;
                statusPayload = { ...json, historyFallback: match };
              }
            }
          } catch (e) {
            console.error(
              "[checkalt-poll-status] history fallback failed for",
              dep.checkalt_reference,
              e instanceof Error ? e.message : e,
            );
          }
        }

        const internal = resolved ?? dep.status;

        // Still nothing usable from either endpoint — record that so it's
        // visible instead of looking like a confirmed no-change poll.
        const statusUnresolved = resolved === undefined;
        if (statusUnresolved) {
          console.warn(
            "[checkalt-poll-status] could not resolve status for",
            dep.checkalt_reference,
            "- response had status:", json?.status, "statusCode:", json?.statusCode,
          );
        }

        const updates: Record<string, unknown> = {
          last_polled_at: new Date().toISOString(),
          last_status_payload: statusPayload,
          status_unresolved: statusUnresolved,
        };
        if (internal !== dep.status) {
          updates.status = internal;
          if (internal === "cleared")
            updates.cleared_at = new Date().toISOString();
          if (internal === "returned")
            updates.returned_at = new Date().toISOString();
          updated++;
        }
        await supabase
          .from("checkalt_deposits")
          .update(updates)
          .eq("id", dep.id);

        if (dep.check_intake_item_id) {
          if (internal === "pending_approval") {
            await supabase
              .from("check_intake_items")
              .update({
                check_stage: "deposited",
                status: "approved_for_deposit",
                deposit_recommendation: null,
                updated_at: new Date().toISOString(),
              })
              .eq("id", dep.check_intake_item_id);
            await supabase
              .from("claim_checks")
              .update({ deposit_status: "deposited" })
              .eq("check_intake_item_id", dep.check_intake_item_id);
          } else if (internal === "submitted" || internal === "cleared") {
            const depositedAt = new Date().toISOString();
            const { data: intake } = await supabase
              .from("check_intake_items")
              .select("tenant_id, deposited_at")
              .eq("id", dep.check_intake_item_id)
              .maybeSingle();
            await supabase
              .from("check_intake_items")
              .update({
                check_stage: "deposited",
                status: "deposited",
                deposit_recommendation: null,
                deposited_at: intake?.deposited_at ?? depositedAt,
                deposited_by_tenant_id: intake?.tenant_id ?? null,
                updated_at: depositedAt,
              })
              .eq("id", dep.check_intake_item_id);
            await supabase
              .from("claim_checks")
              .update({ deposit_status: "deposited" })
              .eq("check_intake_item_id", dep.check_intake_item_id);
          } else if (internal === "returned" || internal === "rejected") {
            await supabase
              .from("check_intake_items")
              .update({
                check_stage: "ready_for_deposit",
                status: "approved_for_deposit",
                deposit_recommendation: "ready_for_deposit",
                updated_at: new Date().toISOString(),
              })
              .eq("id", dep.check_intake_item_id);
            await supabase
              .from("claim_checks")
              .update({ deposit_status: "returned" })
              .eq("check_intake_item_id", dep.check_intake_item_id);
          }
        }
      } catch (e) {
        errors++;
        console.error(
          "[checkalt-poll-status]",
          dep.checkalt_reference,
          e instanceof Error ? e.message : e,
        );
      }
    }

    return new Response(JSON.stringify({ polled, updated, errors }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
