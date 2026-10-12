/**
 * Server-matching Tax & 1099 UI gate.
 * Any member of the tenant may use the tax area (no admin-only features).
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
  return String(tenantRole || "").trim() !== "";
}
