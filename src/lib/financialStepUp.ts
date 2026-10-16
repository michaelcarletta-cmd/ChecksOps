/**
 * Client-side CheckAlt / money-movement step-up binding.
 *
 * Check Alt two-factor is once per login, the same as Moov wallet fund and
 * send: one verified code covers every Check Alt deposit and approval until
 * the user signs out. The server is the authority; it records the step-up
 * against the login and asks again (step_up_required) when it has none.
 *
 * The Check Alt step-up request still carries a check id so the server takes
 * the tenant from that check. Browser tenant_id / amount / amount_cents are
 * never authorization.
 */

export const CHECK_BOUND_ACTIONS = Object.freeze([
  "deposit.submit",
  "deposit.approve",
] as const);

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

/**
 * The browser's per-login cache key. Check Alt actions share one key per
 * user (not per check or amount); other actions keep their own session key.
 * The cache only saves a prompt: the server still decides.
 */
export const stepUpCacheKey = (
  userId: string | null | undefined,
  actionKey: string,
  checkId: string | null,
): string | null => {
  if (!userId) return null;
  if (isCheckBoundAction(actionKey)) {
    if (!checkId) return null;
    return `${userId}|checkalt|session`;
  }
  return `${userId}|unbound|session`;
};

export const cacheAllowsReuse = (cachedKey: string | null | undefined, nextKey: string | null | undefined): boolean =>
  Boolean(cachedKey && nextKey && cachedKey === nextKey);

/** True when the server refused a Check Alt action for lack of this login's step-up. */
export const isStepUpRequiredError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.trim() === "step_up_required";
};

export const awsStepUpBody = (request: FinancialStepUpRequest) => ({
  action_key: request.actionKey,
  check_intake_item_id: request.checkId || undefined,
  // tenant_id is a non-authoritative hint; the server uses the check tenant.
  tenant_id: request.tenantId || undefined,
});
