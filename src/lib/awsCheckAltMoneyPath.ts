/**
 * Production CheckAlt money movement must use the AWS /prep path only.
 * Legacy Lovable/Supabase hosts are refused even if DNS returns.
 */

export const LEGACY_CHECKALT_MONEY_FUNCTIONS = Object.freeze([
  "checkalt-submit-deposit",
  "checkalt-approve-deposit",
] as const);

export const LEGACY_CHECKALT_MONEY_HOST = /supabase\.co|lovable|nbcqwpysqgyxrrbgtmkw/i;

export const LEGACY_CHECKALT_MONEY_BLOCKED = "legacy_checkalt_money_path_blocked";

const AWS_SESSION_KEY = "checksops.aws.staging.auth";

export const isLegacyCheckAltMoneyFunction = (name: unknown): boolean =>
  (LEGACY_CHECKALT_MONEY_FUNCTIONS as readonly string[]).includes(String(name || ""));

export const legacyCheckAltMoneyHostDenied = (value: unknown): boolean =>
  LEGACY_CHECKALT_MONEY_HOST.test(String(value || ""));

export const awsCheckAltMoneyRequestUrl = (
  apiBaseUrl: string,
  name: string,
): string | null => {
  if (!isLegacyCheckAltMoneyFunction(name)) return null;
  const base = String(apiBaseUrl || "").trim().replace(/\/$/, "");
  if (!base || legacyCheckAltMoneyHostDenied(base) || legacyCheckAltMoneyHostDenied(name)) {
    return null;
  }
  return `${base}/functions/v1/${encodeURIComponent(name)}`;
};

export const awsCheckAltMoneyPathReady = (deps: {
  authProvider?: string;
  apiBaseUrl?: string;
  functionName: string;
}): { ok: true; url: string } | { ok: false; error: string } => {
  const authProvider = String(
    deps.authProvider
      ?? (typeof import.meta !== "undefined" ? import.meta.env?.VITE_AUTH_PROVIDER : "")
      ?? "",
  ).toLowerCase();
  if (authProvider !== "cognito") {
    return { ok: false, error: LEGACY_CHECKALT_MONEY_BLOCKED };
  }
  const url = awsCheckAltMoneyRequestUrl(String(deps.apiBaseUrl || ""), deps.functionName);
  if (!url) return { ok: false, error: LEGACY_CHECKALT_MONEY_BLOCKED };
  return { ok: true, url };
};

export const requireAwsCheckAltMoneyPath = (deps: {
  authProvider?: string;
  apiBaseUrl?: string;
  functionName: string;
}): string => {
  const ready = awsCheckAltMoneyPathReady(deps);
  if (!ready.ok) throw new Error(ready.error);
  return ready.url;
};

const readIdToken = (sessionKey = AWS_SESSION_KEY): string | null => {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(sessionKey);
    if (!raw) return null;
    const idToken = JSON.parse(raw)?.tokens?.idToken;
    return typeof idToken === "string" && idToken ? idToken : null;
  } catch {
    return null;
  }
};

export async function invokeAwsCheckAltMoneyFunction(
  name: string,
  options: { body?: Record<string, unknown> } = {},
  deps: {
    authProvider?: string;
    apiBaseUrl?: string;
    idToken?: string | null;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ data: unknown; error: Error | null; providerHttp: false }> {
  const ready = awsCheckAltMoneyPathReady({
    authProvider: deps.authProvider,
    apiBaseUrl: deps.apiBaseUrl,
    functionName: name,
  });
  if (!ready.ok) {
    return { data: null, error: new Error(ready.error), providerHttp: false };
  }
  const token = deps.idToken !== undefined ? deps.idToken : readIdToken();
  if (!token) {
    return { data: null, error: new Error("not_authenticated"), providerHttp: false };
  }
  try {
    const response = await (deps.fetchImpl || fetch)(ready.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(options.body || {}),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        data: body && typeof body === "object" ? body : null,
        error: new Error(String(body?.error || body?.message || `FunctionsHttpError:${name}`)),
        providerHttp: false,
      };
    }
    return { data: body, error: null, providerHttp: false };
  } catch {
    return { data: null, error: new Error(`FunctionsHttpError:${name}`), providerHttp: false };
  }
}
