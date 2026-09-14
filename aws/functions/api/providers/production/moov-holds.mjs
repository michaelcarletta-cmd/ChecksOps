import { financialPermissionsActivated } from '../../financial-flags.mjs';
import { executionAllowed, providerEnabled, providerExecutionEnabled } from '../../provider-flags.mjs';
import { providerSandboxExecutionEnabled } from '../../sandbox-flags.mjs';

const isTrue = (value) => String(value || '') === 'true';

export const PRODUCTION_MOOV_FUNCTIONS = new Set([
  'moov-wallet-fund',
  'moov-disburse',
  'moov-tenant-fee-charge',
  'initiate-wallet-funding',
  'process-funded-payment',
  'wallet-fund-on-clear',
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
  AWS_PROVIDER_WEBHOOK_DRY_RUN: process.env.AWS_PROVIDER_WEBHOOK_DRY_RUN === undefined
    || process.env.AWS_PROVIDER_WEBHOOK_DRY_RUN === ''
    || String(process.env.AWS_PROVIDER_WEBHOOK_DRY_RUN) !== 'false',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED_production: isTrue(process.env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED),
  productionMoovExecutionAllowed: productionMoovExecutionAllowed(),
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
