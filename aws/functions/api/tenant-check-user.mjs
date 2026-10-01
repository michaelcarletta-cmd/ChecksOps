/** Company tenant users may move checks. Platform admin still can too. */
export function canMoveTenantChecks({ roles, isTenantMember } = {}) {
  const set = roles instanceof Set
    ? roles
    : new Set([...(roles || [])].map((role) => String(role || '').toLowerCase()));
  if (isTenantMember) return true;
  return set.has('admin');
}
