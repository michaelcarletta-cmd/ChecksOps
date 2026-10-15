/**
 * Who may use the Check Alt money controls (submit/deposit, approve, reject,
 * refresh status, Auto-Deposit save) in the SPA.
 *
 * UX only: the server is the source of truth and refuses everyone else. This
 * list mirrors CHECKALT_OPERATOR_ROLES in
 * aws/functions/api/providers/production/checkalt-authz.mjs (a test keeps the
 * two equal). Only the caller's tenant_users role for the tenant decides;
 * platform roles are ignored, viewers and unknown roles are refused, and
 * non-members (partners a check is shared with) are refused.
 */
export const CHECKALT_OPERATOR_ROLES: readonly string[] = Object.freeze([
  "owner",
  "admin",
  "manager",
  "operator",
]);

/** One tenant_users row of the signed-in user. */
export type TenantMembership = { tenant_id: string; role: string | null };

/** Same test as the server's roleAllowsCheckAlt: lower-cased, no trimming. */
const roleAllowsCheckAlt = (role: string | null | undefined): boolean =>
  CHECKALT_OPERATOR_ROLES.includes(String(role || "").toLowerCase());

export function canOperateCheckAlt(input: {
  isTenantMember?: boolean | null;
  tenantRole?: string | null;
} = {}): boolean {
  if (!input.isTenantMember) return false;
  return roleAllowsCheckAlt(input.tenantRole);
}

/**
 * Per tenant (for example per deposit row): true when one of the user's
 * memberships of that tenant has an operator-or-above role. The server checks
 * each deposit against its own tenant the same way.
 */
export function canOperateCheckAltForTenant(
  memberships: readonly TenantMembership[] | null | undefined,
  tenantId: string | null | undefined,
): boolean {
  if (!tenantId) return false;
  return (memberships ?? []).some(
    (row) => String(row?.tenant_id ?? "") === String(tenantId) && roleAllowsCheckAlt(row?.role),
  );
}

/**
 * Tenant-wide Poll Now (empty body) covers every tenant the user belongs to
 * and the server checks each deposit, so it is useful when the user is an
 * operator-or-above in at least one tenant.
 */
export function canOperateCheckAltInAnyTenant(
  memberships: readonly TenantMembership[] | null | undefined,
): boolean {
  return (memberships ?? []).some((row) => !!row?.tenant_id && roleAllowsCheckAlt(row?.role));
}

/**
 * Auto-Deposit save: the same tenant roles, plus the platform owner, which
 * the save RPC (aws_save_checkalt_tenant_auto_deposit, SQL 80) also allows.
 */
export function canSaveCheckAltAutoDeposit(input: {
  memberships?: readonly TenantMembership[] | null;
  tenantId?: string | null;
  isPlatformOwner?: boolean | null;
} = {}): boolean {
  if (input.isPlatformOwner === true) return true;
  return canOperateCheckAltForTenant(input.memberships, input.tenantId);
}

export type CheckAltAccessState = "loading" | "error" | "allowed" | "denied";

/**
 * What a gated control should show. Hidden unless "allowed"; the role message
 * is only for "denied", once memberships have loaded.
 */
export function checkAltAccessState(input: {
  isLoading?: boolean;
  isError?: boolean;
  allowed: boolean;
}): CheckAltAccessState {
  if (input.allowed) return "allowed";
  if (input.isLoading) return "loading";
  if (input.isError) return "error";
  return "denied";
}
