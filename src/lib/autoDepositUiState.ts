export type AutoDepositUiState = "loading" | "error" | "no_account" | "unregistered" | "ready";

export type AutoDepositPublicRow = {
  tenant_id?: string;
  auto_approve_enabled?: boolean | null;
  auto_approve_max_cents?: number | null;
  registered?: boolean | null;
} | null;

export function resolveAutoDepositUiState(
  account: AutoDepositPublicRow | undefined,
  status: { isLoading?: boolean; isError?: boolean } = {},
): AutoDepositUiState {
  if (status.isLoading) return "loading";
  if (status.isError) return "error";
  if (!account) return "no_account";
  if (account.registered === true) return "ready";
  return "unregistered";
}

/**
 * The Auto-Deposit ceiling field, in dollars, as integer cents.
 * Blank means no ceiling (null; automatic approval stays off). Returns
 * undefined for anything that is not a non-negative amount with at most two
 * decimals, so the card refuses it instead of guessing.
 */
export function parseAutoDepositCeilingCents(dollars: string): number | null | undefined {
  const raw = String(dollars ?? "").trim();
  if (raw === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return undefined;
  const [whole, fraction = ""] = raw.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 2147483647) return undefined;
  return cents;
}

/**
 * After a save, compare what the user asked for with the row read back from
 * the server. Returns null when they match, otherwise a message to show.
 */
export function autoDepositSaveMismatch(
  wanted: { enabled: boolean; maxCents: number | null },
  stored: AutoDepositPublicRow | undefined,
): string | null {
  if (!stored) return "Auto-Deposit settings could not be read back after saving.";
  const storedMax = stored.auto_approve_max_cents ?? null;
  if (Boolean(stored.auto_approve_enabled) !== wanted.enabled || storedMax !== wanted.maxCents) {
    return "Auto-Deposit settings were not saved. The values shown are the ones on file.";
  }
  return null;
}
