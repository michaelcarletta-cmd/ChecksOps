/**
 * Pure decision + validation logic for Moov-native sweeps.
 *
 * No I/O, no Deno APIs — exercised directly by `scripts/test-sweep-rules.mjs`.
 *
 * Moov sweeps are an account-level resource attached to a wallet. Moov runs
 * them daily: available wallet funds above `minimumBalance` are pushed out to
 * the configured `pushPaymentMethodID`, and a negative balance is remediated by
 * pulling from `pullPaymentMethodID` (which must be an `ach-debit-fund`
 * method). ChecksOps never schedules its own transfers for this.
 */

/**
 * Push rails a sweep may use, fastest first.
 *
 * Moov's current guidance prefers `instant-bank-credit` over `rtp-credit`:
 * the instant-bank method can settle over RTP *or* FedNow, and it falls back
 * to standard ACH when a rail limit or window blocks the fast path.
 */
export const SWEEP_PUSH_RAIL_PREFERENCE = [
  "instant-bank-credit",
  "rtp-credit",
  "ach-credit-same-day",
  "ach-credit-standard",
] as const;

export type SweepPushRail = (typeof SWEEP_PUSH_RAIL_PREFERENCE)[number];

/** Negative-balance remediation is ACH debit only. */
export const SWEEP_PULL_RAIL = "ach-debit-fund";

export const SWEEP_RAIL_LABEL: Record<string, string> = {
  "instant-bank-credit": "Instant (RTP / FedNow, falls back to ACH)",
  "rtp-credit": "Instant (RTP)",
  "ach-credit-same-day": "Same-day ACH",
  "ach-credit-standard": "Standard ACH",
  "ach-debit-fund": "ACH debit (funding)",
};

export type SweepStatus = "enabled" | "disabled";

export interface SweepMethodSource {
  /** Moov paymentMethodType -> paymentMethodID, as cached by Phase 1. */
  railPaymentMethodIds?: Record<string, string> | null;
  /** Optional explicit list of supported Moov payment-method types. */
  supportedRails?: string[] | null;
}

export interface SweepPushSelection {
  railType: SweepPushRail | null;
  paymentMethodId: string | null;
  /** Every rail considered, in preference order. */
  evaluated: Array<{ rail: SweepPushRail; eligible: boolean }>;
  reason: string | null;
}

function railMap(src: SweepMethodSource): Record<string, string> {
  const ids = src.railPaymentMethodIds ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ids)) if (v) out[k] = String(v);
  for (const t of src.supportedRails ?? []) if (!out[t]) out[t] = out[t] ?? "";
  return out;
}

/** Rails the UI is allowed to offer as a sweep push method. */
export function availablePushRails(src: SweepMethodSource): SweepPushRail[] {
  const map = railMap(src);
  return SWEEP_PUSH_RAIL_PREFERENCE.filter((r) => r in map && !!map[r]);
}

/**
 * Picks the sweep push method. When `preferredRail` is given it must actually
 * be supported — we never silently fall back to a slower rail behind the
 * user's back at configuration time.
 */
export function selectSweepPushMethod(
  src: SweepMethodSource,
  preferredRail?: string | null,
): SweepPushSelection {
  const map = railMap(src);
  const evaluated = SWEEP_PUSH_RAIL_PREFERENCE.map((rail) => ({
    rail,
    eligible: !!map[rail],
  }));

  if (preferredRail) {
    if (!SWEEP_PUSH_RAIL_PREFERENCE.includes(preferredRail as SweepPushRail)) {
      return { railType: null, paymentMethodId: null, evaluated, reason: "unsupported_rail_requested" };
    }
    if (!map[preferredRail]) {
      return { railType: null, paymentMethodId: null, evaluated, reason: "rail_not_available_on_method" };
    }
    return {
      railType: preferredRail as SweepPushRail,
      paymentMethodId: map[preferredRail],
      evaluated,
      reason: null,
    };
  }

  const best = evaluated.find((e) => e.eligible);
  if (!best) {
    return { railType: null, paymentMethodId: null, evaluated, reason: "no_push_rail_available" };
  }
  return { railType: best.rail, paymentMethodId: map[best.rail], evaluated, reason: null };
}

/** Resolves the ACH-debit method used for negative-balance remediation. */
export function selectSweepPullMethod(src: SweepMethodSource): string | null {
  const map = railMap(src);
  return map[SWEEP_PULL_RAIL] || null;
}

/* ---------------- minimum balance ---------------- */

export const MIN_BALANCE_MAX_CENTS = 100_000_000; // $1,000,000

/**
 * Accepts dollars (number or string, `$` and commas tolerated) and returns
 * whole cents. Throws on anything that is not a clean, non-negative amount.
 */
export function parseMinimumBalanceCents(input: unknown): number {
  if (input === null || input === undefined || input === "") return 0;
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) throw new Error("Minimum balance must be zero or more.");
    return roundCents(input * 100);
  }
  const raw = String(input).trim().replace(/[$,\s]/g, "");
  if (!/^\d*(\.\d{0,2})?$/.test(raw) || raw === "" || raw === ".") {
    throw new Error("Enter the minimum balance as dollars with at most two decimals.");
  }
  return roundCents(Number(raw) * 100);
}

function roundCents(value: number): number {
  const cents = Math.round(value);
  if (cents < 0) throw new Error("Minimum balance must be zero or more.");
  if (cents > MIN_BALANCE_MAX_CENTS) throw new Error("Minimum balance is too large.");
  return cents;
}

/** Moov expects the retained balance as a decimal string, e.g. "125.00". */
export function centsToDecimalString(cents: number): string {
  return (Math.round(cents) / 100).toFixed(2);
}

/** Reads a Moov minimumBalance back into cents, tolerating both shapes. */
export function minimumBalanceToCents(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (v.valueDecimal !== undefined) return Math.round(Number(v.valueDecimal) * 100) || 0;
    if (v.value !== undefined) return Math.round(Number(v.value)) || 0;
    return 0;
  }
  const n = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/* ---------------- statement descriptor ---------------- */

/** Moov limits the descriptor to 10 characters of printable ASCII. */
export function normalizeStatementDescriptor(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  if (!/^[\x20-\x7E]+$/.test(raw)) {
    throw new Error("Statement descriptor may only contain plain text characters.");
  }
  if (raw.length > 10) throw new Error("Statement descriptor must be 10 characters or fewer.");
  return raw;
}

export function normalizeSweepStatus(value: unknown): SweepStatus {
  return String(value ?? "").toLowerCase() === "enabled" ? "enabled" : "disabled";
}
