import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch, normalizeTransferStatus, scopes } from "../_shared/moovClient.ts";
import { corsHeaders, json, isResponse, logPaymentEvent, requireMoovCaller, sanitize } from "../_shared/moovGuard.ts";

// Creates a sandbox transfer on behalf of the INITIATING tenant.
//
// Hard rule: the source of funds is always a bank account belonging to the
// initiating tenant's own connected account. There is no global ChecksOps or
// Freedom Adjustment funding account — Freedom Adjustment is just a tenant.
//
// Actum and Plaid disbursement paths are untouched; this only runs for tenants
// resolved to the Moov rail and on the allowlist.

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const {
      tenant_id,
      amount_cents,
      speed = "standard",
      description,
      claim_id = null,
      check_id = null,
      recipient_tenant_id = null,
      external_recipient_id = null,
      platform_fee_cents = 0,
      idempotency_key,
    } = body ?? {};

    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);

    const caller = await requireMoovCaller(req, tenant_id);
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    /* ---------- Validation ---------- */

    const amount = Number(amount_cents);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "Amount must be greater than zero." }, 400);
    }
    if (!recipient_tenant_id && !external_recipient_id) {
      return json({ error: "A recipient is required." }, 400);
    }
    if (recipient_tenant_id && external_recipient_id) {
      return json({ error: "Specify exactly one recipient." }, 400);
    }

    // Permission: only members who can send payments for THIS tenant.
    const { data: membership } = await supabase
      .from("tenant_users")
      .select("role")
      .eq("tenant_id", tenant_id)
      .eq("user_id", userId)
      .maybeSingle();
    const { data: adminRole } = await supabase
      .from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
    const canSend = !!adminRole || ["owner", "admin", "manager"].includes(String(membership?.role ?? ""));
    if (!canSend) return json({ error: "You do not have permission to send payments." }, 403);

    // Payer account must be active with the right capabilities.
    const { data: payer } = await supabase
      .from("payment_provider_accounts")
      .select("*")
      .eq("tenant_id", tenant_id)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();

    if (!payer?.provider_account_id) return json({ error: "Set up your payment account first." }, 409);
    if (payer.onboarding_status !== "active") {
      return json({ error: `Your payment account is not active yet (${payer.onboarding_status}).` }, 409);
    }
    if (!payer.can_send_payments || !payer.can_ach_debit) {
      return json({ error: "Your payment account cannot send payments yet." }, 409);
    }

    // Funding source: must belong to the initiating tenant.
    const { data: source } = await supabase
      .from("payment_provider_methods")
      .select("*")
      .eq("tenant_id", tenant_id)
      .eq("provider", "moov")
      .eq("environment", environment)
      .eq("provider_account_id", payer.provider_account_id)
      .eq("connection_status", "connected")
      .order("is_default", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!source) return json({ error: "Connect an eligible business bank account first." }, 409);

    /* ---------- Resolve destination ---------- */

    let destinationAccountId: string | null = null;
    let destinationMethod: any = null;
    let destinationLabel = "";

    if (recipient_tenant_id) {
      // Paying another ChecksOps organization — reuse their own account.
      const { data: payee } = await supabase
        .from("payment_provider_accounts")
        .select("*")
        .eq("tenant_id", recipient_tenant_id)
        .eq("provider", "moov")
        .eq("environment", environment)
        .maybeSingle();
      if (!payee?.provider_account_id) {
        return json({ error: "That organization has not finished payment setup." }, 409);
      }
      if (!payee.can_receive_payments) {
        return json({ error: "That organization cannot receive payments yet." }, 409);
      }
      destinationAccountId = payee.provider_account_id;
      destinationLabel = payee.display_name ?? "organization";

      const { data: m } = await supabase
        .from("payment_provider_methods")
        .select("*")
        .eq("tenant_id", recipient_tenant_id)
        .eq("provider_account_id", destinationAccountId)
        .eq("connection_status", "connected")
        .limit(1)
        .maybeSingle();
      destinationMethod = m;
    } else {
      const { data: recipient } = await supabase
        .from("external_payment_recipients")
        .select("*")
        .eq("id", external_recipient_id)
        .eq("tenant_id", tenant_id) // cross-tenant guard
        .maybeSingle();
      if (!recipient) return json({ error: "Recipient not found." }, 404);
      if (!recipient.provider_account_id) {
        return json({ error: "Recipient setup is not complete." }, 409);
      }
      destinationAccountId = recipient.provider_account_id;
      destinationLabel = recipient.display_name;

      const { data: m } = await supabase
        .from("payment_provider_methods")
        .select("*")
        .eq("external_recipient_id", external_recipient_id)
        .eq("connection_status", "connected")
        .limit(1)
        .maybeSingle();
      destinationMethod = m;
    }

    if (!destinationMethod) {
      return json({ error: "recipient_setup_required", message: "The recipient has not connected a bank account yet." }, 409);
    }

    /* ---------- Rail selection (speed -> actual Moov rail) ---------- */

    const legacyDestinationMethodId =
      destinationMethod.provider_payment_method_id ?? destinationMethod.provider_bank_account_id;

    const destinationRails = await resolveRails({
      cached: destinationMethod.rail_payment_method_ids,
      syncedAt: destinationMethod.rails_synced_at,
      accountId: destinationAccountId,
      bankAccountId: destinationMethod.provider_bank_account_id ?? null,
      persist: (rails) => saveMethodRails(supabase, destinationMethod.id, rails),
    });

    const railDecision = selectRail({
      requestedSpeed: speed,
      amountCents: amount,
      railPaymentMethodIds: destinationRails,
      fallbackPaymentMethodId: legacyDestinationMethodId,
    });
    const railMeta = railDecisionMetadata(railDecision);



    /* ---------- Idempotency / duplicate protection ---------- */

    const key = idempotency_key ??
      `${tenant_id}:${destinationAccountId}:${amount}:${check_id ?? claim_id ?? "adhoc"}`;

    const { data: existingTransfer } = await supabase
      .from("payment_transfers")
      .select("*")
      .eq("tenant_id", tenant_id)
      .eq("idempotency_key", key)
      .maybeSingle();
    if (existingTransfer) {
      return json({ success: true, duplicate: true, transfer: existingTransfer });
    }

    const platformFee = Math.max(0, Number(platform_fee_cents) || 0);

    const { data: draft, error: draftErr } = await supabase
      .from("payment_transfers")
      .insert({
        tenant_id,
        provider: "moov",
        environment,
        status: "ready",
        idempotency_key: key,
        amount_cents: amount,
        platform_fee_cents: platformFee,
        net_amount_cents: amount - platformFee,
        speed: railDecision.selectedSpeed,
        requested_speed: railDecision.requestedSpeed,
        selected_rail: railDecision.railType,
        rail_downgrade_reason: railDecision.downgraded ? railDecision.reason : null,
        description: description ?? null,
        source_tenant_account_id: payer.provider_account_id,
        source_payment_method_id: source.id,
        destination_tenant_id: recipient_tenant_id,
        destination_recipient_id: external_recipient_id,
        destination_payment_method_id: destinationMethod.id,
        claim_id,
        check_id,
        created_by: userId,
      })
      .select()
      .single();

    if (draftErr) {
      if (draftErr.message.toLowerCase().includes("duplicate")) {
        return json({ error: "A matching payment was already submitted." }, 409);
      }
      return json({ error: draftErr.message }, 500);
    }

    /* ---------- Create the transfer ---------- */

    let created: any;
    try {
      created = await moovFetch<any>("/transfers", {
        method: "POST",
        scopes: scopes.transfersWrite(payer.provider_account_id),
        idempotencyKey: `checksops-transfer-${draft.id}`,
        onBehalfOf: payer.provider_account_id,
        body: {
          source: {
            paymentMethodID: source.provider_payment_method_id ?? source.provider_bank_account_id,
          },
          destination: {
            paymentMethodID: railDecision.paymentMethodId ?? legacyDestinationMethodId,
          },
          amount: { currency: "USD", value: amount },
          description: (description ?? `ChecksOps payment to ${destinationLabel}`).slice(0, 128),
          metadata: {
            checksops_transfer_id: draft.id,
            checksops_tenant_id: tenant_id,
            claim_id: claim_id ?? "",
            requested_speed: railDecision.requestedSpeed,
            selected_rail: railDecision.railType ?? "ach-credit-standard",
          },
        },
      });
    } catch (e) {
      await supabase
        .from("payment_transfers")
        .update({ status: "failed", failure_reason: (e as Error).message })
        .eq("id", draft.id);
      await logPaymentEvent(supabase, {
        tenant_id,
        transfer_id: draft.id,
        event_type: "transfer.failed",
        previous_status: "ready",
        new_status: "failed",
        environment,
        provider_metadata: { reason: (e as Error).message },
      });
      return json({ error: (e as Error).message }, 502);
    }

    const providerTransferId = created?.transferID ?? created?.transferId ?? null;
    const providerStatus = created?.status ?? "created";
    const status = normalizeTransferStatus(providerStatus);
    const providerFee = created?.facilitatorFee?.total ?? created?.moovFee ?? null;

    const { data: finalTransfer } = await supabase
      .from("payment_transfers")
      .update({
        provider_transfer_id: providerTransferId,
        provider_status: providerStatus,
        status,
        provider_fee_cents: providerFee,
        submitted_at: new Date().toISOString(),
        provider_metadata: sanitize({ ...(created ?? {}), rail_decision: railMeta }),
      })
      .eq("id", draft.id)
      .select()
      .single();

    await logPaymentEvent(supabase, {
      tenant_id,
      recipient_id: external_recipient_id,
      transfer_id: draft.id,
      provider_transfer_id: providerTransferId,
      event_type: "transfer.created",
      previous_status: "ready",
      new_status: status,
      environment,
      provider_metadata: { provider_status: providerStatus, ...railMeta },
    });

    return json({ success: true, duplicate: false, transfer: finalTransfer });
  } catch (e) {
    console.error("[moov-transfer-create]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
