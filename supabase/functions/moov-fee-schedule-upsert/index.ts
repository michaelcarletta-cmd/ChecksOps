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
  platformAccountId,
  platformPaymentMethodId,
  recurrenceRule,
  safeDayOfMonth,
  scheduleScopes,
} from "../_shared/moovSchedules.ts";

// Creates or updates a recurring platform-fee schedule for one organization.
//
// The schedule ACH-debits the organization's own connected bank account and
// credits the ChecksOps platform account. It is used only for fees that are
// NOT attached to a payout (OCR, storage, mortgage-desk work); payout-linked
// fees keep riding on facilitator fees inside the transfer itself.

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const {
      tenant_id,
      name = "ChecksOps platform fees",
      fee_code = "platform_fees",
      description = null,
      cadence = "monthly",
      day_of_month = 1,
      amount_cents = 0,
      amount_mode = "usage",
      status = "active",
    } = body ?? {};

    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);
    if (!["monthly", "weekly", "once"].includes(cadence)) {
      return json({ error: "cadence must be 'monthly', 'weekly' or 'once'" }, 400);
    }
    if (!["usage", "fixed"].includes(amount_mode)) {
      return json({ error: "amount_mode must be 'usage' or 'fixed'" }, 400);
    }
    const fixedAmount = Number(amount_cents ?? 0);
    if (amount_mode === "fixed" && (!Number.isFinite(fixedAmount) || fixedAmount <= 0)) {
      return json({ error: "A fixed fee amount must be greater than zero." }, 400);
    }

    const caller = await requireMoovCaller(req, tenant_id, { requireAdmin: true });
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    const platformAccount = platformAccountId();
    const platformMethod = platformPaymentMethodId();
    if (!platformAccount || !platformMethod) {
      return json({
        error:
          "The platform billing account is not configured yet. Set the platform account and payment method first.",
      }, 503);
    }

    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("*")
      .eq("tenant_id", tenant_id).eq("provider", "moov").eq("environment", environment)
      .maybeSingle();
    if (!account?.provider_account_id) {
      return json({ error: "This organization has no payment account yet." }, 409);
    }
    if (!account.can_ach_debit) {
      return json({ error: "This organization has not authorized bank debits yet." }, 409);
    }

    const { data: source } = await supabase
      .from("payment_provider_methods")
      .select("*")
      .eq("tenant_id", tenant_id).eq("provider", "moov").eq("environment", environment)
      .eq("provider_account_id", account.provider_account_id)
      .eq("connection_status", "connected")
      .order("is_default", { ascending: false })
      .limit(1).maybeSingle();
    if (!source) return json({ error: "This organization has no connected bank account." }, 409);

    const dom = safeDayOfMonth(day_of_month);
    const nextRun = nextMonthlyRun(dom);

    const { data: existing } = await supabase
      .from("platform_fee_schedules")
      .select("*")
      .eq("tenant_id", tenant_id).eq("provider", "moov").eq("environment", environment)
      .eq("fee_code", fee_code).neq("status", "cancelled")
      .maybeSingle();

    const runTransfer = {
      amount: { currency: "USD", value: amount_mode === "fixed" ? fixedAmount : 1 },
      source: {
        paymentMethodID: source.provider_payment_method_id ?? source.provider_bank_account_id,
      },
      destination: { paymentMethodID: platformMethod },
      description: String(name).slice(0, 128),
      metadata: { checksops_tenant_id: tenant_id, checksops_fee_code: fee_code },
    };

    const schedulePayload: Record<string, unknown> = {
      description: String(name).slice(0, 128),
      recur: {
        start: nextRun.toISOString(),
        recurrenceRule: recurrenceRule(cadence, dom),
        runTransfer,
        indefinite: true,
      },
    };

    let providerSchedule: any = null;
    try {
      if (existing?.provider_schedule_id) {
        providerSchedule = await moovFetch<any>(
          `/accounts/${account.provider_account_id}/schedules/${existing.provider_schedule_id}`,
          {
            method: "PUT",
            scopes: scheduleScopes.write(account.provider_account_id),
            onBehalfOf: account.provider_account_id,
            body: schedulePayload,
          },
        );
      } else {
        providerSchedule = await moovFetch<any>(
          `/accounts/${account.provider_account_id}/schedules`,
          {
            method: "POST",
            scopes: scheduleScopes.write(account.provider_account_id),
            onBehalfOf: account.provider_account_id,
            idempotencyKey: `checksops-fee-schedule-${tenant_id}-${fee_code}`,
            body: schedulePayload,
          },
        );
      }
    } catch (e) {
      return json({ error: (e as Error).message }, 502);
    }

    const providerScheduleId = providerSchedule?.scheduleID ?? providerSchedule?.scheduleId ?? null;

    const row = {
      tenant_id,
      provider: "moov",
      environment,
      name,
      fee_code,
      description,
      cadence,
      day_of_month: dom,
      amount_cents: amount_mode === "fixed" ? fixedAmount : 0,
      amount_mode,
      status,
      provider_schedule_id: providerScheduleId,
      provider_source_payment_method_id:
        source.provider_payment_method_id ?? source.provider_bank_account_id ?? null,
      provider_destination_payment_method_id: platformMethod,
      next_run_at: nextRun.toISOString(),
      metadata: sanitize(providerSchedule ?? {}),
      created_by: userId,
    };

    const { data: saved, error: saveErr } = existing
      ? await supabase.from("platform_fee_schedules").update(row).eq("id", existing.id).select().single()
      : await supabase.from("platform_fee_schedules").insert(row).select().single();
    if (saveErr) return json({ error: saveErr.message }, 500);

    await logPaymentEvent(supabase, {
      tenant_id,
      event_type: existing ? "fee_schedule.updated" : "fee_schedule.created",
      new_status: status,
      environment,
      provider_metadata: { fee_code, cadence, day_of_month: dom, amount_mode },
    });

    return json({ success: true, schedule: saved });
  } catch (e) {
    console.error("[moov-fee-schedule-upsert]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
