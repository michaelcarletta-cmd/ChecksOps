import { resolveAwsApiBaseUrl } from "@/lib/awsApiBase";
import { runtimeHostname, shouldUseAwsChecksOpsBackendFor } from "@/lib/backendMode";

const BRANDING_FIELD_BUCKETS: Record<string, string> = {
  logo_url: "tenant-logos",
  logoUrl: "tenant-logos",
  invoice_letterhead_url: "company-branding",
  letterhead_url: "company-branding",
};

const BRANDING_BUCKETS = new Set(["tenant-logos", "email-assets", "company-branding"]);

function viteEnv(): { MODE?: string; VITE_AUTH_PROVIDER?: string } {
  return typeof import.meta !== "undefined"
    ? ((import.meta as { env?: { MODE?: string; VITE_AUTH_PROVIDER?: string } }).env || {})
    : {};
}

/**
 * Same backend decision as the data client (`integrations/supabase/client`):
 * the AWS build serves `/storage/public` from the AWS API on every host,
 * tenant custom domains included. Outside the AWS build only ChecksOps
 * platform hosts (and localhost) with Cognito use the AWS backend; anywhere
 * else no AWS API is in use, so the stored value is kept.
 */
function shouldRewriteBrandingToAws(): boolean {
  const env = viteEnv();
  if (env.MODE === "aws") return true;
  return shouldUseAwsChecksOpsBackendFor({
    hostname: runtimeHostname(),
    authProvider: String(env.VITE_AUTH_PROVIDER || ""),
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
 * `/prep/storage/public` access path when the app uses the AWS backend (every
 * host in the AWS build) and the value is a branding object path or a legacy
 * Supabase public URL. Already-public HTTPS URLs pass through.
 * javascript:/data:/blob:/file: values are always refused.
 */
export function brandingPublicUrl(
  value: unknown,
  bucket: string,
  apiBaseUrl = apiBase(),
): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (!shouldRewriteBrandingToAws()) {
    return /^(javascript|data|blob|file):/i.test(raw) ? null : raw;
  }
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

/** SPA-host /prep/* is not the staging API; CloudFront serves index.html there. */
export function isBrokenEmailPreviewLogoSrc(src: string): boolean {
  const raw = String(src || "").trim();
  if (!raw) return false;
  if (/^(javascript|data|blob|file):/i.test(raw)) return false;
  if (/checksops-logo\.png/i.test(raw)) return true;
  if (isRawBrandingObjectPath(raw)) return true;
  if (/\/prep\/branding\/logo\//i.test(raw)) return true;
  if (/staging\.checksops\.com\/prep\//i.test(raw)) return true;
  return false;
}

export function shouldReplacePreviewLogoSrc(src: string, resolved: string): boolean {
  const raw = String(src || "").trim();
  const next = String(resolved || "").trim();
  if (!raw || !next || raw === next) return false;
  if (/^(javascript|data|blob|file):/i.test(raw)) return false;
  return isBrokenEmailPreviewLogoSrc(raw);
}

/**
 * Rewrite the generated preview <img src> to the same public-storage URL
 * the Branding page uses. Does not persist or change outbound send HTML.
 */
export function applyEmailPreviewLogo(
  html: string,
  storedLogo: unknown,
  apiBaseUrl = apiBase(),
): string {
  const source = String(html || "");
  const resolved = brandingPublicUrl(storedLogo, "tenant-logos", apiBaseUrl);
  if (!source || !resolved) return source;
  return source.replace(/<img(\s[^>]*?)\bsrc="([^"]*)"/i, (full, pre, src) => {
    if (!shouldReplacePreviewLogoSrc(src, resolved)) return full;
    return `<img${pre}src="${resolved}"`;
  });
}
