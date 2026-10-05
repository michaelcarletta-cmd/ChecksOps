import { resolveAwsApiBaseUrl } from "@/lib/awsApiBase";
import { runtimeHostname, shouldUseAwsChecksOpsBackendFor } from "@/lib/backendMode";

const BRANDING_FIELD_BUCKETS: Record<string, string> = {
  logo_url: "tenant-logos",
  logoUrl: "tenant-logos",
  invoice_letterhead_url: "company-branding",
  letterhead_url: "company-branding",
};

const BRANDING_BUCKETS = new Set(["tenant-logos", "email-assets", "company-branding"]);

function viteAuthProvider(): string {
  return typeof import.meta !== "undefined"
    ? String((import.meta as { env?: { VITE_AUTH_PROVIDER?: string } }).env?.VITE_AUTH_PROVIDER || "")
    : "";
}

function shouldRewriteBrandingToAws(): boolean {
  return shouldUseAwsChecksOpsBackendFor({
    hostname: runtimeHostname(),
    authProvider: viteAuthProvider(),
  });
}

function apiBase(): string {
  const configured = typeof import.meta !== "undefined"
    ? String((import.meta as { env?: { VITE_CHECKSOPS_API_URL?: string } }).env?.VITE_CHECKSOPS_API_URL || "")
    : "";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return resolveAwsApiBaseUrl(configured, origin);
}

export function brandingBucketForField(field: string): string | null {
  return BRANDING_FIELD_BUCKETS[field] || null;
}

export function isRawBrandingObjectPath(value: string): boolean {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (/^https?:\/\//i.test(raw)) return false;
  if (raw.includes("/storage/public")) return false;
  if (raw.includes("://") || raw.startsWith("//")) return false;
  if (/^(javascript|data|blob|file):/i.test(raw)) return false;
  if (raw.includes("..") || /\s/.test(raw) || raw.startsWith("/")) return false;
  if (raw.includes("?") || raw.includes("#")) return false;
  return /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(raw)
    || /^[A-Za-z0-9._-]+\.(png|jpe?g|gif|webp|svg)$/i.test(raw);
}

export function rewriteSupabaseBrandingUrl(value: string, apiBaseUrl = apiBase()): string {
  const match = value.match(
    /^https?:\/\/[^/]*supabase\.co\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/([^?]+)/i,
  );
  if (!match) return value;
  const bucket = match[1];
  const path = decodeURIComponent(match[2]);
  if (BRANDING_BUCKETS.has(bucket)) {
    return `${apiBaseUrl}/storage/public?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}`;
  }
  return value;
}

/**
 * Convert a stored Branding/logo value into the existing AWS
 * `/prep/storage/public` access path when the current host uses the ChecksOps
 * AWS backend and the value is a branding object path or a legacy Supabase
 * public URL. Freedom Claims and custom-domain hosts keep the stored value.
 * Already-public HTTPS URLs pass through.
 */
export function brandingPublicUrl(
  value: unknown,
  bucket: string,
  apiBaseUrl = apiBase(),
): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (!shouldRewriteBrandingToAws()) return raw;
  const rewritten = rewriteSupabaseBrandingUrl(raw, apiBaseUrl);
  if (rewritten !== raw) return rewritten;
  if (/^https?:\/\//i.test(raw) || raw.includes("/storage/public")) return raw;
  if (!isRawBrandingObjectPath(raw)) return null;
  const path = raw.replace(new RegExp(`^${bucket}/`), "");
  if (!path || path.includes("..")) return null;
  return `${apiBaseUrl}/storage/public?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}`;
}

export function resolvePublicBrandingUrl(
  value: unknown,
  bucket: string,
  apiBaseUrl = apiBase(),
): string | null {
  return brandingPublicUrl(value, bucket, apiBaseUrl);
}
