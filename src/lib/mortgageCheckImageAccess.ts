/** Narrow Mortgage Ops image-read authorization.
 *  Active authorized request only. Does not grant completed/cancelled access.
 */

export const ACTIVE_MORTGAGE_IMAGE_STATUSES = ["requested", "in_progress"] as const;

export type MortgageRequestAccessRow = {
  tenant_id?: string | null;
  check_intake_item_id?: string | null;
  status?: string | null;
  assigned_employee_id?: string | null;
};

export function isActiveMortgageImageRequest(status: string | null | undefined): boolean {
  return ACTIVE_MORTGAGE_IMAGE_STATUSES.includes(
    String(status || "").toLowerCase() as (typeof ACTIVE_MORTGAGE_IMAGE_STATUSES)[number],
  );
}

export function mortgageAgentCanReadCheckImages(opts: {
  userRoles?: string[] | null;
  request?: MortgageRequestAccessRow | null;
  checkId: string;
  checkTenantId?: string | null;
}): boolean {
  const roles = (opts.userRoles || []).map((role) => String(role || "").toLowerCase());
  if (!roles.includes("mortgage_agent")) return false;
  const request = opts.request;
  if (!request) return false;
  if (String(request.check_intake_item_id || "") !== String(opts.checkId)) return false;
  if (opts.checkTenantId && request.tenant_id && String(request.tenant_id) !== String(opts.checkTenantId)) {
    return false;
  }
  return isActiveMortgageImageRequest(request.status);
}
