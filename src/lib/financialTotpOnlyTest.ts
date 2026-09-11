/**
 * Production-safe financial TOTP verification.
 *
 * Calls the app-level ChecksOps Financial TOTP `/prep/auth/mfa/step-up` path
 * (via requireStepUp / StepUpDialog) bound to an existing check, then STOPS.
 * This module must never become a provider-execution or deposit-submit helper.
 *
 * Server-derived tenant and amount_cents come from the check inside
 * handleMfaStepUp. Browser tenant / amount are ignored.
 */

import {
  awsStepUpBody,
  buildFinancialStepUpRequest,
  type FinancialStepUpRequest,
} from "./financialStepUp.ts";

export const FINANCIAL_TOTP_ONLY_COPY =
  "Verify financial TOTP only — no deposit will be submitted.";

export const FINANCIAL_TOTP_ONLY_OPERATION = "deposit.submit" as const;

export const FINANCIAL_TOTP_ONLY_ROLES = Object.freeze(["owner", "admin", "manager"] as const);

export const FINANCIAL_TOTP_ONLY_FORBIDDEN = Object.freeze([
  "checkalt-submit-deposit",
  "checkalt-approve-deposit",
  "prepare_deposit",
  "assign_provider",
  "prepareCheckAltDeposit",
] as const);

const CHECK_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isExistingCheckId = (value: unknown): boolean =>
  CHECK_UUID.test(String(value || "").trim());

/** Flatten user_roles, tenant_users, and identity/me role payloads. */
export const collectFinancialTotpOnlyRoles = (...groups: unknown[]): string[] => {
  const roles: string[] = [];
  const visit = (value: unknown) => {
    if (value == null) return;
    if (typeof value === "string") {
      const role = value.trim().toLowerCase();
      if (role) roles.push(role);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.role === "string") visit(record.role);
      visit(record.roles);
      visit(record.tenant_roles);
      visit(record.user_roles);
    }
  };
  for (const group of groups) visit(group);
  return [...new Set(roles)];
};

export const roleMayRunFinancialTotpOnlyTest = (roleOrRoles: unknown): boolean =>
  collectFinancialTotpOnlyRoles(roleOrRoles).some((role) =>
    (FINANCIAL_TOTP_ONLY_ROLES as readonly string[]).includes(role),
  );

/** Exact Account Security / Settings visibility predicate. */
export const canShowFinancialTotpOnlyTestCard = (input: {
  awsMfaAvailable: boolean;
  userId?: string | null;
  roles?: unknown;
}): boolean =>
  Boolean(input.awsMfaAvailable && input.userId && roleMayRunFinancialTotpOnlyTest(input.roles));

/** Trusted roles from AWS GET /identity/me. Empty on any untrusted payload. */
export const identityMeFinancialRoles = (identity: unknown): unknown => {
  if (!identity || typeof identity !== "object") return [];
  const record = identity as Record<string, unknown>;
  if (record.ok === false || !record.applicationUserId) return [];
  return {
    roles: record.roles,
    tenant_roles: Array.isArray(record.tenant_roles) ? record.tenant_roles : record.tenants,
  };
};

export type FinancialTotpOnlyStop = {
  continued: false;
  invoked: readonly [];
  providerHttp: false;
  mutated: {
    check: false;
    stage: false;
    checkalt_deposits: false;
  };
};

export type FinancialTotpOnlyOutcome = FinancialTotpOnlyStop & {
  authorized: boolean;
  operation: typeof FINANCIAL_TOTP_ONLY_OPERATION;
  checkId: string;
  ignored: {
    browserAmount: boolean;
    browserAmountCents: boolean;
    browserTenantNotAuthoritative: true;
  };
  stepUpBody: {
    action_key: string;
    check_intake_item_id?: string;
    tenant_id?: string;
  };
};

const STOPPED: FinancialTotpOnlyStop = Object.freeze({
  continued: false,
  invoked: Object.freeze([]) as readonly [],
  providerHttp: false,
  mutated: Object.freeze({
    check: false,
    stage: false,
    checkalt_deposits: false,
  }),
});

export const financialTotpOnlyDenied = (error: string): FinancialTotpOnlyStop & {
  ok: false;
  error: string;
} => ({
  ok: false,
  error,
  ...STOPPED,
});

export async function runFinancialTotpOnlyVerification(input: {
  roles: unknown;
  checkId: string;
  requireStepUp: (request: FinancialStepUpRequest) => Promise<boolean>;
  browserTenantId?: string | null;
  browserAmount?: unknown;
  browserAmountCents?: unknown;
}): Promise<
  | ({ ok: true } & { outcome: FinancialTotpOnlyOutcome })
  | (FinancialTotpOnlyStop & { ok: false; error: string })
> {
  if (!roleMayRunFinancialTotpOnlyTest(input.roles)) {
    return financialTotpOnlyDenied("financial_role_required");
  }
  if (!isExistingCheckId(input.checkId)) {
    return financialTotpOnlyDenied("existing_check_required");
  }

  const checkId = String(input.checkId).trim();
  const built = buildFinancialStepUpRequest({
    actionKey: FINANCIAL_TOTP_ONLY_OPERATION,
    checkId,
    tenantId: input.browserTenantId,
    amount: input.browserAmount,
    amount_cents: input.browserAmountCents,
    title: FINANCIAL_TOTP_ONLY_COPY,
    description: FINANCIAL_TOTP_ONLY_COPY,
  });
  if (!built.ok) {
    return financialTotpOnlyDenied((built as { error?: string }).error ?? "step_up_unavailable");
  }

  const authorized = await input.requireStepUp(built.request);
  return {
    ok: true,
    outcome: {
      authorized,
      operation: FINANCIAL_TOTP_ONLY_OPERATION,
      checkId,
      ignored: built.ignored,
      stepUpBody: awsStepUpBody(built.request),
      ...STOPPED,
    },
  };
}
