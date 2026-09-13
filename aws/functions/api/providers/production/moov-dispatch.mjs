import { withIdentityWrite } from '../../data.mjs';
import { isProviderNetworkError, providerEgressFailure } from '../../sandbox-credentials.mjs';
import { denyAmbiguousMoovMode, PRODUCTION_MOOV_FUNCTIONS, productionMoovAmbiguousMode, productionMoovExecutionAllowed } from './moov-holds.mjs';
import { bindMoovProductionGucs } from './moov-idempotency.mjs';
import { handleProductionMoovInitiateWalletFunding, handleProductionMoovWalletDisburse } from './moov-wallet-disburse.mjs';
import { handleProductionMoovWalletFund } from './moov-wallet-fund.mjs';

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
          productionExecution: true,
          kycRequested: false,
          capabilitiesPosted: false,
        };
      }
      throw error;
    }
  }, deps)
);

const HANDLERS = {
  'moov-wallet-fund': wrap(handleProductionMoovWalletFund),
  'moov-disburse': wrap(handleProductionMoovWalletDisburse),
  'initiate-wallet-funding': wrap(handleProductionMoovInitiateWalletFunding),
};

export const runProductionMoovHandler = (name, event, deps = {}) => {
  if (productionMoovAmbiguousMode()) return denyAmbiguousMoovMode(name);
  if (!productionMoovExecutionAllowed()) return null;
  const handler = HANDLERS[name];
  if (!handler) return null;
  return handler(event, deps);
};
