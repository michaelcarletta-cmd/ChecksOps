import { AWS_STAGING_AUTH_SESSION_KEY, awsApiBaseUrl, isAwsStaging } from "@/lib/awsStaging";

export type AwsMfaStatus = {
  totpEnrolled: boolean;
  preferredMfa: string | null;
};

const readAccessToken = (sessionKey = AWS_STAGING_AUTH_SESSION_KEY): string | null => {
  try {
    const raw = localStorage.getItem(sessionKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const token = parsed?.tokens?.accessToken;
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
};

const post = async (path: string, body: Record<string, unknown> = {}) => {
  const accessToken = readAccessToken();
  if (!accessToken) throw new Error("missing_access_token");
  const response = await fetch(`${awsApiBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ ...body, accessToken }),
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
    totpEnrolled: Boolean(payload.totpEnrolled),
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

export const verifyAwsTotp = async (code: string) => {
  const payload = await post("/auth/mfa/verify", { code });
  return Boolean(payload.verified || payload.ok);
};
