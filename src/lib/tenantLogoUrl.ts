/**
 * Single tenant-logo URL contract for the Cognito / AWS SPA.
 *
 * - relative AWS logo path → current AWS public-storage resolver
 * - already-valid absolute URL → kept (after optional Supabase rewrite)
 * - missing / unusable value → null (caller shows existing fallback)
 *
 * Does not rewrite stored logo_url values and does not emit Supabase URLs.
 */

const SUPABASE_PUBLIC = /^https?:\/\/[^/]*supabase\.co\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/([^?]+)/i;
const PUBLIC_LOGO_BUCKETS = new Set(["tenant-logos", "email-assets", "company-branding"]);

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
  return objectPath || null;
};

export function resolveTenantLogoUrl(
  value: string | null | undefined,
  explicitApiBase?: string,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(data:|blob:)/i.test(trimmed)) return trimmed;

  const base = String(explicitApiBase ?? defaultApiBase()).replace(/\/$/, "");
  const fromSupabase = rewriteSupabaseLogoUrl(trimmed, base);
  if (fromSupabase) return fromSupabase;

  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  if (trimmed.includes("/storage/public?") && /[?&]bucket=tenant-logos\b/.test(trimmed)) {
    return trimmed;
  }

  if (/^\/(assets|src)\//.test(trimmed)) return trimmed;

  const objectPath = normalizeRelativeLogoPath(trimmed);
  if (!objectPath || !base) return null;
  return publicObjectUrl("tenant-logos", objectPath, base);
}

export function rewriteTenantLogoUrl(value: unknown, explicitApiBase?: string): unknown {
  if (typeof value !== "string") return value;
  return resolveTenantLogoUrl(value, explicitApiBase) ?? value;
}
