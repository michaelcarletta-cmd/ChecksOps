// Shared "pull money from the tenant's own bank into their balance" routine.
//
// Used by the interactive funding endpoint and by the automatic fund-on-clear
// worker. The source of funds is ALWAYS a bank account belonging to the
// initiating tenant — ChecksOps never holds or fronts tenant money.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { moovFetch, normalizeTransferStatus, scopes } from "./moovClient.ts";
import { logPaymentEvent, sanitize } from "./moovGuard.ts";
import { syncWallet, writeLedgerEntry } from "./moovWallet.ts";

export interface FundWalletArgs {
  tenantId: string;
  amountCents: number;
  environment: string;
  walletType?: "operating" | "trust";
  description?: string | null;
  idempotencyKey?: string | null;
  subLedgerId?: string | null;
  createdBy?: string | null;
}

export interface FundWalletResult {
  ok: boolean;
  /** Retryable (bank/provider timing) vs terminal (setup missing) failure. */
  retryable?: boolean;
  error?: string;
  duplicate?: boolean;
  transferId?: string;
  status?: string;
  wallet?: Record<string, unknown> | null;
}

export async function fundWalletFromBank(
  supabase: SupabaseClient,
  args: FundWalletArgs,
): Promise<FundWalletResult> {
  const walletType = args.walletType ?? "operating";
  const amount = Math.round(Number(args.amountCents));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, retryable: false, error: "Amount must be greater than zero." };
  }

  const { data: account } = await supabase
    .from("payment_provider_accounts")
    .select("*")
    .eq("tenant_id", args.tenantId)
    .eq("provider", "moov")
    .eq("environment", args.environment)
    .maybeSingle();

  if (!account?.provider_account_id) {
    return { ok: false, retryable: false, error: "Payment account is not set up." };
  }
  if (account.onboarding_status !== "active") {
    return {
      ok: false,
      retryable: true,
      error: `Payment account is not active yet (${account.onboarding_status}).`,
    };
  }
  if (!account.can_ach_debit) {
    return { ok: false, retryable: true, error: "Payment account cannot pull funds yet." };
  }

  const { data: source } = await supabase
    .from("payment_provider_methods")
    .select("*")
    .eq("tenant_id", args.tenantId)
    .eq("provider", "moov")
    .eq("environment", args.environment)
    .eq("provider_account_id", account.provider_account_id)
    .eq("connection_status", "connected")
    .order("is_default", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!source) {
    return { ok: false, retryable: true, error: "No connected bank account to pull from." };
  }

  const wallet = await syncWallet(supabase, {
    tenantId: args.tenantId,
    accountId: account.provider_account_id,
    environment: args.environment,
    walletType,
  });
  if (!wallet.provider_payment_method_id) {
    return { ok: false, retryable: true, error: "Balance account is not ready to receive funds." };
  }

  const key = args.idempotencyKey ??
    `wallet-fund:${args.tenantId}:${walletType}:${amount}`;

  const { data: existing } = await supabase
    .from("payment_transfers").select("*")
    .eq("tenant_id", args.tenantId).eq("idempotency_key", key).maybeSingle();
  if (existing) {
    return {
      ok: true,
      duplicate: true,
      transferId: existing.id,
      status: existing.status,
      wallet: wallet as unknown as Record<string, unknown>,
    };
  }

  const { data: draft, error: draftErr } = await supabase
    .from("payment_transfers")
    .insert({
      tenant_id: args.tenantId,
      provider: "moov",
      environment: args.environment,
      status: "ready",
      idempotency_key: key,
      amount_cents: amount,
      platform_fee_cents: 0,
      net_amount_cents: amount,
      speed: "standard",
      description: args.description ?? "Balance funding",
      source_tenant_account_id: account.provider_account_id,
      source_payment_method_id: source.id,
      destination_tenant_id: args.tenantId,
      wallet_id: wallet.id,
      leg_role: "wallet_funding",
      created_by: args.createdBy ?? null,
    })
    .select().single();
  if (draftErr) return { ok: false, retryable: true, error: draftErr.message };

  let created: Record<string, unknown>;
  try {
    created = await moovFetch<Record<string, unknown>>("/transfers", {
      method: "POST",
      scopes: scopes.transfersWrite(account.provider_account_id),
      idempotencyKey: `checksops-wallet-fund-${draft.id}`,
      onBehalfOf: account.provider_account_id,
      body: {
        source: {
          paymentMethodID:
            source.provider_payment_method_id ?? source.provider_bank_account_id,
        },
        destination: { paymentMethodID: wallet.provider_payment_method_id },
        amount: { currency: "USD", value: amount },
        description: (args.description ?? "ChecksOps balance funding").slice(0, 128),
        metadata: {
          checksops_transfer_id: draft.id,
          checksops_tenant_id: args.tenantId,
        },
      },
    });
  } catch (e) {
    await supabase.from("payment_transfers")
      .update({ status: "failed", failure_reason: (e as Error).message })
      .eq("id", draft.id);
    return { ok: false, retryable: true, error: (e as Error).message };
  }

  const providerTransferId =
    (created as any)?.transferID ?? (created as any)?.transferId ?? null;
  const status = normalizeTransferStatus((created as any)?.status);

  await supabase
    .from("payment_transfers")
    .update({
      provider_transfer_id: providerTransferId,
      provider_status: (created as any)?.status ?? null,
      status,
      submitted_at: new Date().toISOString(),
      provider_metadata: sanitize(created ?? {}),
    })
    .eq("id", draft.id);

  // The balance only moves in our ledger once the provider says it completed.
  if (status === "completed") {
    await writeLedgerEntry(supabase, {
      wallet_id: wallet.id,
      tenant_id: args.tenantId,
      direction: "credit",
      entry_type: "funding",
      amount_cents: amount,
      sub_ledger_id: args.subLedgerId ?? null,
      transfer_id: draft.id,
      provider_transfer_id: providerTransferId,
      reference: `transfer:${draft.id}`,
      memo: args.description ?? "Balance funding",
      created_by: args.createdBy ?? null,
    });
  }

  await logPaymentEvent(supabase, {
    tenant_id: args.tenantId,
    transfer_id: draft.id,
    provider_transfer_id: providerTransferId,
    event_type: "wallet.funding.created",
    new_status: status,
    environment: args.environment,
  });

  const refreshed = await syncWallet(supabase, {
    tenantId: args.tenantId,
    accountId: account.provider_account_id,
    environment: args.environment,
    walletType,
  }).catch(() => wallet);

  return {
    ok: true,
    duplicate: false,
    transferId: draft.id,
    status,
    wallet: refreshed as unknown as Record<string, unknown>,
  };
}
