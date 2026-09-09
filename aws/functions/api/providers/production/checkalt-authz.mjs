import { FINANCIAL_ROLES, roleAllowsFinancial } from '../../financial-authz.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { financialPermissionsActivated } from '../../financial-flags.mjs';
import { productionCheckAltExecutionAllowed } from './checkalt-holds.mjs';

export const CHECKALT_TOTP_ACTION = 'deposit.submit';
export const CHECKALT_DUAL_CONTROL_ACTION = 'checkalt.dual_control';
export const TOTP_STEPUP_TTL_MS = 30 * 60 * 1000;
export const DUAL_CONTROL_TTL_MS = 24 * 60 * 60 * 1000;

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

export async function loadRecentStepUp(client, {
  userId,
  tenantId,
  actionKey,
  checkId,
  sinceMs,
} = {}) {
  const params = [userId, tenantId, actionKey, new Date(Date.now() - sinceMs).toISOString()];
  let sql = `SELECT id, user_id, tenant_id, action_key, factor_type, succeeded, metadata, created_at
     FROM public.financial_stepup_log
     WHERE user_id = $1::uuid
       AND tenant_id = $2::uuid
       AND action_key = $3
       AND succeeded IS TRUE
       AND created_at >= $4::timestamptz`;
  if (checkId) {
    params.push(checkId);
    sql += ` AND (metadata->>'check_id') = $${params.length}`;
  }
  sql += ' ORDER BY created_at DESC LIMIT 5';
  return (await client.query(sql, params)).rows;
}

export async function loadDualControlApproval(client, { tenantId, checkId, excludeUserId } = {}) {
  const rows = (await client.query(
    `SELECT id, user_id, tenant_id, action_key, factor_type, succeeded, metadata, created_at
     FROM public.financial_stepup_log
     WHERE tenant_id = $1::uuid
       AND action_key = $2
       AND succeeded IS TRUE
       AND created_at >= $3::timestamptz
       AND (metadata->>'check_id') = $4
     ORDER BY created_at DESC
     LIMIT 20`,
    [tenantId, CHECKALT_DUAL_CONTROL_ACTION, new Date(Date.now() - DUAL_CONTROL_TTL_MS).toISOString(), checkId],
  )).rows;
  return rows.find((row) => String(row.user_id) !== String(excludeUserId)) || null;
}

/**
 * Server-side CheckAlt production authorization.
 * Does not flip evaluateFinancialAuthorization().canExecuteProduction.
 */
export const evaluateCheckAltProductionAuthorization = ({
  identityOk,
  membershipOk,
  roles = [],
  totpOk = false,
  dualControlOk = false,
} = {}) => {
  const roleOk = roleAllowsFinancial(roles);
  const stepUpOk = Boolean(totpOk || dualControlOk);
  const flagsOk = productionCheckAltExecutionAllowed();
  const canExecute = Boolean(identityOk && membershipOk && roleOk && stepUpOk && flagsOk);
  return {
    identityOk: Boolean(identityOk),
    membershipOk: Boolean(membershipOk),
    roleOk,
    totpOk: Boolean(totpOk),
    dualControlOk: Boolean(dualControlOk),
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
          ? 'Operator/staff cannot execute production CheckAlt. Owner/admin/manager required.'
          : !stepUpOk
            ? 'Cognito TOTP step-up or dual-control approval from a distinct owner/admin/manager is required.'
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
} = {}) {
  const userId = mapping?.application_user_id;
  if (!userId) return denyCheckAltAuthz('identity_required', { statusCode: 401 });
  const ownership = membershipForTenant(memberships, check?.tenant_id);
  if (!check?.id || !check.tenant_id || !ownership) {
    return denyCheckAltAuthz('cross_tenant_denied', {
      message: 'Authenticated user is not a member of the check tenant. Browser tenant_id is ignored.',
    });
  }
  const roles = await loadTenantRole(client, userId, check.tenant_id);
  let totpOk = false;
  let dualControlOk = false;
  let totpRow = null;
  let dualRow = null;
  if (requireStepUp) {
    const totpRows = await loadRecentStepUp(client, {
      userId,
      tenantId: check.tenant_id,
      actionKey: CHECKALT_TOTP_ACTION,
      checkId: check.id,
      sinceMs: TOTP_STEPUP_TTL_MS,
    });
    totpRow = totpRows[0] || null;
    totpOk = Boolean(totpRow);
    if (!totpOk) {
      const totpAny = await loadRecentStepUp(client, {
        userId,
        tenantId: check.tenant_id,
        actionKey: CHECKALT_TOTP_ACTION,
        sinceMs: TOTP_STEPUP_TTL_MS,
      });
      totpRow = totpAny[0] || null;
      totpOk = Boolean(totpRow);
    }
    dualRow = await loadDualControlApproval(client, {
      tenantId: check.tenant_id,
      checkId: check.id,
      excludeUserId: userId,
    });
    dualControlOk = Boolean(dualRow);
  }
  const evaluation = evaluateCheckAltProductionAuthorization({
    identityOk: true,
    membershipOk: true,
    roles,
    totpOk: requireStepUp ? totpOk : true,
    dualControlOk: requireStepUp ? dualControlOk : true,
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
    dualRow,
  };
}
