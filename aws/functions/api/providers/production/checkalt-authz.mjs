import { membershipForTenant } from '../../financial-ownership.mjs';
import { financialPermissionsActivated } from '../../financial-flags.mjs';
import { formatCheckAltUserAmount } from '../amounts.mjs';
import { productionCheckAltExecutionAllowed } from './checkalt-holds.mjs';

export const CHECKALT_TOTP_ACTION = 'deposit.submit';
export const CHECKALT_APPROVE_ACTION = 'deposit.approve';
/** Check-bound financial TOTP actions: tenant, check and amount are server-derived. */
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
export const TOTP_STEPUP_TTL_MS = 30 * 60 * 1000;

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

export const loggedAmountCents = (metadata) => {
  const raw = metadata?.amount_cents;
  if (raw === undefined || raw === null || raw === '') return null;
  const cents = Number(raw);
  return Number.isInteger(cents) ? cents : null;
};

export const stepUpMatchesCheck = (row, {
  tenantId,
  checkId,
  amountCents,
  actionKey,
} = {}) => {
  if (!row || !tenantId || !checkId || !Number.isInteger(Number(amountCents))) return false;
  if (String(row.tenant_id) !== String(tenantId)) return false;
  if (actionKey && String(row.action_key) !== String(actionKey)) return false;
  if (row.succeeded !== true) return false;
  if (String(row.metadata?.check_id || '') !== String(checkId)) return false;
  return loggedAmountCents(row.metadata) === Number(amountCents);
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

export async function loadRecentStepUp(client, {
  userId,
  tenantId,
  actionKey,
  checkId,
  amountCents,
  sinceMs,
} = {}) {
  if (!userId || !tenantId || !actionKey || !checkId || !Number.isInteger(Number(amountCents))) {
    return [];
  }
  const rows = (await client.query(
    `SELECT id, user_id, tenant_id, action_key, factor_type, succeeded, metadata, created_at
     FROM public.financial_stepup_log
     WHERE user_id = $1::uuid
       AND tenant_id = $2::uuid
       AND action_key = $3
       AND succeeded IS TRUE
       AND created_at >= $4::timestamptz
       AND (metadata->>'check_id') = $5
       AND COALESCE((metadata->>'amount_cents')::bigint, -1) = $6::bigint
     ORDER BY created_at DESC
     LIMIT 5`,
    [userId, tenantId, actionKey, new Date(Date.now() - sinceMs).toISOString(), String(checkId), Number(amountCents)],
  )).rows;
  return rows.filter((row) => stepUpMatchesCheck(row, {
    tenantId,
    checkId,
    amountCents: Number(amountCents),
    actionKey,
  }));
}

/**
 * Owner policy: every member of the tenant is a user with the same rights; partners and other tenants do not act.
 * `roles` holds one entry per tenant_users row of the caller for the check's
 * tenant (loadCheckAltTenantRoles); any row allows, whatever the role value.
 * Platform user_roles are not consulted. Partners (members of another tenant
 * the check is shared with) have no row for the check's tenant and are refused.
 */
export const roleAllowsCheckAlt = (roles = []) => Array.isArray(roles) && roles.length > 0;

/**
 * Server-side CheckAlt production authorization.
 * Does not flip evaluateFinancialAuthorization().canExecuteProduction.
 *
 * Product policy: any member of the check's tenant (verified server-side from
 * tenant_users, never from the browser; the role column is ignored) may
 * submit, approve and refresh Check Alt deposits. Members of other tenants
 * (including partner tenants a check is shared with) may not. Money actions still need the caller's own step-up: there is no
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
    canExecuteProductionCheckAlt: canExecute,
    canExecuteProduction: false,
    message: !identityOk
      ? 'Cognito identity is required.'
      : !membershipOk
        ? 'Tenant membership of the check is required.'
        : !roleOk
          ? 'Membership of the check tenant is required.'
          : !stepUpOk
            ? 'Your own Cognito TOTP step-up is required, bound to this check and amount.'
            : !flagsOk
              ? 'Production CheckAlt holds remain on.'
              : 'CheckAlt production authorization satisfied. Holds must still be lifted by a human.',
  };
};

export async function authorizeCheckAltProduction({
  client,
  mapping,
  memberships,
  check,
  requireStepUp = true,
  actionKey = CHECKALT_TOTP_ACTION,
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
  // Only the caller's tenant_users membership of the check's tenant decides. A
  // platform user_roles admin/staff never lets a non-member act.
  const roles = await loadCheckAltTenantRoles(client, userId, check.tenant_id);
  // Only the caller's own step-up for this action, check and amount counts.
  // A second person's approval never substitutes for it.
  let totpOk = false;
  let totpRow = null;
  if (requireStepUp) {
    const totpRows = await loadRecentStepUp(client, {
      userId,
      tenantId: check.tenant_id,
      actionKey,
      checkId: check.id,
      amountCents,
      sinceMs: TOTP_STEPUP_TTL_MS,
    });
    totpRow = totpRows[0] || null;
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
