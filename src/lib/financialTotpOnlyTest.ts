/**
 * Production-safe financial TOTP verification.
 *
 * Calls the real Cognito `/prep/auth/mfa/step-up` path (via requireStepUp /
 * StepUpDialog) bound to an existing check, then STOPS. This module must never
 * become a provider-execution or deposit-submit helper.
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

export const roleMayRunFinancialTotpOnlyTest = (roleOrRoles: unknown): boolean => {
  const roles = Array.isArray(roleOrRoles)
    ? roleOrRoles
    : typeof roleOrRoles === "string" && roleOrRoles.trim()
      ? [roleOrRoles]
      : [];
  return roles.some((role) =>
    (FINANCIAL_TOTP_ONLY_ROLES as readonly string[]).includes(String(role || "").toLowerCase()),
  );
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
    return financialTotpOnlyDenied(built.error);
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
