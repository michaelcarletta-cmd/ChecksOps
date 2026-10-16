/**
 * Server-matching Tax & 1099 UI gate.
 * Owner policy: tax setup is team management, so only the owner and admin of
 * the current tenant see the tax area. Platform owner/admin/staff roles do not
 * open it; only the caller's own tenant role counts.
 * Hidden tabs are not authorization — the API also enforces this.
 */

export const PERMITTED_TENANT_TAX_ROLES = new Set(["owner", "admin"]);

export function canAccessTaxUi({
  tenantRole = null,
}: {
  tenantRole?: string | null;
} = {}): boolean {
  return PERMITTED_TENANT_TAX_ROLES.has(String(tenantRole || "").toLowerCase());
}
