/**
 * Active owning-tenant context for claim creation.
 *
 * A tenant slug is an authorized session hint. It is never a client UUID
 * (org_id / tenant_id / x-tenant-id are spoof fields and are ignored here).
 * PostgreSQL aws_claim_owner_tenant_id() membership-checks the slug against
 * tenant_users for auth.uid() before using it.
 */

export const ACTIVE_TENANT_SLUG_GUC = 'request.active_tenant_slug';

export const TENANT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const headerValue = (headers, name) => {
  if (!headers || typeof headers !== 'object') return null;
  const lower = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), value]),
  );
  const raw = lower[name];
  return raw == null ? null : String(raw);
};

export const sanitizeTenantSlug = (value) => {
  const slug = String(value || '').trim().toLowerCase();
  if (!slug) return null;
  if (UUID_RE.test(slug)) return null;
  if (!TENANT_SLUG_RE.test(slug)) return null;
  return slug;
};

/**
 * Trusted selector is a slug, never an org/tenant UUID.
 * Sources, in order: x-active-tenant-slug, query tenant_slug / active_tenant_slug,
 * body.active_tenant_slug. Client org_id / tenant_id are ignored.
 */
export const resolveActiveTenantSlug = (event = {}, body = {}) => {
  const query = event?.queryStringParameters || {};
  const bodyObj = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  return sanitizeTenantSlug(
    headerValue(event?.headers, 'x-active-tenant-slug')
    || query.tenant_slug
    || query.active_tenant_slug
    || bodyObj.active_tenant_slug
    || null,
  );
};

export const bindActiveTenantSlug = async (client, event = {}, body = {}) => {
  const slug = resolveActiveTenantSlug(event, body);
  await client.query('SELECT set_config($1, $2, true)', [ACTIVE_TENANT_SLUG_GUC, slug || '']);
  return slug;
};
