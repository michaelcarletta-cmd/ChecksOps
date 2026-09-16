/**
 * Client-side CheckAlt / money-movement step-up binding.
 *
 * The browser may carry a check id to the Cognito step-up route. Tenant,
 * amount, and financial eligibility are derived server-side from that check.
 * Browser tenant_id / amount / amount_cents are never authorization.
 */

export const CHECK_BOUND_ACTIONS = Object.freeze([
  "deposit.submit",
  "deposit.approve",
] as const);

export const MOOV_WALLET_ACTIONS = Object.freeze([
  "wallet.fund",
  "wallet.disburse",
] as const);

export const TENANT_BOUND_ACTIONS = Object.freeze([
  "checkalt.auto_deposit.configure",
] as const);

export type CheckBoundAction = (typeof CHECK_BOUND_ACTIONS)[number];
export type MoovWalletAction = (typeof MOOV_WALLET_ACTIONS)[number];
export type TenantBoundAction = (typeof TENANT_BOUND_ACTIONS)[number];

export type FinancialStepUpRequest = {
  actionKey: string;
  checkId: string | null;
  description?: string;
  tenantId?: string | null;
  title?: string;
  autoDepositEnabled?: boolean;
  autoDepositMaxCents?: number | null;
};

export type BuildStepUpResult =
  | {
      ok: true;
      request: FinancialStepUpRequest;
      ignored: {
        browserAmount: boolean;
        browserAmountCents: boolean;
        browserTenantNotAuthoritative: true;
      };
    }
  | {
      ok: false;
      error: "check_intake_item_id is required" | "tenant_id is required";
      message: string;
    };

const trimId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
};

export const isCheckBoundAction = (actionKey: string | null | undefined): boolean =>
  CHECK_BOUND_ACTIONS.includes(String(actionKey || "") as CheckBoundAction);

export const isMoovWalletAction = (actionKey: string | null | undefined): boolean =>
  MOOV_WALLET_ACTIONS.includes(String(actionKey || "") as MoovWalletAction);

export const isTenantBoundAction = (actionKey: string | null | undefined): boolean =>
  TENANT_BOUND_ACTIONS.includes(String(actionKey || "") as TenantBoundAction);

export const buildFinancialStepUpRequest = (input: {
  actionKey: string;
  checkId?: string | null;
  description?: string;
  title?: string;
  tenantId?: string | null;
  amount?: unknown;
  amount_cents?: unknown;
  tenant_id?: unknown;
  autoDepositEnabled?: boolean;
  autoDepositMaxCents?: number | null;
}): BuildStepUpResult => {
  const actionKey = String(input.actionKey || "");
  const checkId = trimId(input.checkId);
  const tenantId = trimId(input.tenantId) || trimId(input.tenant_id);
  if (isCheckBoundAction(actionKey) && !checkId) {
    return {
      ok: false,
      error: "check_intake_item_id is required",
      message:
        "Financial authorization must be bound to a server-side check. Browser tenant and amount are ignored.",
    };
  }
  if (isTenantBoundAction(actionKey) && !tenantId) {
    return {
      ok: false,
      error: "tenant_id is required",
      message: "Auto-Deposit configuration must be bound to a tenant. Browser amount is not authority.",
    };
  }
  return {
    ok: true,
    request: {
      actionKey,
      checkId,
      description: input.description,
      title: input.title,
      tenantId,
      autoDepositEnabled: input.autoDepositEnabled,
      autoDepositMaxCents: input.autoDepositMaxCents,
    },
    ignored: {
      browserAmount: input.amount !== undefined && input.amount !== null,
      browserAmountCents: input.amount_cents !== undefined && input.amount_cents !== null,
      browserTenantNotAuthoritative: true,
    },
  };
};

export const stepUpCacheKey = (
  userId: string | null | undefined,
  actionKey: string,
  checkId: string | null,
  tenantId?: string | null,
): string | null => {
  if (!userId) return null;
  if (isMoovWalletAction(actionKey)) {
    // Never reuse deposit/session TOTP for wallet.fund / wallet.disburse.
    return `${userId}|${actionKey}|first-test`;
  }
  if (isTenantBoundAction(actionKey)) {
    if (!tenantId) return null;
    return `${userId}|${actionKey}|${tenantId}`;
  }
  if (isCheckBoundAction(actionKey)) {
    if (!checkId) return null;
    return `${userId}|${actionKey}|${checkId}`;
  }
  return `${userId}|unbound|session`;
};

export const cacheAllowsReuse = (cachedKey: string | null | undefined, nextKey: string | null | undefined): boolean => {
  if (!cachedKey || !nextKey || cachedKey !== nextKey) return false;
  if (nextKey.includes("|wallet.fund|") || nextKey.includes("|wallet.disburse|")) return false;
  if (nextKey.includes("|checkalt.auto_deposit.configure|")) return false;
  return true;
};

export const changingCheckRequiresNewAuth = (
  previousCheckId: string | null | undefined,
  nextCheckId: string | null | undefined,
): boolean => String(previousCheckId || "") !== String(nextCheckId || "");

export const awsStepUpBody = (request: FinancialStepUpRequest) => ({
  action_key: request.actionKey,
  ...(request.checkId ? { check_intake_item_id: request.checkId } : {}),
  // tenant_id is a non-authoritative hint; the server binds Freedom / check tenant.
  tenant_id: request.tenantId || undefined,
  ...(request.actionKey === "checkalt.auto_deposit.configure"
    ? {
        auto_deposit_enabled: request.autoDepositEnabled === true,
        auto_deposit_max_cents: Number.isInteger(request.autoDepositMaxCents)
          ? request.autoDepositMaxCents
          : null,
      }
    : {}),
});
