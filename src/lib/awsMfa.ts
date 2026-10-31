import { AWS_STAGING_AUTH_SESSION_KEY, awsApiBaseUrl, isAwsStaging } from "@/lib/awsStaging";
import { normalizeTotpCode, totpUserFailureMessage } from "@/lib/totpCode";

export type AwsMfaStatus = {
  totpEnrolled: boolean;
  preferredMfa: string | null;
};

export { awsTotpEnrollmentDisplay } from "@/lib/totpEnrollment";

const readSession = (sessionKey = AWS_STAGING_AUTH_SESSION_KEY): {
  accessToken: string | null;
  idToken: string | null;
  userId: string | null;
} => {
  try {
    const raw = localStorage.getItem(sessionKey);
    if (!raw) return { accessToken: null, idToken: null, userId: null };
    const parsed = JSON.parse(raw);
    const accessToken = parsed?.tokens?.accessToken;
    const idToken = parsed?.tokens?.idToken;
    const userId = parsed?.user?.id || null;
    return {
      accessToken: typeof accessToken === "string" && accessToken ? accessToken : null,
      idToken: typeof idToken === "string" && idToken ? idToken : null,
      userId: typeof userId === "string" && userId ? userId : null,
    };
  } catch {
    return { accessToken: null, idToken: null, userId: null };
  }
};

const post = async (
  path: string,
  body: Record<string, unknown> = {},
  // Answers that are a step of the flow, not a failure (finding 8: email_code_required).
  allowErrors: string[] = [],
) => {
  const session = readSession();
  if (!session.accessToken) throw new Error("missing_access_token");
  const response = await fetch(`${awsApiBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.idToken || session.accessToken}`,
    },
    body: JSON.stringify({ ...body, accessToken: session.accessToken }),
  });
  const payload = await response.json().catch(() => ({}));
  if (payload?.error && allowErrors.includes(String(payload.error))) return payload;
  if (!response.ok || payload?.ok === false) {
    throw new Error(String(payload?.message || payload?.error || `mfa_request_failed_${response.status}`));
  }
  return payload;
};

export const awsMfaAvailable = () => isAwsStaging() && Boolean(awsApiBaseUrl());

export const getAwsMfaStatus = async (): Promise<AwsMfaStatus> => {
  const payload = await post("/auth/mfa/status");
  return {
    totpEnrolled: payload.totpEnrolled === true,
    preferredMfa: payload.preferredMfa ? String(payload.preferredMfa) : null,
  };
};

export type AwsTotpAssociation = {
  secret: string | null;
  otpauthUri: string | null;
  /** Sent back with the first verify; the API refuses to activate a pending setup without it. */
  enrollmentTicket: string | null;
  /** First-time setup: a code was emailed and must be entered before the secret is issued. */
  emailCodeRequired: boolean;
  emailChallenge: string | null;
  emailHint: string | null;
  /** Staging only (email sink): the API shows the emailed code. Never set in production. */
  stagingDebugCode: string | null;
};

const text = (value: unknown) => (typeof value === "string" && value ? value : null);

/**
 * Starts authenticator setup. Without emailCode, an API that requires a fresh email code
 * (finding 8) emails one and answers emailCodeRequired with a challenge; call again with the
 * challenge and the code to get the secret. An API without that step answers with the secret
 * directly, so this works against both.
 */
export const associateAwsTotp = async (
  email?: string | null,
  emailCode?: { challenge: string; code: string },
): Promise<AwsTotpAssociation> => {
  const payload = await post("/auth/mfa/associate", {
    email: email || undefined,
    emailChallenge: emailCode?.challenge,
    emailCode: emailCode?.code,
  }, ["email_code_required"]);
  return {
    secret: text(payload?.totp?.secret),
    otpauthUri: text(payload?.totp?.otpauth_uri),
    enrollmentTicket: text(payload?.enrollmentTicket),
    emailCodeRequired: payload?.error === "email_code_required",
    emailChallenge: text(payload?.emailChallenge),
    emailHint: text(payload?.emailHint),
    stagingDebugCode: text(payload?.stagingDebugCode),
  };
};

/** The 6-digit code from the setup email, as a string (leading zeros kept). */
export const normalizeEmailSetupCode = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return /^\d{6}$/.test(trimmed) ? trimmed : null;
};

const totpBody = (
  code: unknown,
  extra: { actionKey?: string; tenantId?: string | null; checkId?: string | null } = {},
) => {
  const normalized = normalizeTotpCode(code);
  if (!normalized.ok) {
    throw new Error(totpUserFailureMessage({ message: (normalized as { error?: string }).error }));
  }
  return {
    code: normalized.code,
    action_key: extra.actionKey,
    tenant_id: extra.tenantId || undefined,
    check_intake_item_id: extra.checkId || undefined,
  };
};

const postTotp = async (path: string, body: Record<string, unknown>) => {
  try {
    return await post(path, body);
  } catch (error) {
    throw new Error(totpUserFailureMessage(error));
  }
};

export const verifyAwsTotp = async (
  code: string,
  extra: { actionKey?: string; tenantId?: string | null; checkId?: string | null; enrollmentTicket?: string | null } = {},
) => {
  const payload = await postTotp("/auth/mfa/verify", {
    ...totpBody(code, extra),
    enrollmentTicket: extra.enrollmentTicket || undefined,
  });
  return Boolean(payload.verified || payload.ok);
};

export const stepUpAwsTotp = async (input: {
  code: string;
  actionKey?: string;
  tenantId?: string | null;
  checkId?: string | null;
}) => {
  const payload = await postTotp("/auth/mfa/step-up", totpBody(input.code, {
    actionKey: input.actionKey || "deposit.submit",
    tenantId: input.tenantId,
    checkId: input.checkId,
  }));
  return Boolean(payload.verified || payload.ok);
};

export const awsAuthUserId = () => readSession().userId;
