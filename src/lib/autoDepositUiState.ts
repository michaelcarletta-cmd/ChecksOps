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

/** Settings dollars → integer cents. Blank is NULL (fail-closed; not unlimited). */
export function dollarsToAutoApproveCents(dollars: string): number | null {
  const trimmed = String(dollars ?? "").trim();
  if (trimmed === "") return null;
  const cents = Math.round(parseFloat(trimmed) * 100);
  if (!Number.isFinite(cents) || cents < 0) {
    throw new Error("Invalid maximum amount");
  }
  return cents;
}

export function echoAutoDepositSave(
  saved: AutoDepositPublicRow,
  expected: { enabled: boolean; cents: number | null },
): { ok: true } | { ok: false; error: string } {
  if (!saved) {
    return { ok: false, error: "Auto-Deposit save did not persist. Reload Settings and save again." };
  }
  if (Boolean(saved.auto_approve_enabled) !== Boolean(expected.enabled)) {
    return { ok: false, error: "Auto-Deposit enabled flag did not persist. Reload Settings and save again." };
  }
  if ((saved.auto_approve_max_cents ?? null) !== (expected.cents ?? null)) {
    return {
      ok: false,
      error: "Auto-Deposit ceiling did not persist. Expected integer cents were not echoed after reload.",
    };
  }
  return { ok: true };
}
