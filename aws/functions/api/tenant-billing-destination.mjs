/**
 * Explicit ChecksOps merchant destination for monthly tenant subscription billing.
 * Never selects "first facilitator wallet" at charge time.
 *
 * Known sandbox merchant (MOOV_SANDBOX_PLATFORM_ACCOUNT_ID in staging and
 * production provider secrets): 36b79957-ce7a-4ca7-a68f-30986c9e47bb
 *
 * Production MOOV_ACCOUNT_ID / MOOV_PLATFORM_ACCOUNT_ID are absent from AWS
 * provider secrets. The existing approved production ChecksOps merchant was
 * identified read-only from tenant wallet partnerAccountID values:
 *   account  41cb5d67-4911-4bef-aad5-d8ee9c582208 (owner-confirmed 2026-10-17
 *            as the platform Moov wallet account fees land in)
 *   wallet   c70a90f2-9bcc-4084-8263-d5a0fb5d806c (payment method; not part
 *            of the owner's answer)
 * Production charges fail closed until both destination IDs are set
 * explicitly (env or platform_billing_destination).
 *
 * Owner question (a), answered: the platform Moov wallet. The one answer
 * lives in tenant-collection-v2.mjs PRODUCTION_FEE_DESTINATION.
 */

import { IDENTITY_ENV_PRODUCTION, identityEnvFromChecksopsEnv } from './identity-env.mjs';
import { PRODUCTION_FEE_DESTINATION, assertExplicitDestination } from './tenant-collection-v2.mjs';

/**
 * True only on the ChecksOps production API runtime: CHECKSOPS_ENV is
 * `production` or `production-prep` (trimmed, any case). The same test as
 * identity-env.mjs identityEnvFromChecksopsEnv, email-branding.mjs and
 * homeowner.mjs isProductionChecksopsEnv. Staging, unset and unknown values
 * are not production. Lives here, its only user, so the locked
 * provider-flags.mjs stays unchanged; identity-env.mjs already exports both
 * names in the live production bundle.
 */
export const isProductionChecksOpsRuntime = (env = process.env.CHECKSOPS_ENV) => (
  identityEnvFromChecksopsEnv(env) === IDENTITY_ENV_PRODUCTION
);

export const CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';

const isTrue = (value) => String(value || '') === 'true';

export const monthlyBillingEnabled = () => isTrue(process.env.AWS_MOOV_MONTHLY_BILLING_ENABLED);

export const monthlyBillingProductionPostEnabled = () => (
  isTrue(process.env.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST)
);

/** Isolated $1 billing-verification POST. Independent of monthly PRODUCTION_POST. Default false. */
export const billingVerificationPostEnabled = () => (
  isTrue(process.env.AWS_MOOV_BILLING_VERIFICATION_POST_ENABLED)
);

/** Production only on the production API runtime (isProductionChecksOpsRuntime above). */
export const billingEnvironment = () => (isProductionChecksOpsRuntime() ? 'production' : 'sandbox');

export const billingShouldSimulate = (deps = {}) => {
  if (deps.simulate === true) return true;
  if (deps.simulate === false) return false;
  if (isTrue(process.env.AWS_MOOV_MONTHLY_BILLING_SIMULATE)) return true;
  if (billingEnvironment() === 'production') return !monthlyBillingProductionPostEnabled();
  return !isTrue(process.env.AWS_MOOV_SANDBOX_TRANSFER_POST_ENABLED);
};

/** Simulate unless the isolated verification gate is explicitly true. Does not read monthly POST. */
export const billingVerificationShouldSimulate = (deps = {}) => {
  if (deps.simulate === true) return true;
  if (deps.simulate === false) return false;
  if (isTrue(process.env.AWS_MOOV_BILLING_VERIFICATION_SIMULATE)) return true;
  return !billingVerificationPostEnabled();
};

const failClosed = (reason, extra = {}) => ({
  ok: false,
  error: 'billing_destination_unresolved',
  reason,
  ...extra,
});

export async function resolveBillingDestination(client, { environment, deps = {} } = {}) {
  const env = environment || billingEnvironment();
  if (deps.destination) {
    const dest = normalizeDest(deps.destination, env);
    return dest.ok ? dest : dest;
  }

  const envAccount = String(process.env.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID || '').trim();
  const envMethod = String(process.env.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID || '').trim();
  if (envAccount && envMethod) {
    return normalizeDest({
      moov_account_id: envAccount,
      moov_payment_method_id: envMethod,
      source: 'env',
    }, env);
  }

  if (client) {
    const row = (await client.query(
      `SELECT environment, moov_account_id, moov_payment_method_id, label, verified_at
       FROM public.platform_billing_destination
       WHERE environment = $1
       LIMIT 1`,
      [env],
    ).catch(() => ({ rows: [] }))).rows[0];
    if (row?.moov_account_id && row?.moov_payment_method_id) {
      return normalizeDest({
        moov_account_id: row.moov_account_id,
        moov_payment_method_id: row.moov_payment_method_id,
        label: row.label,
        verified_at: row.verified_at,
        source: 'table',
      }, env);
    }
  }

  return failClosed('destination_not_configured', {
    environment: env,
    message: 'ChecksOps merchant destination is not configured. Set AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID and AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID, or persist platform_billing_destination.',
  });
}

/**
 * Bind the same credential object shape the accepted Moov parity path uses
 * (`caller.mjs` moovParityContext), without changing shared provider architecture.
 * Production never falls back to sandbox keys. Missing required keys fail closed
 * before any provider HTTP.
 */
export async function resolveBillingMoovContext({ environment, deps = {} } = {}) {
  const env = String(environment || billingEnvironment()).toLowerCase();
  if (env !== 'production' && env !== 'sandbox') {
    return { ok: false, error: 'invalid_billing_moov_environment', environment: env };
  }

  const { loadSandboxCredentials } = await import('./sandbox-credentials.mjs');
  const loader = typeof deps.loadSandboxCredentials === 'function'
    ? deps.loadSandboxCredentials
    : loadSandboxCredentials;
  const loaded = await loader();
  const secrets = loaded.secrets || {};

  if (env === 'production') {
    if (!isProductionChecksOpsRuntime()) {
      return {
        ok: false,
        error: 'production_credentials_refused',
        message: 'Production Moov keys are not used on AWS staging.',
      };
    }
    if (!secrets.MOOV_PUBLIC_KEY || !secrets.MOOV_SECRET_KEY) {
      return {
        ok: false,
        error: 'production_credentials_unavailable',
        message: 'Production payment credentials are not configured.',
      };
    }
  } else if (!loaded.moov?.publicKey || !loaded.moov?.secretKey) {
    return {
      ok: false,
      error: 'sandbox_credentials_unavailable',
      message: 'Sandbox payment credentials are not configured for this test organization.',
    };
  }

  return {
    ok: true,
    environment: env,
    moovContext: {
      environment: env,
      sandboxPublicKey: env === 'sandbox' ? (loaded.moov?.publicKey || null) : null,
      sandboxSecretKey: env === 'sandbox' ? (loaded.moov?.secretKey || null) : null,
      sandboxPlatformAccountId: env === 'sandbox' ? (loaded.moov?.platformAccountId || null) : null,
      sandboxOrigin: loaded.moov?.origin || secrets.MOOV_SANDBOX_ALLOWED_ORIGIN || 'https://checksops.com',
      apiVersion: loaded.moov?.apiVersion || secrets.MOOV_SANDBOX_API_VERSION || 'v2024.01.00',
      productionPublicKey: env === 'production' ? (secrets.MOOV_PUBLIC_KEY || null) : null,
      productionSecretKey: env === 'production' ? (secrets.MOOV_SECRET_KEY || null) : null,
      productionPlatformAccountId: env === 'production' ? (secrets.MOOV_ACCOUNT_ID || null) : null,
    },
  };
}

const DEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Platform-owner view of the fee destination for this runtime's billing
 * environment: where it comes from (env or platform_billing_destination) and
 * whether it is usable. Never reads a tenant account.
 */
export async function billingDestinationStatus(client, { environment, deps = {} } = {}) {
  const env = environment || billingEnvironment();
  const resolved = await resolveBillingDestination(client, { environment: env, deps });
  const envOverride = Boolean(
    String(process.env.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID || '').trim()
    && String(process.env.AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID || '').trim(),
  );
  return {
    environment: env,
    configured: resolved.ok === true,
    source: resolved.ok ? resolved.source : null,
    env_override: envOverride,
    account_id: resolved.ok ? resolved.accountId : null,
    payment_method_id: resolved.ok ? resolved.paymentMethodId : null,
    label: resolved.ok ? resolved.label : null,
    verified_at: resolved.ok ? resolved.verifiedAt : null,
    error: resolved.ok ? null : resolved.error,
    reason: resolved.ok ? null : resolved.reason,
    expected_sandbox_account_id: env === 'sandbox' ? CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID : null,
    // Owner question (a): the production pin's kind and what the owner confirmed.
    production_destination_kind: env === 'production' ? PRODUCTION_FEE_DESTINATION.kind : null,
    production_destination_owner_confirmed: env === 'production' ? PRODUCTION_FEE_DESTINATION.ownerConfirmed : null,
    production_destination_payment_method_owner_confirmed: env === 'production'
      ? PRODUCTION_FEE_DESTINATION.paymentMethodOwnerConfirmed
      : null,
  };
}

/**
 * Platform owner sets the ChecksOps fee destination (platform_billing_destination,
 * one row per environment). The caller checks is_platform_owner() first; RLS
 * (SQL 43 / SQL 98) refuses everyone else in the database too. The same pins as
 * charging apply: sandbox = the ChecksOps sandbox merchant, production = the
 * ChecksOps platform account and wallet payment method. A tenant account is
 * never accepted.
 */
export async function setBillingDestination(client, {
  environment, accountId, paymentMethodId, label,
} = {}) {
  const env = environment || billingEnvironment();
  const account = String(accountId || '').trim();
  const method = String(paymentMethodId || '').trim();
  if (!DEST_ID_RE.test(account)) return { ok: false, statusCode: 400, error: 'invalid_destination_account_id' };
  if (!DEST_ID_RE.test(method)) return { ok: false, statusCode: 400, error: 'invalid_destination_payment_method_id' };
  const checked = normalizeDest({ moov_account_id: account, moov_payment_method_id: method }, env);
  if (!checked.ok) return { ...checked, ok: false, statusCode: 400 };
  const tenantOwned = (await client.query(
    `SELECT 1 FROM public.payment_provider_accounts
     WHERE provider_account_id = $1
     LIMIT 1`,
    [account],
  ).catch(() => ({ rows: [] }))).rows[0];
  if (tenantOwned) {
    return { ok: false, statusCode: 400, error: 'destination_is_tenant_account', message: 'Fees must land in the ChecksOps platform account, never a tenant account.' };
  }
  const cleanLabel = String(label || 'ChecksOps platform account').trim().slice(0, 80) || 'ChecksOps platform account';
  const row = (await client.query(
    `INSERT INTO public.platform_billing_destination (environment, moov_account_id, moov_payment_method_id, label)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (environment) DO UPDATE SET
       moov_account_id = EXCLUDED.moov_account_id,
       moov_payment_method_id = EXCLUDED.moov_payment_method_id,
       label = EXCLUDED.label,
       verified_at = NULL,
       updated_at = now()
     RETURNING environment, moov_account_id, moov_payment_method_id, label, verified_at`,
    [env, account, method, cleanLabel],
  )).rows[0];
  return { ok: true, statusCode: 200, destination: row };
}

export function normalizeDest(row, environment) {
  const accountId = String(row.moov_account_id || row.accountId || '').trim();
  const methodId = String(row.moov_payment_method_id || row.paymentMethodId || '').trim();
  if (!accountId || !methodId) {
    return failClosed('destination_ids_required', { environment });
  }
  if (environment === 'sandbox' && accountId !== CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID) {
    return failClosed('sandbox_destination_must_be_checksops_merchant', {
      environment,
      expectedAccountId: CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID,
    });
  }
  if (environment === 'production' && accountId === CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID) {
    return failClosed('production_destination_cannot_be_sandbox_merchant', { environment });
  }
  // Production fees land only in PRODUCTION_FEE_DESTINATION (owner question
  // (a)), the same pin collection (tenant-collection-v2) accepts.
  if (environment === 'production') {
    const pinned = assertExplicitDestination({ accountId, paymentMethodId: methodId }, environment);
    if (!pinned.ok) return failClosed(pinned.errors[0], { environment, errors: pinned.errors });
  }
  return {
    ok: true,
    environment,
    accountId,
    paymentMethodId: methodId,
    label: row.label || 'ChecksOps merchant',
    source: row.source || 'explicit',
    verifiedAt: row.verified_at || row.verifiedAt || null,
  };
}
