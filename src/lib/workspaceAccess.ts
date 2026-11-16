/**
 * Workspace access decision for the white-label app (/{slug}/... and custom domains).
 *
 * Owner, 2026-11-16: the owner of an organization was shown "Access Denied" for their own
 * workspace. The screen trusted one client read of tenant_users and treated any error (for
 * example a refused /data/query) the same as "no row". The server's own list of the user's
 * organizations (/identity/me `tenants`: tenant_id, role, tenant_name, tenant_slug, read from
 * tenant_users) is already on the signed-in user, so it counts first.
 *
 * A member is a user when any of these hold:
 *   - the identity's tenant list contains this tenant (by id, or by slug when an entry has one);
 *   - the tenant_users read returned a row;
 *   - the user is the master merchant (preview of any tenant).
 * Otherwise: a failed read is "unconfirmed" (retry screen), never "denied"; only a read that
 * succeeded with no row is "denied". UX only: the API and RLS enforce membership.
 */

export type IdentityTenantMembership = {
  tenant_id: string | null;
  tenant_slug: string | null;
  role: string | null;
};

export type WorkspaceAccess = "member" | "denied" | "unconfirmed";

export type WorkspaceAccessInput = {
  tenantId: string | null | undefined;
  tenantSlug?: string | null;
  /** app_metadata.tenant_memberships of the signed-in user (from /identity/me `tenants`). */
  identityTenants?: unknown;
  /** The tenant_users read found a row for this tenant and user. */
  tenantUsersRow: boolean;
  /** The tenant_users read failed (an error, as opposed to no row). */
  tenantUsersError: boolean;
  isMasterMerchant: boolean;
};

const text = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

/** Normalizes /identity/me `tenants` rows; anything that is not an object with an id or slug is dropped. */
export function identityTenantMemberships(tenants: unknown): IdentityTenantMembership[] {
  if (!Array.isArray(tenants)) return [];
  const out: IdentityTenantMembership[] = [];
  for (const row of tenants) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const tenantId = text(record.tenant_id) ?? text(record.tenantId);
    const tenantSlug = text(record.tenant_slug) ?? text(record.tenantSlug) ?? text(record.slug);
    if (!tenantId && !tenantSlug) continue;
    out.push({ tenant_id: tenantId, tenant_slug: tenantSlug, role: text(record.role) });
  }
  return out;
}

/** The user's identity tenant list names this tenant (by id; by slug when the entry carries one). */
export function identityListsTenant(
  identityTenants: unknown,
  tenantId: string | null | undefined,
  tenantSlug?: string | null,
): boolean {
  const id = text(tenantId)?.toLowerCase() ?? null;
  const slug = text(tenantSlug)?.toLowerCase() ?? null;
  if (!id && !slug) return false;
  return identityTenantMemberships(identityTenants).some(
    (entry) =>
      (id !== null && entry.tenant_id?.toLowerCase() === id)
      || (slug !== null && entry.tenant_slug?.toLowerCase() === slug),
  );
}

export function decideWorkspaceAccess(input: WorkspaceAccessInput): WorkspaceAccess {
  if (input.isMasterMerchant) return "member";
  if (identityListsTenant(input.identityTenants, input.tenantId, input.tenantSlug)) return "member";
  if (input.tenantUsersRow) return "member";
  if (input.tenantUsersError) return "unconfirmed";
  return "denied";
}
