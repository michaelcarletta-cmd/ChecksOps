import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { moovFetch, normalizeTransferStatus, scopes } from "../_shared/moovClient.ts";
import {
  corsHeaders,
  isResponse,
  json,
  logPaymentEvent,
  requireMoovCaller,
  sanitize,
} from "../_shared/moovGuard.ts";
import { readWallet, syncWallet, writeLedgerEntry } from "../_shared/moovWallet.ts";
import { facilitatorAccountId } from "../_shared/moovClient.ts";

/**
 * Splits ONE settlement across several parties in a single call.
 *
 * Shape of the money:
 *   parent leg : tenant bank account (or tenant balance) -> tenant balance
 *                with the ChecksOps facilitator fee taken on this leg
 *   child legs : parent leg -> homeowner / contractor / public adjuster /
 *                subcontractor / vendor
 *
 * Child legs stay queued until the parent completes, so every recipient sees
 * their money coming the moment the settlement is initiated, and the whole
 * split reconciles as one unit instead of unrelated one-off payments.
 */

type LegInput = {
  role?: string;
  amount_cents: number;
  recipient_tenant_id?: string | null;
  external_recipient_id?: string | null;
  description?: string | null;
};

const ALLOWED_ROLES = [
  "homeowner", "contractor", "public_adjuster", "subcontractor",
  "vendor", "attorney", "mortgage", "other",
];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const {
      tenant_id,
      legs,
      facilitator_fee_cents = 0,
      source_kind = "bank",
      wallet_type = "operating",
      sub_ledger_id = null,
      claim_id = null,
      check_id = null,
      description = null,
      idempotency_key,
    } = body ?? {};

    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);
    if (!Array.isArray(legs) || legs.length === 0) {
      return json({ error: "At least one recipient is required." }, 400);
    }
    if (legs.length > 20) return json({ error: "A split can have at most 20 recipients." }, 400);
    if (!["bank", "wallet"].includes(source_kind)) {
      return json({ error: "source_kind must be 'bank' or 'wallet'" }, 400);
    }

    const fee = Math.max(0, Math.round(Number(facilitator_fee_cents) || 0));
    const parsed: LegInput[] = [];
    for (const leg of legs as LegInput[]) {
      const amt = Math.round(Number(leg?.amount_cents));
      if (!Number.isFinite(amt) || amt <= 0) {
        return json({ error: "Every recipient amount must be greater than zero." }, 400);
      }
      if (!leg.recipient_tenant_id && !leg.external_recipient_id) {
        return json({ error: "Every leg needs a recipient." }, 400);
      }
      if (leg.recipient_tenant_id && leg.external_recipient_id) {
        return json({ error: "Each leg must have exactly one recipient." }, 400);
      }
      if (leg.role && !ALLOWED_ROLES.includes(leg.role)) {
        return json({ error: `Unsupported recipient role "${leg.role}".` }, 400);
      }
      parsed.push({ ...leg, amount_cents: amt });
    }

    const legTotal = parsed.reduce((s, l) => s + l.amount_cents, 0);
    const total = legTotal + fee;

    const caller = await requireMoovCaller(req, tenant_id);
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    const { data: membership } = await supabase
      .from("tenant_users").select("role")
      .eq("tenant_id", tenant_id).eq("user_id", userId).maybeSingle();
    const { data: adminRole } = await supabase
      .from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
    if (!adminRole && !["owner", "admin", "manager"].includes(String(membership?.role ?? ""))) {
      return json({ error: "You do not have permission to send payments." }, 403);
    }

    /* ---------- Payer ---------- */

    const { data: payer } = await supabase
      .from("payment_provider_accounts").select("*")
      .eq("tenant_id", tenant_id).eq("provider", "moov").eq("environment", environment)
      .maybeSingle();
    if (!payer?.provider_account_id) return json({ error: "Set up your payment account first." }, 409);
    if (payer.onboarding_status !== "active") {
      return json({ error: `Your payment account is not active yet (${payer.onboarding_status}).` }, 409);
    }
    if (!payer.can_send_payments) {
      return json({ error: "Your payment account cannot send payments yet." }, 409);
    }

    const accountId = payer.provider_account_id as string;

    const wallet = await syncWallet(supabase, {
      tenantId: tenant_id, accountId, environment, walletType: wallet_type,
    }).catch(async () => await readWallet(supabase, tenant_id, environment, wallet_type));
    if (!wallet?.provider_payment_method_id) {
      return json({ error: "Your balance account is not ready yet." }, 409);
    }

    let sourcePaymentMethodId: string | null = null;
    let sourceMethodRowId: string | null = null;

    if (source_kind === "wallet") {
      if (Number(wallet.available_cents) < total) {
        return json({
          error: "insufficient_balance",
          message: "Your balance does not cover this split. Fund your balance first.",
        }, 409);
      }
      sourcePaymentMethodId = wallet.provider_payment_method_id;
    } else {
      if (!payer.can_ach_debit) {
        return json({ error: "Your payment account cannot pull funds from your bank yet." }, 409);
      }
      const { data: bank } = await supabase
        .from("payment_provider_methods").select("*")
        .eq("tenant_id", tenant_id).eq("provider", "moov").eq("environment", environment)
        .eq("provider_account_id", accountId).eq("connection_status", "connected")
        .order("is_default", { ascending: false }).limit(1).maybeSingle();
      if (!bank) return json({ error: "Connect an eligible business bank account first." }, 409);
      sourcePaymentMethodId = bank.provider_payment_method_id ?? bank.provider_bank_account_id;
      sourceMethodRowId = bank.id;
    }

    /* ---------- Resolve every destination BEFORE moving money ---------- */

    const resolved: Array<LegInput & { methodRow: any; methodId: string; label: string }> = [];
    for (const leg of parsed) {
      let methodRow: any = null;
      let label = "recipient";

      if (leg.recipient_tenant_id) {
        const { data: payee } = await supabase
          .from("payment_provider_accounts").select("*")
          .eq("tenant_id", leg.recipient_tenant_id).eq("provider", "moov")
          .eq("environment", environment).maybeSingle();
        if (payee?.provider_account_id) {
          const { data: m } = await supabase
            .from("payment_provider_methods").select("*")
            .eq("tenant_id", leg.recipient_tenant_id).eq("provider", "moov")
            .eq("environment", environment).eq("provider_account_id", payee.provider_account_id)
            .eq("connection_status", "connected")
            .order("is_default", { ascending: false }).limit(1).maybeSingle();
          methodRow = m;
        }
        label = "partner organization";
      } else {
        const { data: m } = await supabase
          .from("payment_provider_methods").select("*")
          .eq("recipient_id", leg.external_recipient_id).eq("provider", "moov")
          .eq("environment", environment).eq("connection_status", "connected")
          .order("is_default", { ascending: false }).limit(1).maybeSingle();
        methodRow = m;
        label = "recipient";
      }

      const methodId = methodRow?.provider_payment_method_id ?? methodRow?.provider_bank_account_id;
      if (!methodId) {
        return json({
          error: "recipient_setup_required",
          message: "One of the recipients has not connected a bank account yet.",
          recipient_tenant_id: leg.recipient_tenant_id ?? null,
          external_recipient_id: leg.external_recipient_id ?? null,
        }, 409);
      }
      resolved.push({ ...leg, methodRow, methodId, label });
    }

    /* ---------- Group record (idempotent) ---------- */

    const key = idempotency_key ??
      `split:${tenant_id}:${check_id ?? claim_id ?? "adhoc"}:${total}:${resolved.length}`;

    const { data: existingGroup } = await supabase
      .from("payment_transfer_groups").select("*")
      .eq("tenant_id", tenant_id).eq("idempotency_key", key).maybeSingle();
    if (existingGroup) {
      const { data: existingLegs } = await supabase
        .from("payment_transfers").select("*")
        .eq("transfer_group_id", existingGroup.id);
      return json({ success: true, duplicate: true, group: existingGroup, transfers: existingLegs ?? [] });
    }

    const { data: group, error: groupErr } = await supabase
      .from("payment_transfer_groups")
      .insert({
        tenant_id,
        provider: "moov",
        environment,
        status: "submitting",
        idempotency_key: key,
        description,
        claim_id,
        check_id,
        source_kind,
        source_payment_method_id: sourceMethodRowId,
        source_wallet_id: wallet.id,
        total_amount_cents: total,
        facilitator_fee_cents: fee,
        net_amount_cents: legTotal,
        leg_count: resolved.length,
        created_by: userId,
      })
      .select().single();
    if (groupErr) return json({ error: groupErr.message }, 500);

    const fail = async (reason: string, status = 502) => {
      await supabase.from("payment_transfer_groups")
        .update({ status: "failed", failure_reason: reason }).eq("id", group.id);
      return json({ error: reason, group_id: group.id }, status);
    };

    /* ---------- Parent leg: funds into the tenant balance ---------- */

    const { data: parentDraft } = await supabase
      .from("payment_transfers")
      .insert({
        tenant_id, provider: "moov", environment, status: "ready",
        idempotency_key: `${key}:parent`,
        amount_cents: total,
        platform_fee_cents: fee,
        net_amount_cents: legTotal,
        speed: "standard",
        description: description ?? "Settlement split",
        source_tenant_account_id: accountId,
        source_payment_method_id: sourceMethodRowId,
        destination_tenant_id: tenant_id,
        transfer_group_id: group.id,
        leg_role: "parent",
        wallet_id: wallet.id,
        claim_id, check_id, created_by: userId,
      })
      .select().single();

    let parent: any;
    try {
      parent = await moovFetch<any>(`/accounts/${await facilitatorAccountId(accountId)}/transfers`, {
        method: "POST",
        scopes: scopes.transfersWrite(await facilitatorAccountId(accountId)),
        idempotencyKey: `checksops-group-parent-${group.id}`,
        body: {
          source: { paymentMethodID: sourcePaymentMethodId },
          destination: { paymentMethodID: wallet.provider_payment_method_id },
          amount: { currency: "USD", value: total },
          ...(fee > 0 ? { facilitatorFee: { total: fee } } : {}),
          description: (description ?? "ChecksOps settlement split").slice(0, 128),
          metadata: {
            checksops_group_id: group.id,
            checksops_tenant_id: tenant_id,
            claim_id: claim_id ?? "",
            check_id: check_id ?? "",
          },
        },
      });
    } catch (e) {
      if (parentDraft) {
        await supabase.from("payment_transfers")
          .update({ status: "failed", failure_reason: (e as Error).message })
          .eq("id", parentDraft.id);
      }
      return await fail((e as Error).message);
    }

    const parentTransferId = parent?.transferID ?? parent?.transferId ?? null;
    const parentStatus = normalizeTransferStatus(parent?.status);

    await supabase.from("payment_transfers").update({
      provider_transfer_id: parentTransferId,
      provider_status: parent?.status ?? null,
      status: parentStatus,
      submitted_at: new Date().toISOString(),
      provider_metadata: sanitize(parent ?? {}),
    }).eq("id", parentDraft!.id);

    if (!parentTransferId) return await fail("The provider did not return a transfer reference.");

    /* ---------- Child legs ---------- */

    const childRows: any[] = [];
    for (const leg of resolved) {
      const { data: childDraft } = await supabase
        .from("payment_transfers")
        .insert({
          tenant_id, provider: "moov", environment, status: "ready",
          idempotency_key: `${key}:${leg.role ?? "leg"}:${leg.recipient_tenant_id ?? leg.external_recipient_id}`,
          amount_cents: leg.amount_cents,
          platform_fee_cents: 0,
          net_amount_cents: leg.amount_cents,
          speed: "standard",
          description: leg.description ?? description ?? "Settlement split",
          source_tenant_account_id: accountId,
          destination_tenant_id: leg.recipient_tenant_id ?? null,
          destination_recipient_id: leg.external_recipient_id ?? null,
          destination_payment_method_id: leg.methodRow?.id ?? null,
          transfer_group_id: group.id,
          leg_role: leg.role ?? "other",
          wallet_id: wallet.id,
          claim_id, check_id, created_by: userId,
        })
        .select().single();

      try {
        const child = await moovFetch<any>(`/accounts/${await facilitatorAccountId(accountId)}/transfers`, {
          method: "POST",
          scopes: scopes.transfersWrite(await facilitatorAccountId(accountId)),
          idempotencyKey: `checksops-group-child-${childDraft!.id}`,
          body: {
            source: { transferID: parentTransferId },
            destination: { paymentMethodID: leg.methodId },
            amount: { currency: "USD", value: leg.amount_cents },
            description: (leg.description ?? description ?? `ChecksOps payment to ${leg.label}`).slice(0, 128),
            metadata: {
              checksops_group_id: group.id,
              checksops_transfer_id: childDraft!.id,
              leg_role: leg.role ?? "other",
            },
          },
        });

        const { data: saved } = await supabase.from("payment_transfers").update({
          provider_transfer_id: child?.transferID ?? child?.transferId ?? null,
          provider_status: child?.status ?? null,
          status: normalizeTransferStatus(child?.status),
          submitted_at: new Date().toISOString(),
          provider_metadata: sanitize(child ?? {}),
        }).eq("id", childDraft!.id).select().single();
        childRows.push(saved);
      } catch (e) {
        const { data: saved } = await supabase.from("payment_transfers").update({
          status: "failed", failure_reason: (e as Error).message,
        }).eq("id", childDraft!.id).select().single();
        childRows.push(saved);
      }
    }

    const anyFailed = childRows.some((r) => r?.status === "failed");
    const { data: finalGroup } = await supabase
      .from("payment_transfer_groups")
      .update({
        provider_group_id: parent?.groupID ?? parentTransferId,
        status: anyFailed ? "partially_failed" : "submitted",
        submitted_at: new Date().toISOString(),
        provider_metadata: sanitize(parent ?? {}),
      })
      .eq("id", group.id).select().single();

    // Trust wallets keep a per-matter sub-ledger: record the reservation now so
    // the matter balance can never be spent twice.
    if (wallet_type === "trust" && sub_ledger_id && parentStatus === "completed") {
      await writeLedgerEntry(supabase, {
        wallet_id: wallet.id,
        tenant_id,
        direction: "credit",
        entry_type: "settlement_received",
        amount_cents: total,
        sub_ledger_id,
        transfer_group_id: group.id,
        claim_id, check_id,
        reference: `group-parent:${group.id}`,
        memo: description ?? "Settlement received",
        created_by: userId,
      });
    }

    await logPaymentEvent(supabase, {
      tenant_id,
      provider_transfer_id: parentTransferId,
      event_type: "transfer_group.created",
      new_status: finalGroup?.status ?? "submitted",
      environment,
      provider_metadata: { legs: childRows.length, facilitator_fee_cents: fee },
    });

    return json({ success: true, duplicate: false, group: finalGroup, transfers: childRows });
  } catch (e) {
    console.error("[moov-transfer-group-create]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
