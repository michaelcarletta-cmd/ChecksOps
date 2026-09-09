import { withIdentityWrite } from '../../data.mjs';
import { isProviderNetworkError, providerEgressFailure } from '../../sandbox-credentials.mjs';
import { denyAmbiguousCheckAltMode, PRODUCTION_CHECKALT_FUNCTIONS, productionCheckAltAmbiguousMode, productionCheckAltExecutionAllowed } from './checkalt-holds.mjs';
import { bindCheckAltProductionGucs } from './checkalt-idempotency.mjs';
import { handleProductionCheckAltPoll } from './checkalt-poll.mjs';
import { handleProductionCheckAltSubmit } from './checkalt-submit.mjs';

export const hasProductionCheckAltHandler = (name) => PRODUCTION_CHECKALT_FUNCTIONS.has(name);

const wrap = (handler) => async (event, deps = {}) => (
  withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    await bindCheckAltProductionGucs(client, mapping, claims);
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
          ...providerEgressFailure('checkalt'),
          spoofFieldsIgnored: spoof,
          applicationUserId: mapping.application_user_id,
          createdDeposit: false,
          productionExecution: true,
        };
      }
      throw error;
    }
  }, deps)
);

const HANDLERS = {
  'checkalt-submit-deposit': wrap(handleProductionCheckAltSubmit),
  'checkalt-poll-status': wrap(handleProductionCheckAltPoll),
};

export const runProductionCheckAltHandler = (name, event, deps = {}) => {
  if (productionCheckAltAmbiguousMode()) return denyAmbiguousCheckAltMode(name);
  if (!productionCheckAltExecutionAllowed()) return null;
  const handler = HANDLERS[name];
  if (!handler) return null;
  return handler(event, deps);
};
