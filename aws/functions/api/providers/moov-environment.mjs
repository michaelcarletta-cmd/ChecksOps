/**
 * Server-authoritative tenant Moov environment.
 * Browser may display the value. Browser never selects credentials or objects.
 */
import {
  APPROVED_MOOV_ACCOUNT_IDS,
  isKnownApprovedMoovAccount,
  KNOWN_APPROVED_MOOV,
} from './production/moov-accounts.mjs';

export const MOOV_ENVIRONMENTS = Object.freeze(['sandbox', 'production']);

export const MOOV_ENVIRONMENT_CHANGE_WARNING =
  'Changing Moov environment changes which provider account, wallet, banks, recipients, transfers, and credentials this tenant uses. No money or provider objects are migrated between environments.';

export const SANDBOX_SETUP_REQUIRED = 'Sandbox Moov setup required';
export const PRODUCTION_SETUP_REQUIRED = 'Production Moov setup required';

export const KNOWN_PRODUCTION_OBJECT_IDS = Object.freeze(new Set([
  KNOWN_APPROVED_MOOV.freedom.moovAccountId,
  KNOWN_APPROVED_MOOV.freedom.walletId,
  KNOWN_APPROVED_MOOV.freedom.bankId,
  KNOWN_APPROVED_MOOV.freedom.achDebitFundPm,
  KNOWN_APPROVED_MOOV.freedom.walletPm,
  KNOWN_APPROVED_MOOV.freedom.achCreditStandardPm,
  KNOWN_APPROVED_MOOV.c1c.moovAccountId,
  KNOWN_APPROVED_MOOV.platform.moovAccountId,
  KNOWN_APPROVED_MOOV.recipient.moovAccountId,
  KNOWN_APPROVED_MOOV.recipient.bankId,
  KNOWN_APPROVED_MOOV.recipient.achCreditStandardPm,
  KNOWN_APPROVED_MOOV.recipient.walletPm,
  KNOWN_APPROVED_MOOV.recipient.recipientId,
].map((id) => String(id).toLowerCase())));

export const isKnownProductionMoovObject = (id) =>
  KNOWN_PRODUCTION_OBJECT_IDS.has(String(id || '').trim().toLowerCase());

export const normalizeMoovEnvironment = (value) => {
  const env = String(value || '').trim().toLowerCase();
  return env === 'production' || env === 'sandbox' ? env : null;
};

export const assertMoovEnvironment = (value) => {
  const env = normalizeMoovEnvironment(value);
  if (!env) {
    const error = new Error('moov_environment_invalid');
    error.statusCode = 400;
    error.code = 'moov_environment_invalid';
    throw error;
  }
  return env;
};

/** Tenant row is the only authority. Body/header/query environment is ignored. */
export async function loadTenantMoovEnvironment(client, tenantId) {
  if (!tenantId) {
    return { ok: false, statusCode: 400, error: 'tenant_id is required' };
  }
  const row = (await client.query(
    `SELECT id, moov_allowlisted, moov_environment
       FROM public.tenants
      WHERE id = $1::uuid`,
    [tenantId],
  )).rows[0];
  if (!row) return { ok: false, statusCode: 404, error: 'Organization not found' };
  const environment = normalizeMoovEnvironment(row.moov_environment);
  if (!environment) {
    return { ok: false, statusCode: 409, error: 'moov_environment_invalid' };
  }
  return {
    ok: true,
    tenantId: row.id,
    allowlisted: row.moov_allowlisted !== false,
    environment,
  };
}

export const ignoreClientEnvironment = (body = {}) => {
  const ignored = [];
  for (const key of ['environment', 'moov_environment', 'moovEnvironment', 'env']) {
    if (body?.[key] !== undefined && body?.[key] !== null && body?.[key] !== '') {
      ignored.push(key);
    }
  }
  return ignored;
};

const idSet = (values = []) => new Set(
  values.filter(Boolean).map((value) => String(value).trim().toLowerCase()),
);

/**
 * Hard-fail when a sandbox operation references a known production Moov object,
 * or a production operation references an object that is not the tenant's
 * production mapping.
 */
export const assertNoCrossEnvironmentObject = ({
  environment,
  accountId = null,
  walletId = null,
  bankId = null,
  paymentMethodIds = [],
  transferId = null,
} = {}) => {
  const env = assertMoovEnvironment(environment);
  const ids = [...idSet([accountId, walletId, bankId, transferId, ...paymentMethodIds])];
  const productionHits = ids.filter((id) => isKnownApprovedMoovAccount(id)
    || APPROVED_MOOV_ACCOUNT_IDS.has(id)
    || KNOWN_PRODUCTION_OBJECT_IDS.has(id));
  if (env === 'sandbox' && productionHits.length) {
    return {
      ok: false,
      statusCode: 409,
      error: 'cross_environment_object_refused',
      environment: 'sandbox',
      message: 'Sandbox operations cannot reference production Moov objects.',
    };
  }
  if (env === 'production' && accountId) {
    const account = String(accountId).trim().toLowerCase();
    if (account && !isKnownApprovedMoovAccount(account) && !KNOWN_PRODUCTION_OBJECT_IDS.has(account)) {
      return {
        ok: false,
        statusCode: 409,
        error: 'cross_environment_object_refused',
        environment: 'production',
        message: 'Production operations cannot reference sandbox Moov objects.',
      };
    }
  }
  return { ok: true, environment: env };
};

export const credentialSnapshot = ({ sandboxConfigured, productionConfigured }) => ({
  sandbox: {
    secretNames: [
      'MOOV_SANDBOX_PUBLIC_KEY',
      'MOOV_SANDBOX_SECRET_KEY',
      'MOOV_SANDBOX_PLATFORM_ACCOUNT_ID',
      'MOOV_SANDBOX_ALLOWED_ORIGIN',
      'MOOV_SANDBOX_WEBHOOK_SECRET',
    ],
    configured: sandboxConfigured === true,
  },
  production: {
    secretNames: [
      'MOOV_PUBLIC_KEY',
      'MOOV_SECRET_KEY',
      'MOOV_PLATFORM_ACCOUNT_ID',
      'MOOV_WEBHOOK_SECRET',
      'MOOV_ENVIRONMENT',
      'MOOV_ALLOWED_ORIGIN',
    ],
    secretId: 'checksops/production/providers',
    configured: productionConfigured === true,
  },
});

export async function loadTenantProviderObjects(client, tenantId, environment) {
  const env = assertMoovEnvironment(environment);
  const account = (await client.query(
    `SELECT id, tenant_id, provider, environment, provider_account_id,
            onboarding_status, verification_status, can_send_payments, can_receive_payments
       FROM public.payment_provider_accounts
      WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1`,
    [tenantId, env],
  )).rows[0] || null;

  const wallet = (await client.query(
    `SELECT id, tenant_id, provider, environment, wallet_type, provider_wallet_id,
            available_cents, pending_cents, status
       FROM public.payment_wallets
      WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1`,
    [tenantId, env],
  )).rows[0] || null;

  const banks = (await client.query(
    `SELECT id, tenant_id, environment, provider_account_id, provider_bank_account_id,
            provider_payment_method_id, bank_name, last_four, verification_status
       FROM public.payment_provider_methods
      WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2
      ORDER BY connected_at DESC NULLS LAST`,
    [tenantId, env],
  )).rows;

  const recipients = (await client.query(
    `SELECT id, tenant_id, environment, provider_account_id, display_name, onboarding_status
       FROM public.external_payment_recipients
      WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2
      ORDER BY created_at DESC NULLS LAST`,
    [tenantId, env],
  )).rows;

  const setupRequired = !account?.provider_account_id || !wallet?.provider_wallet_id;
  return {
    environment: env,
    account,
    wallet,
    banks,
    recipients,
    setup_required: setupRequired,
    setup_message: setupRequired
      ? (env === 'sandbox' ? SANDBOX_SETUP_REQUIRED : PRODUCTION_SETUP_REQUIRED)
      : null,
  };
}

export const payoutOperationScope = ({
  tenantId,
  environment,
  payoutOperationId,
  leg,
  amountCents,
}) => [
  String(tenantId || ''),
  assertMoovEnvironment(environment),
  String(payoutOperationId || ''),
  String(leg || ''),
  String(Number(amountCents) || 0),
].join(':');
