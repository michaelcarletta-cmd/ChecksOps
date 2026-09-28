const PUBLIC_BRANDING_BUCKETS = new Set(['tenant-logos', 'email-assets', 'company-branding']);

export function rewriteSupabaseStorageUrl(value, apiBase) {
  if (typeof value !== 'string') return value;
  const match = value.match(
    /^https?:\/\/[^/]*supabase\.co\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/([^?]+)/i,
  );
  if (!match) return value;
  const bucket = match[1];
  const objectPath = decodeURIComponent(match[2]);
  if (!PUBLIC_BRANDING_BUCKETS.has(bucket)) return value;
  return `${apiBase}/storage/public?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(objectPath)}`;
}

export function resolveTenantLogoUrl(value, apiBase = '/prep') {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.includes('..')) return null;
  const rewritten = rewriteSupabaseStorageUrl(raw, apiBase);
  if (typeof rewritten === 'string' && rewritten !== raw) return rewritten;
  if (/^https?:\/\//i.test(raw) || raw.startsWith('/storage/public?')) return raw;
  const prefixed = raw.match(/^(tenant-logos|email-assets|company-branding)\/(.+)$/);
  const bucket = prefixed ? prefixed[1] : 'tenant-logos';
  const objectPath = prefixed ? prefixed[2] : raw.replace(/^\/+/, '');
  if (!objectPath || /^https?:/i.test(objectPath)) return null;
  return `${apiBase}/storage/public?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(objectPath)}`;
}

export function rewriteLogoFields(value, apiBase = '/prep') {
  if (Array.isArray(value)) return value.map((row) => rewriteLogoFields(row, apiBase));
  if (!value || typeof value !== 'object') return rewriteSupabaseStorageUrl(value, apiBase);
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === 'string' && /^(logo_url|logoUrl)$/i.test(key)) {
      out[key] = resolveTenantLogoUrl(nested, apiBase) || nested;
    } else if (nested && typeof nested === 'object') {
      out[key] = rewriteLogoFields(nested, apiBase);
    } else {
      out[key] = nested;
    }
  }
  return out;
}
