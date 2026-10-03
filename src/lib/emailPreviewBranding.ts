import {
  isRawBrandingObjectPath,
  resolvePublicBrandingUrl,
} from "@/lib/brandingPublicUrl";

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
