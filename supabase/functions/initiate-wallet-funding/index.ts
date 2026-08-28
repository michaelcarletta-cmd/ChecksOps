import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  facilitatorAccountId,
  moovFetch,
  normalizeTransferStatus,
  scopes,
} from "../_shared/moovClient.ts";
import {
  corsHeaders,
  isResponse,
  json,
  logPaymentEvent,
  requireMoovCaller,
  sanitize,
} from "../_shared/moovGuard.ts";
import { syncWallet } from "../_shared/moovWallet.ts";
import { resolveDebitSourceMethodId } from "../_shared/moovRails.ts";
import {
  ACTIVE_FUNDING_STATUSES,
  callerCanMoveFunds,
  calculateFunding,
  loadFundingSettings,
  loadPaymentContext,
  pulledTodayCents,
} from "../_shared/walletFunding.ts";

/**
 * Pulls the exact shortage from the tenant's own verified bank account into
 * that tenant's wallet, and parks the outgoing payment in "awaiting funding".
 *
 * This function NEVER sends the outgoing payment. That only happens in
 * `process-funded-payment`, once the provider confirms available funds.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = (await req.json().catch(() => ({}))) ?? {};
    const {
      tenant_id,
      payment_id = null,
      amount_cents = null,
      manual = false,
      auto_send_after_funding = true,
    } = body;

    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);
    if (!payment_id && !manual) return json({ error: "payment_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenant_id);
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    if (!(await callerCanMoveFunds(supabase, userId, tenant_id))) {
      return json({ error: "You do not have permission to move funds." }, 403);
    }

    const settings = await loadFundingSettings(supabase, tenant_id);
    if (!manual && !settings.auto_funding_enabled) {
      return json({ error: "Automatic funding is turned off for your organization." }, 409);
    }
    if (!settings.authorization_accepted_at) {
      return json(
        { error: "A bank debit authorization is required before funds can be pulled.", code: "authorization_required" },
        409,
      );
    }

    /* ---------- payment + amount ---------- */

    let paymentCents = 0;
    let batch: Record<string, any> | null = null;

    if (payment_id) {
      const ctx = await loadPaymentContext(supabase, payment_id);
      if (!ctx) return json({ error: "Payment not found." }, 404);
      if (ctx.batch.tenant_id !== tenant_id) return json({ error: "Forbidden" }, 403);
      batch = ctx.batch;
      paymentCents = ctx.paymentCents;

      if (["cancelled", "canceled", "completed", "failed"].includes(String(batch.status))) {
        return json({ error: `This payment is ${batch.status} and cannot be funded.` }, 409);
      }
      if (settings.require_payment_approval && !batch.approved_at) {
        return json({ error: "This payment has not been approved yet." }, 409);
      }
      if (batch.approved_amount_cents && Number(batch.approved_amount_cents) !== paymentCents) {
        return json(
          { error: "The payment amount changed after approval. It must be approved again.", code: "reapproval_required" },
          409,
        );
      }
      if (paymentCents <= 0) return json({ error: "This payment has nothing left to send." }, 409);

      const { data: active } = await supabase
        .from("wallet_funding_requests")
        .select("id, status")
        .eq("related_payment_id", payment_id)
        .in("status", ACTIVE_FUNDING_STATUSES as unknown as string[])
        .maybeSingle();
      if (active) {
        return json({ success: true, duplicate: true, funding_request: active });
      }
    }

    /* ---------- provider account + bank ---------- */

    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("*")
      .eq("tenant_id", tenant_id).eq("provider", "moov").eq("environment", environment)
      .maybeSingle();
    if (!account?.provider_account_id) return json({ error: "Set up your payment account first." }, 409);
    if (account.onboarding_status !== "active") {
      return json({ error: `Your payment account is not active yet (${account.onboarding_status}).` }, 409);
    }
    if (!account.can_ach_debit) {
      return json({ error: "Your payment account cannot pull funds from your bank yet." }, 409);
    }

    let sourceQuery = supabase
      .from("payment_provider_methods").select("*")
      .eq("tenant_id", tenant_id).eq("provider", "moov").eq("environment", environment)
      .eq("provider_account_id", account.provider_account_id)
      .eq("connection_status", "connected");
    if (settings.funding_bank_account_id) sourceQuery = sourceQuery.eq("id", settings.funding_bank_account_id);

    const { data: source } = await sourceQuery
      .order("is_default", { ascending: false }).limit(1).maybeSingle();
    if (!source) return json({ error: "Connect and verify a funding bank account first." }, 409);
    if (source.verification_status && !["verified", "new", "validated"].includes(String(source.verification_status))) {
      return json({ error: "Your funding bank account is not verified." }, 409);
    }

    /* ---------- shortage ---------- */

    const wallet = await syncWallet(supabase, {
      tenantId: tenant_id,
      accountId: account.provider_account_id,
      environment,
      walletType: "operating",
    });
    if (!wallet.provider_payment_method_id) {
      return json({ error: "Your balance account is not ready to receive funds yet." }, 409);
    }

    const calc = await calculateFunding({
      supabase,
      tenantId: tenant_id,
      environment,
      accountId: account.provider_account_id,
      paymentCents,
      paymentId: payment_id,
      wallet,
    });

    let pullCents: number;
    if (manual && amount_cents) {
      pullCents = Math.round(Number(amount_cents));
    } else if (settings.funding_strategy === "target_balance") {
      pullCents = Math.max(
        calc.shortageCents,
        settings.target_wallet_balance_cents - calc.spendableCents,
      );
    } else {
      pullCents = calc.shortageCents;
    }

    if (!Number.isFinite(pullCents) || pullCents <= 0) {
      // Nothing to pull — the wallet already covers it.
      if (payment_id) {
        await supabase.from("disbursement_batches").update({
          funding_status: "not_required",
          amount_reserved_cents: paymentCents,
        }).eq("id", payment_id);
      }
      return json({ success: true, funding_required: false, ...calc });
    }

    if (pullCents > settings.maximum_single_pull_cents) {
      return json({ error: "This transfer exceeds your single-transfer limit.", code: "limit_exceeded" }, 409);
    }
    const today = await pulledTodayCents(supabase, tenant_id);
    if (today + pullCents > settings.maximum_daily_pull_cents) {
      return json({ error: "This transfer exceeds your daily funding limit.", code: "limit_exceeded" }, 409);
    }

    /* ---------- funding request (idempotency key persisted first) ---------- */

    const idempotencyKey = payment_id
      ? `wallet-funding:${payment_id}:${pullCents}`
      : `wallet-funding-manual:${tenant_id}:${Date.now()}`;

    const { data: request, error: reqErr } = await supabase
      .from("wallet_funding_requests")
      .insert({
        tenant_id,
        related_payment_id: payment_id,
        related_claim_check_file_id: batch?.check_intake_item_id ?? null,
        moov_account_id: account.provider_account_id,
        moov_wallet_id: wallet.provider_wallet_id,
        wallet_row_id: wallet.id,
        source_bank_account_id: source.id,
        source_payment_method_id: null,
        requested_amount_cents: pullCents,
        wallet_available_balance_at_request_cents: calc.availableCents,
        payment_amount_cents: paymentCents,
        shortage_amount_cents: calc.shortageCents,
        idempotency_key: idempotencyKey,
        status: "initiating",
        strategy: manual ? "manual" : settings.funding_strategy,
        initiated_by: userId,
        initiated_at: new Date().toISOString(),
      })
      .select().single();

    if (reqErr) {
      if (reqErr.code === "23505") {
        const { data: dup } = await supabase
          .from("wallet_funding_requests").select("*")
          .eq("tenant_id", tenant_id).eq("idempotency_key", idempotencyKey).maybeSingle();
        return json({ success: true, duplicate: true, funding_request: dup });
      }
      return json({ error: reqErr.message }, 500);
    }

    if (payment_id) {
      await supabase.from("disbursement_batches").update({
        funding_request_id: request.id,
        funding_status: "awaiting_funding",
        amount_reserved_cents: paymentCents,
        auto_send_after_funding: auto_send_after_funding !== false,
      }).eq("id", payment_id);
    }

    /* ---------- provider transfer ---------- */

    const sourceMethodId = await resolveDebitSourceMethodId(supabase, source, account.provider_account_id);
    if (!sourceMethodId) {
      await failRequest(supabase, request.id, payment_id, "no_ach_debit_method",
        "No ach-debit-fund method on the funding bank account.");
      return json({ error: "Your bank account is not set up to fund your balance yet." }, 409);
    }

    const { data: draft, error: draftErr } = await supabase
      .from("payment_transfers")
      .insert({
        tenant_id,
        provider: "moov",
        environment,
        status: "ready",
        idempotency_key: idempotencyKey,
        amount_cents: pullCents,
        platform_fee_cents: 0,
        net_amount_cents: pullCents,
        speed: "standard",
        description: "Wallet funding",
        source_tenant_account_id: account.provider_account_id,
        source_payment_method_id: source.id,
        destination_tenant_id: tenant_id,
        wallet_id: wallet.id,
        leg_role: "wallet_funding",
        created_by: userId,
      })
      .select().single();
    if (draftErr) {
      await failRequest(supabase, request.id, payment_id, "transfer_draft_failed", draftErr.message);
      return json({ error: draftErr.message }, 500);
    }

    let created: any;
    try {
      const facilitatorId = await facilitatorAccountId(account.provider_account_id);
      created = await moovFetch<any>(`/accounts/${facilitatorId}/transfers`, {
        method: "POST",
        scopes: scopes.transfersWrite(facilitatorId),
        idempotencyKey: `checksops-wallet-funding-${request.id}`,
        body: {
          source: { paymentMethodID: sourceMethodId },
          destination: { paymentMethodID: wallet.provider_payment_method_id },
          amount: { currency: "USD", value: pullCents },
          description: "ChecksOps wallet funding",
          metadata: {
            checksops_funding_request_id: request.id,
            checksops_tenant_id: tenant_id,
            checksops_payment_id: payment_id ?? "",
          },
        },
      });
    } catch (e) {
      await supabase.from("payment_transfers")
        .update({ status: "failed", failure_reason: (e as Error).message }).eq("id", draft.id);
      await failRequest(supabase, request.id, payment_id, "provider_error", (e as Error).message);
      return json({ error: (e as Error).message }, 502);
    }

    const providerTransferId = created?.transferID ?? created?.transferId ?? null;
    const status = normalizeTransferStatus(created?.status);

    await supabase.from("payment_transfers").update({
      provider_transfer_id: providerTransferId,
      provider_status: created?.status ?? null,
      status,
      submitted_at: new Date().toISOString(),
      provider_metadata: sanitize(created ?? {}),
    }).eq("id", draft.id);

    const fundingStatus = status === "completed" ? "completed" : status === "failed" ? "failed" : "pending";
    const { data: updatedRequest } = await supabase
      .from("wallet_funding_requests")
      .update({
        moov_transfer_id: providerTransferId,
        transfer_id: draft.id,
        source_payment_method_id: sourceMethodId,
        status: fundingStatus,
        completed_at: fundingStatus === "completed" ? new Date().toISOString() : null,
        funds_available_at: fundingStatus === "completed" ? new Date().toISOString() : null,
      })
      .eq("id", request.id).select().single();

    await logPaymentEvent(supabase, {
      tenant_id,
      transfer_id: draft.id,
      provider_transfer_id: providerTransferId,
      event_type: "wallet.funding.initiated",
      new_status: fundingStatus,
      environment,
      provider_metadata: { funding_request_id: request.id, payment_id, amount_cents: pullCents },
    });

    return json({
      success: true,
      duplicate: false,
      funding_required: true,
      funding_request: updatedRequest,
      amount_cents: pullCents,
      status: fundingStatus,
    });
  } catch (e) {
    console.error("[initiate-wallet-funding]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});

async function failRequest(
  supabase: any,
  requestId: string,
  paymentId: string | null,
  code: string,
  reason: string,
) {
  await supabase.from("wallet_funding_requests")
    .update({ status: "failed", failure_code: code, failure_reason: reason })
    .eq("id", requestId);
  if (paymentId) {
    await supabase.from("disbursement_batches")
      .update({ funding_status: "funding_failed", amount_reserved_cents: 0 })
      .eq("id", paymentId);
  }
}
