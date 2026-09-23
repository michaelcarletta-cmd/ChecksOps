import { financialPermissionsActivated } from '../../financial-flags.mjs';
import {
  executionAllowed,
  moovTransferPostEnabled,
  providerEnabled,
  providerExecutionEnabled,
} from '../../provider-flags.mjs';
import { providerSandboxExecutionEnabled } from '../../sandbox-flags.mjs';

export const PRODUCTION_MOOV_FUNCTIONS = new Set([
  'moov-transfer-create',
  'moov-disburse',
]);

export const FREEDOM_PRODUCTION_TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
export const FREEDOM_PRODUCTION_MOOV_ACCOUNT_ID = '60922058-7eca-4889-81dd-5720d7b9de96';
export const PRODUCTION_MOOV_ENVIRONMENT = 'production';

/**
 * Dedicated production Moov money movement is allowed only when every
 * financial gate is explicitly lifted AND sandbox parity is off.
 * Default: unreachable. Does not auto-fund, sweep, or replay.
 */
export const productionMoovExecutionAllowed = () => (
  executionAllowed('moov')
  && financialPermissionsActivated()
  && moovTransferPostEnabled()
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
  AWS_MOOV_TRANSFER_POST_ENABLED: moovTransferPostEnabled(),
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: providerSandboxExecutionEnabled(),
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: financialPermissionsActivated(),
  AWS_ENDORSEMENT_AUTO_ADVANCE: String(process.env.AWS_ENDORSEMENT_AUTO_ADVANCE || '') === 'true',
  productionMoovExecutionAllowed: productionMoovExecutionAllowed(),
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

export const denyMoovProductionHold = (error, extra = {}) => ({
  ok: false,
  statusCode: extra.statusCode || 403,
  error,
  provider: 'moov',
  liveProviderCalled: false,
  productionExecution: false,
  tranche4HardBlock: extra.tranche4HardBlock === true || error === 'production_execution_blocked',
  holds: moovProductionHoldSnapshot(),
  message: extra.message || 'Production Moov execution is blocked. Flags stay off until an operator authorizes a specific transfer.',
  ...extra,
});
