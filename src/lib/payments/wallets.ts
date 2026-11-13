import { supabase } from "@/integrations/supabase/client";
import {
  normalizePaymentEnvironment,
  PaymentWalletSelectionError,
} from "@/lib/payments/selectPaymentWallet";
import {
  PER_DAY_LIMIT_FIELD,
  PER_TRANSFER_LIMIT_FIELD,
  TRANSFER_TO_BANK_LABEL,
  WALLET_WITHDRAW_FUNCTION,
  WALLET_WITHDRAW_LIMITS_FUNCTION,
  withdrawErrorMessage,
  type WithdrawErrorReply,
  type WithdrawLimits,
  type WithdrawReply,
} from "@/lib/payments/walletWithdraw";

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
  opts?: { force?: boolean },
): Promise<WalletSnapshot> {
  return invoke<WalletSnapshot>("moov-wallet-sync", {
    tenant_id: tenantId,
    wallet_type: walletType,
    force: !!opts?.force,
  });
}

/** A funding request the server refused; `code` is the server's error code. */
export class WalletFundError extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message);
    this.name = "WalletFundError";
  }
}

/**
 * Pulls money from the organization's own bank account into its balance.
 * `idempotencyKey` identifies one click: retrying with the same key never
 * sends a second transfer.
 */
export async function fundWallet(input: {
  tenantId: string;
  amountCents: number;
  idempotencyKey: string;
  walletType?: WalletType;
  subLedgerId?: string | null;
  description?: string;
}): Promise<{ transfer: Record<string, unknown>; wallet?: Wallet; duplicate: boolean; message?: string }> {
  const { data, error } = await supabase.functions.invoke("moov-wallet-fund", {
    body: {
      tenant_id: input.tenantId,
      amount_cents: input.amountCents,
      wallet_type: input.walletType ?? "operating",
      sub_ledger_id: input.subLedgerId ?? null,
      description: input.description ?? null,
      idempotency_key: input.idempotencyKey,
    },
  });
  type FundReply = { error?: unknown; message?: unknown };
  const failure = (reply: FundReply | null | undefined, fallback: string) => {
    const code = typeof reply?.error === "string" ? reply.error : null;
    const message = typeof reply?.message === "string" && reply.message ? reply.message : code || fallback;
    return new WalletFundError(message, code);
  };
  if (error) {
    // Supabase puts a Response on `context`; AWS puts the parsed reply on `context.body` (and `data`).
    const context = (error as { context?: { body?: unknown; json?: () => Promise<FundReply> } }).context;
    let reply: FundReply | null = null;
    if (typeof context?.json === "function") {
      try {
        reply = await context.json();
      } catch {
        /* keep the original message */
      }
    } else if (context?.body && typeof context.body === "object") {
      reply = context.body as FundReply;
    }
    reply = reply ?? (data as FundReply | null) ?? null;
    throw failure(reply, error.message ?? "Funding failed");
  }
  if ((data as FundReply | null)?.error) throw failure(data as FundReply, "Funding failed");
  return data as { transfer: Record<string, unknown>; wallet?: Wallet; duplicate: boolean; message?: string };
}

/** A transfer-to-bank or limits request the server refused; `code` is the server's error code. */
export class WalletWithdrawError extends Error {
  constructor(message: string, readonly code: string | null, readonly reply: WithdrawErrorReply | null = null) {
    super(message);
    this.name = "WalletWithdrawError";
  }
}

/** The reply body of a refused function call: Supabase puts a Response on `context`, AWS the parsed body on `context.body`. */
async function refusedReply(error: unknown, data: unknown): Promise<WithdrawErrorReply | null> {
  const context = (error as { context?: { body?: unknown; json?: () => Promise<WithdrawErrorReply> } } | null)?.context;
  if (typeof context?.json === "function") {
    try {
      return await context.json();
    } catch {
      /* fall through to data */
    }
  } else if (context?.body && typeof context.body === "object") {
    return context.body as WithdrawErrorReply;
  }
  return data && typeof data === "object" ? (data as WithdrawErrorReply) : null;
}

async function invokeWithdrawRoute<T>(fn: string, body: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  const refused = (reply: WithdrawErrorReply | null) => {
    const code = typeof reply?.error === "string" ? reply.error : null;
    return new WalletWithdrawError(code || reply?.message ? withdrawErrorMessage(code, reply) : fallback, code, reply);
  };
  if (error) throw refused(await refusedReply(error, data));
  const reply = data as (WithdrawErrorReply & { ok?: boolean }) | null;
  if (reply?.error || reply?.ok === false) throw refused(reply);
  return data as T;
}

/**
 * Sends money from the operating wallet to the organization's default bank by same-day ACH
 * (moov-wallet-withdraw). The server picks the bank; the browser never names one.
 * `idempotencyKey` identifies one confirmation: retrying with the same key never sends twice.
 */
export function withdrawToBank(input: {
  tenantId: string;
  amountCents: number;
  idempotencyKey: string;
}): Promise<WithdrawReply> {
  return invokeWithdrawRoute<WithdrawReply>(
    WALLET_WITHDRAW_FUNCTION,
    {
      tenant_id: input.tenantId,
      wallet_type: "operating",
      amount_cents: input.amountCents,
      idempotency_key: input.idempotencyKey,
      description: TRANSFER_TO_BANK_LABEL,
    },
    "The transfer to your bank could not be started. Nothing was sent.",
  );
}

const limitsOf = (reply: { limits?: Partial<WithdrawLimits> | null } | null): WithdrawLimits => ({
  [PER_TRANSFER_LIMIT_FIELD]: reply?.limits?.[PER_TRANSFER_LIMIT_FIELD] ?? null,
  [PER_DAY_LIMIT_FIELD]: reply?.limits?.[PER_DAY_LIMIT_FIELD] ?? null,
});

/** The organization's transfer-to-bank limits; null means no limit. Reading needs no two-factor. */
export async function readWithdrawLimits(tenantId: string): Promise<WithdrawLimits> {
  return limitsOf(
    await invokeWithdrawRoute<{ limits?: WithdrawLimits }>(
      WALLET_WITHDRAW_LIMITS_FUNCTION,
      { action: "get", tenant_id: tenantId },
      "Could not load transfer limits.",
    ),
  );
}

/** Saves both limits (null = no limit). The server answers totp_required until the wallet.fund code is entered. */
export async function saveWithdrawLimits(tenantId: string, limits: WithdrawLimits): Promise<WithdrawLimits> {
  return limitsOf(
    await invokeWithdrawRoute<{ limits?: WithdrawLimits }>(
      WALLET_WITHDRAW_LIMITS_FUNCTION,
      {
        action: "save",
        tenant_id: tenantId,
        [PER_TRANSFER_LIMIT_FIELD]: limits[PER_TRANSFER_LIMIT_FIELD],
        [PER_DAY_LIMIT_FIELD]: limits[PER_DAY_LIMIT_FIELD],
      },
      "Could not save transfer limits.",
    ),
  );
}

/** Reads the locally stored balance without calling the provider. */
export async function readWallet(
  tenantId: string,
  walletType: WalletType = "operating",
  environment?: string | null,
): Promise<Wallet | null> {
  const env = normalizePaymentEnvironment(environment);
  if (!env) {
    throw new PaymentWalletSelectionError(
      "environment_required",
      "Payment wallet environment is required.",
    );
  }
  const { data, error } = await supabase
    .from("payment_wallets")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("provider", "moov")
    .eq("environment", env)
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
