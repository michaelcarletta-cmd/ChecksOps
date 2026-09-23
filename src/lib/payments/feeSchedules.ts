import { supabase } from "@/integrations/aws/client";

/**
 * Recurring platform fees.
 *
 * Fees tied to a payout ride along on the payout itself (facilitator fees).
 * Everything else — OCR, storage, mortgage-desk work — accrues as usage line
 * items and is pulled once per period from the organization's own bank
 * account through a scheduled ACH debit.
 */

export type FeeCadence = "monthly" | "weekly" | "once";
export type FeeAmountMode = "usage" | "fixed";

export interface PlatformFeeSchedule {
  id: string;
  tenant_id: string;
  name: string;
  fee_code: string;
  description: string | null;
  cadence: FeeCadence;
  day_of_month: number;
  amount_cents: number;
  amount_mode: FeeAmountMode;
  status: string;
  next_run_at: string | null;
  last_run_at: string | null;
}

export interface PlatformFeeOccurrence {
  id: string;
  schedule_id: string;
  run_at: string;
  period_start: string | null;
  period_end: string | null;
  amount_cents: number;
  status: string;
  failure_reason: string | null;
}

export interface PlatformFeeLineItem {
  id: string;
  fee_code: string;
  description: string | null;
  quantity: number;
  amount_cents: number;
  occurred_at: string;
  status: string;
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

export async function listFeeSchedules(tenantId: string): Promise<PlatformFeeSchedule[]> {
  const { data, error } = await supabase
    .from("platform_fee_schedules")
    .select("*")
    .eq("tenant_id", tenantId)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as PlatformFeeSchedule[];
}

export async function listFeeOccurrences(tenantId: string, limit = 12): Promise<PlatformFeeOccurrence[]> {
  const { data, error } = await supabase
    .from("platform_fee_occurrences")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("run_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as PlatformFeeOccurrence[];
}

export async function listUnbilledFees(tenantId: string, limit = 100): Promise<PlatformFeeLineItem[]> {
  const { data, error } = await supabase
    .from("platform_fee_line_items")
    .select("id, fee_code, description, quantity, amount_cents, occurred_at, status")
    .eq("tenant_id", tenantId)
    .eq("status", "unbilled")
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as PlatformFeeLineItem[];
}

export async function saveFeeSchedule(input: {
  tenantId: string;
  name?: string;
  feeCode?: string;
  description?: string | null;
  cadence?: FeeCadence;
  dayOfMonth?: number;
  amountCents?: number;
  amountMode?: FeeAmountMode;
}): Promise<{ schedule: PlatformFeeSchedule }> {
  return invoke("moov-fee-schedule-upsert", {
    tenant_id: input.tenantId,
    name: input.name ?? "ChecksOps platform fees",
    fee_code: input.feeCode ?? "platform_fees",
    description: input.description ?? null,
    cadence: input.cadence ?? "monthly",
    day_of_month: input.dayOfMonth ?? 1,
    amount_cents: input.amountCents ?? 0,
    amount_mode: input.amountMode ?? "usage",
  });
}

export async function cancelFeeSchedule(tenantId: string, scheduleId: string) {
  return invoke("moov-fee-schedule-cancel", { tenant_id: tenantId, schedule_id: scheduleId });
}

/** Totals unbilled usage and books it as one dated charge. */
export async function rollUpFees(input: {
  tenantId: string;
  dryRun?: boolean;
  runAt?: string | null;
}): Promise<{
  amount_cents: number;
  line_item_count: number;
  period?: { start: string; end: string };
  skipped?: boolean;
  dry_run?: boolean;
}> {
  return invoke("moov-fee-rollup", {
    tenant_id: input.tenantId,
    dry_run: !!input.dryRun,
    run_at: input.runAt ?? null,
  });
}
