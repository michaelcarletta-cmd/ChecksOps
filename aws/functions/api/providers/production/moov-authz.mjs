import { TENANT_MEMBERSHIP_SQL } from '../../identity.mjs';
import { FINANCIAL_ROLES, roleAllowsFinancial } from '../../financial-authz.mjs';
import { membershipForTenant } from '../../financial-ownership.mjs';
import { financialPermissionsActivated } from '../../financial-flags.mjs';
import { isPlatformOwnerCaller } from './moov-roles.mjs';
import { productionMoovExecutionAllowed } from './moov-holds.mjs';
import {
  bindingForMoovWalletAction,
  isMoovWalletTotpAction,
  mismatchFirstTestBody,
  MOOV_DISBURSE_TOTP_ACTION,
  MOOV_FUND_TOTP_ACTION,
} from './moov-first-test.mjs';

export {
  isMoovWalletTotpAction,
  MOOV_DISBURSE_TOTP_ACTION,
  MOOV_FUND_TOTP_ACTION,
};
export const MOOV_FEE_COLLECT_TOTP_ACTION = 'platform.fee_collect';
export const MOOV_REFUND_TOTP_ACTION = 'platform.refund';
export const TOTP_STEPUP_TTL_MS = 30 * 60 * 1000;

export const TENANT_MANAGEMENT_SEND_MESSAGE = 'Tenant Management does not send payouts on a tenant\'s behalf. Tenants send partner, sub, vendor, and homeowner payouts from the wallet. CheckAlt is required only when a ChecksOps deposit is named. Tenant Management only pulls monthly/usage fees and issues refunds.';

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

export const tenantManagementSendDenied = (mapping) => {
  if (!isPlatformOwnerCaller(mapping)) return null;
  return denyMoovAuthz('tenant_management_send_refused', {
    message: TENANT_MANAGEMENT_SEND_MESSAGE,
  });
};

/** Tenant membership required. Tenant Management cannot send on a tenant's behalf. */
export async function assertMoovTenantAccess(client, mapping, tenantId) {
  const refused = tenantManagementSendDenied(mapping);
  if (refused) return refused;
  const memberships = await loadTenantMemberships(client, mapping.application_user_id);
  if (!memberships.some((row) => row.tenant_id === tenantId)) {
    return denyMoovAuthz('cross_tenant_denied', {
      message: 'Requested tenant_id is not a membership of the authenticated user.',
    });
  }
  return { ok: true, platformOwner: false, memberships };
}

/** Tenant members see their wallet. Tenant Management may view any tenant (read-only). */
export async function assertMoovTenantView(client, mapping, tenantId) {
  const platformOwner = isPlatformOwnerCaller(mapping);
  if (platformOwner) {
    return { ok: true, platformOwner: true, memberships: [] };
  }
  const memberships = await loadTenantMemberships(client, mapping.application_user_id);
  if (!memberships.some((row) => row.tenant_id === tenantId)) {
    return denyMoovAuthz('cross_tenant_denied', {
      message: 'Requested tenant_id is not a membership of the authenticated user.',
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
  if (requirePlatformOwner) {
    if (!platformOwner) {
      return denyMoovAuthz('platform_owner_required', {
        message: 'Only Tenant Management (checksopsadmin@gmail.com) can pull monthly/usage fees or issue refunds.',
      });
    }
  } else if (platformOwner) {
    return denyMoovAuthz('tenant_management_send_refused', {
      message: TENANT_MANAGEMENT_SEND_MESSAGE,
    });
  }
  const access = requirePlatformOwner
    ? { ok: true, platformOwner: true, memberships: [] }
    : await assertMoovTenantAccess(client, mapping, tenantId);
  if (!access.ok) return access;
  let roles = [];
  if (!platformOwner) {
    roles = await loadTenantRole(client, mapping.application_user_id, tenantId);
    if (!roleAllowsFinancial(roles) && !roles.some((role) => FINANCIAL_ROLES.has(role))) {
      return denyMoovAuthz('financial_role_required', {
        message: 'Wallet funding and disbursement require owner, admin, or manager of this tenant.',
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

/**
 * Financial TOTP for wallet.fund / wallet.disburse.
 * Server-binds Freedom tenant, exact bank/wallet or wallet/recipient PMs, and 1¢.
 * Browser tenant/amount/IDs are never authority.
 */
export async function resolveMoovWalletStepUpBinding({
  client,
  mapping,
  body,
  spoof,
  actionKey,
} = {}) {
  if (!isMoovWalletTotpAction(actionKey)) {
    return denyMoovAuthz('action_mismatch', {
      statusCode: 409,
      spoofFieldsIgnored: spoof,
      message: 'Financial TOTP step-up action is server-controlled.',
    });
  }
  const binding = bindingForMoovWalletAction(actionKey);
  const mismatch = mismatchFirstTestBody(body, binding);
  if (mismatch) {
    return denyMoovAuthz(mismatch.error, {
      statusCode: mismatch.statusCode,
      field: mismatch.field,
      amountCents: mismatch.amountCents,
      capCents: mismatch.capCents,
      message: mismatch.message,
      spoofFieldsIgnored: spoof,
    });
  }
  const refused = tenantManagementSendDenied(mapping);
  if (refused) return { ...refused, spoofFieldsIgnored: spoof };
  const memberships = await loadTenantMemberships(client, mapping.application_user_id);
  if (!membershipForTenant(memberships, binding.tenantId)) {
    return denyMoovAuthz('cross_tenant_denied', {
      spoofFieldsIgnored: spoof,
      message: 'wallet.fund / wallet.disburse TOTP is bound to Freedom membership. Browser tenant_id is ignored.',
    });
  }
  const roles = await loadTenantRole(client, mapping.application_user_id, binding.tenantId);
  if (!roleAllowsFinancial(roles) && !roles.some((role) => FINANCIAL_ROLES.has(role))) {
    return denyMoovAuthz('financial_role_required', {
      spoofFieldsIgnored: spoof,
      message: 'Wallet funding and disbursement require owner, admin, or manager of Freedom.',
    });
  }
  return {
    ok: true,
    check: null,
    tenantId: binding.tenantId,
    actionKey: binding.actionKey,
    amountCents: binding.amountCents,
    sourcePaymentMethodId: binding.sourcePaymentMethodId,
    destinationPaymentMethodId: binding.destinationPaymentMethodId,
    bankId: binding.bankId,
    walletId: binding.walletId,
    recipientId: binding.recipientId,
    recipientBankId: binding.recipientBankId,
    spoofFieldsIgnored: spoof,
  };
}
