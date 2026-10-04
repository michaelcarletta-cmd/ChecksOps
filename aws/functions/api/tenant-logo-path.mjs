/**
 * Canonical tenant-logo path contract.
 *
 * Stored AWS logos are a two-segment object path:
 *   <tenant-id>/logo-<ts>.png
 *
 * Also recognizes (for read/auth compatibility):
 *   /prep/storage/public?bucket=tenant-logos&path=...
 *   files/tenant-logos/<tenant-id>/<file>
 *   tenant-logos/<tenant-id>/<file>
 *
 * Does not treat arbitrary URL text as a match. No LIKE '%path%'.
 */

const TENANT_LOGO_BUCKET = 'tenant-logos';
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPABASE_LOGO = /^https?:\/\/[^/]*supabase\.co\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/([^?]+)/i;

export const isUuid = (value) => UUID_RE.test(String(value || '').trim());

const unsafe = (value) => {
  const raw = String(value || '');
  return !raw || raw.includes('..') || raw.includes('\0') || /[\u0000-\u001F\u007F]/.test(raw);
};

const twoSegmentObjectPath = (raw) => {
  if (typeof raw !== 'string') return null;
  let path = raw.trim().replace(/^\/+/, '');
  if (unsafe(path) || path.includes('://') || path.includes('?') || path.includes('#') || path.includes('\\')) {
    return null;
  }
  if (path.startsWith('files/')) path = path.slice('files/'.length);
  if (path.startsWith(`${TENANT_LOGO_BUCKET}/`)) path = path.slice(`${TENANT_LOGO_BUCKET}/`.length);
  const parts = path.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  if (parts.some((seg) => !SAFE_SEGMENT.test(seg) || seg === '.' || seg === '..')) return null;
  return parts.join('/');
};

export const isAwsPublicStorageLogoUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw || unsafe(raw)) return false;
  try {
    const url = raw.startsWith('http://') || raw.startsWith('https://')
      ? new URL(raw)
      : raw.startsWith('/')
        ? new URL(raw, 'https://checksops.com')
        : null;
    if (!url) return false;
    if (!url.pathname.includes('/storage/public')) return false;
    return url.searchParams.get('bucket') === TENANT_LOGO_BUCKET && Boolean(url.searchParams.get('path'));
  } catch {
    return false;
  }
};

export const isSafeExternalHttpsLogo = (value) => {
  const raw = String(value || '').trim();
  if (!raw || unsafe(raw) || raw.startsWith('//')) return false;
  if (isAwsPublicStorageLogoUrl(raw)) return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || !parsed.hostname) return false;
  return parsed.protocol === 'https:';
};

/**
 * Normalize a stored or requested logo representation to a tenant-logos object path.
 * Returns null when the value is not a supported tenant-logo object.
 */
export const normalizeTenantLogoObjectPath = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || unsafe(trimmed)) return null;

  if (isAwsPublicStorageLogoUrl(trimmed)) {
    try {
      const url = trimmed.startsWith('http') ? new URL(trimmed) : new URL(trimmed, 'https://checksops.com');
      if (url.searchParams.get('bucket') !== TENANT_LOGO_BUCKET) return null;
      return twoSegmentObjectPath(url.searchParams.get('path') || '');
    } catch {
      return null;
    }
  }

  const supabase = trimmed.match(SUPABASE_LOGO);
  if (supabase) {
    if (supabase[1] !== TENANT_LOGO_BUCKET) return null;
    return twoSegmentObjectPath(decodeURIComponent(supabase[2]));
  }

  return twoSegmentObjectPath(trimmed);
};

/** Exact stored-vs-requested match after normalization. Never substring LIKE. */
export const storedLogoMatchesRequest = (storedLogoUrl, requestedPath) => {
  const stored = normalizeTenantLogoObjectPath(storedLogoUrl);
  const requested = normalizeTenantLogoObjectPath(requestedPath);
  return Boolean(stored && requested && stored === requested);
};

/**
 * Value to persist on tenants.logo_url after upload or save.
 * AWS public-resolver URLs and relative object paths → relative path.
 * Legitimate external HTTPS (e.g. C1C Supabase) → unchanged.
 */
export const canonicalStoredTenantLogo = (value) => {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (isAwsPublicStorageLogoUrl(trimmed)) {
    return normalizeTenantLogoObjectPath(trimmed);
  }
  if (!trimmed.includes('://') && !trimmed.startsWith('/storage/public')) {
    return normalizeTenantLogoObjectPath(trimmed);
  }
  if (isSafeExternalHttpsLogo(trimmed)) return trimmed;
  return null;
};

export const emailBrandingLogoPath = (tenantId) => {
  const id = String(tenantId || '').trim();
  if (!isUuid(id)) return null;
  return `/prep/branding/logo/${id.toLowerCase()}`;
};

export const resolveEmailTenantLogoUrl = ({ tenantId = null, logoUrl = null, origin } = {}) => {
  const base = String(origin || '').replace(/\/$/, '');
  if (isSafeExternalHttpsLogo(logoUrl)) return String(logoUrl).trim();
  const objectPath = normalizeTenantLogoObjectPath(logoUrl);
  const brandingPath = emailBrandingLogoPath(tenantId);
  if (objectPath && brandingPath && base) {
    if (base.endsWith('/prep')) return `${base}${brandingPath.replace(/^\/prep/, '')}`;
    return `${base}${brandingPath}`;
  }
  return null;
};
