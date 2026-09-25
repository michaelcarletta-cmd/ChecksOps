/**
 * Explicit ChecksOps merchant destination for monthly tenant subscription billing.
 * Never selects "first facilitator wallet" at charge time.
 *
 * Known sandbox merchant (MOOV_SANDBOX_PLATFORM_ACCOUNT_ID in staging and
 * production provider secrets): 36b79957-ce7a-4ca7-a68f-30986c9e47bb
 *
 * Production MOOV_ACCOUNT_ID is not present in AWS provider secrets. Production
 * charges fail closed until AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID and
 * AWS_MOOV_BILLING_DESTINATION_PAYMENT_METHOD_ID are set to the approved
 * ChecksOps production merchant (not the sandbox id).
 */

export const CHECKSOPS_SANDBOX_MERCHANT_ACCOUNT_ID = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';

const isTrue = (value) => String(value || '') === 'true';

export const monthlyBillingEnabled = () => isTrue(process.env.AWS_MOOV_MONTHLY_BILLING_ENABLED);

export const monthlyBillingProductionPostEnabled = () => (
  isTrue(process.env.AWS_MOOV_MONTHLY_BILLING_PRODUCTION_POST)
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
