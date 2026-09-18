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
