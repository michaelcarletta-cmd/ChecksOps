/**
 * Production CheckAlt provider actions must use the AWS /prep path only.
 * Legacy Lovable/Supabase hosts are refused even if DNS returns.
 */

export const LEGACY_CHECKALT_PROVIDER_FUNCTIONS = Object.freeze([
  "checkalt-submit-deposit",
  "checkalt-approve-deposit",
  "checkalt-poll-status",
  "checkalt-test-connection",
  "checkalt-register-account",
  "checkalt-verify-account",
  "checkalt-account-status",
  "checkalt-deposit-history",
] as const);

/** @deprecated Use LEGACY_CHECKALT_PROVIDER_FUNCTIONS */
export const LEGACY_CHECKALT_MONEY_FUNCTIONS = LEGACY_CHECKALT_PROVIDER_FUNCTIONS;

export const LEGACY_CHECKALT_MONEY_HOST = /supabase\.co|lovable|nbcqwpysqgyxrrbgtmkw/i;

export const LEGACY_CHECKALT_PROVIDER_BLOCKED = "legacy_checkalt_provider_path_blocked";

/** @deprecated Use LEGACY_CHECKALT_PROVIDER_BLOCKED */
export const LEGACY_CHECKALT_MONEY_BLOCKED = LEGACY_CHECKALT_PROVIDER_BLOCKED;

export const CHECKALT_PROVIDER_UNAVAILABLE = "Provider not enabled / unavailable";

const isCheckAltArtifactPath = (value: unknown) =>
  /\.checkalt\.jpe?g$/i.test(String(value || ""));

const AWS_SESSION_KEY = "checksops.aws.staging.auth";

export const isLegacyCheckAltProviderFunction = (name: unknown): boolean =>
  (LEGACY_CHECKALT_PROVIDER_FUNCTIONS as readonly string[]).includes(String(name || ""));

/** @deprecated Use isLegacyCheckAltProviderFunction */
export const isLegacyCheckAltMoneyFunction = isLegacyCheckAltProviderFunction;

export const legacyCheckAltMoneyHostDenied = (value: unknown): boolean =>
  LEGACY_CHECKALT_MONEY_HOST.test(String(value || ""));

export const awsCheckAltProviderRequestUrl = (
  apiBaseUrl: string,
  name: string,
): string | null => {
  if (!isLegacyCheckAltProviderFunction(name)) return null;
  const base = String(apiBaseUrl || "").trim().replace(/\/$/, "");
  if (!base || legacyCheckAltMoneyHostDenied(base) || legacyCheckAltMoneyHostDenied(name)) {
    return null;
  }
  return `${base}/functions/v1/${encodeURIComponent(name)}`;
};

/** @deprecated Use awsCheckAltProviderRequestUrl */
export const awsCheckAltMoneyRequestUrl = awsCheckAltProviderRequestUrl;

export const awsCheckAltProviderPathReady = (deps: {
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
    return { ok: false, error: LEGACY_CHECKALT_PROVIDER_BLOCKED };
  }
  const url = awsCheckAltProviderRequestUrl(String(deps.apiBaseUrl || ""), deps.functionName);
  if (!url) return { ok: false, error: LEGACY_CHECKALT_PROVIDER_BLOCKED };
  return { ok: true, url };
};

/** @deprecated Use awsCheckAltProviderPathReady */
export const awsCheckAltMoneyPathReady = awsCheckAltProviderPathReady;

export const requireAwsCheckAltProviderPath = (deps: {
  authProvider?: string;
  apiBaseUrl?: string;
  functionName: string;
}): string => {
  const ready = awsCheckAltProviderPathReady(deps);
  if (!ready.ok) throw new Error((ready as { error?: string }).error ?? "provider path unavailable");
  return ready.url;
};

/** @deprecated Use requireAwsCheckAltProviderPath */
export const requireAwsCheckAltMoneyPath = requireAwsCheckAltProviderPath;

export const checkAltProviderUserMessage = (error: unknown): string => {
  const msg = error instanceof Error ? error.message : String(error || "");
  if (
    /provider_disabled|production_execution_blocked|legacy_checkalt_provider_path/i.test(msg)
  ) {
    return CHECKALT_PROVIDER_UNAVAILABLE;
  }
  return msg || CHECKALT_PROVIDER_UNAVAILABLE;
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

export async function invokeAwsCheckAltProviderFunction(
  name: string,
  options: { body?: Record<string, unknown> } = {},
  deps: {
    authProvider?: string;
    apiBaseUrl?: string;
    idToken?: string | null;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ data: unknown; error: Error | null; providerHttp: false }> {
  const ready = awsCheckAltProviderPathReady({
    authProvider: deps.authProvider,
    apiBaseUrl: deps.apiBaseUrl,
    functionName: name,
  });
  if (!ready.ok) {
    return { data: null, error: new Error((ready as { error?: string }).error ?? "provider path unavailable"), providerHttp: false };
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
    if (body && typeof body === "object" && body.success === false && body.error) {
      return {
        data: body,
        error: new Error(String(body.error)),
        providerHttp: false,
      };
    }
    return { data: body, error: null, providerHttp: false };
  } catch {
    return { data: null, error: new Error(`FunctionsHttpError:${name}`), providerHttp: false };
  }
}

/** @deprecated Use invokeAwsCheckAltProviderFunction */
export const invokeAwsCheckAltMoneyFunction = invokeAwsCheckAltProviderFunction;

export const CHECKALT_IMAGE_PREPARATION_REQUIRED = "CHECKALT_IMAGE_PREPARATION_REQUIRED";

/**
 * Command Center one-click CheckAlt submit.
 * Official 1920x1080 artifacts must exist before AWS submit.
 * No prepare_deposit / assign_provider RPCs. No silent 1600/1200 submit.
 */
export async function runCheckAltOneClickSubmit(
  checkId: string,
  deps: {
    authProvider?: string;
    apiBaseUrl?: string;
    idToken?: string | null;
    fetchImpl?: typeof fetch;
    prepareCheckAltDeposit?: (checkId: string) => Promise<{
      deposit_front_path: string;
      deposit_back_path: string;
    }>;
  } = {},
): Promise<{ data: unknown; error: Error | null; providerHttp: false; mutated: {
  deposit_items: false;
  deposit_batches: false;
  assign_provider: false;
  prepare_deposit: false;
  check_stage: false;
} }> {
  requireAwsCheckAltProviderPath({
    authProvider: deps.authProvider,
    apiBaseUrl: deps.apiBaseUrl,
    functionName: "checkalt-submit-deposit",
  });
  const noSubmit = (message: string) => ({
    data: null,
    error: new Error(message),
    providerHttp: false as const,
    mutated: {
      deposit_items: false as const,
      deposit_batches: false as const,
      assign_provider: false as const,
      prepare_deposit: false as const,
      check_stage: false as const,
    },
  });
  let prepared: { deposit_front_path: string; deposit_back_path: string };
  try {
    const prepare = deps.prepareCheckAltDeposit
      || (await import("./prepareCheckAltDeposit")).prepareCheckAltDeposit;
    prepared = await prepare(checkId);
  } catch (error) {
    return noSubmit(error instanceof Error ? error.message : CHECKALT_IMAGE_PREPARATION_REQUIRED);
  }
  if (
    !isCheckAltArtifactPath(prepared.deposit_front_path)
    || !isCheckAltArtifactPath(prepared.deposit_back_path)
  ) {
    return noSubmit(CHECKALT_IMAGE_PREPARATION_REQUIRED);
  }
  const result = await invokeAwsCheckAltProviderFunction(
    "checkalt-submit-deposit",
    {
      body: {
        check_intake_item_id: checkId,
        deposit_front_path: prepared.deposit_front_path,
        deposit_back_path: prepared.deposit_back_path,
      },
    },
    deps,
  );
  return {
    ...result,
    mutated: {
      deposit_items: false,
      deposit_batches: false,
      assign_provider: false,
      prepare_deposit: false,
      check_stage: false,
    },
  };
}
