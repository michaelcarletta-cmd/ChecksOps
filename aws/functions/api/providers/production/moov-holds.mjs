import { financialPermissionsActivated } from '../../financial-flags.mjs';
import { executionAllowed, providerEnabled, providerExecutionEnabled } from '../../provider-flags.mjs';
import { providerSandboxExecutionEnabled } from '../../sandbox-flags.mjs';
import { providerWebhookDryRun } from '../../provider-flags.mjs';

/**
 * Money-path Moov functions that production AWS must own.
 * Onboarding/KYC/bank-link stay on the sandbox parity path unless separately activated.
 */
export const PRODUCTION_MOOV_FUNCTIONS = new Set([
  'moov-wallet-fund',
  'initiate-wallet-funding',
  'cancel-wallet-funding',
  'calculate-payment-funding',
  'moov-wallet-sync',
  'moov-transfer-create',
  'moov-transfer-group-create',
  'moov-transfer-status',
  'moov-disburse',
  'process-funded-payment',
]);

/**
 * Production Moov HTTP is allowed only when every money-movement hold is
 * explicitly lifted AND sandbox parity is not also on.
 */
export const productionMoovExecutionAllowed = () => (
  executionAllowed('moov')
  && financialPermissionsActivated()
  && !providerSandboxExecutionEnabled()
);

export const productionMoovAmbiguousMode = () => (
  executionAllowed('moov')
  && financialPermissionsActivated()
  && providerSandboxExecutionEnabled()
);

export const productionWebhookApplyEnabled = () => (
  !providerWebhookDryRun()
  && executionAllowed('moov')
  && financialPermissionsActivated()
  && !providerSandboxExecutionEnabled()
);

export const moovProductionHoldSnapshot = () => ({
  productionExecution: productionMoovExecutionAllowed(),
  AWS_PROVIDER_EXECUTION_ENABLED: providerExecutionEnabled(),
  AWS_MOOV_ENABLED: providerEnabled('moov'),
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: providerSandboxExecutionEnabled(),
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: financialPermissionsActivated(),
  AWS_PROVIDER_WEBHOOK_DRY_RUN: providerWebhookDryRun(),
  productionMoovExecutionAllowed: productionMoovExecutionAllowed(),
  productionWebhookApplyEnabled: productionWebhookApplyEnabled(),
});

export const denyAmbiguousMoovMode = (operation) => ({
  ok: false,
  statusCode: 409,
  error: 'ambiguous_execution_mode',
  provider: 'moov',
  operation,
  liveProviderCalled: false,
  productionExecution: false,
  message: 'Production Moov and sandbox parity cannot run together. Leave AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED false for the production path.',
});
