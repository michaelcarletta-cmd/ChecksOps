function resolveAwsApiBaseUrl(configured: string, windowOrigin?: string): string {
  const value = String(configured || "").trim().replace(/\/$/, "");
  const token = value.toLowerCase();
  if (token === "/prep" || token === "same-origin" || token === "same-origin:/prep") {
    if (windowOrigin) {
      return new URL("/prep", windowOrigin).toString().replace(/\/$/, "");
    }
    return "/prep";
  }
  return value;
}

const BRANDING_FIELD_BUCKETS: Record<string, string> = {
  logo_url: "tenant-logos",
  logoUrl: "tenant-logos",
  invoice_letterhead_url: "company-branding",
  letterhead_url: "company-branding",
};

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

function apiBase(): string {
  const configured = typeof import.meta !== "undefined"
    ? String((import.meta as { env?: { VITE_CHECKSOPS_API_URL?: string } }).env?.VITE_CHECKSOPS_API_URL || "")
    : "";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return resolveAwsApiBaseUrl(configured, origin);
}

export function rewriteSupabaseBrandingUrl(value: string, apiBaseUrl = apiBase()): string {
  const match = value.match(
    /^https?:\/\/[^/]*supabase\.co\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/([^?]+)/i,
  );
  if (!match) return value;
  const bucket = match[1];
  const path = decodeURIComponent(match[2]);
  if (bucket === "tenant-logos" || bucket === "email-assets" || bucket === "company-branding") {
    return `${apiBaseUrl}/storage/public?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}`;
  }
  return value;
}

export function resolvePublicBrandingUrl(
  value: unknown,
  bucket: string,
  apiBaseUrl = apiBase(),
): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const rewritten = rewriteSupabaseBrandingUrl(raw, apiBaseUrl);
  if (rewritten !== raw) return rewritten;
  if (/^https?:\/\//i.test(raw) || raw.includes("/storage/public")) return raw;
  if (!isRawBrandingObjectPath(raw)) return null;
  const path = raw.replace(new RegExp(`^${bucket}/`), "");
  if (!path || path.includes("..")) return null;
  return `${apiBaseUrl}/storage/public?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}`;
}

export function rewriteBrandingStorageFields(value: unknown, apiBaseUrl = apiBase()): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteBrandingStorageFields(item, apiBaseUrl));
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? rewriteSupabaseBrandingUrl(value, apiBaseUrl) : value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (typeof nested === "string" && /(_url|logoUrl)$/i.test(key)) {
      const bucket = brandingBucketForField(key);
      out[key] = bucket
        ? (resolvePublicBrandingUrl(nested, bucket, apiBaseUrl) ?? rewriteSupabaseBrandingUrl(nested, apiBaseUrl))
        : rewriteSupabaseBrandingUrl(nested, apiBaseUrl);
    } else if (nested && typeof nested === "object") {
      out[key] = rewriteBrandingStorageFields(nested, apiBaseUrl);
    } else {
      out[key] = nested;
    }
  }
  return out;
}
