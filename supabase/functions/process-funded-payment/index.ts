import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, json, logPaymentEvent, serviceClient } from "../_shared/moovGuard.ts";
import { syncWallet } from "../_shared/moovWallet.ts";
import { calculateFunding, loadPaymentContext } from "../_shared/walletFunding.ts";

/**
 * Sends an approved payment once — and only once — its wallet funding has
 * completed and the money is AVAILABLE (never pending).
 *
 * Called by the webhook when a funding transfer completes, or manually. It is
 * idempotent: a replayed webhook cannot send a second payment.
 */
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = (await req.json().catch(() => ({}))) ?? {};
    const fundingRequestId: string | null = body.funding_request_id ?? null;
    const paymentIdInput: string | null = body.payment_id ?? null;
    if (!fundingRequestId && !paymentIdInput) {
      return json({ error: "funding_request_id or payment_id is required" }, 400);
    }

    const internalKey = req.headers.get("x-checksops-internal");
    if (internalKey !== Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) {
      return json({ error: "Unauthorized" }, 401);
    }

    const supabase = serviceClient();
    const environment = (Deno.env.get("MOOV_ENVIRONMENT") ?? "sandbox").toLowerCase();

    let request: any = null;
    if (fundingRequestId) {
      const { data } = await supabase
        .from("wallet_funding_requests").select("*").eq("id", fundingRequestId).maybeSingle();
      request = data;
      if (!request) return json({ error: "Funding request not found." }, 404);
      if (request.status !== "completed") {
        return json({ success: false, reason: "funding_not_complete", status: request.status });
      }
    }

    const paymentId = paymentIdInput ?? request?.related_payment_id ?? null;
    if (!paymentId) return json({ success: true, reason: "no_payment_attached" });

    /**
     * Claim the payment so two webhook deliveries cannot both send it.
     * The conditional update is the lock: only one worker sees a row change.
     */
    const { data: claimed } = await supabase
      .from("disbursement_batches")
      .update({ funding_status: "funded" })
      .eq("id", paymentId)
      .eq("funding_status", "awaiting_funding")
      .select().maybeSingle();

    if (!claimed) {
      return json({ success: true, reason: "already_processed_or_not_awaiting" });
    }

    const tenantId = claimed.tenant_id as string;

    if (["cancelled", "canceled", "completed", "failed"].includes(String(claimed.status))) {
      await supabase.from("disbursement_batches")
        .update({ funding_status: "action_required", amount_reserved_cents: 0 }).eq("id", paymentId);
      return json({ success: false, reason: "payment_no_longer_sendable" });
    }
    if (claimed.auto_send_after_funding === false) {
      return json({ success: true, reason: "manual_send_required" });
    }

    /* ---------- Re-verify the amount and the balance ---------- */

    const ctx = await loadPaymentContext(supabase, paymentId);
    if (!ctx || ctx.paymentCents <= 0) {
      return json({ success: true, reason: "nothing_to_send" });
    }
    if (claimed.approved_amount_cents && Number(claimed.approved_amount_cents) !== ctx.paymentCents) {
      await supabase.from("disbursement_batches")
        .update({ funding_status: "action_required" }).eq("id", paymentId);
      await logPaymentEvent(supabase, {
        tenant_id: tenantId, event_type: "wallet.funding.reapproval_required", environment,
        provider_metadata: { payment_id: paymentId },
      });
      return json({ success: false, reason: "reapproval_required" });
    }

    const { data: account } = await supabase
      .from("payment_provider_accounts").select("provider_account_id")
      .eq("tenant_id", tenantId).eq("provider", "moov").eq("environment", environment).maybeSingle();
    if (!account?.provider_account_id) {
      return json({ success: false, reason: "no_provider_account" });
    }

    const wallet = await syncWallet(supabase, {
      tenantId,
      accountId: account.provider_account_id,
      environment,
      walletType: "operating",
    });

    const calc = await calculateFunding({
      supabase,
      tenantId,
      environment,
      accountId: account.provider_account_id,
      paymentCents: ctx.paymentCents,
      paymentId,
      wallet,
    });

    if (calc.shortageCents > 0) {
      await supabase.from("disbursement_batches")
        .update({ funding_status: "awaiting_funding" }).eq("id", paymentId);
      return json({ success: false, reason: "still_short", shortage_cents: calc.shortageCents });
    }

    /* ---------- Send through the existing disbursement path ---------- */

    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/moov-disburse`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-checksops-internal": Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      },
      body: JSON.stringify({ batch_id: paymentId, source_kind: "wallet" }),
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok || payload?.error) {
      await supabase.from("disbursement_batches")
        .update({ funding_status: "action_required" }).eq("id", paymentId);
      await logPaymentEvent(supabase, {
        tenant_id: tenantId, event_type: "wallet.funding.send_failed", environment,
        provider_metadata: { payment_id: paymentId, error: payload?.error ?? `HTTP ${res.status}` },
      });
      return json({ success: false, reason: "send_failed", error: payload?.error ?? `HTTP ${res.status}` }, 502);
    }

    await supabase.from("disbursement_batches")
      .update({ amount_reserved_cents: 0 }).eq("id", paymentId);

    await logPaymentEvent(supabase, {
      tenant_id: tenantId, event_type: "wallet.funding.payment_sent", environment,
      provider_metadata: { payment_id: paymentId, funding_request_id: fundingRequestId },
    });

    return json({ success: true, payment_id: paymentId, result: payload });
  } catch (e) {
    console.error("[process-funded-payment]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
