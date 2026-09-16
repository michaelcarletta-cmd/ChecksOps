import { awsApiBaseUrl } from "@/lib/awsStaging";
import { AWS_STAGING_AUTH_SESSION_KEY } from "@/lib/awsStaging";

const readIdToken = (): string | null => {
  try {
    const raw = sessionStorage.getItem(AWS_STAGING_AUTH_SESSION_KEY);
    if (!raw) return null;
    const idToken = JSON.parse(raw)?.tokens?.idToken;
    return typeof idToken === "string" && idToken ? idToken : null;
  } catch {
    return null;
  }
};

const api = async (path: string, init: RequestInit = {}) => {
  const token = readIdToken();
  const base = String(awsApiBaseUrl() || "").replace(/\/$/, "");
  if (!base || !token) {
    return { ok: false, status: 401, json: { error: "not_authenticated" } };
  }
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok && json?.ok !== false, status: response.status, json };
};

export const fetchCheckAltAutoDepositSettings = async (tenantId: string) =>
  api(`/functions/v1/checkalt-auto-deposit-settings?tenant_id=${encodeURIComponent(tenantId)}`, {
    method: "GET",
  });

export const saveCheckAltAutoDepositSettings = async (input: {
  tenantId: string;
  enabled: boolean;
  maxCents: number | null;
}) =>
  api("/functions/v1/checkalt-auto-deposit-settings", {
    method: "POST",
    body: JSON.stringify({
      tenant_id: input.tenantId,
      auto_deposit_enabled: input.enabled,
      auto_deposit_max_cents: input.maxCents,
    }),
  });
