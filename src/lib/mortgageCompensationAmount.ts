/**
 * Mortgage Agent compensation Adjust: amount parsing and caps. Mirrors the
 * SQL 85 bounds (adjust_mortgage_agent_compensation) so the dialog can show
 * them; the database enforces them regardless.
 */

const DOLLARS_PATTERN = /^-?\d+(\.\d{1,2})?$/;

/** Signed dollars ("10", "-5.5", "12.34") to integer cents, or null. No exponents, no "+", no commas. */
export function parseDollarsToCents(raw: string): number | null {
  const text = String(raw ?? "").trim();
  if (!DOLLARS_PATTERN.test(text)) return null;
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  if (whole.length > 9) return null;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

export type AdjustmentChild = { agent_user_id: string; amount_cents: number; status?: string | null };

export type AdjustmentCaps = {
  /** abs(amount) may not exceed the parent entry's amount. */
  maxAbsCents: number;
  /** A debit to the parent's agent may not exceed the agent's net on the file. */
  maxDebitCents: number;
};

export function adjustmentCaps(
  parent: { agent_user_id: string; amount_cents: number },
  children: AdjustmentChild[] = [],
): AdjustmentCaps {
  const maxAbsCents = Math.abs(Number(parent.amount_cents || 0));
  const net = Number(parent.amount_cents || 0) + children
    .filter((c) => c.agent_user_id === parent.agent_user_id && !["voided", "excluded"].includes(String(c.status || "")))
    .reduce((sum, c) => sum + Number(c.amount_cents || 0), 0);
  return { maxAbsCents, maxDebitCents: Math.max(0, net) };
}

/** Returns an error message, or null when the amount is within the SQL 85 bounds. */
export function adjustmentAmountError(cents: number | null, caps: AdjustmentCaps, paired: boolean): string | null {
  if (cents === null) return "Enter a dollar amount like 10.00 or -5.00";
  if (cents === 0) return "Enter a nonzero dollar amount";
  if (Math.abs(cents) > caps.maxAbsCents) return "The amount cannot exceed the original entry amount";
  const debit = paired ? Math.abs(cents) : (cents < 0 ? -cents : 0);
  if (debit > caps.maxDebitCents) return "The debit cannot exceed the agent's remaining net on this file";
  return null;
}

/** A random per-dialog idempotency key. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `adjust-${c.randomUUID()}`;
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return `adjust-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
