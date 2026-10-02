/** A company user may move checks. Role titles are ignored.
 *  Platform admin can still act across tenants.
 */
export function canMoveTenantChecks({ roles, isTenantMember } = {}) {
  const set = roles instanceof Set
    ? roles
    : new Set([...(roles || [])].map((role) => String(role || '').toLowerCase()));
  if (isTenantMember) return true;
  return set.has('admin');
}
