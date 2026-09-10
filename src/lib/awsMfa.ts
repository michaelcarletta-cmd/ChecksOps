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

const post = async (path: string, body: Record<string, unknown> = {}) => {
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

export const associateAwsTotp = async (email?: string | null) => {
  const payload = await post("/auth/mfa/associate", { email: email || undefined });
  return {
    secret: payload?.totp?.secret ? String(payload.totp.secret) : null,
    otpauthUri: payload?.totp?.otpauth_uri ? String(payload.totp.otpauth_uri) : null,
  };
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
  extra: { actionKey?: string; tenantId?: string | null; checkId?: string | null } = {},
) => {
  const payload = await postTotp("/auth/mfa/verify", totpBody(code, extra));
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

export const recordCheckAltDualControl = async (checkId: string) => {
  const session = readSession();
  if (!session.idToken && !session.accessToken) throw new Error("missing_access_token");
  const response = await fetch(`${awsApiBaseUrl()}/financial/checkalt-dual-control`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.idToken || session.accessToken}`,
    },
    body: JSON.stringify({ check_intake_item_id: checkId }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(String(payload?.message || payload?.error || "dual_control_failed"));
  }
  return payload;
};

export const awsAuthUserId = () => readSession().userId;
