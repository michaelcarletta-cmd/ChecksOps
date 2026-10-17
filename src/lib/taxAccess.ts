/**
 * Server-matching Tax & 1099 UI gate.
 * Owner policy: every member of the tenant is a user with the same rights, so
 * any member of the current tenant sees the tax area. Platform owner/admin/staff
 * roles do not open it; only the user's own membership counts.
 * Hidden tabs are not authorization — the API also enforces this.
 */

export function canAccessTaxUi({
  isTenantMember = false,
}: {
  isTenantMember?: boolean;
} = {}): boolean {
  return isTenantMember === true;
}
