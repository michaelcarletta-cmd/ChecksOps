/** Ordinary check movement requires same-company tenant_users membership. */
export function canMoveTenantChecks({ isTenantMember } = {}) {
  return isTenantMember === true;
}
