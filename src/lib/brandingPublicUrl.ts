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

export const PLATFORM_EMAIL_BRAND_COLOR = "#1a56db";

export function isSafeEmailBrandColor(value: unknown): value is string {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(value || "").trim());
}

export function normalizeEmailBrandColor(value: unknown, fallback = PLATFORM_EMAIL_BRAND_COLOR): string {
  const raw = String(value || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  }
  return fallback;
}

export function absolutizePreviewUrl(value: string, origin?: string): string {
  const raw = String(value || "").trim();
  if (!raw) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = String(origin || "").replace(/\/$/, "");
  if (!base) return raw;
  try {
    return new URL(raw, `${base}/`).toString();
  } catch {
    return raw;
  }
}

function decodeAttr(value: string): string {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function isUnsafePreviewSrc(src: string): boolean {
  return /^(javascript|data|blob|file|vbscript):/i.test(src)
    || src.startsWith("//")
    || src.includes("..");
}

/** True when preview HTML is still using a raw path, platform logo, or CloudFront /prep logo. */
export function shouldReplacePreviewLogoSrc(src: string, resolvedLogoUrl: string): boolean {
  const raw = decodeAttr(String(src || "").trim());
  const resolved = String(resolvedLogoUrl || "").trim();
  if (!raw || !resolved || raw === resolved) return false;
  if (isUnsafePreviewSrc(raw)) return false;
  if (raw.includes("checksops-logo")) return true;
  if (isRawBrandingObjectPath(raw)) return true;
  if (raw.includes("/storage/public") && /bucket=tenant-logos|bucket=email-assets/.test(raw)) return true;
  if (raw.includes("tenant-logos") && raw.includes("storage/public")) return true;
  return false;
}

export function resolvePreviewLogoUrl(
  logoUrl: unknown,
  apiBaseUrl?: string,
  origin?: string,
): string | null {
  const resolved = resolvePublicBrandingUrl(logoUrl, "tenant-logos", apiBaseUrl)
    || (typeof logoUrl === "string" && (
      logoUrl.includes("/storage/public")
      || /^https?:\/\//i.test(logoUrl.trim())
    )
      ? logoUrl.trim()
      : null);
  if (!resolved || isUnsafePreviewSrc(resolved)) return null;
  return absolutizePreviewUrl(resolved, origin);
}

export function applyEmailPreviewBranding(
  html: string,
  {
    logoUrl = null,
    primaryColor = null,
    previousColors = [],
    apiBaseUrl,
    origin,
  }: {
    logoUrl?: string | null;
    primaryColor?: string | null;
    previousColors?: Array<string | null | undefined>;
    apiBaseUrl?: string;
    origin?: string;
  } = {},
): string {
  if (!html) return html;
  let out = html;
  const resolvedLogo = resolvePreviewLogoUrl(logoUrl, apiBaseUrl, origin);

  if (resolvedLogo) {
    out = out.replace(/src=(["'])([^"']*)\1/gi, (full, quote: string, src: string) => {
      if (!shouldReplacePreviewLogoSrc(src, resolvedLogo)) return full;
      return `src=${quote}${resolvedLogo}${quote}`;
    });
  }

  if (isSafeEmailBrandColor(primaryColor)) {
    const next = String(primaryColor).trim();
    const seen = new Set<string>();
    for (const candidate of [...previousColors, PLATFORM_EMAIL_BRAND_COLOR]) {
      if (!isSafeEmailBrandColor(candidate)) continue;
      const color = String(candidate).trim();
      if (color.toLowerCase() === next.toLowerCase()) continue;
      if (seen.has(color)) continue;
      seen.add(color);
      out = out.split(color).join(next);
    }
  }

  return out;
}
