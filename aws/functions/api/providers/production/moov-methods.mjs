import {
  FREEDOM_PRODUCTION_MOOV_ACCOUNT_ID,
  FREEDOM_PRODUCTION_TENANT_ID,
  PRODUCTION_MOOV_ENVIRONMENT,
} from './moov-holds.mjs';

export const loadProductionMoovAccount = async (client, tenantId) => {
  if (!tenantId) return null;
  return (await client.query(
    `SELECT *
     FROM public.payment_provider_accounts
     WHERE tenant_id = $1::uuid
       AND provider = 'moov'
       AND environment = $2
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 1`,
    [tenantId, PRODUCTION_MOOV_ENVIRONMENT],
  )).rows[0] || null;
};

export const loadProductionTenant = async (client, tenantId) => {
  if (!tenantId) return null;
  return (await client.query(
    `SELECT id, moov_allowlisted, moov_environment
     FROM public.tenants
     WHERE id = $1::uuid`,
    [tenantId],
  )).rows[0] || null;
};

export const isProductionFreedomTenant = (tenant) => (
  String(tenant?.id) === FREEDOM_PRODUCTION_TENANT_ID
  && tenant?.moov_allowlisted === true
  && String(tenant?.moov_environment || '').toLowerCase() === PRODUCTION_MOOV_ENVIRONMENT
);

export const isProductionFreedomAccount = (account) => (
  account
  && String(account.tenant_id) === FREEDOM_PRODUCTION_TENANT_ID
  && String(account.environment) === PRODUCTION_MOOV_ENVIRONMENT
  && String(account.provider_account_id) === FREEDOM_PRODUCTION_MOOV_ACCOUNT_ID
  && account.disabled !== true
  && account.restricted !== true
);

/**
 * Production payout method only. Sandbox rows are refused.
 * Does not redesign bank connection; it only loads the intended production method.
 */
export const loadProductionConnectedMethod = async (client, {
  tenantId,
  providerAccountId,
  methodId = null,
  externalRecipientId = null,
} = {}) => {
  if (methodId) {
    const row = (await client.query(
      `SELECT * FROM public.payment_provider_methods WHERE id = $1::uuid LIMIT 1`,
      [methodId],
    )).rows[0] || null;
    return row;
  }
  if (externalRecipientId) {
    return (await client.query(
      `SELECT * FROM public.payment_provider_methods
       WHERE external_recipient_id = $1::uuid
         AND provider = 'moov'
         AND environment = $2
         AND connection_status = 'connected'
       ORDER BY is_default DESC NULLS LAST, created_at DESC NULLS LAST
       LIMIT 1`,
      [externalRecipientId, PRODUCTION_MOOV_ENVIRONMENT],
    )).rows[0] || null;
  }
  if (!tenantId || !providerAccountId) return null;
  return (await client.query(
    `SELECT * FROM public.payment_provider_methods
     WHERE tenant_id = $1::uuid
       AND provider = 'moov'
       AND environment = $2
       AND provider_account_id = $3
       AND connection_status = 'connected'
     ORDER BY is_default DESC NULLS LAST, created_at DESC NULLS LAST
     LIMIT 1`,
    [tenantId, PRODUCTION_MOOV_ENVIRONMENT, providerAccountId],
  )).rows[0] || null;
};

export const loadProductionWallet = async (client, { tenantId, providerAccountId } = {}) => {
  if (!tenantId) return null;
  return (await client.query(
    `SELECT * FROM public.payment_wallets
     WHERE tenant_id = $1::uuid
       AND provider = 'moov'
       AND environment = $2
       AND wallet_type = 'operating'
       AND ($3::text IS NULL OR provider_account_id = $3)
     ORDER BY last_synced_at DESC NULLS LAST
     LIMIT 1`,
    [tenantId, PRODUCTION_MOOV_ENVIRONMENT, providerAccountId || null],
  )).rows[0] || null;
};

export const loadProductionRecipient = async (client, { tenantId, recipientId } = {}) => {
  if (!tenantId || !recipientId) return null;
  return (await client.query(
    `SELECT * FROM public.external_payment_recipients
     WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [recipientId, tenantId],
  )).rows[0] || null;
};

export const assertProductionMethod = (method, { tenantId, label = 'payout method' } = {}) => {
  if (!method) {
    return {
      ok: false,
      error: 'production_method_missing',
      statusCode: 409,
      message: `No connected production Moov ${label} is available.`,
    };
  }
  if (String(method.environment || '') !== PRODUCTION_MOOV_ENVIRONMENT) {
    return {
      ok: false,
      error: 'sandbox_method_refused',
      statusCode: 409,
      message: 'Sandbox payment methods cannot be used for production execution.',
    };
  }
  if (tenantId && method.tenant_id && String(method.tenant_id) !== String(tenantId)) {
    return {
      ok: false,
      error: 'cross_tenant_denied',
      statusCode: 403,
      message: 'Payment method is not owned by the disbursement tenant.',
    };
  }
  if (method.connection_status && method.connection_status !== 'connected') {
    return {
      ok: false,
      error: 'production_method_missing',
      statusCode: 409,
      message: `The production ${label} is not connected.`,
    };
  }
  const providerMethodId = method.provider_payment_method_id || null;
  if (!providerMethodId) {
    return {
      ok: false,
      error: 'production_method_missing',
      statusCode: 409,
      message: `The production ${label} has no Moov payment-method id.`,
    };
  }
  return { ok: true, method, providerMethodId };
};
