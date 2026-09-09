/**
 * AWS-only role refresh for the financial TOTP test card.
 * Calls GET /identity/me on the Cognito /prep API.
 */

import { identityMeFinancialRoles } from "./financialTotpOnlyTest.ts";

const AWS_SESSION_KEY = "checksops.aws.staging.auth";
const LEGACY_BACKEND = /supabase\.co|lovable|nbcqwpysqgyxrrbgtmkw/i;

const readIdToken = (sessionKey = AWS_SESSION_KEY): string | null => {
  try {
    const raw = localStorage.getItem(sessionKey);
    if (!raw) return null;
    const idToken = JSON.parse(raw)?.tokens?.idToken;
    return typeof idToken === "string" && idToken ? idToken : null;
  } catch {
    return null;
  }
};

export const identityMeRequestUrl = (apiBaseUrl: string): string | null => {
  const base = String(apiBaseUrl || "").trim().replace(/\/$/, "");
  if (!base || LEGACY_BACKEND.test(base)) return null;
  return `${base}/identity/me`;
};

export async function loadAwsIdentityFinancialRoles(deps: {
  awsMfaAvailable?: boolean;
  apiBaseUrl?: string;
  idToken?: string | null;
  fetchImpl?: typeof fetch;
} = {}): Promise<{ ok: true; roles: unknown } | { ok: false; error: string }> {
  const available = deps.awsMfaAvailable === true;
  const apiBaseUrl = deps.apiBaseUrl ?? "";
  const idToken = deps.idToken !== undefined ? deps.idToken : readIdToken();
  const url = identityMeRequestUrl(apiBaseUrl);
  if (!available || !url || !idToken) {
    return { ok: false, error: "identity_unavailable" };
  }

  try {
    const response = await (deps.fetchImpl || fetch)(url, {
      method: "GET",
      headers: { authorization: `Bearer ${idToken}` },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false || !body?.applicationUserId) {
      return { ok: false, error: "identity_lookup_failed" };
    }
    return { ok: true, roles: identityMeFinancialRoles(body) };
  } catch {
    return { ok: false, error: "identity_lookup_failed" };
  }
}
