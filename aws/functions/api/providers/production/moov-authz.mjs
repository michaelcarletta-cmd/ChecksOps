import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { FINANCIAL_ROLES, roleAllowsFinancial } from '../../financial-authz.mjs';
import { financialPermissionsActivated } from '../../financial-flags.mjs';
import { isPlatformOwnerCaller } from './moov-roles.mjs';
import { productionMoovExecutionAllowed } from './moov-holds.mjs';

export const MOOV_FUND_TOTP_ACTION = 'wallet.fund';
export const MOOV_DISBURSE_TOTP_ACTION = 'wallet.disburse';
export const MOOV_FEE_COLLECT_TOTP_ACTION = 'platform.fee_collect';
export const TOTP_STEPUP_TTL_MS = 30 * 60 * 1000;

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

export const stepUpMatchesMoov = (row, {
  tenantId,
  actionKey,
  amountCents,
  sourcePaymentMethodId,
  destinationPaymentMethodId,
} = {}) => {
  if (!row || !tenantId || !Number.isInteger(Number(amountCents))) return false;
  if (String(row.tenant_id) !== String(tenantId)) return false;
  if (actionKey && String(row.action_key) !== String(actionKey)) return false;
  if (row.succeeded !== true) return false;
  const meta = row.metadata || {};
  if (Number(meta.amount_cents) !== Number(amountCents)) return false;
  if (sourcePaymentMethodId && String(meta.source_payment_method_id || '') !== String(sourcePaymentMethodId)) {
    return false;
  }
  if (destinationPaymentMethodId && String(meta.destination_payment_method_id || '') !== String(destinationPaymentMethodId)) {
    return false;
  }
  return true;
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
  amountCents,
  sourcePaymentMethodId,
  destinationPaymentMethodId,
  sinceMs = TOTP_STEPUP_TTL_MS,
} = {}) {
  if (!userId || !tenantId || !actionKey || !Number.isInteger(Number(amountCents))) return [];
  const rows = (await client.query(
    `SELECT id, user_id, tenant_id, action_key, factor_type, succeeded, metadata, created_at
     FROM public.financial_stepup_log
     WHERE user_id = $1::uuid
       AND tenant_id = $2::uuid
       AND action_key = $3
       AND succeeded IS TRUE
       AND created_at >= $4::timestamptz
       AND COALESCE((metadata->>'amount_cents')::bigint, -1) = $5::bigint
     ORDER BY created_at DESC
     LIMIT 5`,
    [userId, tenantId, actionKey, new Date(Date.now() - sinceMs).toISOString(), Number(amountCents)],
  )).rows;
  return rows.filter((row) => stepUpMatchesMoov(row, {
    tenantId,
    actionKey,
    amountCents: Number(amountCents),
    sourcePaymentMethodId,
    destinationPaymentMethodId,
  }));
}

export async function loadTenantMemberships(client, userId) {
  if (!userId) return [];
  return (await client.query(TENANT_MEMBERSHIP_SQL, [userId])).rows;
}

export async function assertMoovTenantAccess(client, mapping, tenantId) {
  const platformOwner = isPlatformOwnerCaller(mapping);
  if (platformOwner) {
    return { ok: true, platformOwner: true, memberships: [] };
  }
  const memberships = await loadTenantMemberships(client, mapping.application_user_id);
  if (!memberships.some((row) => row.tenant_id === tenantId)) {
    return denyMoovAuthz('cross_tenant_denied', {
      message: 'Requested tenant_id is not a membership of the authenticated user. Tenant Management (checksopsadmin@gmail.com) may act across tenants.',
    });
  }
  return { ok: true, platformOwner: false, memberships };
}

export async function authorizeMoovProduction({
  client,
  mapping,
  tenantId,
  actionKey,
  amountCents,
  sourcePaymentMethodId,
  destinationPaymentMethodId,
  requirePlatformOwner = false,
} = {}) {
  if (!productionMoovExecutionAllowed() || !financialPermissionsActivated()) {
    return denyMoovAuthz('production_execution_blocked', {
      message: 'Production Moov money flags stay false.',
    });
  }
  const platformOwner = isPlatformOwnerCaller(mapping);
  if (requirePlatformOwner && !platformOwner) {
    return denyMoovAuthz('platform_owner_required', {
      message: 'Only Tenant Management (checksopsadmin@gmail.com) can pull monthly and usage fees from other tenants.',
    });
  }
  const access = await assertMoovTenantAccess(client, mapping, tenantId);
  if (!access.ok) return access;
  let roles = [];
  if (!platformOwner) {
    roles = await loadTenantRole(client, mapping.application_user_id, tenantId);
    if (!roleAllowsFinancial(roles) && !roles.some((role) => FINANCIAL_ROLES.has(role))) {
      return denyMoovAuthz('financial_role_required', {
        message: 'Wallet funding and disbursement require owner, admin, or manager, or Tenant Management.',
      });
    }
  }
  const totpRows = await loadRecentMoovStepUp(client, {
    userId: mapping.application_user_id,
    tenantId,
    actionKey,
    amountCents,
    sourcePaymentMethodId,
    destinationPaymentMethodId,
  });
  if (!totpRows.length) {
    return denyMoovAuthz('financial_totp_required', {
      actionKey,
      amountCents,
      message: 'A Financial TOTP step-up bound to this tenant, action, amount, and payment methods is required before Moov money movement.',
    });
  }
  return {
    ok: true,
    totpRow: totpRows[0],
    roles,
    memberships: access.memberships,
    platformOwner,
  };
}
