import { financialPermissionsActivated } from '../../financial-flags.mjs';
import { executionAllowed, providerEnabled, providerExecutionEnabled } from '../../provider-flags.mjs';
import { providerSandboxExecutionEnabled } from '../../sandbox-flags.mjs';

const isTrue = (value) => String(value || '') === 'true';

export const PRODUCTION_CHECKALT_FUNCTIONS = new Set([
  'checkalt-submit-deposit',
  'checkalt-poll-status',
]);

/**
 * Dark production CheckAlt HTTP is allowed only when every money-movement
 * hold is explicitly lifted AND sandbox parity is not also on.
 * Default: all flags false → unreachable.
 */
export const productionCheckAltExecutionAllowed = () => (
  executionAllowed('checkalt')
  && financialPermissionsActivated()
  && !providerSandboxExecutionEnabled()
);

export const productionCheckAltAmbiguousMode = () => (
  executionAllowed('checkalt')
  && financialPermissionsActivated()
  && providerSandboxExecutionEnabled()
);

export const checkAltProductionHoldSnapshot = () => ({
  productionExecution: false,
  AWS_PROVIDER_EXECUTION_ENABLED: providerExecutionEnabled(),
  AWS_CHECKALT_ENABLED: providerEnabled('checkalt'),
  AWS_MOOV_ENABLED: providerEnabled('moov'),
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: providerSandboxExecutionEnabled(),
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: financialPermissionsActivated(),
  AWS_PROVIDER_WEBHOOK_DRY_RUN: process.env.AWS_PROVIDER_WEBHOOK_DRY_RUN === undefined
    || process.env.AWS_PROVIDER_WEBHOOK_DRY_RUN === ''
    || String(process.env.AWS_PROVIDER_WEBHOOK_DRY_RUN) !== 'false',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED_production: isTrue(process.env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED),
  productionCheckAltExecutionAllowed: productionCheckAltExecutionAllowed(),
  sql64: 'NOT_APPLIED',
  sql65: 'COLUMNS_PRESENT',
});

export const denyAmbiguousCheckAltMode = (operation) => ({
  ok: false,
  statusCode: 409,
  error: 'ambiguous_execution_mode',
  provider: 'checkalt',
  operation,
  liveProviderCalled: false,
  productionExecution: false,
  message: 'Production CheckAlt and sandbox/UAT parity cannot run together. Leave AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED false for the production path.',
});
