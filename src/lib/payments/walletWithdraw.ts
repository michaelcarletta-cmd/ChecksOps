/**
 * Transfer to bank (Wallet & Treasury): the website side of the moov-wallet-withdraw API (#1876)
 * and its limits route save-tenant-wallet-withdraw-limits.
 *
 * Owner decisions (2026-11-13, docs/WALLET_TO_BANK_TRANSFER_DESIGN.md §9): no fee; any member of
 * the tenant; no admin approval; same-day ACH; the same wallet.fund two-factor as Add funds;
 * no email; the operating wallet only; the tenant's default bank only; limits set by the tenant
 * (empty means no limit, so any amount up to the operating wallet balance); changing the limits
 * needs the two-factor code.
 *
 * Pure helpers only (no React, no network), so aws/tests can import this file directly.
 * The server is the authority for every rule here: the browser never picks the bank and never
 * decides the arrival date.
 */

/** The provider function that moves money from the operating wallet to the default bank. */
export const WALLET_WITHDRAW_FUNCTION = "moov-wallet-withdraw";
/** The app-services route that reads (action "get") and saves (action "save") the tenant's limits. */
export const WALLET_WITHDRAW_LIMITS_FUNCTION = "save-tenant-wallet-withdraw-limits";
/** payment_transfers.leg_role of a transfer to bank (the API's WALLET_WITHDRAW_LEG). */
export const WALLET_WITHDRAWAL_LEG = "wallet_withdrawal";
/** The same two-factor step-up as Add funds (WALLET_FUND_TOTP_ACTION on the server). */
export const WALLET_WITHDRAW_TOTP_ACTION = "wallet.fund";
/** The label of a transfer to bank everywhere on Wallet & Treasury. */
export const TRANSFER_TO_BANK_LABEL = "Transfer to bank";

export const PER_TRANSFER_LIMIT_FIELD = "wallet_withdraw_max_per_transfer_cents";
export const PER_DAY_LIMIT_FIELD = "wallet_withdraw_max_per_day_cents";

export type WithdrawLimits = {
  wallet_withdraw_max_per_transfer_cents: number | null;
  wallet_withdraw_max_per_day_cents: number | null;
};

export type ExpectedArrival = { arrives: "today" | "next_banking_day"; date: string };

/** The API's reply to a successful transfer to bank. */
export type WithdrawReply = {
  success?: boolean;
  duplicate?: boolean;
  transfer?: { id: string; status: string; amount_cents: number } | null;
  expected_arrival?: ExpectedArrival | null;
  fee_cents?: number;
  message?: string;
};

/** A bank row as the browser reads it from payment_provider_methods. */
export type SettlementBankRow = {
  id: string;
  bank_name?: string | null;
  last_four?: string | null;
  is_default?: boolean | null;
  connection_status?: string | null;
  external_recipient_id?: string | null;
};

const usd = (cents: number) =>
  (Number(cents || 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/**
 * Dollars typed by the user ("1,250.5", "$10") as whole cents, or null when it is not a positive
 * amount with at most two decimals.
 */
export function parseDollarsToCents(input: string | null | undefined): number | null {
  const text = String(input ?? "").replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(text) && !/^\.\d{1,2}$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole || "0") * 100 + Number((fraction + "00").slice(0, 2));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** Cents as a dollar input value ("1250.50"); empty for null (no limit). */
export const centsToDollarInput = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? "" : (Number(cents) / 100).toFixed(2);

/**
 * A limit field as the API wants it: null when the box is empty (no limit), whole cents otherwise,
 * or "invalid" when the text is not a positive amount.
 */
export function limitInputToCents(input: string): number | null | "invalid" {
  if (!String(input ?? "").trim()) return null;
  return parseDollarsToCents(input) ?? "invalid";
}

/** "No limit" or the formatted amount. */
export const limitLabel = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? "No limit" : usd(cents);

/**
 * The tenant's default bank: the connected, tenant-owned row marked is_default. There is no
 * fallback to another bank (owner decision 2026-11-13: transfers go to the default bank only);
 * with no default, null, and the dialog explains how to choose one.
 */
export function defaultSettlementBank(rows: SettlementBankRow[] | null | undefined): SettlementBankRow | null {
  return (
    (rows ?? []).find(
      (row) =>
        row?.is_default === true
        && String(row.connection_status ?? "").toLowerCase() === "connected"
        && !row.external_recipient_id,
    ) ?? null
  );
}

/** "FIRST BANK ••1234": the bank name and only the last four digits. */
export function maskedBankLabel(
  bank: Pick<SettlementBankRow, "bank_name" | "last_four"> | null | undefined,
  displayName: (value: string | null) => string | null = (value) => value,
): string {
  if (!bank) return "No default bank";
  return `${displayName(bank.bank_name ?? null) ?? "Bank"} ••${bank.last_four ?? "----"}`;
}

/** Same-day ACH, before the server's answer: the rule, not a date the browser guessed. */
export const SAME_DAY_RULE_TEXT =
  "Same-day ACH. Sent before 4:45 PM Eastern on a banking day, it arrives that day. After the cutoff, on a weekend or on a Federal Reserve holiday, it arrives the next banking day. ChecksOps confirms the date when you send.";

const formatArrivalDate = (date: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!match) return String(date || "");
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
};

/** The arrival estimate the API returned (expected_arrival), in words. */
export function arrivalText(arrival: ExpectedArrival | null | undefined): string | null {
  if (!arrival?.date) return null;
  const when = formatArrivalDate(arrival.date);
  return arrival.arrives === "today"
    ? `Arrives today, ${when}`
    : `Arrives next banking day, ${when} (sent after today's same-day cutoff)`;
}

/** Every error code the website handles for a transfer to bank or a limits change. */
export const WITHDRAW_ERROR_MESSAGES: Record<string, string> = {
  // Two-factor (the same wallet.fund step-up as Add funds).
  totp_required: "Enter your two-factor code to transfer to your bank.",
  totp_not_enrolled: "Set up two-factor authentication before transferring to your bank.",
  step_up_cancelled: "Two-factor confirmation is required. Nothing was sent.",
  // The default bank only.
  default_bank_required: "Choose a default settlement bank before transferring. Nothing was sent.",
  same_day_unavailable: "Your default settlement bank is not verified for same-day transfers yet. Nothing was sent.",
  // Balance and the tenant's own limits.
  insufficient_available_balance:
    "That is more than your available balance. Pending funds cannot be transferred. Nothing was sent.",
  tenant_limit_exceeded: "That is more than your transfer-to-bank limit. Nothing was sent.",
  // Not switched on (503).
  withdrawal_not_ready: "Transfers to your bank are not switched on yet. Nothing was sent.",
  limits_not_ready: "Transfer-to-bank limits are not switched on yet. Nothing was saved.",
  production_withdrawal_disabled: "Transfers to your bank are not enabled.",
  transfer_post_held: "Sending to Moov is switched off. Nothing was sent.",
  facilitator_unavailable: "Payments are not configured correctly. Nothing was sent.",
  // Wallet state.
  wallet_not_ready: "Your balance account is not ready yet. Nothing was sent.",
  wallet_mismatch: "The recorded Moov wallet was not returned by Moov. Nothing was sent.",
  // Idempotency and the provider's outcome.
  idempotency_key_reused: "That request was already used for a different payment.",
  provider_transfer_refused: "Moov declined this transfer to your bank. Nothing was sent.",
  provider_outcome_unknown:
    "We could not confirm whether the transfer to your bank went through. It will not be retried automatically; check Recent Wallet Activity before trying again.",
  withdrawal_failed: "This transfer to your bank did not go through. Nothing was sent.",
  wallet_withdraw_failed: "The transfer to your bank could not be started. Nothing was sent.",
  // Access.
  cross_tenant_denied: "You are not a member of this organization.",
  not_authorized: "Only a member of this organization can change transfer-to-bank limits.",
  missing_tenant: "Organization isn't loaded yet. Try again in a moment.",
  // Limits input.
  invalid_action: "That limits request is not supported.",
  invalid_field: "Each limit must be empty (no limit) or an amount greater than zero.",
  empty_patch: "Nothing to save.",
  withdraw_limits_update_not_applied: "The limits were not saved. Try again.",
};

export type WithdrawErrorReply = {
  error?: unknown;
  message?: unknown;
  limit?: unknown;
  limit_cents?: unknown;
  used_today_cents?: unknown;
  available_cents?: unknown;
};

/**
 * The message to show for a refused request: the API's own message, plainly, when it sent one;
 * otherwise the message for its code. Limit and balance refusals add the numbers the API returned.
 */
export function withdrawErrorMessage(code: string | null | undefined, reply: WithdrawErrorReply | null = null): string {
  const key = String(code ?? "");
  const apiMessage = typeof reply?.message === "string" && reply.message.trim() ? reply.message.trim() : null;
  let message = apiMessage ?? WITHDRAW_ERROR_MESSAGES[key] ?? (key || "The request could not be completed.");
  if (key === "tenant_limit_exceeded" && Number.isFinite(Number(reply?.limit_cents))) {
    const limit = usd(Number(reply?.limit_cents));
    message += reply?.limit === "per_day"
      ? ` Your daily limit is ${limit}${Number.isFinite(Number(reply?.used_today_cents)) ? `; ${usd(Number(reply?.used_today_cents))} has already been sent today` : ""}.`
      : ` Your per-transfer limit is ${limit}.`;
  }
  if (key === "insufficient_available_balance" && Number.isFinite(Number(reply?.available_cents))) {
    message += ` Available to transfer now: ${usd(Number(reply?.available_cents))}.`;
  }
  return message;
}

/**
 * What the browser can check before sending (the server checks again): a positive amount, not
 * above the available balance, not above a per-transfer limit. The daily limit needs the day's
 * total, which only the server has.
 */
export function precheckWithdrawAmount({
  amountCents,
  availableCents,
  perTransferCents,
}: {
  amountCents: number | null;
  availableCents: number;
  perTransferCents: number | null;
}): { code: string; message: string } | null {
  if (amountCents === null || amountCents <= 0) {
    return { code: "invalid_amount", message: "Enter an amount greater than zero, in dollars and cents." };
  }
  if (amountCents > Math.max(0, Number(availableCents || 0))) {
    return {
      code: "insufficient_available_balance",
      message: withdrawErrorMessage("insufficient_available_balance", { available_cents: Math.max(0, Number(availableCents || 0)) }),
    };
  }
  if (perTransferCents !== null && amountCents > perTransferCents) {
    return {
      code: "tenant_limit_exceeded",
      message: withdrawErrorMessage("tenant_limit_exceeded", { limit: "per_transfer", limit_cents: perTransferCents }),
    };
  }
  return null;
}
