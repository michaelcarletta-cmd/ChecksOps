/**
 * Client-side CheckAlt / money-movement step-up UX.
 *
 * A successful TOTP establishes a login-session cache so the dialog is not
 * shown again until expiry or logout. This cache is not authorization.
 * Tenant, amount, role, and MFA completion are enforced server-side.
 */

export const CHECK_BOUND_ACTIONS = Object.freeze([
  "deposit.submit",
  "deposit.approve",
] as const);

export const STEP_UP_CACHE_TTL_MS = 30 * 60 * 1000;

export type CheckBoundAction = (typeof CHECK_BOUND_ACTIONS)[number];

export type FinancialStepUpRequest = {
  actionKey: string;
  checkId: string | null;
  description?: string;
  tenantId?: string | null;
  title?: string;
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
      error: "check_intake_item_id is required";
      message: string;
    };

const trimId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
};

export const isCheckBoundAction = (actionKey: string | null | undefined): boolean =>
  CHECK_BOUND_ACTIONS.includes(String(actionKey || "") as CheckBoundAction);

export const buildFinancialStepUpRequest = (input: {
  actionKey: string;
  checkId?: string | null;
  description?: string;
  title?: string;
  tenantId?: string | null;
  amount?: unknown;
  amount_cents?: unknown;
  tenant_id?: unknown;
}): BuildStepUpResult => {
  const actionKey = String(input.actionKey || "");
  const checkId = trimId(input.checkId);
  if (isCheckBoundAction(actionKey) && !checkId) {
    return {
      ok: false,
      error: "check_intake_item_id is required",
      message:
        "Financial authorization must be bound to a server-side check. Browser tenant and amount are ignored.",
    };
  }
  return {
    ok: true,
    request: {
      actionKey,
      checkId,
      description: input.description,
      title: input.title,
      tenantId: trimId(input.tenantId) || trimId(input.tenant_id),
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
  _actionKey?: string,
  _checkId?: string | null,
): string | null => {
  if (!userId) return null;
  return `${userId}|session`;
};

const userIdFromCacheKey = (key: string | null | undefined): string | null => {
  const value = String(key || "");
  const userId = value.split("|")[0];
  return userId || null;
};

export const cacheAllowsReuse = (
  cachedKey: string | null | undefined,
  nextKey: string | null | undefined,
): boolean => {
  if (!cachedKey || !nextKey) return false;
  if (cachedKey === nextKey) return true;
  const cachedUser = userIdFromCacheKey(cachedKey);
  const nextUser = userIdFromCacheKey(nextKey);
  return Boolean(cachedUser && nextUser && cachedUser === nextUser);
};

export const changingCheckRequiresNewAuth = (
  previousCheckId: string | null | undefined,
  nextCheckId: string | null | undefined,
): boolean => String(previousCheckId || "") !== String(nextCheckId || "");

export const awsStepUpBody = (request: FinancialStepUpRequest) => ({
  action_key: request.actionKey,
  check_intake_item_id: request.checkId || undefined,
  // tenant_id is a non-authoritative hint; the server uses the check tenant.
  tenant_id: request.tenantId || undefined,
});
