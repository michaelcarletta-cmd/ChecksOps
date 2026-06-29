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
 * Returns a valid JWT for FinCapture. Uses cached JWT if not expired,
 * otherwise authenticates via /public/fincapture/authenticate and caches the result.
 *
 * Sandbox/production credentials live in env secrets:
 *   CHECKALT_USERNAME, CHECKALT_PASSWORD
 *
 * The `merchant` header is required by Cloudflare WAF — without it requests
 * are blocked before reaching the application.
 */
export async function getCheckAltJwt(
  supabase: SupabaseClient,
  cfg: CheckAltConfig,
): Promise<string> {
  // 60s safety margin before expiry
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

  // Auth endpoint is under /public — no JWT needed
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

  // FinCapture may return the JWT as a raw string (not JSON-wrapped).
  // Try JSON first; fall back to the raw text body.
  const rawBody = await resp.text();
  let jwt: string | undefined;
  try {
    const data = JSON.parse(rawBody);
    jwt =
      typeof data === "string"
        ? data
        : (data?.token ?? data?.jwt ?? data?.accessToken);
  } catch {
    // Not valid JSON — treat the whole body as the JWT
    jwt = rawBody.trim();
  }
  if (!jwt) throw new Error("CheckAlt auth response missing token");

  // FinCapture JWTs are typically valid ~1h; decode exp if present, else assume 50min.
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
  } catch {
    /* ignore decode errors */
  }

  await supabase
    .from("checkalt_config")
    .update({ cached_jwt: jwt, cached_jwt_expires_at: expiresAt })
    .eq("singleton", true);

  return jwt;
}

/**
 * Authenticated fetch wrapper for FinCapture endpoints.
 * Automatically loads config, acquires/caches JWT, and injects
 * the required `merchant` + `Authorization` headers.
 *
 * `path` should be the API path *without* the base URL, e.g.
 *   "/fincapture/deposit/process"
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
