import { supabase } from "@/integrations/supabase/client";

/**
 * Provider-agnostic access to organization balances (wallets).
 *
 * A balance lets an organization pre-fund once and pay out of that balance,
 * instead of pulling from the bank on every single payout. Trust balances add
 * per-matter sub-ledgers that can never go negative — the rule attorney trust
 * and IOLTA accounts are held to.
 */

export type WalletType = "operating" | "trust";

export interface Wallet {
  id: string;
  tenant_id: string;
  wallet_type: WalletType;
  name: string;
  currency: string;
  available_cents: number;
  pending_cents: number;
  status: string;
  last_synced_at: string | null;
  provider_wallet_id?: string | null;
  environment?: string | null;
  synchronized?: boolean | null;
}

export interface WalletLedgerEntry {
  id: string;
  wallet_id: string;
  sub_ledger_id: string | null;
  direction: "credit" | "debit";
  entry_type: string;
  amount_cents: number;
  balance_after_cents: number;
  claim_id: string | null;
  check_id: string | null;
  memo: string | null;
  created_at: string;
}

export interface WalletSubLedger {
  id: string;
  wallet_id: string;
  claim_id: string | null;
  matter_reference: string | null;
  client_name: string;
  balance_cents: number;
  status: string;
}

export interface WalletSnapshot {
  wallet: Wallet;
  ledger: WalletLedgerEntry[];
  sub_ledgers: WalletSubLedger[];
}

async function invoke<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    let message = error.message ?? `${fn} failed`;
    try {
      const parsed = await (error as any).context?.json?.();
      if (parsed?.message) message = parsed.message;
      else if (parsed?.error) message = parsed.error;
    } catch {
      /* keep the original message */
    }
    throw new Error(message);
  }
  if ((data as any)?.error) throw new Error((data as any).error);
  return data as T;
}

/** Refreshes the balance from the provider and returns it with its ledger. */
export async function syncWallet(
  tenantId: string,
  walletType: WalletType = "operating",
): Promise<WalletSnapshot> {
  return invoke<WalletSnapshot>("moov-wallet-sync", {
    tenant_id: tenantId,
    wallet_type: walletType,
  });
}

/** Pulls money from the organization's own bank account into its balance. */
export async function fundWallet(input: {
  tenantId: string;
  amountCents: number;
  walletType?: WalletType;
  subLedgerId?: string | null;
  description?: string;
  idempotencyKey?: string;
}): Promise<{ transfer: Record<string, unknown>; wallet: Wallet; duplicate: boolean }> {
  return invoke("moov-wallet-fund", {
    tenant_id: input.tenantId,
    amount_cents: input.amountCents,
    wallet_type: input.walletType ?? "operating",
    sub_ledger_id: input.subLedgerId ?? null,
    description: input.description ?? null,
    idempotency_key: input.idempotencyKey,
  });
}

const tenantMoovEnvironment = async (tenantId: string) => {
  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .select("moov_environment")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantError) throw tenantError;
  return String((tenant as any)?.moov_environment || "").toLowerCase() === "production"
    ? "production"
    : "sandbox";
};

/** Reads the locally stored balance without calling the provider. */
export async function readWallet(
  tenantId: string,
  walletType: WalletType = "operating",
): Promise<Wallet | null> {
  const environment = await tenantMoovEnvironment(tenantId);
  const { data, error } = await supabase
    .from("payment_wallets")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("wallet_type", walletType)
    .eq("environment", environment)
    .maybeSingle();
  if (error) throw error;
  return (data as Wallet) ?? null;
}

/** Local environment-scoped wallet, ledger, and money intents. No provider POST. */
export async function readWalletSnapshot(
  tenantId: string,
  walletType: WalletType = "operating",
  ledgerLimit = 50,
): Promise<WalletSnapshot & { transfers: Record<string, unknown>[] }> {
  const environment = await tenantMoovEnvironment(tenantId);
  const wallet = await readWallet(tenantId, walletType);
  if (!wallet?.id) {
    const { data: transfers, error: transferError } = await supabase
      .from("payment_transfers")
      .select(
        "id, amount_cents, status, provider_status, speed, selected_rail, description, created_at, completed_at, leg_role, is_facilitator_fee, provider_transfer_id",
      )
      .eq("tenant_id", tenantId)
      .eq("environment", environment)
      .order("created_at", { ascending: false })
      .limit(ledgerLimit);
    if (transferError) throw transferError;
    return { wallet: null as unknown as Wallet, ledger: [], sub_ledgers: [], transfers: transfers ?? [] };
  }

  const [{ data: ledger, error: ledgerError }, { data: subLedgers, error: subError }, { data: transfers, error: transferError }] =
    await Promise.all([
      supabase
        .from("payment_wallet_ledger")
        .select("*")
        .eq("wallet_id", wallet.id)
        .order("created_at", { ascending: false })
        .limit(Math.min(Number(ledgerLimit) || 50, 200)),
      supabase
        .from("payment_wallet_sub_ledgers")
        .select("*")
        .eq("wallet_id", wallet.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("payment_transfers")
        .select(
          "id, amount_cents, status, provider_status, speed, selected_rail, description, created_at, completed_at, leg_role, is_facilitator_fee, provider_transfer_id",
        )
        .eq("tenant_id", tenantId)
        .eq("environment", environment)
        .order("created_at", { ascending: false })
        .limit(ledgerLimit),
    ]);
  if (ledgerError) throw ledgerError;
  if (subError) throw subError;
  if (transferError) throw transferError;
  return {
    wallet,
    ledger: (ledger ?? []) as WalletLedgerEntry[],
    sub_ledgers: (subLedgers ?? []) as WalletSubLedger[],
    transfers: transfers ?? [],
  };
}

/** Opens a per-matter sub-ledger inside a trust balance. */
export async function createSubLedger(input: {
  walletId: string;
  tenantId: string;
  clientName: string;
  claimId?: string | null;
  matterReference?: string | null;
  notes?: string | null;
}): Promise<WalletSubLedger> {
  const { data, error } = await supabase
    .from("payment_wallet_sub_ledgers")
    .insert({
      wallet_id: input.walletId,
      tenant_id: input.tenantId,
      client_name: input.clientName,
      claim_id: input.claimId ?? null,
      matter_reference: input.matterReference ?? null,
      notes: input.notes ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data as WalletSubLedger;
}
