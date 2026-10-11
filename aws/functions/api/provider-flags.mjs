/**
 * Tranche 4 kill switches. Only the string `true` enables a flag. Default is false.
 *
 * AWS_MOOV_ENABLED is NOT a tenant allowlist and is NOT the real-money hold.
 *
 * Proven meaning on the current AWS implementation:
 * - Staging: leftover cutover/safety leftover. Sandbox onboarding uses
 *   AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED while this flag stays false.
 *   Turning it on with AWS_PROVIDER_EXECUTION_ENABLED still hits
 *   production_execution_blocked on staging.
 * - Production (CHECKSOPS_ENV starts with production): this is the Moov
 *   global availability / onboarding gate. Combined with
 *   AWS_PROVIDER_EXECUTION_ENABLED it becomes executionAllowed('moov')
 *   and allows KYB/ToS/bank/wallet onboarding handlers.
 * - Real-money movement stays held by AWS_MOOV_TRANSFER_POST_ENABLED,
 *   plus identity/KYB, ToS, bank, wallet, and capability checks.
 *
 * Tenant availability is not gated by moov_allowlisted. Flip production
 * AWS_MOOV_ENABLED only to make Moov onboarding generally available.
 * Do not flip AWS_MOOV_TRANSFER_POST_ENABLED for GA.
 */

const isTrue = (value) => String(value || '') === 'true';

export const PROVIDER_FLAG_ENV = {
  moov: 'AWS_MOOV_ENABLED',
  checkalt: 'AWS_CHECKALT_ENABLED',
  plaid: 'AWS_PLAID_ENABLED',
  actum: 'AWS_ACTUM_ENABLED',
  quickbooks: 'AWS_QUICKBOOKS_ENABLED',
};

export const providerExecutionEnabled = () => isTrue(process.env.AWS_PROVIDER_EXECUTION_ENABLED);

export const providerEnabled = (provider) => {
  const envName = PROVIDER_FLAG_ENV[provider];
  if (!envName) return false;
  return isTrue(process.env[envName]);
};

/** Live HTTP GET/POST to a provider API. Independent of execution. Default false. */
export const providerLiveReadsEnabled = () => isTrue(process.env.AWS_PROVIDER_LIVE_READS_ENABLED);

/**
 * Staging default is dry-run (unset or any value other than `false`).
 * Dry-run verifies signatures and records receipts. It never applies payment mutations.
 */
export const providerWebhookDryRun = () => {
  const value = process.env.AWS_PROVIDER_WEBHOOK_DRY_RUN;
  if (value === undefined || value === '') return true;
  return String(value) !== 'false';
};

export const executionAllowed = (provider) => providerExecutionEnabled() && providerEnabled(provider);

export const denyProviderExecution = (provider, operation, extra = {}) => ({
  ok: false,
  statusCode: 403,
  error: 'provider_disabled',
  provider: provider || null,
  operation: operation || null,
  masterEnabled: providerExecutionEnabled(),
  providerEnabled: provider ? providerEnabled(provider) : false,
  liveReadsEnabled: providerLiveReadsEnabled(),
  message: 'Provider execution is disabled on AWS staging. No money movement, deposits, or live provider mutations.',
  ...extra,
});

export const isProductionChecksOpsRuntime = () => (
  String(process.env.CHECKSOPS_ENV || '').toLowerCase().startsWith('production')
);

/** Live unused-until-now money-movement hold already present on production Lambda. */
export const moovTransferPostEnabled = () => isTrue(process.env.AWS_MOOV_TRANSFER_POST_ENABLED);

export const flagSnapshot = () => ({
  AWS_PROVIDER_EXECUTION_ENABLED: providerExecutionEnabled(),
  AWS_MOOV_ENABLED: providerEnabled('moov'),
  AWS_CHECKALT_ENABLED: providerEnabled('checkalt'),
  AWS_PLAID_ENABLED: providerEnabled('plaid'),
  AWS_ACTUM_ENABLED: providerEnabled('actum'),
  AWS_QUICKBOOKS_ENABLED: providerEnabled('quickbooks'),
  AWS_PROVIDER_LIVE_READS_ENABLED: providerLiveReadsEnabled(),
  AWS_PROVIDER_WEBHOOK_DRY_RUN: providerWebhookDryRun(),
  AWS_MOOV_TRANSFER_POST_ENABLED: moovTransferPostEnabled(),
});
