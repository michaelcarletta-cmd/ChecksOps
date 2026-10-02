/** A company user may move checks. Role titles are ignored.
 *  Outsiders (client, contractor, and anyone not on the tenant) stay out.
 *  Platform admin can still act across tenants.
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
