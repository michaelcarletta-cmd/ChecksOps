/**
 * Mortgage Desk (internal ChecksOps operational queue) is for mortgage_agent
 * personnel only. Tenant CheckOps admins are not Mortgage Ops staff and must
 * not inherit the queue from user_roles.role = admin.
 */
export function isMortgageDeskStaff(roles: readonly string[] | null | undefined): boolean {
  return (roles ?? []).includes("mortgage_agent");
}
