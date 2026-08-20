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
import { syncWallet, writeLedgerEntry } from "../_shared/moovWallet.ts";

// Funds a tenant's wallet from that tenant's own connected bank account.
//
// This is what removes the "credits only / no reserve" problem: the tenant
// pre-funds their own balance once, then pays out of the balance instead of
// debiting a bank account on every single payout.
//
// The source of funds is ALWAYS a bank account belonging to the initiating
// tenant. ChecksOps never holds or fronts tenant money.

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const {
      tenant_id,
      amount_cents,
      wallet_type = "operating",
      sub_ledger_id = null,
      description = null,
      idempotency_key,
    } = body ?? {};

    if (!tenant_id) return json({ error: "tenant_id is required" }, 400);
    const amount = Number(amount_cents);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: "Amount must be greater than zero." }, 400);
    }
    if (!["operating", "trust"].includes(wallet_type)) {
      return json({ error: "wallet_type must be 'operating' or 'trust'" }, 400);
    }

    const caller = await requireMoovCaller(req, tenant_id);
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    const { data: membership } = await supabase
      .from("tenant_users").select("role")
      .eq("tenant_id", tenant_id).eq("user_id", userId).maybeSingle();
    const { data: adminRole } = await supabase
      .from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
    if (!adminRole && !["owner", "admin", "manager"].includes(String(membership?.role ?? ""))) {
      return json({ error: "You do not have permission to move funds." }, 403);
    }

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

    const { data: source } = await supabase
      .from("payment_provider_methods")
      .select("*")
      .eq("tenant_id", tenant_id).eq("provider", "moov").eq("environment", environment)
      .eq("provider_account_id", account.provider_account_id)
      .eq("connection_status", "connected")
      .order("is_default", { ascending: false })
      .limit(1).maybeSingle();
    if (!source) return json({ error: "Connect an eligible business bank account first." }, 409);

    const wallet = await syncWallet(supabase, {
      tenantId: tenant_id,
      accountId: account.provider_account_id,
      environment,
      walletType: wallet_type,
    });
    if (!wallet.provider_payment_method_id) {
      return json({ error: "Your balance account is not ready to receive funds yet." }, 409);
    }

    const key = idempotency_key ?? `wallet-fund:${tenant_id}:${wallet_type}:${amount}`;

    const { data: existing } = await supabase
      .from("payment_transfers").select("*")
      .eq("tenant_id", tenant_id).eq("idempotency_key", key).maybeSingle();
    if (existing) return json({ success: true, duplicate: true, transfer: existing, wallet });

    const { data: draft, error: draftErr } = await supabase
      .from("payment_transfers")
      .insert({
        tenant_id,
        provider: "moov",
        environment,
        status: "ready",
        idempotency_key: key,
        amount_cents: amount,
        platform_fee_cents: 0,
        net_amount_cents: amount,
        speed: "standard",
        description: description ?? "Balance funding",
        source_tenant_account_id: account.provider_account_id,
        source_payment_method_id: source.id,
        destination_tenant_id: tenant_id,
        wallet_id: wallet.id,
        leg_role: "wallet_funding",
        created_by: userId,
      })
      .select().single();
    if (draftErr) return json({ error: draftErr.message }, 500);

    let created: any;
    try {
      created = await moovFetch<any>(`/accounts/${account.provider_account_id}/transfers`, {
        method: "POST",
        scopes: scopes.transfersWrite(account.provider_account_id),
        idempotencyKey: `checksops-wallet-fund-${draft.id}`,
        onBehalfOf: account.provider_account_id,
        body: {
          source: {
            paymentMethodID: source.provider_payment_method_id ?? source.provider_bank_account_id,
          },
          destination: { paymentMethodID: wallet.provider_payment_method_id },
          amount: { currency: "USD", value: amount },
          description: (description ?? "ChecksOps balance funding").slice(0, 128),
          metadata: { checksops_transfer_id: draft.id, checksops_tenant_id: tenant_id },
        },
      });
    } catch (e) {
      await supabase.from("payment_transfers")
        .update({ status: "failed", failure_reason: (e as Error).message })
        .eq("id", draft.id);
      return json({ error: (e as Error).message }, 502);
    }

    const providerTransferId = created?.transferID ?? created?.transferId ?? null;
    const status = normalizeTransferStatus(created?.status);

    const { data: finalTransfer } = await supabase
      .from("payment_transfers")
      .update({
        provider_transfer_id: providerTransferId,
        provider_status: created?.status ?? null,
        status,
        submitted_at: new Date().toISOString(),
        provider_metadata: sanitize(created ?? {}),
      })
      .eq("id", draft.id).select().single();

    // The balance only moves in our ledger once the provider says it completed.
    if (status === "completed") {
      await writeLedgerEntry(supabase, {
        wallet_id: wallet.id,
        tenant_id,
        direction: "credit",
        entry_type: "funding",
        amount_cents: amount,
        sub_ledger_id,
        transfer_id: draft.id,
        provider_transfer_id: providerTransferId,
        reference: `transfer:${draft.id}`,
        memo: description ?? "Balance funding",
        created_by: userId,
      });
    }

    await logPaymentEvent(supabase, {
      tenant_id,
      transfer_id: draft.id,
      provider_transfer_id: providerTransferId,
      event_type: "wallet.funding.created",
      new_status: status,
      environment,
    });

    const refreshed = await syncWallet(supabase, {
      tenantId: tenant_id,
      accountId: account.provider_account_id,
      environment,
      walletType: wallet_type,
    }).catch(() => wallet);

    return json({ success: true, duplicate: false, transfer: finalTransfer, wallet: refreshed });
  } catch (e) {
    console.error("[moov-wallet-fund]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
