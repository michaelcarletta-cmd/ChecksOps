// Shared helpers for platform fee Schedules.
//
// A fee schedule is a recurring ACH debit that pulls ChecksOps platform fees
// (OCR, storage, mortgage-desk work — anything NOT attached to a payout) from
// the tenant's own connected bank account into the ChecksOps platform account.
//
// Fees that ARE attached to a payout keep using facilitator fees on the
// transfer itself; nothing here touches that path, Actum, or Plaid.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export const scheduleScopes = {
  read: (id: string) => [`/accounts/${id}/transfers.read`],
  write: (id: string) => [`/accounts/${id}/transfers.write`],
};

export function platformAccountId(): string | null {
  return Deno.env.get("MOOV_PLATFORM_ACCOUNT_ID") ?? null;
}

export function platformPaymentMethodId(): string | null {
  return Deno.env.get("MOOV_PLATFORM_PAYMENT_METHOD_ID") ?? null;
}

/** Clamp a day-of-month to a value that exists in every month. */
export function safeDayOfMonth(day: unknown): number {
  const n = Number(day);
  if (!Number.isFinite(n)) return 1;
  return Math.min(28, Math.max(1, Math.trunc(n)));
}

/** The billing period that a run on `runAt` covers (the previous month). */
export function periodForRun(runAt: Date): { start: string; end: string } {
  const end = new Date(Date.UTC(runAt.getUTCFullYear(), runAt.getUTCMonth(), 1));
  const start = new Date(Date.UTC(runAt.getUTCFullYear(), runAt.getUTCMonth() - 1, 1));
  const lastDay = new Date(end.getTime() - 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: lastDay.toISOString().slice(0, 10) };
}

/** Next UTC run timestamp for a monthly cadence on `dayOfMonth`. */
export function nextMonthlyRun(dayOfMonth: number, from = new Date()): Date {
  const day = safeDayOfMonth(dayOfMonth);
  const candidate = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), day, 14, 0, 0));
  if (candidate.getTime() > from.getTime()) return candidate;
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, day, 14, 0, 0));
}

export function recurrenceRule(cadence: string, dayOfMonth: number): string {
  if (cadence === "weekly") return "FREQ=WEEKLY;INTERVAL=1";
  return `FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=${safeDayOfMonth(dayOfMonth)}`;
}

/** Sum of everything not yet billed for a tenant, optionally within a period. */
export async function unbilledTotalCents(
  supabase: SupabaseClient,
  tenantId: string,
  period?: { start: string; end: string },
): Promise<{ totalCents: number; ids: string[] }> {
  let q = supabase
    .from("platform_fee_line_items")
    .select("id, amount_cents, occurred_at")
    .eq("tenant_id", tenantId)
    .eq("status", "unbilled");
  if (period) {
    q = q.gte("occurred_at", `${period.start}T00:00:00Z`).lte("occurred_at", `${period.end}T23:59:59Z`);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  return {
    totalCents: rows.reduce((sum: number, r: any) => sum + Number(r.amount_cents ?? 0), 0),
    ids: rows.map((r: any) => r.id),
  };
}
