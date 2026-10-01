/** Company operators may move checks. View-only tenant roles cannot.
 *  Platform admin can still act across tenants.
 */

export const OPERATING_TENANT_ROLES = new Set([
  "admin",
  "operator",
  "owner",
  "member",
  "staff",
]);

export const VIEW_ONLY_TENANT_ROLES = new Set(["viewer", "read_only"]);

export function canMoveTenantChecks(input: {
  systemRoles?: Iterable<string | null | undefined> | null;
  isTenantMember?: boolean;
  tenantRole?: string | null;
}): boolean {
  const roles = new Set(
    [...(input.systemRoles ?? [])]
      .filter((role): role is string => Boolean(role))
      .map((role) => String(role).toLowerCase()),
  );
  if (roles.has("admin")) return true;
  if (!input.isTenantMember) return false;
  const tenantRole = String(input.tenantRole || "").toLowerCase();
  if (VIEW_ONLY_TENANT_ROLES.has(tenantRole)) return false;
  return OPERATING_TENANT_ROLES.has(tenantRole);
}
