/** Company people who may move checks. Outsiders (client, contractor,
 *  mortgage agent, read-only) stay out unless they also have a tenant_users
 *  row. Platform admin can still act across tenants.
 */
export function canMoveTenantChecks(input: {
  systemRoles?: Iterable<string | null | undefined> | null;
  isTenantMember?: boolean;
}): boolean {
  const roles = new Set(
    [...(input.systemRoles ?? [])]
      .filter((role): role is string => Boolean(role))
      .map((role) => String(role).toLowerCase()),
  );
  if (input.isTenantMember) return true;
  return roles.has("admin");
}
