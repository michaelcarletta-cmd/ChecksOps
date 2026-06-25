// Shared CheckAlt (FinCapture) helpers — JWT acquisition + base config loader.
//
// Auth flow (UAT/Prod):
//   POST {base_url}/public/jwtauth/authenticate
//     Headers:
//       merchant: <CHECKALT_MERCHANT>            (e.g. "lockbox5")
//       Content-Type: application/x-www-form-urlencoded
//       Authorization: Basic base64(userId:password)
//
// Every other call must include `merchant` and `Authorization: Bearer <jwt>`.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface CheckAltConfig {
  base_url: string | null;
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

export function getCheckAltMerchant(): string {
  return Deno.env.get("CHECKALT_MERCHANT") ?? "lockbox5";
}

export function getCheckAltFiKey(): string {
  const k = Deno.env.get("CHECKALT_FI_KEY");
  if (!k) throw new Error("CHECKALT_FI_KEY not configured");
  return k;
}

export async function loadConfig(supabase: SupabaseClient): Promise<CheckAltConfig> {
  const { data, error } = await supabase
    .from("checkalt_config")
    .select("base_url, business_unit, depositor_account_id, default_enabled, cached_jwt, cached_jwt_expires_at")
    .eq("singleton", true)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("checkalt_config singleton row missing");
  return data as CheckAltConfig;
}

export async function getCheckAltJwt(supabase: SupabaseClient, cfg: CheckAltConfig): Promise<string> {
  // 60s safety margin before expiry
  if (cfg.cached_jwt && cfg.cached_jwt_expires_at) {
    const exp = new Date(cfg.cached_jwt_expires_at).getTime();
    if (exp - Date.now() > 60_000) return cfg.cached_jwt;
  }

  const username = Deno.env.get("CHECKALT_USERNAME");
  const password = Deno.env.get("CHECKALT_PASSWORD");
  if (!username || !password) throw new Error("CHECKALT_USERNAME / CHECKALT_PASSWORD not configured");
  const base = (cfg.base_url ?? "https://uatapi.checkalt.com").replace(/\/$/, "");

  const basic = btoa(`${username}:${password}`);
  const resp = await fetch(`${base}/public/jwtauth/authenticate`, {
    method: "POST",
    headers: {
      merchant: getCheckAltMerchant(),
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: "",
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`CheckAlt auth failed [${resp.status}]: ${body}`);
  }

  // The token may be returned as a raw string OR as JSON { token | jwt | accessToken }.
  const text = await resp.text();
  let jwt: string | undefined;
  try {
    const data = JSON.parse(text);
    jwt = data?.token ?? data?.jwt ?? data?.accessToken;
  } catch {
    jwt = text.trim().replace(/^Bearer\s+/i, "");
  }
  if (!jwt) throw new Error("CheckAlt auth response missing token");

  let expiresAt = new Date(Date.now() + 50 * 60_000).toISOString();
  try {
    const parts = jwt.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (payload?.exp) expiresAt = new Date(payload.exp * 1000).toISOString();
    }
  } catch { /* ignore */ }

  await supabase
    .from("checkalt_config")
    .update({ cached_jwt: jwt, cached_jwt_expires_at: expiresAt })
    .eq("singleton", true);

  return jwt;
}

export async function checkAltFetch(
  supabase: SupabaseClient,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const cfg = await loadConfig(supabase);
  const jwt = await getCheckAltJwt(supabase, cfg);
  const base = (cfg.base_url ?? "https://uatapi.checkalt.com").replace(/\/$/, "");
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${jwt}`);
  headers.set("merchant", getCheckAltMerchant());
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
  return await fetch(url, { ...init, headers });
}
