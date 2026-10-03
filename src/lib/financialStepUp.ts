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
  actionKey: string,
  checkId: string | null,
): string | null => {
  if (!userId) return null;
  if (isCheckBoundAction(actionKey)) {
    if (!checkId) return null;
    return `${userId}|${actionKey}|${checkId}`;
  }
  return `${userId}|unbound|session`;
};

/**
 * Key-equality only. Not authorization. Callers must also check TTL via
 * `stepUpCacheAllowsReuse` — the browser cache is never authoritative.
 */
export const cacheAllowsReuse = (cachedKey: string | null | undefined, nextKey: string | null | undefined): boolean =>
  Boolean(cachedKey && nextKey && cachedKey === nextKey);

/** Matches server `TOTP_STEPUP_TTL_MS` in checkalt-authz.mjs. */
export const FINANCIAL_STEPUP_TTL_MS = 30 * 60 * 1000;
/** Client-local authorizedAt expires 60s early so a fast browser clock cannot outlive the server. */
export const FINANCIAL_STEPUP_CLIENT_CLOCK_SKEW_MS = 60 * 1000;
const AUTHORIZED_AT_FUTURE_SLACK_MS = 2 * 60 * 1000;

export type StepUpCacheSource = "server" | "client";

export type StepUpCacheEntry = {
  userId: string;
  key: string;
  authorizedAt: number;
  source: StepUpCacheSource;
};

export const parseAuthorizedAtMs = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return null;
};

export const resolveStepUpAuthorizedAt = (input: {
  serverCreatedAt?: unknown;
  authorizedAt?: unknown;
  clientNowMs?: number;
}): { authorizedAt: number; source: StepUpCacheSource } => {
  const server = parseAuthorizedAtMs(input.serverCreatedAt) ?? parseAuthorizedAtMs(input.authorizedAt);
  if (server !== null) return { authorizedAt: server, source: "server" };
  return { authorizedAt: input.clientNowMs ?? Date.now(), source: "client" };
};

export const stepUpCacheRemainingMs = (
  entry: { authorizedAt?: number | null; source?: string } | null | undefined,
  nowMs = Date.now(),
): number => {
  const authorizedAt = Number(entry?.authorizedAt);
  if (!Number.isFinite(authorizedAt) || authorizedAt <= 0) return -1;
  if (authorizedAt > nowMs + AUTHORIZED_AT_FUTURE_SLACK_MS) return -1;
  const effectiveAuthorizedAt = Math.min(authorizedAt, nowMs);
  const ttl = entry?.source === "server"
    ? FINANCIAL_STEPUP_TTL_MS
    : FINANCIAL_STEPUP_TTL_MS - FINANCIAL_STEPUP_CLIENT_CLOCK_SKEW_MS;
  return effectiveAuthorizedAt + ttl - nowMs;
};

export const parseStepUpCacheEntry = (
  parsed: unknown,
  userId: string,
  nowMs = Date.now(),
): StepUpCacheEntry | null => {
  if (!parsed || typeof parsed !== "object") return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.userId !== userId || typeof rec.key !== "string" || !rec.key) return null;
  const authorizedAt = parseAuthorizedAtMs(rec.authorizedAt);
  if (authorizedAt === null) return null;
  const source: StepUpCacheSource = rec.source === "server" ? "server" : "client";
  const entry: StepUpCacheEntry = { userId, key: rec.key, authorizedAt, source };
  if (stepUpCacheRemainingMs(entry, nowMs) <= 0) return null;
  return entry;
};

export const stepUpCacheAllowsReuse = (
  cached: { key?: string | null; authorizedAt?: number | null; source?: string } | null | undefined,
  nextKey: string | null | undefined,
  nowMs = Date.now(),
): boolean => {
  if (!cached?.key || !nextKey || cached.key !== nextKey) return false;
  return stepUpCacheRemainingMs(cached, nowMs) > 0;
};

const financialErrorText = (error: unknown): string => {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (error && typeof error === "object") {
    const rec = error as { error?: unknown; message?: unknown; code?: unknown };
    return [rec.error, rec.message, rec.code].filter(Boolean).join(" ");
  }
  return String(error || "");
};

export const isFinancialStepUpRequiredError = (error: unknown): boolean =>
  /\bstep_up_required\b|\bfinancial_step_up_required\b/i.test(financialErrorText(error));

export const AMBIGUOUS_FINANCIAL_PROVIDER_ERRORS = Object.freeze([
  "checkalt_approve_failed",
  "provider_timeout",
  "reconciliation_required",
  "deposit_process_ambiguous",
  "provider_response_ambiguous",
]);

export const isAmbiguousFinancialProviderOutcome = (error: unknown): boolean => {
  const text = financialErrorText(error);
  return AMBIGUOUS_FINANCIAL_PROVIDER_ERRORS.some((code) => text.includes(code));
};

export class FinancialStepUpDeniedError extends Error {
  readonly error = "totp_required";
  constructor(message = "Two-factor verification is required before money can move.") {
    super(message);
    this.name = "FinancialStepUpDeniedError";
  }
}

export type RequireStepUpFn = (
  request: FinancialStepUpRequest,
  options?: { force?: boolean },
) => Promise<boolean>;

/**
 * Challenge (or reuse an unexpired cache), run a ChecksOps action, and if the
 * backend reports expired server authorization (`step_up_required`) invalidate
 * the client cache, re-challenge, and retry that ChecksOps action at most once.
 * Ambiguous provider outcomes are never retried.
 */
export const runFinancialActionWithStepUp = async <T>(input: {
  requireStepUp: RequireStepUpFn;
  invalidateStepUp?: () => void;
  request: FinancialStepUpRequest;
  action: () => Promise<T>;
}): Promise<T> => {
  const firstOk = await input.requireStepUp(input.request);
  if (!firstOk) throw new FinancialStepUpDeniedError();

  try {
    return await input.action();
  } catch (error) {
    if (isAmbiguousFinancialProviderOutcome(error) || !isFinancialStepUpRequiredError(error)) {
      throw error;
    }
    input.invalidateStepUp?.();
    const retryOk = await input.requireStepUp(input.request, { force: true });
    if (!retryOk) throw new FinancialStepUpDeniedError();
    try {
      return await input.action();
    } catch (retryError) {
      if (isFinancialStepUpRequiredError(retryError)) {
        input.invalidateStepUp?.();
      }
      throw retryError;
    }
  }
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
