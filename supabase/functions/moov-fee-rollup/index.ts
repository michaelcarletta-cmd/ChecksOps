import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch } from "../_shared/moovClient.ts";
import {
  corsHeaders,
  isResponse,
  json,
  logPaymentEvent,
  requireMoovCaller,
  sanitize,
} from "../_shared/moovGuard.ts";
import {
  nextMonthlyRun,
  periodForRun,
  platformAccountId,
  platformPaymentMethodId,
  scheduleScopes,
  unbilledTotalCents,
} from "../_shared/moovSchedules.ts";

// Rolls up an organization's unbilled platform fees into one scheduled charge.
//
// Usage-based fees (OCR, storage, mortgage-desk work) are written to
// platform_fee_line_items as they happen. This function totals everything not
// yet billed, books a single dated occurrence at the provider, and marks the
// line items as billed against that occurrence.
//
// Pass { dry_run: true } to preview the roll-up without charging anything.

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { tenant_id, dry_run = false, run_at = null } = body ?? {};
    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenant_id, { requireAdmin: !dry_run });
    if (isResponse(caller)) return caller;
    const { supabase, environment } = caller;

    const { data: schedule } = await supabase
      .from("platform_fee_schedules")
      .select("*")
      .eq("tenant_id", tenant_id).eq("provider", "moov").eq("environment", environment)
      .eq("status", "active")
      .maybeSingle();
    if (!schedule) return json({ error: "No active fee schedule for this organization." }, 409);

    const runDate = run_at ? new Date(run_at) : nextMonthlyRun(schedule.day_of_month);
    if (Number.isNaN(runDate.getTime())) return json({ error: "run_at is not a valid date" }, 400);
    const period = periodForRun(runDate);

    const { totalCents, ids } = await unbilledTotalCents(supabase, tenant_id);
    const amount = schedule.amount_mode === "fixed"
      ? Number(schedule.amount_cents ?? 0) + totalCents
      : totalCents;

    if (dry_run) {
      return json({
        success: true,
        dry_run: true,
        period,
        run_at: runDate.toISOString(),
        line_item_count: ids.length,
        amount_cents: amount,
      });
    }

    if (amount <= 0) {
      return json({ success: true, skipped: true, reason: "Nothing to bill.", period, amount_cents: 0 });
    }

    const platformMethod = platformPaymentMethodId();
    const platformAccount = platformAccountId();
    if (!platformAccount || !platformMethod) {
      return json({ error: "The platform billing account is not configured yet." }, 503);
    }

    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("provider_account_id, can_ach_debit")
      .eq("tenant_id", tenant_id).eq("provider", "moov").eq("environment", environment)
      .maybeSingle();
    if (!account?.provider_account_id) return json({ error: "No payment account for this organization." }, 409);
    if (!account.can_ach_debit) return json({ error: "Bank debits are not authorized for this organization." }, 409);

    const { data: occurrence, error: occErr } = await supabase
      .from("platform_fee_occurrences")
      .insert({
        schedule_id: schedule.id,
        tenant_id,
        run_at: runDate.toISOString(),
        period_start: period.start,
        period_end: period.end,
        amount_cents: amount,
        status: "scheduled",
      })
      .select().single();
    if (occErr) return json({ error: occErr.message }, 500);

    let providerOccurrence: any = null;
    try {
      providerOccurrence = await moovFetch<any>(
        `/accounts/${account.provider_account_id}/schedules/${schedule.provider_schedule_id}`,
        {
          method: "PUT",
          scopes: scheduleScopes.write(account.provider_account_id),
          onBehalfOf: account.provider_account_id,
          body: {
            description: `${schedule.name} — ${period.start} to ${period.end}`.slice(0, 128),
            occurrences: [
              {
                runOn: runDate.toISOString(),
                runTransfer: {
                  amount: { currency: "USD", value: amount },
                  source: { paymentMethodID: schedule.provider_source_payment_method_id },
                  destination: { paymentMethodID: platformMethod },
                  description: `ChecksOps platform fees ${period.start}–${period.end}`.slice(0, 128),
                  metadata: {
                    checksops_tenant_id: tenant_id,
                    checksops_occurrence_id: occurrence.id,
                  },
                },
              },
            ],
          },
        },
      );
    } catch (e) {
      await supabase.from("platform_fee_occurrences")
        .update({ status: "failed", failure_reason: (e as Error).message })
        .eq("id", occurrence.id);
      return json({ error: (e as Error).message }, 502);
    }

    const providerOccurrenceId = providerOccurrence?.occurrences?.[0]?.occurrenceID
      ?? providerOccurrence?.occurrences?.[0]?.occurrenceId
      ?? null;

    const { data: finalOccurrence } = await supabase
      .from("platform_fee_occurrences")
      .update({
        provider_occurrence_id: providerOccurrenceId,
        metadata: sanitize(providerOccurrence ?? {}),
      })
      .eq("id", occurrence.id).select().single();

    if (ids.length) {
      await supabase
        .from("platform_fee_line_items")
        .update({
          status: "billed",
          occurrence_id: occurrence.id,
          period_start: period.start,
          period_end: period.end,
        })
        .in("id", ids);
    }

    await supabase
      .from("platform_fee_schedules")
      .update({ last_run_at: new Date().toISOString(), next_run_at: nextMonthlyRun(schedule.day_of_month, runDate).toISOString() })
      .eq("id", schedule.id);

    await logPaymentEvent(supabase, {
      tenant_id,
      event_type: "fee_schedule.rollup",
      new_status: "scheduled",
      environment,
      provider_metadata: { amount_cents: amount, line_items: ids.length, period },
    });

    return json({
      success: true,
      occurrence: finalOccurrence,
      amount_cents: amount,
      line_item_count: ids.length,
      period,
    });
  } catch (e) {
    console.error("[moov-fee-rollup]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
