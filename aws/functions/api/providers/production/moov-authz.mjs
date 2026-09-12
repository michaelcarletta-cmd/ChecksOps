import { FINANCIAL_ROLES, roleAllowsFinancial } from '../../financial-authz.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { financialPermissionsActivated } from '../../financial-flags.mjs';
import { productionMoovExecutionAllowed } from './moov-holds.mjs';

export const MOOV_TOTP_ACTION = 'disbursement.send';
export const MOOV_DUAL_CONTROL_ACTION = 'moov.dual_control';
export const TOTP_STEPUP_TTL_MS = 30 * 60 * 1000;
export const DUAL_CONTROL_TTL_MS = 24 * 60 * 60 * 1000;

export const denyMoovAuthz = (error, extra = {}) => ({
  ok: false,
  statusCode: extra.statusCode || 403,
  error,
  provider: 'moov',
  liveProviderCalled: false,
  productionExecution: false,
  message: extra.message || 'Financial authorization denied. Cognito login is not money-movement authority.',
  ...extra,
});

export const loggedAmountCents = (metadata) => {
  const raw = metadata?.amount_cents;
  if (raw === undefined || raw === null || raw === '') return null;
  const cents = Number(raw);
  return Number.isInteger(cents) ? cents : null;
};

export const stepUpMatchesTransfer = (row, {
  tenantId,
  transferId,
  amountCents,
  actionKey,
} = {}) => {
  if (!row || !tenantId || !transferId || !Number.isInteger(Number(amountCents))) return false;
  if (String(row.tenant_id) !== String(tenantId)) return false;
  if (actionKey && String(row.action_key) !== String(actionKey)) return false;
  if (row.succeeded !== true) return false;
  if (String(row.metadata?.payment_transfer_id || row.metadata?.resource_id || '') !== String(transferId)) {
    return false;
  }
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

export async function loadRecentMoovStepUp(client, {
  userId,
  tenantId,
  actionKey,
  transferId,
  amountCents,
  sinceMs,
} = {}) {
  if (!userId || !tenantId || !actionKey || !transferId || !Number.isInteger(Number(amountCents))) {
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
       AND (
         (metadata->>'payment_transfer_id') = $5
         OR (metadata->>'resource_id') = $5
       )
       AND COALESCE((metadata->>'amount_cents')::bigint, -1) = $6::bigint
     ORDER BY created_at DESC
     LIMIT 5`,
    [userId, tenantId, actionKey, new Date(Date.now() - sinceMs).toISOString(), String(transferId), Number(amountCents)],
  )).rows;
  return rows.filter((row) => stepUpMatchesTransfer(row, {
    tenantId,
    transferId,
    amountCents: Number(amountCents),
    actionKey,
  }));
}

export async function loadMoovDualControlApproval(client, {
  tenantId,
  transferId,
  amountCents,
  excludeUserId,
} = {}) {
  if (!tenantId || !transferId || !Number.isInteger(Number(amountCents))) return null;
  const rows = (await client.query(
    `SELECT id, user_id, tenant_id, action_key, factor_type, succeeded, metadata, created_at
     FROM public.financial_stepup_log
     WHERE tenant_id = $1::uuid
       AND action_key = $2
       AND succeeded IS TRUE
       AND created_at >= $3::timestamptz
       AND (
         (metadata->>'payment_transfer_id') = $4
         OR (metadata->>'resource_id') = $4
       )
       AND COALESCE((metadata->>'amount_cents')::bigint, -1) = $5::bigint
     ORDER BY created_at DESC
     LIMIT 20`,
    [
      tenantId,
      MOOV_DUAL_CONTROL_ACTION,
      new Date(Date.now() - DUAL_CONTROL_TTL_MS).toISOString(),
      String(transferId),
      Number(amountCents),
    ],
  )).rows;
  for (const row of rows) {
    if (String(row.user_id) === String(excludeUserId)) continue;
    if (!stepUpMatchesTransfer(row, {
      tenantId,
      transferId,
      amountCents: Number(amountCents),
      actionKey: MOOV_DUAL_CONTROL_ACTION,
    })) continue;
    const approverRoles = await loadTenantRole(client, row.user_id, tenantId);
    if (!roleAllowsFinancial(approverRoles)) continue;
    return row;
  }
  return null;
}

/**
 * Server-side Moov production authorization.
 * Does not flip evaluateFinancialAuthorization().canExecuteProduction.
 */
export const evaluateMoovProductionAuthorization = ({
  identityOk,
  membershipOk,
  roles = [],
  totpOk = false,
  dualControlOk = false,
} = {}) => {
  const roleOk = roleAllowsFinancial(roles);
  const stepUpOk = Boolean(totpOk || dualControlOk);
  const flagsOk = productionMoovExecutionAllowed();
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
    canExecuteProductionMoov: canExecute,
    canExecuteProduction: false,
    message: !identityOk
      ? 'Cognito identity is required.'
      : !membershipOk
        ? 'Tenant membership of the transfer is required.'
        : !roleOk
          ? 'Operator/staff cannot execute production Moov. Owner/admin/manager required.'
          : !stepUpOk
            ? 'Cognito TOTP step-up or dual-control approval from a distinct owner/admin/manager is required, bound to this transfer and amount.'
            : !flagsOk
              ? 'Production Moov holds remain on.'
              : 'Moov production authorization satisfied. Holds must still be lifted by a human.',
  };
};

export async function authorizeMoovProduction({
  client,
  mapping,
  memberships,
  transfer,
  requireStepUp = true,
} = {}) {
  const userId = mapping?.application_user_id;
  if (!userId) return denyMoovAuthz('identity_required', { statusCode: 401 });
  const ownership = membershipForTenant(memberships, transfer?.tenant_id);
  if (!transfer?.id || !transfer.tenant_id || !ownership) {
    return denyMoovAuthz('cross_tenant_denied', {
      message: 'Authenticated user is not a member of the transfer tenant. Browser tenant_id is ignored.',
    });
  }
  const amountCents = Number(transfer.amount_cents);
  if (requireStepUp && !Number.isInteger(amountCents)) {
    return denyMoovAuthz('invalid_amount', {
      statusCode: 400,
      message: 'Server-derived transfer amount_cents is required for financial step-up. Browser amount is ignored.',
    });
  }
  const roles = await loadTenantRole(client, userId, transfer.tenant_id);
  let totpOk = false;
  let dualControlOk = false;
  let totpRow = null;
  let dualRow = null;
  if (requireStepUp) {
    const totpRows = await loadRecentMoovStepUp(client, {
      userId,
      tenantId: transfer.tenant_id,
      actionKey: MOOV_TOTP_ACTION,
      transferId: transfer.id,
      amountCents,
      sinceMs: TOTP_STEPUP_TTL_MS,
    });
    totpRow = totpRows[0] || null;
    totpOk = Boolean(totpRow);
    dualRow = await loadMoovDualControlApproval(client, {
      tenantId: transfer.tenant_id,
      transferId: transfer.id,
      amountCents,
      excludeUserId: userId,
    });
    dualControlOk = Boolean(dualRow);
  }
  const evaluation = evaluateMoovProductionAuthorization({
    identityOk: true,
    membershipOk: true,
    roles,
    totpOk: requireStepUp ? totpOk : true,
    dualControlOk: requireStepUp ? dualControlOk : true,
  });
  if (!evaluation.canExecuteProductionMoov) {
    const error = !evaluation.roleOk
      ? 'financial_unauthorized'
      : !evaluation.stepUpOk
        ? 'step_up_required'
        : 'production_execution_blocked';
    return denyMoovAuthz(error, {
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
