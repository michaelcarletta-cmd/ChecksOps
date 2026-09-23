import { withIdentityWrite } from '../../data.mjs';
import { isProviderNetworkError, providerEgressFailure } from '../../sandbox-credentials.mjs';
import {
  PRODUCTION_MOOV_FUNCTIONS,
  denyAmbiguousMoovMode,
  denyMoovProductionHold,
  productionMoovAmbiguousMode,
  productionMoovExecutionAllowed,
} from './moov-holds.mjs';
import { bindMoovProductionGucs } from './moov-idempotency.mjs';
import {
  handleProductionMoovDisburse,
  handleProductionMoovTransferCreate,
} from './moov-submit.mjs';
import { executionAllowed } from '../../provider-flags.mjs';
import { providerSandboxExecutionEnabled } from '../../sandbox-flags.mjs';

export const hasProductionMoovHandler = (name) => PRODUCTION_MOOV_FUNCTIONS.has(name);

const wrap = (handler) => async (event, deps = {}) => (
  withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    await bindMoovProductionGucs(client, mapping, claims);
    try {
      return await handler({
        client,
        mapping,
        claims,
        body,
        spoof,
        fetchImpl: deps.fetchImpl || fetch,
        deps,
      });
    } catch (error) {
      if (isProviderNetworkError(error)) {
        return {
          ...providerEgressFailure('moov'),
          spoofFieldsIgnored: spoof,
          applicationUserId: mapping.application_user_id,
          createdTransfer: false,
          productionExecution: true,
        };
      }
      throw error;
    }
  }, deps)
);

const HANDLERS = {
  'moov-transfer-create': wrap(handleProductionMoovTransferCreate),
  'moov-disburse': wrap(handleProductionMoovDisburse),
};

/**
 * Dedicated production Moov money path.
 * Sandbox parity remains reachable only when production Moov execution is off.
 * Returning a deny object (never null) when production flags are on prevents
 * the sandbox-parity handler from executing production money movement.
 */
export const runProductionMoovHandler = (name, event, deps = {}) => {
  const handler = HANDLERS[name];
  if (!handler) return null;
  if (productionMoovAmbiguousMode()) return denyAmbiguousMoovMode(name);
  if (providerSandboxExecutionEnabled() && !executionAllowed('moov')) return null;
  if (!executionAllowed('moov')) return null;
  if (!productionMoovExecutionAllowed()) {
    return denyMoovProductionHold('production_execution_blocked', {
      tranche4HardBlock: true,
      operation: name,
      message: 'Production Moov execution flags remain off. No transfer was created.',
    });
  }
  return handler(event, deps);
};
