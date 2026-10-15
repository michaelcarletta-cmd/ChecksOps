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

export function canOperateCheckAlt(input: {
  isTenantMember?: boolean | null;
  tenantRole?: string | null;
} = {}): boolean {
  if (!input.isTenantMember) return false;
  const role = String(input.tenantRole ?? "").trim().toLowerCase();
  return CHECKALT_OPERATOR_ROLES.includes(role);
}

/**
 * Auto-Deposit save: the same tenant roles, plus the platform owner, which
 * the save RPC (aws_save_checkalt_tenant_auto_deposit, SQL 80) also allows.
 */
export function canSaveCheckAltAutoDeposit(input: {
  isTenantMember?: boolean | null;
  tenantRole?: string | null;
  isPlatformOwner?: boolean | null;
} = {}): boolean {
  if (input.isPlatformOwner === true) return true;
  return canOperateCheckAlt(input);
}
