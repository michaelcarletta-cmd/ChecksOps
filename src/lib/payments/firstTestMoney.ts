/**
 * First-test Moov send controls for the live SPA.
 *
 * The browser may request the allowed 1-cent value. Tenant, Moov account,
 * bank, wallet, recipient, payment methods, and amount are bound server-side.
 * Do not send those objects as authority.
 */

export const FIRST_TEST_TRANSFER_CENTS = 1;
export const FIRST_TEST_TRANSFER_DOLLARS = "0.01";
export const FIRST_TEST_TRANSFER_LABEL = "$0.01";

export const FIRST_TEST_FUND_FN = "moov-wallet-fund";
export const FIRST_TEST_FUND_CONTINUE_FN = "moov-wallet-fund-continue";
export const FIRST_TEST_DISBURSE_FN = "moov-disburse";
export const LEGACY_COMBINED_TRANSFER_FN = "moov-transfer-create";
export const COUPLED_FUNDING_FN = "initiate-wallet-funding";

export const FIRST_TEST_FUND_TOTP = "wallet.fund";
export const FIRST_TEST_DISBURSE_TOTP = "wallet.disburse";
export const CHECKALT_DEPOSIT_TOTP = "deposit.submit";

export const FIRST_TEST_CAP_MESSAGE =
  "The first production Moov transfer is capped at $0.01. The server amount is authoritative.";

export const FIRST_TEST_FUND_COPY =
  "BANK→WALLET first test: Financial TOTP for wallet.fund, then $0.01 from Freedom Wells Fargo ••••4573 into the Freedom wallet. Server binds bank, wallet, and amount.";

export const FIRST_TEST_AUTHORIZE_HELD_FUND_COPY =
  "Authorize the existing held $0.01 BANK→WALLET intent with Financial TOTP for wallet.fund. This does not create a new transfer and does not click Add $0.01 from bank.";

export const FIRST_TEST_DISBURSE_COPY =
  "WALLET→RECIPIENT first test: Financial TOTP for wallet.disburse, then $0.01 from the Freedom wallet to Michael / Chase ••••1506. Server binds wallet, recipient, bank, and amount.";

export type FirstTestMoneyHint = {
  tenantId?: string | null;
  idempotencyKey?: string | null;
};

const trim = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const next = value.trim();
  return next || null;
};

export const isFirstTestAmountCents = (cents: unknown): cents is number =>
  Number.isInteger(cents) && Number(cents) === FIRST_TEST_TRANSFER_CENTS;

export const parseFirstTestAmountCents = (raw: unknown): number | null => {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.round(raw * 100) === FIRST_TEST_TRANSFER_CENTS ? FIRST_TEST_TRANSFER_CENTS : null;
  }
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const dollars = Number(text);
  if (!Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100) === FIRST_TEST_TRANSFER_CENTS ? FIRST_TEST_TRANSFER_CENTS : null;
};

export const assertFirstTestAmountCents = (cents: unknown): number => {
  if (!isFirstTestAmountCents(cents)) {
    throw new Error(FIRST_TEST_CAP_MESSAGE);
  }
  return FIRST_TEST_TRANSFER_CENTS;
};

/** Browser body: amount hint + optional tenant hint. No bank/wallet/recipient IDs. */
export const firstTestFundBody = (hint: FirstTestMoneyHint = {}): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    amount_cents: FIRST_TEST_TRANSFER_CENTS,
    source_kind: "bank",
  };
  const tenantId = trim(hint.tenantId);
  if (tenantId) body.tenant_id = tenantId;
  const key = trim(hint.idempotencyKey);
  if (key) body.idempotency_key = key;
  return body;
};

export const firstTestDisburseBody = (hint: FirstTestMoneyHint = {}): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    amount_cents: FIRST_TEST_TRANSFER_CENTS,
    source_kind: "wallet",
  };
  const tenantId = trim(hint.tenantId);
  if (tenantId) body.tenant_id = tenantId;
  const key = trim(hint.idempotencyKey);
  if (key) body.idempotency_key = key;
  return body;
};

export const isTransferPostHeld = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error || "");
  return /transfer_post_held/i.test(message);
};

export const FIRST_TEST_HELD_MESSAGE =
  "Durable intent was recorded. Moov transfer POST stays held until a later reviewed Test A arming. No money moved.";

export const nextFirstTestIdempotencyKey = (existing?: string | null): string =>
  trim(existing) || (typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `first-test-${Date.now()}`);
