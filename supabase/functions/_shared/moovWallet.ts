// Shared wallet helpers: provisioning, balance sync, and ledger writes.
//
// A wallet is a per-tenant balance held at the provider. ChecksOps never
// commingles funds: every tenant has its own wallet, and attorney/trust
// tenants get a second `trust` wallet whose per-matter sub-ledgers can never
// go negative (enforced by a CHECK constraint in the database).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { moovFetch } from "./moovClient.ts";

export type WalletType = "operating" | "trust";

export interface WalletRow {
  id: string;
  tenant_id: string;
  provider_wallet_id: string | null;
  provider_account_id: string | null;
  provider_payment_method_id: string | null;
  wallet_type: WalletType;
  available_cents: number;
  pending_cents: number;
  status: string;
}

const walletScopes = {
  read: (id: string) => [`/accounts/${id}/wallets.read`],
  write: (id: string) => [`/accounts/${id}/wallets.write`],
  methods: (id: string) => [`/accounts/${id}/payment-methods.read`],
};

/** Finds the provider wallet for an account, creating one if none exists. */
async function ensureProviderWallet(
  accountId: string,
  walletType: WalletType,
  name: string,
  knownWalletId?: string | null,
  allowCreate = true,
): Promise<{ walletID: string; availableCents: number; pendingCents: number }> {
  let list: any[] = [];
  try {
    list = await moovFetch<any[]>(`/accounts/${accountId}/wallets`, {
      scopes: walletScopes.read(accountId),
    });
  } catch (e) {
    console.warn("[ensureProviderWallet] Could not list wallets", (e as Error).message);
    // If we can't list, we assume we might need to create or we return empty if it's a 403
    if ((e as any).status !== 403) throw e;
  }

  console.log("[ensureProviderWallet] provider wallets", JSON.stringify(list ?? []));

  // Always prefer the wallet we already synced before — provider list order is
  // not stable, and picking a different wallet makes the balance look like it
  // vanished.
  const pinned = knownWalletId
    ? (list ?? []).find((w: any) => (w?.walletID ?? w?.walletId) === knownWalletId)
    : null;

  const wanted = pinned ?? (list ?? []).find((w: any) =>
    walletType === "trust"
      ? String(w?.name ?? w?.metadata?.walletType ?? "").toLowerCase().includes("trust")
      : !String(w?.name ?? "").toLowerCase().includes("trust")
  ) ?? (walletType === "operating" ? (list ?? [])[0] : null);

  let wallet = wanted;
  if (!wallet) {
    if (!allowCreate) {
      throw new Error("Wallet is missing. Do not create a new Moov wallet for this already-approved account.");
    }
    try {
      wallet = await moovFetch<any>(`/accounts/${accountId}/wallets`, {
        method: "POST",
        scopes: walletScopes.write(accountId),
        body: { name, description: `ChecksOps ${walletType} wallet` },
      });
    } catch (e) {
      console.warn("[ensureProviderWallet] Could not create wallet", (e as Error).message);
      throw e;
    }
  }

  const available = wallet?.availableBalance?.valueDecimal
    ? Math.round(Number(wallet.availableBalance.valueDecimal) * 100)
    : Number(wallet?.availableBalance?.value ?? 0);
  const pending = Number(wallet?.pendingBalance?.value ?? 0);

  return {
    walletID: wallet?.walletID ?? wallet?.walletId,
    availableCents: Number.isFinite(available) ? available : 0,
    pendingCents: Number.isFinite(pending) ? pending : 0,
  };
}

/** Resolves the `moov-wallet` payment method id used as a transfer endpoint. */
export async function walletPaymentMethodId(
  accountId: string,
  walletId: string,
): Promise<string | null> {
  const methods = await moovFetch<any[]>(`/accounts/${accountId}/payment-methods`, {
    scopes: walletScopes.methods(accountId),
  });
  const match = (methods ?? []).find(
    (m: any) =>
      m?.paymentMethodType === "moov-wallet" &&
      (m?.wallet?.walletID ?? m?.wallet?.walletId) === walletId,
  );
  return match?.paymentMethodID ?? match?.paymentMethodId ?? null;
}

/**
 * Provisions (if needed) and refreshes the local wallet row from the provider.
 * The provider is always the source of truth for the balance.
 */
export async function syncWallet(
  supabase: SupabaseClient,
  args: {
    tenantId: string;
    accountId: string;
    environment: string;
    walletType?: WalletType;
    skipProviderFetch?: boolean;
    knownWalletId?: string | null;
    allowCreate?: boolean;
  },
): Promise<WalletRow> {
  const walletType: WalletType = args.walletType ?? "operating";
  const name = walletType === "trust" ? "Trust wallet" : "Operating wallet";

  // Check if we already have a wallet record with a provider ID
  const existing = await readWallet(supabase, args.tenantId, args.environment, walletType);
  
  let providerWalletId = existing?.provider_wallet_id || args.knownWalletId || null;
  let availableCents = existing?.available_cents ?? 0;
  let pendingCents = existing?.pending_cents ?? 0;

  if (!args.skipProviderFetch || !providerWalletId) {
    const provider = await ensureProviderWallet(
      args.accountId,
      walletType,
      name,
      providerWalletId,
      args.allowCreate !== false,
    );
    providerWalletId = provider.walletID;
    availableCents = provider.availableCents;
    pendingCents = provider.pendingCents;
  }

  const pmId = providerWalletId
    ? await walletPaymentMethodId(args.accountId, providerWalletId)
    : null;

  const { data, error } = await supabase
    .from("payment_wallets")
    .upsert(
      {
        tenant_id: args.tenantId,
        provider: "moov",
        environment: args.environment,
        wallet_type: walletType,
        name,
        provider_wallet_id: providerWalletId ?? null,
        provider_account_id: args.accountId,
        provider_payment_method_id: pmId,
        available_cents: availableCents,
        pending_cents: pendingCents,
        status: "active",
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,provider,environment,wallet_type" },
    )
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data as WalletRow;
}

/** Reads the local wallet row without hitting the provider. */
export async function readWallet(
  supabase: SupabaseClient,
  tenantId: string,
  environment: string,
  walletType: WalletType = "operating",
): Promise<WalletRow | null> {
  const { data } = await supabase
    .from("payment_wallets")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("provider", "moov")
    .eq("environment", environment)
    .eq("wallet_type", walletType)
    .maybeSingle();
  return (data as WalletRow) ?? null;
}

/**
 * Appends a wallet ledger entry. `reference` makes the write idempotent —
 * replaying the same provider event never double-counts a balance.
 * Balances (wallet + trust sub-ledger) are maintained by a database trigger.
 */
export async function writeLedgerEntry(
  supabase: SupabaseClient,
  entry: {
    wallet_id: string;
    tenant_id: string;
    direction: "credit" | "debit";
    entry_type: string;
    amount_cents: number;
    sub_ledger_id?: string | null;
    transfer_id?: string | null;
    transfer_group_id?: string | null;
    claim_id?: string | null;
    check_id?: string | null;
    provider_transfer_id?: string | null;
    reference?: string | null;
    memo?: string | null;
    created_by?: string | null;
  },
): Promise<{ applied: boolean; error?: string }> {
  const { error } = await supabase.from("payment_wallet_ledger").insert(entry);
  if (!error) return { applied: true };
  // Unique reference violation => already applied. Not an error.
  if (error.code === "23505") return { applied: false };
  return { applied: false, error: error.message };
}

/**
 * Posts (or reverses) the wallet ledger entry for a transfer whose status just
 * became terminal. Safe to call repeatedly: `reference` is unique, so a replay
 * from the webhook AND the status poller can never double-count a balance.
 */
export async function postTransferLedger(
  supabase: SupabaseClient,
  transfer: {
    id: string;
    tenant_id: string;
    wallet_id: string | null;
    amount_cents: number | string;
    leg_role?: string | null;
    transfer_group_id?: string | null;
    claim_id?: string | null;
    check_id?: string | null;
    description?: string | null;
  },
  status: string,
  providerTransferId?: string | null,
): Promise<void> {
  if (!transfer.wallet_id) return;

  const amount = Number(transfer.amount_cents || 0);
  if (!Number.isFinite(amount) || amount <= 0) return;

  const incoming = transfer.leg_role === "wallet_funding" || transfer.leg_role === "parent";

  if (status === "completed") {
    await writeLedgerEntry(supabase, {
      wallet_id: transfer.wallet_id,
      tenant_id: transfer.tenant_id,
      direction: incoming ? "credit" : "debit",
      entry_type: incoming
        ? (transfer.leg_role === "parent" ? "settlement_received" : "funding")
        : "payout",
      amount_cents: amount,
      transfer_id: transfer.id,
      transfer_group_id: transfer.transfer_group_id ?? null,
      claim_id: transfer.claim_id ?? null,
      check_id: transfer.check_id ?? null,
      provider_transfer_id: providerTransferId ?? null,
      reference: `transfer:${transfer.id}`,
      memo: transfer.description ?? null,
    });
    return;
  }

  // A transfer that already posted and then failed/returned must be undone so
  // the local balance keeps matching the provider.
  if (["failed", "returned", "reversed", "canceled", "cancelled"].includes(status)) {
    const { data: posted } = await supabase
      .from("payment_wallet_ledger")
      .select("id")
      .eq("reference", `transfer:${transfer.id}`)
      .maybeSingle();
    if (!posted) return;

    await writeLedgerEntry(supabase, {
      wallet_id: transfer.wallet_id,
      tenant_id: transfer.tenant_id,
      direction: incoming ? "debit" : "credit",
      entry_type: "reversal",
      amount_cents: amount,
      transfer_id: transfer.id,
      transfer_group_id: transfer.transfer_group_id ?? null,
      claim_id: transfer.claim_id ?? null,
      check_id: transfer.check_id ?? null,
      provider_transfer_id: providerTransferId ?? null,
      reference: `transfer:${transfer.id}:reversal`,
      memo: `Reversed (${status})${transfer.description ? ` — ${transfer.description}` : ""}`,
    });
  }
}
