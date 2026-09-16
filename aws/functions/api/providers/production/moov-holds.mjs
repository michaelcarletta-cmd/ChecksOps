import { financialPermissionsActivated } from '../../financial-flags.mjs';
import {
  executionAllowed,
  moovTransferPostEnabled,
  providerEnabled,
  providerExecutionEnabled,
  providerLiveReadsEnabled,
  providerWebhookDryRun,
} from '../../provider-flags.mjs';
import { providerSandboxExecutionEnabled } from '../../sandbox-flags.mjs';

const isTrue = (value) => String(value || '') === 'true';

export const PRODUCTION_MOOV_FUNCTIONS = new Set([
  'moov-wallet-fund',
  'moov-wallet-fund-continue',
  'moov-disburse',
  'moov-tenant-fee-charge',
  'moov-refund',
  'initiate-wallet-funding',
  'process-funded-payment',
  'wallet-fund-on-clear',
]);

/** Live GET snapshot + dark sweep config. Runs when live reads are on, even if money flags stay false. */
export const PRODUCTION_MOOV_LIVE_READ_FUNCTIONS = new Set([
  'moov-wallet-status',
  'moov-readiness',
  'moov-wallet-sync',
  'moov-sweep-config',
]);

export const FIRST_PRODUCTION_TRANSFER_CENTS = 1;

/**
 * Dark production Moov money HTTP is allowed only when every money-movement
 * hold is explicitly lifted AND sandbox parity is not also on.
 * Default: all flags false → unreachable.
 */
export const productionMoovExecutionAllowed = () => (
  executionAllowed('moov')
  && financialPermissionsActivated()
  && !providerSandboxExecutionEnabled()
);

export const productionMoovLiveReadsAllowed = () => (
  providerLiveReadsEnabled()
  && !providerSandboxExecutionEnabled()
);

/** Alias for live overlay modules that still import the M6.4 read-gate name. */
export const productionMoovReadsAllowed = productionMoovLiveReadsAllowed;

/** Transfer POST stays held until a later reviewed Test A arming. Default false. */
export const productionMoovTransferPostAllowed = () => (
  productionMoovExecutionAllowed()
  && moovTransferPostEnabled()
);

/** Live webhook apply helper. Dry-run remains the default; this phase does not cut AWS webhooks. */
export const productionWebhookApplyEnabled = () => (
  !providerWebhookDryRun()
  && executionAllowed('moov')
  && financialPermissionsActivated()
  && !providerSandboxExecutionEnabled()
);

export const productionMoovAmbiguousMode = () => (
  executionAllowed('moov')
  && financialPermissionsActivated()
  && providerSandboxExecutionEnabled()
);

export const moovProductionHoldSnapshot = () => ({
  productionExecution: false,
  AWS_PROVIDER_EXECUTION_ENABLED: providerExecutionEnabled(),
  AWS_MOOV_ENABLED: providerEnabled('moov'),
  AWS_CHECKALT_ENABLED: providerEnabled('checkalt'),
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: providerSandboxExecutionEnabled(),
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: financialPermissionsActivated(),
  AWS_PROVIDER_WEBHOOK_DRY_RUN: providerWebhookDryRun(),
  AWS_MOOV_TRANSFER_POST_ENABLED: moovTransferPostEnabled(),
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED_production: isTrue(process.env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED),
  AWS_PROVIDER_LIVE_READS_ENABLED: providerLiveReadsEnabled(),
  productionMoovLiveReadsAllowed: productionMoovLiveReadsAllowed(),
  productionMoovExecutionAllowed: productionMoovExecutionAllowed(),
  productionMoovTransferPostAllowed: productionMoovTransferPostAllowed(),
  productionWebhookApplyEnabled: productionWebhookApplyEnabled(),
  firstTransferCapCents: FIRST_PRODUCTION_TRANSFER_CENTS,
  neverReKyc: true,
  neverReRequestCapabilities: true,
  sql64: 'NOT_APPLIED',
  sql72: 'NOT_APPLIED',
});

export const denyAmbiguousMoovMode = (operation) => ({
  ok: false,
  statusCode: 409,
  error: 'ambiguous_execution_mode',
  provider: 'moov',
  operation,
  liveProviderCalled: false,
  productionExecution: false,
  message: 'Production Moov and sandbox/UAT parity cannot run together. Leave AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED false for the production path.',
});
