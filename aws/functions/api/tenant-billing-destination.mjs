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
 *   account  41cb5d67-4911-4bef-aad5-d8ee9c582208
 *   wallet   c70a90f2-9bcc-4084-8263-d5a0fb5d806c
 * Do not write those to production env until operator approval. Production
 * charges fail closed until both destination IDs are set explicitly.
 */

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

export const billingEnvironment = () => {
  const raw = String(process.env.CHECKSOPS_ENV || '').toLowerCase();
  if (raw.startsWith('production')) return 'production';
  return 'sandbox';
};

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

  const { isProductionChecksOpsRuntime } = await import('./provider-flags.mjs');
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
