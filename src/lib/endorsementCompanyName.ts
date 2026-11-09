/**
 * The name drawn after "Pay to the order of" on a check's endorsement.
 *
 * Owner request 2026-11-09: it is the tenant's Company Name from Company
 * Profile (`public.tenants.name`). The server stamp
 * (aws/functions/api/endorsement-composite.mjs, resolveEndorsementCompanyName)
 * reads the name of the tenant that OWNS the check (`check.tenant_id`), so the
 * on-screen preview and the browser renderer use that same tenant, also when a
 * partner tenant is viewing a shared check.
 *
 * A blank name gives "" and the renderers leave the "Pay to the order of" and
 * name lines out. Another tenant's name is never used as a fallback.
 */
import { FREEDOM_ADJUSTMENT_TENANT_ID } from "./vendorOps.ts";

type TenantNameRow = { id?: string | null; name?: string | null } | null | undefined;

export type EndorsementCheckTenant = {
  tenant_id?: string | null;
  /** `tenants(name)` embed on the check row (served from tenants_public on AWS). */
  tenants?: TenantNameRow | TenantNameRow[];
};

export function resolveEndorsementCompanyName(tenant: TenantNameRow): string {
  return String(tenant?.name ?? "").trim();
}

/**
 * The check owner's Company Name: the `tenants(name)` embed on the check row,
 * else the signed-in tenant when it is the check's owner. A partner viewing a
 * shared check never sees its own name here.
 */
export function endorsementCompanyNameForCheck(
  check: EndorsementCheckTenant | null | undefined,
  currentTenant: TenantNameRow,
): string {
  if (!check) return "";
  const embedded = Array.isArray(check.tenants) ? check.tenants[0] : check.tenants;
  const fromEmbed = resolveEndorsementCompanyName(embedded);
  if (fromEmbed) return fromEmbed;
  const ownerId = check.tenant_id ?? null;
  if (ownerId && currentTenant?.id && currentTenant.id === ownerId) {
    return resolveEndorsementCompanyName(currentTenant);
  }
  return "";
}

/**
 * Whether an endorsement row is the company's own signature (drawn under the
 * company name at the bottom of the block). Mirrors isCompanyName in
 * endorsement-composite.mjs: the tenant's name, plus the legacy
 * "Freedom"/"Carletta" signer rows for the Freedom Adjustment tenant only.
 */
export function isCompanyEndorsementName(
  payeeName: string | null | undefined,
  companyName: string,
  tenantId: string | null | undefined,
): boolean {
  const lc = String(payeeName ?? "").toLowerCase();
  const company = companyName.trim().toLowerCase();
  if (company && lc.includes(company)) return true;
  return tenantId === FREEDOM_ADJUSTMENT_TENANT_ID && (lc.includes("freedom") || lc.includes("carletta"));
}
