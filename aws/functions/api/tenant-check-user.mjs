/** Company operators may move checks. View-only tenant roles cannot.
 *  Platform admin can still act across tenants.
 */

export const OPERATING_TENANT_ROLES = new Set([
  'admin',
  'operator',
  'owner',
  'member',
  'staff',
]);

export const VIEW_ONLY_TENANT_ROLES = new Set(['viewer', 'read_only']);

export function canMoveTenantChecks({ roles, isTenantMember, tenantRole } = {}) {
  const set = roles instanceof Set
    ? roles
    : new Set([...(roles || [])].map((role) => String(role || '').toLowerCase()));
  if (set.has('admin')) return true;
  if (!isTenantMember) return false;
  const tenant = String(tenantRole || '').toLowerCase();
  if (VIEW_ONLY_TENANT_ROLES.has(tenant)) return false;
  return OPERATING_TENANT_ROLES.has(tenant);
}
