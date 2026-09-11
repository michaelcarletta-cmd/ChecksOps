/**
 * Server-matching Tax & 1099 UI gate.
 * Ordinary tenant members must not see the tax area.
 * Hidden tabs are not authorization — the API also enforces this.
 */

export const PERMITTED_TENANT_TAX_ROLES = new Set(["owner", "admin"]);

export function canAccessTaxUi({
  isPlatformOwner = false,
  platformRole = null,
  tenantRole = null,
}: {
  isPlatformOwner?: boolean;
  platformRole?: string | null;
  tenantRole?: string | null;
} = {}): boolean {
  if (isPlatformOwner === true) return true;
  if (String(platformRole || "").toLowerCase() === "admin") return true;
  return PERMITTED_TENANT_TAX_ROLES.has(String(tenantRole || "").toLowerCase());
}
