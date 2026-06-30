// Shared CheckAlt (Clearingworks FinCapture) helpers — JWT acquisition + base config loader.
// Single ChecksOps-wide account model: credentials live in env secrets,
// per-deployment config (base URL, merchant, fi_key, depositor account, business unit) lives in checkalt_config.
//
// API reference: Clearingworks IR OpenAPI 3.1 spec (ClearingworksAPI.yaml)
// Auth:    POST {base_url}/public/fincapture/authenticate  (no JWT required)
// Deposit: POST {base_url}/fincapture/deposit/process      (JWT required)
// Status:  POST {base_url}/fincapture/deposit/item         (JWT required)
// Approve: POST {base_url}/fincapture/deposit/approve      (JWT required)
// History: POST {base_url}/fincapture/deposit/history       (JWT required)

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Types ──────────────────────────────────────────────────

export interface CheckAltConfig {
  base_url: string | null;
  merchant: string | null;
  fi_key: string | null;
  business_unit: string | null;
  depositor_account_id: string | null;
  default_enabled: boolean;
  cached_jwt: string | null;
  cached_jwt_expires_at: string | null;
}

export interface TenantAccount {
  tenant_id: string;
  sso_user_id: string;
  deposit_account_number: string;
}

// ─── Core helpers ───────────────────────────────────────────

export function getServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Supabase service env not configured");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function loadConfig(supabase: SupabaseClient): Promise<CheckAltConfig> {
  const { data, error } = await supabase
    .from("checkalt_config")
    .select(
      "base_url, merchant, fi_key, business_unit, depositor_account_id, default_enabled, cached_jwt, cached_jwt_expires_at",
    )
    .eq("singleton", true)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("checkalt_config singleton row missing");
  return data as CheckAltConfig;
}

/**
 * Load the CheckAlt tenant account row for a given tenant_id.
 * Throws if no registered account exists.
 */
export async function loadTenantAccount(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<TenantAccount> {
  const { data, error } = await supabase
    .from("checkalt_tenant_accounts")
    .select("tenant_id, sso_user_id, deposit_account_number")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.sso_user_id || !data?.deposit_account_number) {
    throw new Error(
      "No registered CheckAlt account for this tenant. Register in Integration Settings first.",
    );
  }
  return data as TenantAccount;
}

// ─── JWT ────────────────────────────────────────────────────

/**
 * Returns a valid JWT for FinCapture. Uses cached JWT if not expired,
 * otherwise authenticates via /public/fincapture/authenticate and caches the result.
 */
export async function getCheckAltJwt(
  supabase: SupabaseClient,
  cfg: CheckAltConfig,
): Promise<string> {
  if (cfg.cached_jwt && cfg.cached_jwt_expires_at) {
    const exp = new Date(cfg.cached_jwt_expires_at).getTime();
    if (exp - Date.now() > 60_000) return cfg.cached_jwt;
  }

  const username = Deno.env.get("CHECKALT_USERNAME");
  const password = Deno.env.get("CHECKALT_PASSWORD");
  if (!username || !password)
    throw new Error("CHECKALT_USERNAME / CHECKALT_PASSWORD not configured");
  if (!cfg.base_url) throw new Error("checkalt_config.base_url not set");
  if (!cfg.merchant) throw new Error("checkalt_config.merchant not set");

  const baseUrl = cfg.base_url.replace(/\/$/, "");
  const resp = await fetch(`${baseUrl}/public/fincapture/authenticate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      merchant: cfg.merchant,
    },
    body: JSON.stringify({ userName: username, password }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`CheckAlt auth failed [${resp.status}]: ${body}`);
  }

  const raw = (await resp.text()).trim();
  let jwt: string | undefined;
  if (raw.startsWith("{")) {
    try {
      const data = JSON.parse(raw);
      jwt = data?.token ?? data?.jwt ?? data?.accessToken;
    } catch { /* fall through */ }
  } else {
    jwt = raw.replace(/^"|"$/g, "");
  }
  if (!jwt || !jwt.includes(".")) throw new Error("CheckAlt auth response missing token");

  let expiresAt = new Date(Date.now() + 50 * 60_000).toISOString();
  try {
    const parts = jwt.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(
        atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
      );
      if (payload?.exp)
        expiresAt = new Date(payload.exp * 1000).toISOString();
    }
  } catch { /* ignore */ }

  await supabase
    .from("checkalt_config")
    .update({ cached_jwt: jwt, cached_jwt_expires_at: expiresAt })
    .eq("singleton", true);

  return jwt;
}

// ─── Authenticated fetch ────────────────────────────────────

/**
 * Authenticated fetch wrapper for FinCapture endpoints.
 * Automatically loads config, acquires/caches JWT, and injects
 * the required `merchant` + `Authorization` headers.
 */
export async function checkAltFetch(
  supabase: SupabaseClient,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const cfg = await loadConfig(supabase);
  if (!cfg.merchant) throw new Error("checkalt_config.merchant not set");

  const jwt = await getCheckAltJwt(supabase, cfg);
  const baseUrl = (cfg.base_url ?? "").replace(/\/$/, "");
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${jwt}`);
  headers.set("merchant", cfg.merchant);
  if (!headers.has("Content-Type") && init.body)
    headers.set("Content-Type", "application/json");

  return await fetch(url, { ...init, headers });
}

// ─── Account info helpers ───────────────────────────────────

/**
 * Calls POST /fincapture/useraccount/getUserAccountInformation
 * Returns the full response JSON (FinCaptureAPIUserResponse with accountDataList).
 */
export async function getUserAccountInfo(
  supabase: SupabaseClient,
  ssoUserId: string,
): Promise<{ ok: boolean; json: any; raw: string }> {
  const cfg = await loadConfig(supabase);
  if (!cfg.fi_key) throw new Error("checkalt_config.fi_key not set");

  const resp = await checkAltFetch(supabase, "/fincapture/useraccount/getUserAccountInformation", {
    method: "POST",
    body: JSON.stringify({ fiKey: cfg.fi_key, userId: ssoUserId }),
  });
  const raw = await resp.text();
  let json: any;
  try { json = JSON.parse(raw); } catch { json = { raw }; }
  return { ok: resp.ok, json, raw };
}

/**
 * Calls POST /fincapture/useraccount/getDepositAccountInformation
 */
export async function getDepositAccountInfo(
  supabase: SupabaseClient,
  ssoUserId: string,
  accountNumber: string,
): Promise<{ ok: boolean; json: any; raw: string }> {
  const cfg = await loadConfig(supabase);
  if (!cfg.fi_key) throw new Error("checkalt_config.fi_key not set");

  const resp = await checkAltFetch(supabase, "/fincapture/useraccount/getDepositAccountInformation", {
    method: "POST",
    body: JSON.stringify({ fiKey: cfg.fi_key, userId: ssoUserId, accountNumber }),
  });
  const raw = await resp.text();
  let json: any;
  try { json = JSON.parse(raw); } catch { json = { raw }; }
  return { ok: resp.ok, json, raw };
}

/**
 * Calls POST /fincapture/deposit/item for a single deposit status check.
 */
export async function getDepositItemStatus(
  supabase: SupabaseClient,
  tenant: TenantAccount,
  referenceNumber: string,
): Promise<{ ok: boolean; json: any; raw: string }> {
  const cfg = await loadConfig(supabase);
  if (!cfg.fi_key) throw new Error("checkalt_config.fi_key not set");

  const resp = await checkAltFetch(supabase, "/fincapture/deposit/item", {
    method: "POST",
    body: JSON.stringify({
      fiKey: cfg.fi_key,
      ssoKey: tenant.sso_user_id,
      referenceNumber: Number(referenceNumber),
    }),
  });
  const raw = await resp.text();
  let json: any;
  try { json = JSON.parse(raw); } catch { json = { raw }; }
  return { ok: resp.ok, json, raw };
}

/**
 * Maps a numeric CheckAlt deposit status code to an internal status string.
 * Codes per Clearingworks API spec FinCaptureAPIDepositItemResponse:
 *   1 = pending, 2 = submitted, 3 = accepted/cleared, 4 = rejected/returned,
 *   5 = suspended, 6 = duplicate
 */
export function mapDepositStatus(
  code: number,
  currentStatus: string,
): string {
  switch (code) {
    case 1: return "pending";
    case 2: return "submitted";
    case 3: return "cleared";
    case 4: return "rejected";
    case 5: return "suspended";
    case 6: return "duplicate";
    default: return currentStatus;
  }
}

/**
 * Extracts the ssoKey for a given accountNumber from the CheckAlt
 * getUserAccountInformation response.
 *
 * The response shape is: { accountDataList: [{ accountNumber, ssoKey, ... }] }
 * Returns the ssoKey string, or null if not found.
 */
export function extractSsoKey(
  userAccountInfo: any,
  accountNumber: string,
): string | null {
  const list: any[] = userAccountInfo?.accountDataList ?? [];
  for (const acct of list) {
    if (acct.accountNumber === accountNumber && acct.ssoKey) {
      return acct.ssoKey;
    }
  }
  // If only one account and it has ssoKey, use it regardless of accountNumber match
  if (list.length === 1 && list[0]?.ssoKey) {
    return list[0].ssoKey;
  }
  return null;
}
