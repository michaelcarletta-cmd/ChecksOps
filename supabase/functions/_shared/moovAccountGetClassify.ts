/**
 * Sanitized classification for the public recipient-session Moov account GET.
 * Never include access tokens, API keys, secure-link tokens, SSN/DOB, or
 * raw provider bodies.
 */

export type MoovFailureStage = "oauth_token" | "account_get";

export type MoovProviderErrorClass =
  | "oauth_credentials"
  | "oauth_origin"
  | "oauth_unauthorized"
  | "account_unauthenticated"
  | "account_unauthorized"
  | "account_not_found"
  | "cloudflare_block"
  | "network"
  | "rate_limited"
  | "provider_error"
  | "unknown";

export const AWS_PRODUCTION_PUBLIC_KEY_FP12 = "3ad0839428e5";
export const AWS_PRODUCTION_APP_ID_PREFIX = "694a303b";
export const TARGET_MOOV_ACCOUNT_ID = "ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function truncateId(id: string | null | undefined): string | null {
  const value = String(id ?? "").trim();
  if (!value) return null;
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export function keyShape(value: string | undefined | null): {
  present: boolean;
  length: number;
  shape: "missing" | "uuid" | "pk_prefixed" | "other";
} {
  if (!value) return { present: false, length: 0, shape: "missing" };
  if (UUID_RE.test(value)) return { present: true, length: value.length, shape: "uuid" };
  if (value.startsWith("pk_")) return { present: true, length: value.length, shape: "pk_prefixed" };
  return { present: true, length: value.length, shape: "other" };
}

export async function sha256Hex12(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

export function extractCloudflareCode(text: string | null | undefined): string | null {
  const raw = String(text ?? "");
  if (!raw) return null;
  const match = raw.match(/error code[:\s]+(\d{4})/i)
    || raw.match(/cf-error-code["'\s:=]+(\d+)/i)
    || raw.match(/Cloudflare[^0-9]{0,40}(\d{4})/i);
  return match?.[1] ?? null;
}

export function extractRequestId(headers: Headers | Record<string, string> | null | undefined): string | null {
  if (!headers) return null;
  const read = (name: string) => {
    if (headers instanceof Headers) return headers.get(name);
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lower) return v;
    }
    return null;
  };
  return read("x-request-id") || read("x-moov-request-id") || read("cf-ray") || null;
}

export function extractCloudflareRay(headers: Headers | Record<string, string> | null | undefined): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get("cf-ray");
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "cf-ray") return v;
  }
  return null;
}

export function sanitizeProviderErrorHint(body: unknown, text?: string): string | null {
  const rawText = typeof text === "string" ? text : "";
  const fromBody = (() => {
    if (!body || typeof body !== "object") return typeof body === "string" ? body : "";
    const rec = body as Record<string, unknown>;
    const parts = [rec.error, rec.errorCode, rec.error_code, rec.message, rec.error_description];
    return parts.filter((p) => typeof p === "string").join(" ");
  })();
  const combined = `${fromBody} ${rawText}`.slice(0, 300);
  if (/access_token|client_secret|Bearer |ssn|birthDate|accountNumber/i.test(combined)) return null;
  const hint = fromBody.trim() || (rawText.startsWith("{") ? null : rawText.trim());
  if (!hint) return null;
  const compact = hint.replace(/\s+/g, " ").slice(0, 80);
  if (/<html|<!doctype/i.test(compact)) return "html_error_page";
  return compact || null;
}

export function classifyProviderErrorClass(input: {
  stage: MoovFailureStage;
  status: number | null;
  cloudflareCode: string | null;
  hint: string | null;
  network: boolean;
}): MoovProviderErrorClass {
  if (input.cloudflareCode || input.hint === "html_error_page") return "cloudflare_block";
  if (input.network && (input.status == null || input.status === 0)) return "network";
  const hint = (input.hint ?? "").toLowerCase();
  const status = input.status ?? 0;
  if (input.stage === "oauth_token") {
    if (status === 401 && /origin/.test(hint)) return "oauth_origin";
    if (status === 401 && /invalid_client|unauthorized_client|invalid client/i.test(hint)) return "oauth_credentials";
    if (status === 401 || status === 403) return /origin/.test(hint) ? "oauth_origin" : "oauth_credentials";
    if (status === 429) return "rate_limited";
    if (status >= 500) return "provider_error";
    return "oauth_unauthorized";
  }
  if (status === 401) return "account_unauthenticated";
  if (status === 403) return "account_unauthorized";
  if (status === 404) return "account_not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_error";
  return "unknown";
}

export function decodeMoovJwtMetadata(token: string | null | undefined): {
  aid: string | null;
  caid: string | null;
  aud_includes_checksops: boolean;
  aud_count: number;
} | null {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/") + "===".slice((parts[1].length + 3) % 4);
    const json = JSON.parse(atob(padded));
    const aud = json?.aud;
    const audList = Array.isArray(aud) ? aud.map(String) : aud ? [String(aud)] : [];
    return {
      aid: typeof json?.aid === "string" ? json.aid : null,
      caid: typeof json?.caid === "string" ? json.caid : null,
      aud_includes_checksops: audList.some((v) => /checksops\.com/i.test(v)),
      aud_count: audList.length,
    };
  } catch {
    return null;
  }
}

export function operatorClassifyRequested(req: Request): boolean {
  return (req.headers.get("x-checksops-operator-classify") ?? "").trim() === "1";
}

export type MoovAccountGetClassify = {
  failure_stage: MoovFailureStage;
  provider_http_status: number | null;
  provider_error_class: MoovProviderErrorClass;
  provider_error_hint: string | null;
  cloudflare_code: string | null;
  cloudflare_ray: string | null;
  request_id: string | null;
  origin_used: string;
  environment: string;
  api_version: string;
  account_id_fp12: string | null;
  account_id_truncated: string | null;
  account_id_is_target: boolean;
  oauth_token_issued: boolean;
  account_get_sent: boolean;
  edge_public_key_fp12: string | null;
  edge_public_key_shape: ReturnType<typeof keyShape>;
  edge_secret_present: boolean;
  edge_secret_length: number;
  edge_app_id: string | null;
  edge_caid: string | null;
  aud_includes_checksops: boolean | null;
  aws_public_key_fp12: string;
  aws_app_id_prefix: string;
  edge_matches_aws_public_key_fp: boolean | null;
  edge_matches_aws_app_id: boolean | null;
};

export async function buildEdgeCredentialFingerprint(envName: string): Promise<{
  public_key_fp12: string | null;
  public_key_shape: ReturnType<typeof keyShape>;
  secret_present: boolean;
  secret_length: number;
}> {
  const publicKey = envName === "sandbox"
    ? (Deno.env.get("MOOV_SANDBOX_PUBLIC_KEY") ?? "")
    : (Deno.env.get("MOOV_PUBLIC_KEY") ?? "");
  const secretKey = envName === "sandbox"
    ? (Deno.env.get("MOOV_SANDBOX_SECRET_KEY") ?? "")
    : (Deno.env.get("MOOV_SECRET_KEY") ?? "");
  return {
    public_key_fp12: publicKey ? await sha256Hex12(publicKey) : null,
    public_key_shape: keyShape(publicKey),
    secret_present: Boolean(secretKey),
    secret_length: secretKey ? secretKey.length : 0,
  };
}

export async function classifyMoovAccountGetFailure(input: {
  error: unknown;
  stage: MoovFailureStage;
  oauthTokenIssued: boolean;
  accountGetSent: boolean;
  origin: string;
  environment: string;
  apiVersion: string;
  accountId: string;
  jwt?: ReturnType<typeof decodeMoovJwtMetadata>;
  creds: Awaited<ReturnType<typeof buildEdgeCredentialFingerprint>>;
}): Promise<MoovAccountGetClassify> {
  const err = input.error as {
    status?: number;
    body?: unknown;
    message?: string;
    meta?: {
      stage?: string;
      requestId?: string | null;
      cloudflareCode?: string | null;
      cloudflareRay?: string | null;
      rawText?: string;
    };
  } | null;
  const status = typeof err?.status === "number" ? err.status : null;
  const rawText = typeof err?.meta?.rawText === "string" ? err.meta.rawText : "";
  const hint = sanitizeProviderErrorHint(err?.body, rawText || err?.message);
  const cloudflareCode = err?.meta?.cloudflareCode ?? extractCloudflareCode(rawText);
  const network = status == null && !(err && "status" in (err ?? {}));
  const providerClass = classifyProviderErrorClass({
    stage: input.stage,
    status,
    cloudflareCode,
    hint,
    network,
  });
  const accountFp = input.accountId ? await sha256Hex12(input.accountId) : null;
  const jwt = input.jwt ?? null;
  const edgeAppId = jwt?.aid ?? null;
  return {
    failure_stage: input.stage,
    provider_http_status: status,
    provider_error_class: providerClass,
    provider_error_hint: hint,
    cloudflare_code: cloudflareCode,
    cloudflare_ray: err?.meta?.cloudflareRay ?? null,
    request_id: err?.meta?.requestId ?? null,
    origin_used: input.origin,
    environment: input.environment,
    api_version: input.apiVersion,
    account_id_fp12: accountFp,
    account_id_truncated: truncateId(input.accountId),
    account_id_is_target: input.accountId === TARGET_MOOV_ACCOUNT_ID,
    oauth_token_issued: input.oauthTokenIssued,
    account_get_sent: input.accountGetSent,
    edge_public_key_fp12: input.creds.public_key_fp12,
    edge_public_key_shape: input.creds.public_key_shape,
    edge_secret_present: input.creds.secret_present,
    edge_secret_length: input.creds.secret_length,
    edge_app_id: truncateId(edgeAppId),
    edge_caid: truncateId(jwt?.caid),
    aud_includes_checksops: jwt ? jwt.aud_includes_checksops : null,
    aws_public_key_fp12: AWS_PRODUCTION_PUBLIC_KEY_FP12,
    aws_app_id_prefix: AWS_PRODUCTION_APP_ID_PREFIX,
    edge_matches_aws_public_key_fp: input.creds.public_key_fp12
      ? input.creds.public_key_fp12 === AWS_PRODUCTION_PUBLIC_KEY_FP12
      : null,
    edge_matches_aws_app_id: edgeAppId
      ? edgeAppId.replace(/-/g, "").toLowerCase().startsWith(AWS_PRODUCTION_APP_ID_PREFIX)
        || edgeAppId.toLowerCase().startsWith(AWS_PRODUCTION_APP_ID_PREFIX)
      : null,
  };
}
