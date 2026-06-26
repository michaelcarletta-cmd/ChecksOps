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

export interface CheckAltTenantAccount {
  sso_user_id: string;
  deposit_account_number: string;
  enabled: boolean;
  registered_at: string | null;
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

// Each tenant registers its own depositor account with FinCapture
// (POST /fincapture/useraccount/register). The userId chosen at registration
// becomes the ssoKey used on every later deposit/process, deposit/approve and
// deposit/history call for that tenant — this replaces the old global
// cfg.business_unit / cfg.depositor_account_id fields.
export async function loadTenantAccount(
  supabase: SupabaseClient,
  tenantId: string | null | undefined,
): Promise<CheckAltTenantAccount> {
  if (!tenantId) {
    throw new Error("No tenant associated with this check — cannot resolve CheckAlt account");
  }
  const { data, error } = await supabase
    .from("checkalt_tenant_accounts")
    .select("sso_user_id, deposit_account_number, enabled, registered_at")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.registered_at) {
    throw new Error("This organization has not registered a CheckAlt depositor account yet");
  }
  if (!data.enabled) {
    throw new Error("CheckAlt deposits are disabled for this organization");
  }
  return data as CheckAltTenantAccount;
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

  const basic = base64FromUtf8(`${username}:${password}`);
  const authResult = await authenticateCheckAlt(base, basic, username, password);
  const jwt = authResult.jwt;

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

interface CheckAltAuthAttempt {
  path: string;
  body: string;
  contentType: string;
  label: string;
}

async function authenticateCheckAlt(
  base: string,
  basic: string,
  username: string,
  password: string,
): Promise<{ jwt: string }> {
  const attempts: CheckAltAuthAttempt[] = [
    {
      path: "/Clearingworks/cxf/public/jwtauth/authenticate",
      body: JSON.stringify({ userId: username, password }),
      contentType: "application/json",
      label: "clearingworks-cxf-userId-json",
    },
    {
      path: "/Clearingworks/cxf/public/jwtauth/authenticate",
      body: new URLSearchParams({ userId: username, password }).toString(),
      contentType: "application/x-www-form-urlencoded",
      label: "clearingworks-cxf-userId-form",
    },
    {
      path: "/cxf/public/jwtauth/authenticate",
      body: JSON.stringify({ userId: username, password }),
      contentType: "application/json",
      label: "cxf-userId-json",
    },
    {
      path: "/cxf/public/jwtauth/authenticate",
      body: new URLSearchParams({ userId: username, password }).toString(),
      contentType: "application/x-www-form-urlencoded",
      label: "cxf-userId-form",
    },
    {
      path: "/public/jwtauth/authenticate",
      body: JSON.stringify({ userId: username, password }),
      contentType: "application/json",
      label: "public-userId-json",
    },
    {
      path: "/public/jwtauth/authenticate",
      body: new URLSearchParams({ userId: username, password }).toString(),
      contentType: "application/x-www-form-urlencoded",
      label: "public-userId-form",
    },
    {
      path: "/public/jwtauth/authenticate",
      body: JSON.stringify({ username, password }),
      contentType: "application/json",
      label: "public-username-json",
    },
    {
      path: "/public/jwtauth/authenticate",
      body: new URLSearchParams({ username, password }).toString(),
      contentType: "application/x-www-form-urlencoded",
      label: "public-username-form",
    },
  ];

  const failures: string[] = [];
  for (const attempt of attempts) {
    const resp = await fetch(`${base}${attempt.path}`, {
      method: "POST",
      headers: {
        merchant: getCheckAltMerchant(),
        "Content-Type": attempt.contentType,
        Accept: "application/json, text/plain, */*",
        Authorization: `Basic ${basic}`,
      },
      body: attempt.body,
    });

    const text = await resp.text();
    const jwt = extractJwtFromResponse(resp.headers, text);
    if (resp.ok && jwt) return { jwt };

    failures.push(`${attempt.label}:${resp.status}:${summarizeAuthBody(text)}`);
    if (resp.ok && !jwt) {
      console.error(
        "[checkalt] auth attempt returned success without JWT",
        attempt.label,
        "headers:",
        JSON.stringify(safeAuthHeaders(resp.headers)),
        "body:",
        summarizeAuthBody(text),
      );
    }
  }

  throw new Error(`CheckAlt auth response missing token (${failures.join(" | ")})`);
}

function extractJwtFromResponse(headers: Headers, text: string): string | undefined {
  const headerToken =
    headers.get("authorization") ??
    headers.get("x-auth-token") ??
    headers.get("x-jwt-token") ??
    headers.get("jwt") ??
    headers.get("token");
  if (headerToken) return headerToken.replace(/^Bearer\s+/i, "").trim();

  try {
    const data = JSON.parse(text);
    const token =
      data?.token ??
      data?.jwt ??
      data?.accessToken ??
      data?.access_token ??
      data?.id_token ??
      data?.idToken ??
      data?.authToken ??
      data?.auth_token ??
      data?.bearerToken ??
      data?.bearer_token ??
      data?.data?.token ??
      data?.data?.jwt ??
      data?.data?.accessToken ??
      data?.response?.token ??
      data?.response?.jwt ??
      data?.result?.token ??
      data?.result?.jwt;
    if (typeof token === "string") return token.replace(/^Bearer\s+/i, "").trim();
  } catch {
    const raw = text.trim().replace(/^Bearer\s+/i, "");
    if (raw && raw.split(".").length === 3) return raw;
  }
  return undefined;
}

function safeAuthHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    out[key] = key.toLowerCase() === "set-cookie" ? "[cookie omitted]" : value;
  }
  return out;
}

function summarizeAuthBody(text: string): string {
  if (!text) return "empty-body";
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 240)}…` : compact;
}

function base64FromUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// Best-effort mirror into the general deposit_items/deposit_action pipeline.
// Never throws — a sync failure here must not block the CheckAlt-side
// response, since checkalt_deposits is already the source of truth.
export async function syncDepositItem(
  supabase: SupabaseClient,
  params: {
    action: "record_submission" | "record_success" | "record_failure" | "record_return";
    deposit_item_id: string;
    actor_id: string;
    amount?: number;
    notes?: string;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await supabase.rpc("deposit_action", {
    p_action: params.action,
    p_actor_id: params.actor_id,
    p_deposit_item_id: params.deposit_item_id,
    p_check_id: null,
    p_provider: null,
    p_amount: params.amount ?? null,
    p_notes: params.notes ?? null,
    p_extra: params.extra ?? {},
  });
  if (error) {
    console.error("[checkalt] deposit_items sync failed", params.action, params.deposit_item_id, error.message);
  }
}

// Maps FinCapture's numeric deposit status codes to ChecksOps' internal
// checkalt_deposits.status values. Shared by checkalt-poll-status (batch
// reconciliation via /deposit/history) and checkalt-account-status
// (on-demand single-item refresh via /deposit/item).
export function mapDepositStatus(code: number, current: string): string {
  switch (code) {
    case 127: return "submitted";
    case 40: return "pending_approval";
    case 120: return "rejected";
    case 11: return "error";
    default: return code >= 200 ? "cleared" : current;
  }
}

interface CheckAltApiResult {
  ok: boolean;
  status: number;
  json: any;
}

// NOTE: CheckAlt has not provided sample payloads for these three endpoints
// (unlike auth/register/process/approve/history, which were confirmed from
// their Postman collection). The field names below follow the same
// fiKey/userId/accountNumber/referenceId conventions used in the confirmed
// calls — verify the request/response shape against live UAT before relying
// on this in production.

export async function getUserAccountInfo(
  supabase: SupabaseClient,
  ssoUserId: string,
): Promise<CheckAltApiResult> {
  const fiKey = getCheckAltFiKey();
  const resp = await checkAltFetch(supabase, "/fincapture/useraccount/getUserAccountInformation", {
    method: "POST",
    body: JSON.stringify({ fiKey, userId: ssoUserId }),
  });
  return { ok: resp.ok, status: resp.status, json: await resp.json().catch(() => ({})) };
}

export async function getDepositAccountInfo(
  supabase: SupabaseClient,
  ssoUserId: string,
  accountNumber: string,
): Promise<CheckAltApiResult> {
  const fiKey = getCheckAltFiKey();
  const resp = await checkAltFetch(supabase, "/fincapture/useraccount/getDepositAccountInformation", {
    method: "POST",
    body: JSON.stringify({ fiKey, userId: ssoUserId, accountNumber }),
  });
  return { ok: resp.ok, status: resp.status, json: await resp.json().catch(() => ({})) };
}

export async function getDepositItemStatus(
  supabase: SupabaseClient,
  tenantAccount: CheckAltTenantAccount,
  referenceId: string,
): Promise<CheckAltApiResult> {
  const fiKey = getCheckAltFiKey();
  const resp = await checkAltFetch(supabase, "/fincapture/deposit/item", {
    method: "POST",
    body: JSON.stringify({
      fiKey,
      ssoKey: tenantAccount.sso_user_id,
      depositAccountNumber: tenantAccount.deposit_account_number,
      referenceId,
    }),
  });
  return { ok: resp.ok, status: resp.status, json: await resp.json().catch(() => ({})) };
}

export async function checkAltFetch(
  supabase: SupabaseClient,
  path: string,
  init: RequestInit & { idempotencyKey?: string } = {},
): Promise<Response> {
  const cfg = await loadConfig(supabase);
  const jwt = await getCheckAltJwt(supabase, cfg);
  const base = (cfg.base_url ?? "https://uatapi.checkalt.com").replace(/\/$/, "");
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${jwt}`);
  headers.set("merchant", getCheckAltMerchant());
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
  // Per Clearingworks dev guide: CW-IDEMPOTENCY guarantees a request runs
  // exactly once even if retried. Required for deposit/process submissions.
  if (init.idempotencyKey) headers.set("CW-IDEMPOTENCY", init.idempotencyKey);
  return await fetch(url, { ...init, headers });
}
