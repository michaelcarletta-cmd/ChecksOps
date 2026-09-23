import { FINANCIAL_ROLES, roleAllowsFinancial } from '../../financial-authz.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { financialPermissionsActivated } from '../../financial-flags.mjs';
import { formatCheckAltUserAmount } from '../amounts.mjs';
import { productionCheckAltExecutionAllowed } from './checkalt-holds.mjs';

export const CHECKALT_TOTP_ACTION = 'deposit.submit';
export const CHECKALT_APPROVE_ACTION = 'deposit.approve';
export const FINANCIAL_CHECKALT_STEPUP_ACTIONS = Object.freeze([
  CHECKALT_TOTP_ACTION,
  CHECKALT_APPROVE_ACTION,
]);
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

export async function loadDualControlApproval(client, {
  tenantId,
  checkId,
  amountCents,
  excludeUserId,
} = {}) {
  if (!tenantId || !checkId || !Number.isInteger(Number(amountCents))) return null;
  const rows = (await client.query(
    `SELECT id, user_id, tenant_id, action_key, factor_type, succeeded, metadata, created_at
     FROM public.financial_stepup_log
     WHERE tenant_id = $1::uuid
       AND action_key = $2
       AND succeeded IS TRUE
       AND created_at >= $3::timestamptz
       AND (metadata->>'check_id') = $4
       AND COALESCE((metadata->>'amount_cents')::bigint, -1) = $5::bigint
     ORDER BY created_at DESC
     LIMIT 20`,
    [
      tenantId,
      CHECKALT_DUAL_CONTROL_ACTION,
      new Date(Date.now() - DUAL_CONTROL_TTL_MS).toISOString(),
      String(checkId),
      Number(amountCents),
    ],
  )).rows;
  for (const row of rows) {
    if (String(row.user_id) === String(excludeUserId)) continue;
    if (!stepUpMatchesCheck(row, {
      tenantId,
      checkId,
      amountCents: Number(amountCents),
      actionKey: CHECKALT_DUAL_CONTROL_ACTION,
    })) continue;
    const approverRoles = await loadTenantRole(client, row.user_id, tenantId);
    if (!roleAllowsFinancial(approverRoles)) continue;
    return row;
  }
  return null;
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
            ? 'Cognito TOTP step-up or dual-control approval from a distinct owner/admin/manager is required, bound to this check and amount.'
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
  const roles = await loadTenantRole(client, userId, check.tenant_id);
  let totpOk = false;
  let dualControlOk = false;
  let totpRow = null;
  let dualRow = null;
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
    dualRow = await loadDualControlApproval(client, {
      tenantId: check.tenant_id,
      checkId: check.id,
      amountCents,
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
    amountCents,
  };
}
