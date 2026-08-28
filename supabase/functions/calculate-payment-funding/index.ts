import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, isResponse, json, requireMoovCaller } from "../_shared/moovGuard.ts";
import {
  callerCanMoveFunds,
  calculateFunding,
  loadFundingSettings,
  loadPaymentContext,
} from "../_shared/walletFunding.ts";

/**
 * Answers one question for an approved payment: can the wallet cover it, and
 * if not, exactly how much has to be pulled from the tenant's bank?
 *
 * Read-only. Nothing here moves money.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { tenant_id, payment_id } = (await req.json().catch(() => ({}))) ?? {};
    if (!tenant_id || !payment_id) {
      return json({ error: "tenant_id and payment_id are required" }, 400);
    }

    const caller = await requireMoovCaller(req, tenant_id);
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    if (!(await callerCanMoveFunds(supabase, userId, tenant_id))) {
      return json({ error: "You do not have permission to move funds." }, 403);
    }

    const ctx = await loadPaymentContext(supabase, payment_id);
    if (!ctx) return json({ error: "Payment not found." }, 404);
    if (ctx.batch.tenant_id !== tenant_id) return json({ error: "Forbidden" }, 403);

    if (["cancelled", "canceled", "completed", "failed"].includes(String(ctx.batch.status))) {
      return json({ error: `This payment is ${ctx.batch.status} and cannot be funded.` }, 409);
    }
    if (ctx.paymentCents <= 0) {
      return json({ error: "This payment has nothing left to send." }, 409);
    }

    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("provider_account_id, onboarding_status, can_ach_debit")
      .eq("tenant_id", tenant_id).eq("provider", "moov").eq("environment", environment)
      .maybeSingle();
    if (!account?.provider_account_id) {
      return json({ error: "Set up your payment account first." }, 409);
    }

    const settings = await loadFundingSettings(supabase, tenant_id);
    const calc = await calculateFunding({
      supabase,
      tenantId: tenant_id,
      environment,
      accountId: account.provider_account_id,
      paymentCents: ctx.paymentCents,
      paymentId: payment_id,
    });

    let fundingBank: Record<string, unknown> | null = null;
    if (settings.funding_bank_account_id) {
      const { data: bank } = await supabase
        .from("payment_provider_methods")
        .select("id, bank_name, last_four, verification_status, connection_status")
        .eq("id", settings.funding_bank_account_id).maybeSingle();
      fundingBank = bank ?? null;
    }

    // Target-balance strategy tops up to the reserve, never below the shortage.
    const targetTopUp = settings.funding_strategy === "target_balance"
      ? Math.max(0, settings.target_wallet_balance_cents - (calc.availableCents - calc.reservedCents))
      : 0;
    const suggestedPullCents = Math.max(calc.shortageCents, targetTopUp);

    return json({
      success: true,
      payment_id,
      ...calc,
      suggested_pull_cents: suggestedPullCents,
      auto_funding_enabled: settings.auto_funding_enabled,
      authorization_on_file: Boolean(settings.authorization_accepted_at),
      funding_strategy: settings.funding_strategy,
      maximum_single_pull_cents: settings.maximum_single_pull_cents,
      maximum_daily_pull_cents: settings.maximum_daily_pull_cents,
      funding_bank: fundingBank,
      can_ach_debit: Boolean(account.can_ach_debit),
    });
  } catch (e) {
    console.error("[calculate-payment-funding]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
