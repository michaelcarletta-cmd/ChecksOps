import { financialPermissionsActivated } from '../../financial-flags.mjs';
import {
  executionAllowed,
  providerEnabled,
  providerExecutionEnabled,
  providerLiveReadsEnabled,
  providerWebhookDryRun,
} from '../../provider-flags.mjs';
import { providerSandboxExecutionEnabled } from '../../sandbox-flags.mjs';

const isTrue = (value) => String(value || '') === 'true';

export const PRODUCTION_MOOV_READ_FUNCTIONS = new Set([
  'moov-readiness',
  'moov-transfer-status',
  'moov-recipient-readiness',
  'moov-wallet-activity',
  'moov-account-files',
  'moov-account-file-view',
  'moov-underwriting',
]);

export const PRODUCTION_MOOV_MONEY_FUNCTIONS = new Set([
  'moov-transfer-create',
  'moov-disburse',
  'moov-wallet-fund',
  'initiate-wallet-funding',
  'process-funded-payment',
  'moov-transfer-group-create',
  'wallet-fund-on-clear',
  'platform-treasury',
  'homeowner-deductible-pay',
  'moov-tenant-fee-charge',
  'moov-sweep-config',
]);

/** Tenant/recipient/bank/ToS/KYC mutations. Independent of money flags. Default unreachable. */
export const PRODUCTION_MOOV_ONBOARDING_WRITE_FUNCTIONS = new Set([
  'moov-account-create',
  'moov-account-onboard',
  'moov-onboarding-link',
  'moov-sync',
  'moov-tos-token',
  'moov-tos-accept',
  'moov-account-file-upload',
  'moov-bank-account-add',
  'moov-bank-link-token',
  'moov-micro-deposit-initiate',
  'moov-micro-deposit-confirm',
  'moov-plaid-bridge',
  'moov-recipient-create',
  'moov-recipient-disconnect',
]);

/** Public token flows — no Cognito. Mutations still fail-closed. */
export const PRODUCTION_MOOV_PUBLIC_RECIPIENT_FUNCTIONS = new Set([
  'moov-recipient-session',
  'moov-recipient-kyc-update',
  'moov-recipient-tos-accept',
  'moov-recipient-bank-add',
]);

export const PRODUCTION_MOOV_FUNCTIONS = new Set([
  ...PRODUCTION_MOOV_READ_FUNCTIONS,
  ...PRODUCTION_MOOV_MONEY_FUNCTIONS,
  ...PRODUCTION_MOOV_ONBOARDING_WRITE_FUNCTIONS,
  ...PRODUCTION_MOOV_PUBLIC_RECIPIENT_FUNCTIONS,
]);

/** Later neutralization gate. Default false so AWS money cannot go live while Lovable still moves money. */
export const lovableMoneyNeutralized = () => isTrue(process.env.AWS_LOVABLE_MONEY_NEUTRALIZED);

/** Dedicated onboarding-write hold. Independent of money execution. Default false. */
export const moovOnboardingWritesEnabled = () => isTrue(process.env.AWS_MOOV_ONBOARDING_WRITES_ENABLED);

/** Authoritative webhook apply. Default false (M3 dark). Distinct from dry-run receipt persist. */
export const moovWebhookApplyEnabled = () => isTrue(process.env.AWS_MOOV_WEBHOOK_APPLY_ENABLED);

/**
 * Dark production Moov HTTP is allowed only when every money-movement
 * hold is explicitly lifted AND sandbox parity is not also on
 * AND Lovable money movers have been neutralized.
 * Default: all flags false → unreachable.
 */
export const productionMoovExecutionAllowed = () => (
  executionAllowed('moov')
  && financialPermissionsActivated()
  && lovableMoneyNeutralized()
  && !providerSandboxExecutionEnabled()
);

export const productionMoovAmbiguousMode = () => (
  executionAllowed('moov')
  && financialPermissionsActivated()
  && providerSandboxExecutionEnabled()
);

export const productionMoovOnboardingWritesAllowed = () => (
  moovOnboardingWritesEnabled()
  && !providerSandboxExecutionEnabled()
  && !productionMoovAmbiguousMode()
);

/**
 * M3.1 GET-only gate. Independent of money flags.
 * Sandbox parity stays off so staging UAT never takes the production GET path.
 * Default: AWS_PROVIDER_LIVE_READS_ENABLED is false → unreachable.
 */
export const productionMoovReadsAllowed = () => (
  providerLiveReadsEnabled()
  && !providerSandboxExecutionEnabled()
);

export const moovProductionHoldSnapshot = () => ({
  productionExecution: false,
  AWS_PROVIDER_EXECUTION_ENABLED: providerExecutionEnabled(),
  AWS_MOOV_ENABLED: providerEnabled('moov'),
  AWS_CHECKALT_ENABLED: providerEnabled('checkalt'),
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: providerSandboxExecutionEnabled(),
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: financialPermissionsActivated(),
  AWS_PROVIDER_LIVE_READS_ENABLED: providerLiveReadsEnabled(),
  AWS_PROVIDER_WEBHOOK_DRY_RUN: providerWebhookDryRun(),
  AWS_MOOV_ONBOARDING_WRITES_ENABLED: moovOnboardingWritesEnabled(),
  AWS_MOOV_WEBHOOK_APPLY_ENABLED: moovWebhookApplyEnabled(),
  AWS_LOVABLE_MONEY_NEUTRALIZED: lovableMoneyNeutralized(),
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED_production: isTrue(process.env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED),
  productionMoovExecutionAllowed: productionMoovExecutionAllowed(),
  productionMoovReadsAllowed: productionMoovReadsAllowed(),
  productionMoovOnboardingWritesAllowed: productionMoovOnboardingWritesAllowed(),
  productionMoovAmbiguousMode: productionMoovAmbiguousMode(),
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
  productionRead: false,
  message: 'Production Moov and sandbox/UAT parity cannot run together. Leave AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED false for the production path.',
});

export const denyProductionMoovHolds = (operation, extra = {}) => ({
  ok: false,
  statusCode: 403,
  error: extra.error || 'production_execution_blocked',
  provider: 'moov',
  operation: operation || null,
  liveProviderCalled: false,
  productionExecution: false,
  productionRead: false,
  productionOnboardingWrite: false,
  holds: moovProductionHoldSnapshot(),
  message: extra.message || 'Production Moov holds remain on. No provider HTTP.',
  ...extra,
});

export const denyProductionOnboardingWrites = (operation, extra = {}) => (
  denyProductionMoovHolds(operation, {
    error: 'production_onboarding_blocked',
    message: extra.message || 'Production Moov onboarding writes remain dark. AWS_MOOV_ONBOARDING_WRITES_ENABLED is false. No Moov mutation.',
    ...extra,
  })
);
