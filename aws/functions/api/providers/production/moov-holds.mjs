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
]);

export const PRODUCTION_MOOV_MONEY_FUNCTIONS = new Set([
  'moov-transfer-create',
  'moov-disburse',
]);

export const PRODUCTION_MOOV_FUNCTIONS = new Set([
  ...PRODUCTION_MOOV_READ_FUNCTIONS,
  ...PRODUCTION_MOOV_MONEY_FUNCTIONS,
]);

/**
 * Dark production Moov HTTP is allowed only when every money-movement
 * hold is explicitly lifted AND sandbox parity is not also on.
 * Default: all flags false → unreachable.
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
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED_production: isTrue(process.env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED),
  productionMoovExecutionAllowed: productionMoovExecutionAllowed(),
  productionMoovReadsAllowed: productionMoovReadsAllowed(),
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
  holds: moovProductionHoldSnapshot(),
  message: extra.message || 'Production Moov holds remain on. No provider HTTP.',
  ...extra,
});
