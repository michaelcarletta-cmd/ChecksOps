/**
 * Who may use the Check Alt money controls (submit/deposit, approve, reject,
 * refresh status, Auto-Deposit save) in the SPA.
 *
 * UX only: the server is the source of truth and refuses everyone else. This
 * mirrors roleAllowsCheckAlt in
 * aws/functions/api/providers/production/checkalt-authz.mjs. Owner policy:
 * every member of the tenant is a user with the same rights. Only the caller's
 * tenant_users membership of the tenant decides (the role value is ignored);
 * platform roles are ignored and non-members (partners a check is shared with)
 * are refused.
 */

/** One tenant_users row of the signed-in user. */
export type TenantMembership = { tenant_id: string; role: string | null };

export function canOperateCheckAlt(input: {
  isTenantMember?: boolean | null;
  tenantRole?: string | null;
} = {}): boolean {
  return Boolean(input.isTenantMember);
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
    (row) => String(row?.tenant_id ?? "") === String(tenantId),
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
  return (memberships ?? []).some((row) => !!row?.tenant_id);
}

/**
 * Auto-Deposit save: any member of that tenant. It is a tenant setting: the
 * save RPC (aws_save_checkalt_tenant_auto_deposit, SQL 90) refuses the
 * platform owner, so the platform owner is not offered the control either.
 */
export function canSaveCheckAltAutoDeposit(input: {
  memberships?: readonly TenantMembership[] | null;
  tenantId?: string | null;
} = {}): boolean {
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
