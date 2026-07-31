import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch } from "../_shared/moovClient.ts";
import {
  corsHeaders,
  isResponse,
  json,
  logPaymentEvent,
  requireMoovCaller,
} from "../_shared/moovGuard.ts";
import { scheduleScopes } from "../_shared/moovSchedules.ts";

// Cancels an organization's recurring platform-fee schedule.
// Fees already billed are untouched; only future runs stop.

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { tenant_id, schedule_id } = (await req.json().catch(() => ({}))) ?? {};
    if (!tenant_id || !schedule_id) {
      return json({ error: "tenant_id and schedule_id are required" }, 400);
    }

    const caller = await requireMoovCaller(req, tenant_id, { requireAdmin: true });
    if (isResponse(caller)) return caller;
    const { supabase, environment } = caller;

    const { data: schedule } = await supabase
      .from("platform_fee_schedules")
      .select("*")
      .eq("id", schedule_id).eq("tenant_id", tenant_id)
      .maybeSingle();
    if (!schedule) return json({ error: "Fee schedule not found." }, 404);

    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("provider_account_id")
      .eq("tenant_id", tenant_id).eq("provider", "moov").eq("environment", environment)
      .maybeSingle();

    if (schedule.provider_schedule_id && account?.provider_account_id) {
      try {
        await moovFetch<unknown>(
          `/accounts/${account.provider_account_id}/schedules/${schedule.provider_schedule_id}`,
          {
            method: "DELETE",
            scopes: scheduleScopes.write(account.provider_account_id),
            onBehalfOf: account.provider_account_id,
          },
        );
      } catch (e) {
        console.error("[moov-fee-schedule-cancel] provider delete failed", (e as Error).message);
      }
    }

    const { data: updated, error } = await supabase
      .from("platform_fee_schedules")
      .update({ status: "cancelled", next_run_at: null })
      .eq("id", schedule_id).select().single();
    if (error) return json({ error: error.message }, 500);

    await supabase
      .from("platform_fee_occurrences")
      .update({ status: "cancelled" })
      .eq("schedule_id", schedule_id)
      .eq("status", "scheduled");

    await logPaymentEvent(supabase, {
      tenant_id,
      event_type: "fee_schedule.cancelled",
      new_status: "cancelled",
      environment,
    });

    return json({ success: true, schedule: updated });
  } catch (e) {
    console.error("[moov-fee-schedule-cancel]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
