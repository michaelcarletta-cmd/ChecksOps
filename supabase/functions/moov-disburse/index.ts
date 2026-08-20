import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch, normalizeTransferStatus, scopes } from "../_shared/moovClient.ts";
import { railDecisionMetadata, selectRail } from "../_shared/railRouter.ts";
import { resolveRails, saveStakeholderRails } from "../_shared/moovRails.ts";
import {
  corsHeaders,
  isResponse,
  json,
  logPaymentEvent,
  requireMoovCaller,
  sanitize,
  serviceClient,
} from "../_shared/moovGuard.ts";
import { readWallet, syncWallet } from "../_shared/moovWallet.ts";

/**
 * Pays out a disbursement batch on the platform payment rail (Moov).
 *
 * This is the DEFAULT disbursement path. It never partially pays a batch:
 * every recipient is resolved to a connected bank account BEFORE any money
 * moves. If even one recipient has not linked a bank on the platform rail the
 * function returns 409 `recipient_setup_required` with the list of names and
 * touches nothing, so the caller can fall back to the legacy Actum rail.
 *
 * The Actum and Plaid disbursement functions are untouched.
 */

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const batchId = body?.batch_id;
    const sourceKind = body?.source_kind === "wallet" ? "wallet" : "auto";
    if (!batchId || typeof batchId !== "string") {
      return json({ error: "batch_id is required" }, 400);
    }

    const svc = serviceClient();
    const { data: batch } = await svc
      .from("disbursement_batches")
      .select("id, tenant_id, status, delivery_speed, check_intake_item_id")
      .eq("id", batchId)
      .maybeSingle();
    if (!batch) return json({ error: "Disbursement batch not found." }, 404);

    const tenantId = batch.tenant_id as string;

    const caller = await requireMoovCaller(req, tenantId);
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    /* ---------- Permission ---------- */

    const { data: membership } = await supabase
      .from("tenant_users").select("role")
      .eq("tenant_id", tenantId).eq("user_id", userId).maybeSingle();
    const { data: adminRole } = await supabase
      .from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
    if (!adminRole && !["owner", "admin", "manager"].includes(String(membership?.role ?? ""))) {
      return json({ error: "You do not have permission to send payments." }, 403);
    }

    /* ---------- Splits ---------- */

    const { data: splits } = await supabase
      .from("disbursement_splits")
      .select(
        "id, amount, status, moov_transfer_id, stakeholder_account_id, recipient_name, " +
          "stakeholder_accounts(id, nickname, custname, provider, provider_environment, provider_account_id, " +
          "provider_bank_account_id, moov_rail_payment_method_ids, moov_rails_synced_at)",
      )
      .eq("batch_id", batchId);

    const payable = (splits ?? []).filter(
      (s: any) => !s.moov_transfer_id && !["failed", "cancelled", "returned"].includes(String(s.status)),
    );
    if (payable.length === 0) {
      return json({ error: "This batch has nothing left to pay out." }, 409);
    }

    /* ---------- Payer ---------- */

    const { data: payer } = await supabase
      .from("payment_provider_accounts").select("*")
      .eq("tenant_id", tenantId).eq("provider", "moov").eq("environment", environment)
      .maybeSingle();
    if (!payer?.provider_account_id) {
      return json({ error: "payer_setup_required", message: "Set up your payment account first." }, 409);
    }
    if (payer.onboarding_status !== "active" || !payer.can_send_payments) {
      return json({
        error: "payer_setup_required",
        message: `Your payment account is not ready to send payments yet (${payer.onboarding_status}).`,
      }, 409);
    }
    const accountId = payer.provider_account_id as string;

    /* ---------- Resolve every destination BEFORE moving money ---------- */

    const requestedSpeed = batch.delivery_speed ?? "standard";
    const resolved: Array<{
      split: any;
      methodId: string;
      label: string;
      cents: number;
      decision: ReturnType<typeof selectRail>;
    }> = [];
    const unready: string[] = [];

    for (const split of payable) {
      const acct = (split as any).stakeholder_accounts;
      const label = acct?.nickname ?? acct?.custname ?? split.recipient_name ?? "recipient";
      const isMoovLinked =
        acct?.provider === "moov" &&
        (!acct?.provider_environment || acct.provider_environment === environment) &&
        (acct?.provider_bank_account_id || acct?.provider_account_id);
      if (!isMoovLinked) {
        unready.push(label);
        continue;
      }
      const cents = Math.round(Number(split.amount) * 100);
      if (!Number.isFinite(cents) || cents <= 0) {
        return json({ error: `Invalid payout amount for ${label}.` }, 400);
      }
      // Rail eligibility for THIS recipient, cached on the stakeholder row.
      const legacyMethodId = acct.provider_bank_account_id ?? acct.provider_account_id;
      const rails = await resolveRails({
        cached: acct.moov_rail_payment_method_ids,
        syncedAt: acct.moov_rails_synced_at,
        accountId: acct.provider_account_id ?? null,
        bankAccountId: acct.provider_bank_account_id ?? null,
        persist: (r) => saveStakeholderRails(supabase, acct.id, r),
      });

      const decision = selectRail({
        requestedSpeed,
        amountCents: cents,
        railPaymentMethodIds: rails,
        fallbackPaymentMethodId: legacyMethodId,
      });

      resolved.push({
        split,
        methodId: decision.paymentMethodId ?? legacyMethodId,
        label,
        cents,
        decision,
      });
    }

    if (unready.length > 0) {
      return json({
        error: "recipient_setup_required",
        message:
          `${unready.length} recipient(s) have not connected a bank account on the platform rail: ` +
          `${unready.join(", ")}.`,
        recipients: unready,
      }, 409);
    }

    const total = resolved.reduce((s, r) => s + r.cents, 0);

    /* ---------- Funding source ---------- */

    const wallet = await syncWallet(supabase, {
      tenantId, accountId, environment, walletType: "operating",
    }).catch(async () => await readWallet(supabase, tenantId, environment, "operating"));

    let sourcePaymentMethodId: string | null = null;
    if (wallet?.provider_payment_method_id && Number(wallet.available_cents) >= total) {
      sourcePaymentMethodId = wallet.provider_payment_method_id;
    } else if (sourceKind === "wallet") {
      return json({
        error: "insufficient_balance",
        message: "Your balance does not cover this disbursement. Fund your balance first.",
      }, 409);
    } else {
      if (!payer.can_ach_debit) {
        return json({
          error: "payer_setup_required",
          message: "Your payment account cannot pull funds from your bank yet.",
        }, 409);
      }
      const { data: bank } = await supabase
        .from("payment_provider_methods").select("*")
        .eq("tenant_id", tenantId).eq("provider", "moov").eq("environment", environment)
        .eq("provider_account_id", accountId).eq("connection_status", "connected")
        .order("is_default", { ascending: false }).limit(1).maybeSingle();
      if (!bank) {
        return json({
          error: "payer_setup_required",
          message: "Connect an eligible business bank account first.",
        }, 409);
      }
      sourcePaymentMethodId = bank.provider_payment_method_id ?? bank.provider_bank_account_id;
    }

    if (!sourcePaymentMethodId) {
      return json({ error: "payer_setup_required", message: "No funding source is available." }, 409);
    }

    /* ---------- Send ---------- */

    await supabase
      .from("disbursement_batches")
      .update({ status: "submitted", rail: "moov", submitted_at: new Date().toISOString() })
      .eq("id", batchId);

    let sent = 0;
    let failed = 0;
    const results: Array<{
      split_id: string;
      ok: boolean;
      status?: string;
      error?: string;
      requested_speed?: string;
      selected_rail?: string | null;
      downgrade_reason?: string | null;
    }> = [];

    for (const leg of resolved) {
      try {
        const created = await moovFetch<any>(`/accounts/${accountId}/transfers`, {
          method: "POST",
          scopes: scopes.transfersWrite(accountId),
          idempotencyKey: `checksops-disb-split-${leg.split.id}`,
          onBehalfOf: accountId,
          body: {
            source: { paymentMethodID: sourcePaymentMethodId },
            destination: { paymentMethodID: leg.methodId },
            amount: { currency: "USD", value: leg.cents },
            description: `ChecksOps disbursement to ${leg.label}`.slice(0, 128),
            metadata: {
              checksops_batch_id: batchId,
              checksops_split_id: leg.split.id,
              checksops_tenant_id: tenantId,
              requested_speed: leg.decision.requestedSpeed,
              selected_rail: leg.decision.railType ?? "ach-credit-standard",
            },
          },
        });

        const transferId = created?.transferID ?? created?.transferId ?? null;
        const status = normalizeTransferStatus(created?.status);

        await supabase
          .from("disbursement_splits")
          .update({
            rail: "moov",
            requested_speed: leg.decision.requestedSpeed,
            selected_rail: leg.decision.railType,
            rail_downgrade_reason: leg.decision.downgraded ? leg.decision.reason : null,
            moov_transfer_id: transferId,
            moov_status: status,
            status: status === "failed" ? "failed" : "submitted",
            submitted_at: new Date().toISOString(),
          })
          .eq("id", leg.split.id);

        sent += 1;
        results.push({
          split_id: leg.split.id,
          ok: true,
          status,
          requested_speed: leg.decision.requestedSpeed,
          selected_rail: leg.decision.railType,
          downgrade_reason: leg.decision.downgraded ? leg.decision.reason : null,
        });
      } catch (e) {
        let message = (e as Error).message;
        if (/403|forbidden/i.test(message)) {
          const pending = await pendingCapabilities(accountId).catch(() => [] as string[]);
          message = pending.length
            ? `Your payment account is not approved to move money yet. Pending approval: ${pending.join(", ")}. Finish the payment onboarding requirements, then retry.`
            : "Your payment account is not approved to move money yet. Finish the payment onboarding requirements, then retry.";
        }
        await supabase
          .from("disbursement_splits")
          .update({
            rail: "moov",
            status: "failed",
            moov_status: "failed",
            moov_failure_reason: message,
            requested_speed: leg.decision.requestedSpeed,
            selected_rail: leg.decision.railType,
            rail_downgrade_reason: leg.decision.downgraded ? leg.decision.reason : null,
          })
          .eq("id", leg.split.id);
        failed += 1;
        results.push({ split_id: leg.split.id, ok: false, error: message });
      }
    }

    if (sent === 0) {
      await supabase.from("disbursement_batches").update({ status: "failed" }).eq("id", batchId);
    }

    await logPaymentEvent(supabase, {
      tenant_id: tenantId,
      event_type: "disbursement.submitted",
      new_status: sent === 0 ? "failed" : "submitted",
      environment,
      provider_metadata: sanitize({
        batch_id: batchId,
        sent,
        failed,
        total_cents: total,
        requested_speed: requestedSpeed,
        rails: resolved.map((r) => ({ split_id: r.split.id, ...railDecisionMetadata(r.decision) })),
      }),
    });

    if (sent === 0) {
      return json({
        success: false,
        error: results.find((r) => !r.ok)?.error ?? "Disbursement failed.",
        results,
      }, 502);
    }

    return json({ success: true, batch_id: batchId, sent, failed, results });
  } catch (e) {
    console.error("[moov-disburse]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
