import { FINANCIAL_ROLES } from '../../financial-authz.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { financialPermissionsActivated } from '../../financial-flags.mjs';
import { formatCheckAltUserAmount } from '../amounts.mjs';
import { productionCheckAltExecutionAllowed } from './checkalt-holds.mjs';
import { loginSessionBinding } from './moov-fund-authz.mjs';

export const CHECKALT_TOTP_ACTION = 'deposit.submit';
export const CHECKALT_APPROVE_ACTION = 'deposit.approve';
/**
 * Check Alt financial TOTP actions. Two-factor is once per login, the same as
 * Moov wallet fund and send: one successful step-up for any of these actions,
 * recorded with the caller's login (loginSessionBinding), authorizes every
 * Check Alt action for the check's tenant until the user signs out. The
 * step-up request still names a check, only so the tenant is taken from the
 * server-side check and the check and amount are kept in the audit log.
 */
export const FINANCIAL_CHECKALT_STEPUP_ACTIONS = Object.freeze([
  CHECKALT_TOTP_ACTION,
  CHECKALT_APPROVE_ACTION,
]);
/**
 * Removed feature: Check Alt dual control (second-person approval) no longer
 * authorizes anything. Rows with this action_key are never read. The constant
 * stays exported only so a live checkalt-dual-control.mjs that still imports
 * it keeps linking until that member is overlaid with the 410 refusal.
 */
export const CHECKALT_DUAL_CONTROL_ACTION = 'checkalt.dual_control';

export const denyCheckAltAuthz = (error, extra = {}) => ({
  ok: false,
  statusCode: extra.statusCode || 403,
  error,
  provider: 'checkalt',
  liveProviderCalled: false,
  productionExecution: false,
  message: extra.message || 'Financial authorization denied. Cognito login is not money-movement authority.',
  ...extra,
});

export const serverAmountCentsFromCheck = (check) => {
  const formatted = formatCheckAltUserAmount(check?.amount);
  if (formatted?.error || !Number.isInteger(formatted?.userAmount)) return null;
  return formatted.userAmount;
};

/**
 * Deprecated: mixes tenant_users with platform user_roles, so it must not
 * decide any Check Alt action. Kept exported only so a live
 * checkalt-dual-control.mjs that still imports it keeps linking until that
 * member is overlaid (it is next in the production plan). Use
 * loadCheckAltTenantRoles.
 */
export async function loadTenantRole(client, userId, tenantId) {
  if (!userId || !tenantId) return [];
  const tenant = (await client.query(
    'SELECT role FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid',
    [userId, tenantId],
  )).rows.map((row) => String(row.role || '').toLowerCase());
  const platform = (await client.query(
    'SELECT role FROM public.user_roles WHERE user_id = $1::uuid',
    [userId],
  )).rows.map((row) => String(row.role || '').toLowerCase());
  return [...new Set([...tenant, ...platform])];
}

/** The caller's tenant_users role(s) for one tenant, without platform user_roles. */
export async function loadCheckAltTenantRoles(client, userId, tenantId) {
  if (!userId || !tenantId) return [];
  return (await client.query(
    'SELECT role FROM public.tenant_users WHERE user_id = $1::uuid AND tenant_id = $2::uuid',
    [userId, tenantId],
  )).rows.map((row) => String(row.role || '').toLowerCase());
}

/**
 * The caller's own Check Alt step-up for this tenant in this login, or null.
 * Bound to user, tenant and login session (sub + origin_jti or auth_time), not
 * to a check, an amount or a time window: a new login, another user, another
 * tenant or another session needs a new code.
 */
export async function loadSessionCheckAltStepUp(client, { userId, tenantId, loginSession } = {}) {
  if (!userId || !tenantId || !loginSession) return null;
  return (await client.query(
    `SELECT id, user_id, tenant_id, action_key, factor_type, succeeded, metadata, created_at
     FROM public.financial_stepup_log
     WHERE user_id = $1::uuid
       AND tenant_id = $2::uuid
       AND action_key = ANY($3::text[])
       AND succeeded IS TRUE
       AND factor_type = 'totp'
       AND (metadata->>'source') = 'app_financial_totp'
       AND (metadata->>'login_session') = $4
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, tenantId, [...FINANCIAL_CHECKALT_STEPUP_ACTIONS], loginSession],
  )).rows[0] || null;
}

/**
 * Roles that may submit, approve, reject and refresh Check Alt deposits for a
 * tenant they belong to. Viewers (for example partners added to a tenant to
 * see shared checks) may not. `roles` holds only the caller's tenant_users
 * role for the check's tenant (loadCheckAltTenantRoles); platform user_roles
 * are not consulted, and unknown roles fail closed.
 */
export const CHECKALT_OPERATOR_ROLES = Object.freeze(['owner', 'admin', 'manager', 'operator']);

export const roleAllowsCheckAlt = (roles = []) =>
  roles.some((role) => CHECKALT_OPERATOR_ROLES.includes(String(role || '').toLowerCase()));

/**
 * Server-side CheckAlt production authorization.
 * Does not flip evaluateFinancialAuthorization().canExecuteProduction.
 *
 * Product policy: a member of the check's tenant (verified server-side from
 * tenant_users, never from the browser) whose role is owner, admin, manager or
 * operator may submit, approve and refresh Check Alt deposits. Viewers and
 * members of other tenants (including partner tenants a check is shared with)
 * may not. Money actions still need the caller's own step-up: there is no
 * second-person (dual-control) alternative.
 */
export const evaluateCheckAltProductionAuthorization = ({
  identityOk,
  membershipOk,
  roles = [],
  totpOk = false,
} = {}) => {
  const roleOk = Boolean(membershipOk) && roleAllowsCheckAlt(roles);
  const stepUpOk = Boolean(totpOk);
  const flagsOk = productionCheckAltExecutionAllowed();
  const canExecute = Boolean(identityOk && membershipOk && roleOk && stepUpOk && flagsOk);
  return {
    identityOk: Boolean(identityOk),
    membershipOk: Boolean(membershipOk),
    roleOk,
    totpOk: Boolean(totpOk),
    stepUpOk,
    flagsOk,
    financialPermissionActivated: financialPermissionsActivated(),
    financialRoles: [...FINANCIAL_ROLES],
    canExecuteProductionCheckAlt: canExecute,
    canExecuteProduction: false,
    message: !identityOk
      ? 'Cognito identity is required.'
      : !membershipOk
        ? 'Tenant membership of the check is required.'
        : !roleOk
          ? 'Viewers cannot submit, approve or refresh Check Alt deposits. Owner/admin/manager/operator required.'
          : !stepUpOk
            ? 'Your own Cognito TOTP step-up is required once per login.'
            : !flagsOk
              ? 'Production CheckAlt holds remain on.'
              : 'CheckAlt production authorization satisfied. Holds must still be lifted by a human.',
  };
};

export async function authorizeCheckAltProduction({
  client,
  mapping,
  claims,
  memberships,
  check,
  requireStepUp = true,
} = {}) {
  const userId = mapping?.application_user_id;
  if (!userId) return denyCheckAltAuthz('identity_required', { statusCode: 401 });
  const ownership = membershipForTenant(memberships, check?.tenant_id);
  if (!check?.id || !check.tenant_id || !ownership) {
    return denyCheckAltAuthz('cross_tenant_denied', {
      message: 'Authenticated user is not a member of the check tenant. Browser tenant_id is ignored.',
    });
  }
  const amountCents = serverAmountCentsFromCheck(check);
  if (requireStepUp && !Number.isInteger(amountCents)) {
    return denyCheckAltAuthz('invalid_amount', {
      statusCode: 400,
      message: 'Server-derived check amount is required for financial step-up. Browser amount is ignored.',
    });
  }
  // Only the caller's tenant_users role for the check's tenant decides. A
  // platform user_roles admin/staff never lets a tenant viewer act.
  const roles = await loadCheckAltTenantRoles(client, userId, check.tenant_id);
  // Only the caller's own Check Alt step-up for this tenant, entered in this
  // login, counts. A second person's approval never substitutes for it.
  let totpOk = false;
  let totpRow = null;
  if (requireStepUp) {
    totpRow = await loadSessionCheckAltStepUp(client, {
      userId,
      tenantId: check.tenant_id,
      loginSession: loginSessionBinding(claims),
    });
    totpOk = Boolean(totpRow);
  }
  const evaluation = evaluateCheckAltProductionAuthorization({
    identityOk: true,
    membershipOk: true,
    roles,
    totpOk: requireStepUp ? totpOk : true,
  });
  if (!evaluation.canExecuteProductionCheckAlt) {
    const error = !evaluation.roleOk
      ? 'financial_unauthorized'
      : !evaluation.stepUpOk
        ? 'step_up_required'
        : 'production_execution_blocked';
    return denyCheckAltAuthz(error, {
      evaluation,
      tenantRole: ownership.role,
    });
  }
  return {
    ok: true,
    evaluation,
    membership: ownership,
    roles,
    totpRow,
    amountCents,
  };
}
