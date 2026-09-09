import { withIdentityWrite } from '../../data.mjs';
import { isProviderNetworkError, providerEgressFailure } from '../../sandbox-credentials.mjs';
import {
  denyAmbiguousMoovMode,
  PRODUCTION_MOOV_FUNCTIONS,
  productionMoovAmbiguousMode,
  productionMoovExecutionAllowed,
} from './moov-holds.mjs';
import { bindMoovProductionGucs } from './moov-idempotency.mjs';
import { handleProductionMoovReadiness, handleProductionMoovTransferStatus } from './moov-read.mjs';
import { handleProductionMoovDisburse, handleProductionMoovTransferCreate } from './moov-transfer.mjs';

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
          liveProviderCalled: true,
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
  'moov-transfer-status': wrap(handleProductionMoovTransferStatus),
  'moov-readiness': wrap(handleProductionMoovReadiness),
};

export const runProductionMoovHandler = (name, event, deps = {}) => {
  if (productionMoovAmbiguousMode()) return denyAmbiguousMoovMode(name);
  if (!productionMoovExecutionAllowed()) return null;
  const handler = HANDLERS[name];
  if (!handler) return null;
  return handler(event, deps);
};
