/**
 * Shared logic for automatic wallet funding.
 *
 * A tenant approves an outgoing payment (a `disbursement_batches` row). Before
 * anything moves we compare the payment total against the tenant's AVAILABLE
 * wallet balance (never pending) minus funds already reserved for other
 * approved-but-unsent payments. Any shortage is pulled from the tenant's own
 * verified bank account with Moov's `ach-debit-fund` payment method.
 *
 * All money maths is integer cents. No floating point currency arithmetic.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { readWallet, syncWallet, type WalletRow } from "./moovWallet.ts";

/** Parses a Postgres numeric (string) into integer cents without float drift. */
export function toCents(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Math.round(value * 100);
  const raw = String(value).trim();
  if (!raw) return 0;
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!m) return Math.round(Number(raw) * 100);
  const sign = m[1] === "-" ? -1 : 1;
  const whole = m[2] || "0";
  const frac = (m[3] || "").padEnd(2, "0").slice(0, 2);
  return sign * (Number(whole) * 100 + Number(frac));
}

export const ACTIVE_FUNDING_STATUSES = [
  "draft",
  "authorization_required",
  "ready",
  "initiating",
  "pending",
] as const;

const TERMINAL_FUNDING_STATUSES = ["completed", "failed", "returned", "canceled"];

/** Terminal funding records never move backwards, whatever webhooks arrive. */
export function isTerminalFundingStatus(status: string | null | undefined): boolean {
  return TERMINAL_FUNDING_STATUSES.includes(String(status ?? ""));
}

export interface PaymentContext {
  batch: Record<string, any>;
  paymentCents: number;
  payableSplitCount: number;
}

/** Loads an outgoing payment and totals the legs that still need to be paid. */
export async function loadPaymentContext(
  supabase: SupabaseClient,
  paymentId: string,
): Promise<PaymentContext | null> {
  const { data: batch } = await supabase
    .from("disbursement_batches")
    .select("*")
    .eq("id", paymentId)
    .maybeSingle();
  if (!batch) return null;

  const { data: splits } = await supabase
    .from("disbursement_splits")
    .select("id, amount, status, moov_transfer_id")
    .eq("batch_id", paymentId);

  const payable = (splits ?? []).filter(
    (s: any) =>
      !s.moov_transfer_id &&
      !["failed", "cancelled", "canceled", "returned", "settled"].includes(String(s.status)),
  );

  return {
    batch: batch as Record<string, any>,
    paymentCents: payable.reduce((sum: number, s: any) => sum + toCents(s.amount), 0),
    payableSplitCount: payable.length,
  };
}

/**
 * Funds already spoken for by other approved payments that have not sent yet.
 * Two payments approved at once can therefore never overspend one balance.
 */
export async function reservedCentsForTenant(
  supabase: SupabaseClient,
  tenantId: string,
  excludePaymentId?: string | null,
): Promise<number> {
  const { data } = await supabase
    .from("disbursement_batches")
    .select("id, amount_reserved_cents, funding_status, status")
    .eq("tenant_id", tenantId)
    .in("funding_status", ["awaiting_funding", "funded"]);

  return (data ?? [])
    .filter((b: any) => b.id !== excludePaymentId)
    .filter((b: any) => !["completed", "cancelled", "canceled", "failed"].includes(String(b.status)))
    .reduce((sum: number, b: any) => sum + Number(b.amount_reserved_cents || 0), 0);
}

export interface FundingCalculation {
  fundingRequired: boolean;
  paymentCents: number;
  availableCents: number;
  pendingCents: number;
  reservedCents: number;
  spendableCents: number;
  shortageCents: number;
  walletId: string | null;
  providerWalletId: string | null;
  walletPaymentMethodId: string | null;
}

/** Computes the shortage for one payment against live provider balances. */
export async function calculateFunding(args: {
  supabase: SupabaseClient;
  tenantId: string;
  environment: string;
  accountId: string;
  paymentCents: number;
  paymentId?: string | null;
  /** Skips the provider round trip when a caller just synced. */
  wallet?: WalletRow | null;
}): Promise<FundingCalculation> {
  const wallet = args.wallet ??
    (await syncWallet(args.supabase, {
      tenantId: args.tenantId,
      accountId: args.accountId,
      environment: args.environment,
      walletType: "operating",
    }).catch(() => readWallet(args.supabase, args.tenantId, args.environment, "operating")));

  const availableCents = Number(wallet?.available_cents ?? 0);
  const pendingCents = Number(wallet?.pending_cents ?? 0);
  const reserved = await reservedCentsForTenant(args.supabase, args.tenantId, args.paymentId ?? null);
  const spendable = availableCents - reserved;
  const shortage = Math.max(0, args.paymentCents - spendable);

  return {
    fundingRequired: shortage > 0,
    paymentCents: args.paymentCents,
    availableCents,
    pendingCents,
    reservedCents: reserved,
    spendableCents: spendable,
    shortageCents: shortage,
    walletId: wallet?.id ?? null,
    providerWalletId: wallet?.provider_wallet_id ?? null,
    walletPaymentMethodId: wallet?.provider_payment_method_id ?? null,
  };
}

/** Total pulled from the bank today, used to enforce the daily cap. */
export async function pulledTodayCents(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const { data } = await supabase
    .from("wallet_funding_requests")
    .select("requested_amount_cents, status, created_at")
    .eq("tenant_id", tenantId)
    .gte("created_at", startOfDay.toISOString());

  return (data ?? [])
    .filter((r: any) => !["failed", "canceled", "returned"].includes(String(r.status)))
    .reduce((sum: number, r: any) => sum + Number(r.requested_amount_cents || 0), 0);
}

export interface FundingSettings {
  tenant_id: string;
  auto_funding_enabled: boolean;
  funding_bank_account_id: string | null;
  funding_payment_method_id: string | null;
  funding_strategy: "payment_shortage" | "target_balance" | "manual";
  target_wallet_balance_cents: number;
  maximum_single_pull_cents: number;
  maximum_daily_pull_cents: number;
  require_payment_approval: boolean;
  authorization_accepted_at: string | null;
  authorization_accepted_by: string | null;
  authorization_version: string | null;
}

/** Reads (and lazily creates) the tenant's funding settings. */
export async function loadFundingSettings(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<FundingSettings> {
  const { data } = await supabase
    .from("tenant_wallet_funding_settings")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (data) return data as unknown as FundingSettings;

  const { data: created } = await supabase
    .from("tenant_wallet_funding_settings")
    .insert({ tenant_id: tenantId })
    .select()
    .single();
  return created as unknown as FundingSettings;
}

/** Permission gate shared by every funding entry point. */
export async function callerCanMoveFunds(
  supabase: SupabaseClient,
  userId: string,
  tenantId: string,
): Promise<boolean> {
  const { data: membership } = await supabase
    .from("tenant_users").select("role")
    .eq("tenant_id", tenantId).eq("user_id", userId).maybeSingle();
  const { data: adminRole } = await supabase
    .from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
  return Boolean(adminRole) || ["owner", "admin", "manager"].includes(String(membership?.role ?? ""));
}
