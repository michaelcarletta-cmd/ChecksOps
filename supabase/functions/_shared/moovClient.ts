// Shared Moov REST client for edge functions.
//
// ChecksOps is the Moov *platform*: every tenant gets its own connected Moov
// account and its own linked bank. Nothing here touches Actum or Plaid — those
// rails keep their own clients (`_shared/plaidClient.ts`, actum helpers) and
// keep working exactly as before.
//
// `MOOV_ENVIRONMENT` selects which credential set is live: "sandbox" or
// "production". Production is enabled — the keys themselves decide the ledger.

// Moov serves sandbox and production from the SAME host; the environment is
// determined by which API credentials are used. There is no api.sandbox.moov.io
// (it does not resolve in DNS).
const MOOV_HOSTS: Record<string, string> = {
  sandbox: "https://api.moov.io",
  production: "https://api.moov.io",
};

/**
 * Per-request environment override.
 *
 * Tenants flagged as test accounts (`tenants.moov_environment = 'sandbox'`)
 * run against Moov's sandbox credentials so no real money moves, while live
 * tenants keep using production in the same deployment. `moovGuard` binds the
 * value for the current request's async context; everything else in this
 * module reads it through `moovEnvironment()`.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const envStore = new AsyncLocalStorage<string>();

/** Binds the environment for the remainder of the current request. */
export function bindMoovEnvironment(env: string): void {
  const normalized = (env ?? "").toLowerCase();
  if (!MOOV_HOSTS[normalized]) return;
  envStore.enterWith(normalized);
}

/** Runs `fn` with an explicit environment (webhooks, cron, tests). */
export function withMoovEnvironment<T>(env: string, fn: () => T): T {
  const normalized = (env ?? "").toLowerCase();
  return MOOV_HOSTS[normalized] ? envStore.run(normalized, fn) : fn();
}

export function moovEnvironment(): string {
  const env = (
    envStore.getStore() ?? Deno.env.get("MOOV_ENVIRONMENT") ?? "sandbox"
  ).toLowerCase();
  if (!MOOV_HOSTS[env]) {
    throw new Error(`MOOV_ENVIRONMENT must be "sandbox" or "production", got "${env}"`);
  }
  return env;
}

/** True when the current request is running against Moov's sandbox ledger. */
export function moovIsSandbox(): boolean {
  return moovEnvironment() === "sandbox";
}

export function moovHost(): string {
  return MOOV_HOSTS[moovEnvironment()];
}

/** Credentials for a given environment; sandbox uses its own key pair. */
function credentialsFor(env: string): { key?: string; secret?: string } {
  if (env === "sandbox") {
    return {
      key: Deno.env.get("MOOV_SANDBOX_PUBLIC_KEY") ?? undefined,
      secret: Deno.env.get("MOOV_SANDBOX_SECRET_KEY") ?? undefined,
    };
  }
  return {
    key: Deno.env.get("MOOV_PUBLIC_KEY") ?? undefined,
    secret: Deno.env.get("MOOV_SECRET_KEY") ?? undefined,
  };
}

export function moovConfigured(env?: string): boolean {
  const { key, secret } = credentialsFor(env ?? moovEnvironment());
  return !!(key && secret);
}

function credentials(): { key: string; secret: string } {
  const env = moovEnvironment();
  const { key, secret } = credentialsFor(env);
  if (!key || !secret) {
    const prefix = env === "sandbox" ? "MOOV_SANDBOX_" : "MOOV_";
    throw new Error(
      `Moov is not configured for the ${env} environment. ${prefix}PUBLIC_KEY and ${prefix}SECRET_KEY must be set.`,
    );
  }
  return { key, secret };
}


/**
 * Moov ties every API key to an allowlisted domain list: requests to
 * /oauth2/token and to the API must carry an `Origin` header (scheme + domain,
 * no path) that matches one registered domain, or Moov answers 401.
 * Server-side fetch sends no Origin, so we set it explicitly.
 */
export function moovOrigin(): string {
  const sandbox = moovEnvironment() === "sandbox"
    ? Deno.env.get("MOOV_SANDBOX_ALLOWED_ORIGIN")
    : null;
  const raw = sandbox
    ?? Deno.env.get("MOOV_ALLOWED_ORIGIN")
    ?? Deno.env.get("CHECKSOPS_APP_URL")
    ?? "https://checksops.com";
  try {

    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "https://checksops.com";
  }
}

export type MoovErrorStage = "oauth_token" | "api";

export type MoovErrorMeta = {
  stage: MoovErrorStage;
  requestId?: string | null;
  cloudflareCode?: string | null;
  cloudflareRay?: string | null;
  rawText?: string;
};

export class MoovError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
    public readonly meta: MoovErrorMeta = { stage: "api" },
  ) {
    super(message);
    this.name = "MoovError";
  }
}

function headerVal(res: Response, name: string): string | null {
  return res.headers.get(name);
}

function moovResponseMeta(res: Response, text: string, stage: MoovErrorStage): MoovErrorMeta {
  const cfRay = headerVal(res, "cf-ray");
  const requestId = headerVal(res, "x-request-id")
    || headerVal(res, "x-moov-request-id")
    || cfRay;
  const cfCodeMatch = String(text || "").match(/error code[:\s]+(\d{4})/i)
    || String(text || "").match(/cf-error-code["'\s:=]+(\d+)/i);
  const truncatedText = text && !/access_token|client_secret/i.test(text)
    ? text.slice(0, 400)
    : "";
  return {
    stage,
    requestId,
    cloudflareCode: cfCodeMatch?.[1] ?? null,
    cloudflareRay: cfRay,
    rawText: truncatedText,
  };
}

function sanitizedMoovLogBody(body: unknown, text: string): unknown {
  if (body && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of ["error", "errorCode", "error_code", "message"]) {
      if (typeof rec[key] === "string") out[key] = String(rec[key]).slice(0, 80);
    }
    return out;
  }
  if (/<html|error code[:\s]+\d{4}/i.test(text)) {
    const cf = text.match(/error code[:\s]+(\d{4})/i);
    return { html: true, cloudflare_code: cf?.[1] ?? null };
  }
  return { non_json: true, length: text.length };
}

/* ---------------- OAuth ---------------- */

type CachedToken = { token: string; expiresAt: number };
const tokenCache = new Map<string, CachedToken>();

/**
 * Exchanges the platform credentials for a short-lived access token.
 * Tokens are cached per scope-set for the life of the isolate.
 */
export async function moovToken(scopes: string[], requestOrigin?: string): Promise<string> {
  const scope = scopes.join(" ");
  const origin = requestOrigin ?? moovOrigin();
  const cacheKey = `${moovEnvironment()}|${origin}|${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const { key, secret } = credentials();
  const basic = btoa(`${key}:${secret}`);

  const res = await fetch(`${moovHost()}/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: origin,
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope }),
  });

  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch { /* non-JSON handled below */ }

  if (!res.ok) {
    const meta = moovResponseMeta(res, text, "oauth_token");
    console.error("[moov] token error", res.status, sanitizedMoovLogBody(body, text));
    throw new MoovError("Could not authenticate with the payment provider", res.status, body ?? null, meta);
  }

  const token = body?.access_token as string;
  const ttl = Number(body?.expires_in ?? 300) * 1000;
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + ttl });
  return token;
}

/** Scope helpers — Moov scopes are per-resource and per-account. */
export const scopes = {
  accountsWrite: () => ["/accounts.write"],
  accountsRead: () => ["/accounts.read"],
  accountRead: (id: string) => [`/accounts/${id}/profile.read`],
  accountWrite: (id: string) => [`/accounts/${id}/profile.write`],
  capabilitiesRead: (id: string) => [`/accounts/${id}/capabilities.read`],
  capabilitiesWrite: (id: string) => [`/accounts/${id}/capabilities.write`],
  bankAccountsRead: (id: string) => [`/accounts/${id}/bank-accounts.read`],
  bankAccountsWrite: (id: string) => [`/accounts/${id}/bank-accounts.write`],
  paymentMethodsRead: (id: string) => [`/accounts/${id}/payment-methods.read`],
  transfersWrite: (id: string) => [`/accounts/${id}/transfers.write`],
  transfersRead: (id: string) => [`/accounts/${id}/transfers.read`],
  representativesWrite: (id: string) => [`/accounts/${id}/representatives.write`],
  representativesRead: (id: string) => [`/accounts/${id}/representatives.read`],
  filesRead: (id: string) => [`/accounts/${id}/files.read`],
  filesWrite: (id: string) => [`/accounts/${id}/files.write`],
  /**
   * Scopes handed to a browser-side Moov.js session for a recipient.
   * Only documented scopes belong here — bank-accounts.write covers the
   * verification calls the bank-link Drop makes.
   */
  dropBankLink: (id: string) => [
    `/accounts/${id}/bank-accounts.write`,
    `/accounts/${id}/bank-accounts.read`,
    `/accounts/${id}/profile.read`,
    // The moov-terms-of-service Drop mints an acceptance token against the
    // account profile — without profile.write the token it returns is not
    // accepted when patched server-side.
    `/accounts/${id}/profile.write`,
  ],
  /** Browser ToS Drop only — do not grant bank-account write to the public page. */
  dropTos: (id: string) => [
    `/accounts/${id}/profile.write`,
    `/accounts/${id}/profile.read`,
    "/ping.read",
  ],


};

/* ---------------- Facilitator account ---------------- */

const facilitatorCache = new Map<string, string>();

/**
 * Moov creates transfers under the FACILITATOR (platform) account, not under
 * the tenant account that owns the funding bank. Posting to the tenant path
 * returns a bare 403, so every transfer call must resolve this first.
 *
 * Resolution order: env override -> the partner account id exposed on the
 * tenant's `moov-wallet` payment method -> the tenant account itself.
 */
export async function facilitatorAccountId(hintAccountId?: string): Promise<string> {
  const env = moovEnvironment();
  const fromEnv = env === "sandbox"
    ? Deno.env.get("MOOV_SANDBOX_PLATFORM_ACCOUNT_ID")
    : Deno.env.get("MOOV_PLATFORM_ACCOUNT_ID");
  if (fromEnv) return fromEnv;
  const cached = facilitatorCache.get(env);
  if (cached) return cached;
  if (!hintAccountId) throw new Error("Facilitator account id is not configured.");

  const methods = await moovFetch<any[]>(`/accounts/${hintAccountId}/payment-methods`, {
    scopes: scopes.paymentMethodsRead(hintAccountId),
  }).catch(() => [] as any[]);
  const partner = (methods ?? [])
    .map((m: any) => m?.wallet?.partnerAccountID ?? m?.wallet?.partnerAccountId)
    .find(Boolean) as string | undefined;

  const resolved = partner ?? hintAccountId;
  facilitatorCache.set(env, resolved);
  return resolved;
}


/* ---------------- REST ---------------- */

export interface MoovRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  scopes: string[];
  body?: unknown;
  idempotencyKey?: string;
  /**
   * ChecksOps pinned Moov API version: v2024.01.00
   * Moov current stable API: v2026.07.00
   * ChecksOps intentionally remains pinned pending a controlled API migration.
   */
  apiVersion?: string;
  /** Act on behalf of a connected account. */
  onBehalfOf?: string;
  /** Extra headers, e.g. forwarding the end user's IP / user agent. */
  extraHeaders?: Record<string, string>;

}


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Moov requires X-Idempotency-Key to be a valid UUID. Our keys are readable
 * seeds ("checksops-disb-split-<id>"), so they are hashed into a stable v4
 * shaped UUID — same seed always yields the same key, which is the whole
 * point of idempotency.
 */
export async function idempotencyUuid(seed: string): Promise<string> {
  if (UUID_RE.test(seed)) return seed;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)),
  ).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x40; // version 4
  digest[8] = (digest[8] & 0x3f) | 0x80; // variant
  const hex = Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function moovFetch<T = any>(
  path: string,
  opts: MoovRequestOptions,
): Promise<T> {
  const token = await moovToken(opts.scopes);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    Origin: moovOrigin(),
    "x-moov-version": opts.apiVersion ?? Deno.env.get("MOOV_API_VERSION") ?? "v2024.01.00",
  };
  if (opts.idempotencyKey) {
    headers["X-Idempotency-Key"] = await idempotencyUuid(opts.idempotencyKey);
  }
  if (opts.onBehalfOf) headers["X-Account-ID"] = opts.onBehalfOf;
  if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);


  const res = await fetch(`${moovHost()}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch { /* non-JSON */ }

  if (!res.ok) {
    let msg = json?.error ?? json?.message ?? text ?? `Moov ${path} failed`;
    
    // Map Moov-specific error responses to user-friendly strings if possible.
    if (json?.errors) {
      const details = Object.entries(json.errors)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      msg = `${msg} (${details})`;
    }

    const meta = moovResponseMeta(res, text, "api");
    console.error("[moov] error", opts.method ?? "GET", path, res.status, sanitizedMoovLogBody(json, text));

    // Provide helpful hints for common status codes.
    let userMessage = typeof msg === "string" ? msg : JSON.stringify(msg);
    if (res.status === 401) userMessage = "Authentication failed with the payment provider. Please check credentials or origin white-listing.";
    if (res.status === 403) userMessage = "Action forbidden. This account may lack the required permissions or capabilities.";
    if (res.status === 404) userMessage = "Resource not found on the payment provider.";
    if (res.status === 429) userMessage = "Rate limit exceeded. Please try again in a moment.";

    throw new MoovError(userMessage, res.status, json ?? null, meta);
  }

  return json as T;
}

/* ---------------- Normalizers ---------------- */

/** Moov transfer/account statuses → ChecksOps neutral payment statuses. */
export function normalizeTransferStatus(moovStatus: string | null | undefined): string {
  switch ((moovStatus ?? "").toLowerCase()) {
    case "created":
    case "queued":
      return "submitted";
    case "pending":
      return "pending";
    case "reversed":
      return "returned";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "canceled":
    case "cancelled":
      return "canceled";
    default:
      return "processing";
  }
}

/** Moov account/capability state → ChecksOps onboarding status. */
export function normalizeOnboardingStatus(input: {
  verificationStatus?: string | null;
  capabilities?: Array<{ capability: string; status: string }> | null;
  disabled?: boolean;
}): string {
  if (input.disabled) return "suspended";
  const v = (input.verificationStatus ?? "").toLowerCase();
  const caps = input.capabilities ?? [];
  const enabled = caps.filter((c) => c.status === "enabled");

  if (v === "failed" || v === "resubmit") return "restricted";
  if (caps.some((c) => c.status === "pending")) return "verification_pending";
  if (caps.some((c) => c.status === "errored")) return "additional_information_required";
  if (v === "verified" && enabled.length > 0) return "active";
  if (caps.length === 0) return "onboarding_incomplete";
  if (v === "pending" || v === "review") return "verification_pending";
  return "onboarding_incomplete";
}

export { capabilityFlags } from "./moovCapabilities.ts";

/** Last four of a Moov bank account without ever handling the full number. */
export function safeLastFour(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/* ---------------- Multipart upload ---------------- */

export interface MoovUploadOptions {
  scopes: string[];
  form: FormData;
  idempotencyKey?: string;
  apiVersion?: string;
  onBehalfOf?: string;
}

/**
 * Multipart POST (Moov account Files API). The body is a FormData, so we must
 * NOT set Content-Type ourselves — fetch adds the boundary.
 */
export async function moovUpload<T = any>(path: string, opts: MoovUploadOptions): Promise<T> {
  const token = await moovToken(opts.scopes);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    Origin: moovOrigin(),
  };
  if (opts.idempotencyKey) headers["X-Idempotency-Key"] = opts.idempotencyKey;
  if (opts.apiVersion) headers["x-moov-version"] = opts.apiVersion;
  if (opts.onBehalfOf) headers["X-Account-ID"] = opts.onBehalfOf;

  const res = await fetch(`${moovHost()}${path}`, { method: "POST", headers, body: opts.form });

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch { /* non-JSON */ }

  if (!res.ok) {
    const msg = json?.error ?? json?.message ?? text ?? `Moov ${path} failed`;
    const meta = moovResponseMeta(res, text, "api");
    console.error("[moov] upload error", path, res.status, sanitizedMoovLogBody(json, text));
    throw new MoovError(typeof msg === "string" ? msg : JSON.stringify(msg), res.status, json ?? null, meta);
  }
  return json as T;
}


/**
 * Capabilities that a payment account still needs approved before money can
 * move. Used to turn the provider's bare 403 into an actionable message.
 */
export async function pendingCapabilities(accountId: string): Promise<string[]> {
  const caps = await moovFetch<Array<{ capability: string; status: string }>>(
    `/accounts/${accountId}/capabilities`,
    { method: "GET", scopes: scopes.capabilitiesRead(accountId) },
  );
  return (caps ?? []).filter((c) => c.status !== "enabled").map((c) => c.capability);
}
