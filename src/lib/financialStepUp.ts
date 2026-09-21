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

export const WALLET_BOUND_ACTIONS = Object.freeze([
  "wallet.fund",
  "wallet.disburse",
] as const);

export const PAYOUT_BOUND_ACTIONS = Object.freeze([
  "disbursement.send",
] as const);

export type CheckBoundAction = (typeof CHECK_BOUND_ACTIONS)[number];
export type WalletBoundAction = (typeof WALLET_BOUND_ACTIONS)[number];
export type PayoutBoundAction = (typeof PAYOUT_BOUND_ACTIONS)[number];

export type FinancialStepUpRequest = {
  actionKey: string;
  checkId: string | null;
  description?: string;
  tenantId?: string | null;
  title?: string;
  payoutOperationId?: string | null;
  recipientId?: string | null;
  amountCents?: number | null;
};

export type StepUpCacheScope = {
  payoutOperationId?: string | null;
  recipientId?: string | null;
  amountCents?: number | null;
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

export const isWalletBoundAction = (actionKey: string | null | undefined): boolean =>
  WALLET_BOUND_ACTIONS.includes(String(actionKey || "") as WalletBoundAction);

export const buildFinancialStepUpRequest = (input: {
  actionKey: string;
  checkId?: string | null;
  description?: string;
  title?: string;
  tenantId?: string | null;
  amount?: unknown;
  amount_cents?: unknown;
  tenant_id?: unknown;
  payoutOperationId?: string | null;
  recipientId?: string | null;
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
  const amountCents = Number.isInteger(Number(input.amount_cents)) ? Number(input.amount_cents) : null;
  return {
    ok: true,
    request: {
      actionKey,
      checkId,
      description: input.description,
      title: input.title,
      tenantId: trimId(input.tenantId) || trimId(input.tenant_id),
      payoutOperationId: trimId(input.payoutOperationId),
      recipientId: trimId(input.recipientId),
      amountCents,
    },
    ignored: {
      browserAmount: input.amount !== undefined && input.amount !== null,
      browserAmountCents: input.amount_cents !== undefined && input.amount_cents !== null,
      browserTenantNotAuthoritative: true,
    },
  };
};

export const isPayoutBoundAction = (actionKey: string | null | undefined): boolean =>
  PAYOUT_BOUND_ACTIONS.includes(String(actionKey || "") as PayoutBoundAction);

export const stepUpCacheKey = (
  userId: string | null | undefined,
  actionKey: string,
  checkId: string | null,
  scope: StepUpCacheScope | null = null,
): string | null => {
  if (!userId) return null;
  if (isCheckBoundAction(actionKey)) {
    if (!checkId) return null;
    return `${userId}|${actionKey}|${checkId}`;
  }
  if (isWalletBoundAction(actionKey)) {
    return `${userId}|${actionKey}|moov-first-test`;
  }
  if (isPayoutBoundAction(actionKey)) {
    const op = trimId(scope?.payoutOperationId) || checkId || "unbound-op";
    const recipient = trimId(scope?.recipientId) || "unbound-recipient";
    const amount = Number.isInteger(scope?.amountCents) ? String(scope?.amountCents) : "unbound-amount";
    return `${userId}|${actionKey}|${op}|${recipient}|${amount}`;
  }
  return `${userId}|unbound|session`;
};

export const cacheAllowsReuse = (cachedKey: string | null | undefined, nextKey: string | null | undefined): boolean =>
  Boolean(cachedKey && nextKey && cachedKey === nextKey);

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
