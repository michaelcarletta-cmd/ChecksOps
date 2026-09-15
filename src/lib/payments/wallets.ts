import { supabase } from "@/integrations/supabase/client";
import {
  FIRST_TEST_DISBURSE_FN,
  FIRST_TEST_FUND_FN,
  FIRST_TEST_TRANSFER_CENTS,
  assertFirstTestAmountCents,
  firstTestDisburseBody,
  firstTestFundBody,
  nextFirstTestIdempotencyKey,
} from "./firstTestMoney";

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
  assertFirstTestAmountCents(input.amountCents);
  return invoke(FIRST_TEST_FUND_FN, firstTestFundBody({
    tenantId: input.tenantId,
    idempotencyKey: nextFirstTestIdempotencyKey(input.idempotencyKey),
  }));
}

/** Sends $0.01 from the Freedom wallet to the server-bound first-test recipient. */
export async function disburseWalletFirstTest(input: {
  tenantId?: string | null;
  idempotencyKey?: string;
}): Promise<{ transfer: Record<string, unknown>; duplicate: boolean; error?: string }> {
  return invoke(FIRST_TEST_DISBURSE_FN, firstTestDisburseBody({
    tenantId: input.tenantId ?? null,
    idempotencyKey: nextFirstTestIdempotencyKey(input.idempotencyKey),
  }));
}

export const FIRST_TEST_WALLET_AMOUNT_CENTS = FIRST_TEST_TRANSFER_CENTS;

/** Reads the locally stored balance without calling the provider. */
export async function readWallet(
  tenantId: string,
  walletType: WalletType = "operating",
): Promise<Wallet | null> {
  const { data, error } = await supabase
    .from("payment_wallets")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("wallet_type", walletType)
    .maybeSingle();
  if (error) throw error;
  return (data as Wallet) ?? null;
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
