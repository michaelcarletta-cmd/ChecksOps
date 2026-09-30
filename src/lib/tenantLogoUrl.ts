/**
 * Single tenant-logo URL contract for the Cognito / AWS SPA.
 *
 * Display prefers the live binary route `/prep/branding/logo/{tenantId}`
 * (image/png) over `/storage/public` 302 hops. Persist still stores the
 * canonical two-segment object path.
 */

const SUPABASE_PUBLIC = /^https?:\/\/[^/]*supabase\.co\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/([^?]+)/i;
const PUBLIC_LOGO_BUCKETS = new Set(["tenant-logos", "email-assets", "company-branding"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

const defaultApiBase = (): string => {
  const configured = String((import.meta as { env?: Record<string, string> }).env?.VITE_CHECKSOPS_API_URL || "")
    .trim()
    .replace(/\/$/, "");
  const origin = typeof window !== "undefined" ? String(window.location.origin || "").replace(/\/$/, "") : "";
  const token = configured.toLowerCase();
  if (!configured || token === "/prep" || token === "same-origin" || token === "same-origin:/prep") {
    return origin ? `${origin}/prep` : "/prep";
  }
  return configured;
};

const publicObjectUrl = (bucket: string, objectPath: string, base: string) =>
  `${base.replace(/\/$/, "")}/storage/public?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(objectPath)}`;

const brandingLogoUrl = (tenantId: string, base: string) =>
  `${base.replace(/\/$/, "")}/branding/logo/${tenantId.toLowerCase()}`;

const rewriteSupabaseLogoUrl = (value: string, base: string): string | null => {
  const match = value.match(SUPABASE_PUBLIC);
  if (!match) return null;
  const bucket = match[1];
  const path = decodeURIComponent(match[2]);
  if (!PUBLIC_LOGO_BUCKETS.has(bucket)) return null;
  return publicObjectUrl(bucket, path, base);
};

const normalizeRelativeLogoPath = (raw: string): string | null => {
  let objectPath = raw.replace(/^\/+/, "");
  if (!objectPath || objectPath.includes("..") || objectPath.includes("://")) return null;
  objectPath = objectPath.replace(/^files\//, "");
  if (objectPath.startsWith("tenant-logos/")) objectPath = objectPath.slice("tenant-logos/".length);
  if (objectPath.startsWith("company-branding/")) objectPath = objectPath.slice("company-branding/".length);
  return objectPath || null;
};

const parseMaybeUrl = (value: string): URL | null => {
  try {
    if (value.startsWith("http://") || value.startsWith("https://")) return new URL(value);
    if (value.startsWith("/")) return new URL(value, "https://checksops.com");
    return null;
  } catch {
    return null;
  }
};

/** Tenant UUID encoded in a stored logo path or public URL. */
export function tenantIdFromStoredLogo(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const branding = trimmed.match(/\/branding\/logo\/([0-9a-fA-F-]{36})(?:\b|$)/);
  if (branding && UUID_RE.test(branding[1])) return branding[1].toLowerCase();
  const url = parseMaybeUrl(trimmed);
  if (url) {
    const fromQuery = url.searchParams.get("path") || "";
    const first = fromQuery.replace(/^\/+/, "").split("/")[0];
    if (UUID_RE.test(first)) return first.toLowerCase();
  }
  const relative = normalizeRelativeLogoPath(trimmed);
  const first = relative?.split("/")[0];
  return first && UUID_RE.test(first) ? first.toLowerCase() : null;
}

export function resolveTenantLogoUrl(
  value: string | null | undefined,
  explicitApiBase?: string,
  tenantIdHint?: string | null,
): string | null {
  const base = String(explicitApiBase ?? defaultApiBase()).replace(/\/$/, "");
  const hinted = typeof tenantIdHint === "string" && UUID_RE.test(tenantIdHint.trim())
    ? tenantIdHint.trim().toLowerCase()
    : null;

  if (typeof value !== "string") {
    return hinted && base ? brandingLogoUrl(hinted, base) : null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return hinted && base ? brandingLogoUrl(hinted, base) : null;
  }
  if (/^(data:|blob:)/i.test(trimmed)) return trimmed;

  const tenantId = tenantIdFromStoredLogo(trimmed) || hinted;
  if (tenantId && base) return brandingLogoUrl(tenantId, base);

  const fromSupabase = rewriteSupabaseLogoUrl(trimmed, base);
  if (fromSupabase) return fromSupabase;

  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^\/(assets|src)\//.test(trimmed)) return trimmed;

  const objectPath = normalizeRelativeLogoPath(trimmed);
  if (!objectPath || !base) return null;
  return publicObjectUrl("tenant-logos", objectPath, base);
}

export function resolveTenantAssetUrl(
  value: string | null | undefined,
  bucket = "tenant-logos",
  explicitApiBase?: string,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(data:|blob:)/i.test(trimmed)) return trimmed;
  if (bucket === "tenant-logos") return resolveTenantLogoUrl(trimmed, explicitApiBase);

  const base = String(explicitApiBase ?? defaultApiBase()).replace(/\/$/, "");
  const fromSupabase = rewriteSupabaseLogoUrl(trimmed, base);
  if (fromSupabase) return fromSupabase;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const objectPath = normalizeRelativeLogoPath(trimmed);
  if (!objectPath || !base) return null;
  return publicObjectUrl(bucket, objectPath, base);
}

export function rewriteTenantLogoUrl(value: unknown, explicitApiBase?: string): unknown {
  if (typeof value !== "string") return value;
  return resolveTenantLogoUrl(value, explicitApiBase) ?? value;
}

const twoSegmentObjectPath = (raw: string): string | null => {
  let objectPath = raw.replace(/^\/+/, "");
  if (!objectPath || objectPath.includes("..") || objectPath.includes("://") || objectPath.includes("?") || objectPath.includes("#")) {
    return null;
  }
  objectPath = objectPath.replace(/^files\//, "");
  if (objectPath.startsWith("tenant-logos/")) objectPath = objectPath.slice("tenant-logos/".length);
  if (objectPath.startsWith("company-branding/")) objectPath = objectPath.slice("company-branding/".length);
  const parts = objectPath.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  if (parts.some((seg) => !SAFE_SEGMENT.test(seg))) return null;
  return parts.join("/");
};

const isAwsPublicStorageLogoUrl = (value: string): boolean => {
  try {
    const url = parseMaybeUrl(value);
    if (!url || !url.pathname.includes("/storage/public")) return false;
    const bucket = url.searchParams.get("bucket") || "";
    return PUBLIC_LOGO_BUCKETS.has(bucket) && Boolean(url.searchParams.get("path"));
  } catch {
    return false;
  }
};

/**
 * Persist rule for tenants.logo_url / invoice_letterhead_url after AWS upload/save.
 * Relative object path or /prep/storage/public?... → `<tenant-id>/<file>`.
 * Legitimate external HTTPS (C1C Supabase, CDN) is kept unchanged.
 */
export function canonicalStoredTenantLogo(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(data:|blob:)/i.test(trimmed)) return null;
  if (isAwsPublicStorageLogoUrl(trimmed)) {
    try {
      const url = parseMaybeUrl(trimmed);
      return twoSegmentObjectPath(url?.searchParams.get("path") || "");
    } catch {
      return null;
    }
  }
  if (!trimmed.includes("://") && !trimmed.startsWith("/storage/public") && !trimmed.includes("/branding/logo/")) {
    return twoSegmentObjectPath(trimmed);
  }
  if (/^https:\/\//i.test(trimmed) && !trimmed.includes("/storage/public?") && !trimmed.includes("/branding/logo/")) {
    try {
      const url = new URL(trimmed);
      if (url.username || url.password) return null;
      return trimmed;
    } catch {
      return null;
    }
  }
  const fromBranding = tenantIdFromStoredLogo(trimmed);
  if (fromBranding) {
    const path = twoSegmentObjectPath(normalizeRelativeLogoPath(trimmed) || "");
    return path;
  }
  return null;
}

export function persistableLogoField(value: string | null | undefined): string | undefined {
  const canonical = canonicalStoredTenantLogo(value);
  if (canonical) return canonical;
  if (typeof value === "string" && value.trim() && !/^(data:|blob:)/i.test(value.trim())) {
    return value.trim();
  }
  return undefined;
}

export function isCanonicalRelativeTenantLogo(value: string | null | undefined): boolean {
  const path = typeof value === "string" ? twoSegmentObjectPath(value.trim()) : null;
  return Boolean(path && UUID_RE.test(path.split("/")[0]));
}
