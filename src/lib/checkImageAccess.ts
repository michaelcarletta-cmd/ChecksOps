import { mortgageAgentCanReadCheckImages } from "./mortgageCheckImageAccess";

/** Product rule: any mortgage_agent with an active request for this check may
 *  read images. Assignment isolation is intentionally not added. */

export function decideCheckImageAccess(opts: {
  userId?: string | null;
  check?: { id?: string | null; tenant_id?: string | null } | null;
  userRoles?: string[] | null;
  tenantIds?: string[] | null;
  activeMortgageRequest?: {
    tenant_id?: string | null;
    check_intake_item_id?: string | null;
    status?: string | null;
  } | null;
  sharedCheck?: boolean;
}): { ok: true } | { ok: false; status: 401 | 403 | 404; error: string } {
  if (!opts.userId) return { ok: false, status: 401, error: "Not authenticated" };
  if (!opts.check?.id) return { ok: false, status: 404, error: "Check not found" };

  const roles = (opts.userRoles || []).map((role) => String(role || "").toLowerCase());
  const privileged = roles.includes("admin") || roles.includes("staff");
  if (privileged) return { ok: true };

  const tenantIds = opts.tenantIds || [];
  if (opts.check.tenant_id && tenantIds.includes(String(opts.check.tenant_id))) return { ok: true };

  if (mortgageAgentCanReadCheckImages({
    userRoles: roles,
    request: opts.activeMortgageRequest,
    checkId: String(opts.check.id),
    checkTenantId: opts.check.tenant_id,
  })) {
    return { ok: true };
  }

  if (opts.sharedCheck) return { ok: true };
  return { ok: false, status: 403, error: "Check not accessible" };
}

export async function runGetCheckImageUrls(opts: {
  userId?: string | null;
  body?: { checkId?: string; check_id?: string };
  loadCheck: (checkId: string) => Promise<{ id: string; tenant_id?: string | null; check_number?: string | null } | null>;
  loadUserRoles: (userId: string) => Promise<string[]>;
  loadTenantIds: (userId: string) => Promise<string[]>;
  loadActiveMortgageRequest: (checkId: string) => Promise<{
    tenant_id?: string | null;
    check_intake_item_id?: string | null;
    status?: string | null;
  } | null>;
  loadSharedCheck: (checkId: string, tenantIds: string[]) => Promise<boolean>;
  signUrls: (check: { id: string }) => Promise<{ frontUrl: string | null; backUrl: string | null }>;
}) {
  if (!opts.userId) return { statusCode: 401, error: "Not authenticated" };
  const checkId = opts.body?.checkId || opts.body?.check_id;
  if (!checkId) return { statusCode: 400, error: "Missing checkId" };

  const check = await opts.loadCheck(checkId);
  if (!check) return { statusCode: 404, error: "Check not found" };

  const [userRoles, tenantIds] = await Promise.all([
    opts.loadUserRoles(opts.userId),
    opts.loadTenantIds(opts.userId),
  ]);
  const activeMortgageRequest = userRoles.includes("mortgage_agent")
    ? await opts.loadActiveMortgageRequest(checkId)
    : null;
  const sharedCheck = tenantIds.length > 0
    ? await opts.loadSharedCheck(checkId, tenantIds)
    : false;

  const access = decideCheckImageAccess({
    userId: opts.userId,
    check,
    userRoles,
    tenantIds,
    activeMortgageRequest,
    sharedCheck,
  });
  if (!access.ok) return { statusCode: access.status, error: access.error };

  const signed = await opts.signUrls(check);
  return {
    statusCode: 200,
    checkId: check.id,
    check_id: check.id,
    checkNumber: check.check_number ?? null,
    frontUrl: signed.frontUrl,
    backUrl: signed.backUrl,
    front_url: signed.frontUrl,
    back_url: signed.backUrl,
  };
}
