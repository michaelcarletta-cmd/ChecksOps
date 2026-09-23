/** Tranche 4 kill switches. Only the string `true` enables a flag. Default is false. */

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

export const moovTransferPostEnabled = () => isTrue(process.env.AWS_MOOV_TRANSFER_POST_ENABLED);

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
