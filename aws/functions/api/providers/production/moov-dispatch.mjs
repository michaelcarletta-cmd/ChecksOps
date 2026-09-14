import { withIdentity, withIdentityWrite } from '../../data.mjs';
import { isProviderNetworkError, providerEgressFailure } from '../../sandbox-credentials.mjs';
import {
  denyAmbiguousMoovMode,
  PRODUCTION_MOOV_FUNCTIONS,
  PRODUCTION_MOOV_LIVE_READ_FUNCTIONS,
  productionMoovAmbiguousMode,
  productionMoovExecutionAllowed,
  productionMoovLiveReadsAllowed,
} from './moov-holds.mjs';
import { bindMoovProductionGucs } from './moov-idempotency.mjs';
import { handleProductionMoovTenantFeeCharge } from './moov-fee-collect.mjs';
import { handleProductionMoovRefund } from './moov-refund.mjs';
import { handleProductionMoovInitiateWalletFunding, handleProductionMoovProcessFundedPayment, handleProductionMoovWalletDisburse, handleProductionMoovWalletFundOnClear } from './moov-wallet-disburse.mjs';
import { handleProductionMoovWalletFund } from './moov-wallet-fund.mjs';
import {
  handleProductionMoovReadiness,
  handleProductionMoovWalletStatus,
  handleProductionMoovWalletSync,
} from './moov-live-read.mjs';
import { handleProductionMoovSweepConfig } from './moov-sweep-config.mjs';

export const hasProductionMoovHandler = (name) => PRODUCTION_MOOV_FUNCTIONS.has(name);
export const hasProductionMoovLiveReadHandler = (name) => PRODUCTION_MOOV_LIVE_READ_FUNCTIONS.has(name);

const wrapNetwork = (handler, identityFn) => async (event, deps = {}) => (
  identityFn(event, async ({ client, mapping, claims, body, spoof }) => {
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
          productionExecution: false,
          kycRequested: false,
          capabilitiesPosted: false,
        };
      }
      throw error;
    }
  }, deps)
);

const wrapWrite = (handler) => wrapNetwork(handler, withIdentityWrite);
const wrapRead = (handler) => wrapNetwork(handler, withIdentity);

const HANDLERS = {
  'moov-wallet-fund': wrapWrite(handleProductionMoovWalletFund),
  'moov-disburse': wrapWrite(handleProductionMoovWalletDisburse),
  'moov-tenant-fee-charge': wrapWrite(handleProductionMoovTenantFeeCharge),
  'moov-refund': wrapWrite(handleProductionMoovRefund),
  'initiate-wallet-funding': wrapWrite(handleProductionMoovInitiateWalletFunding),
  'process-funded-payment': wrapWrite(handleProductionMoovProcessFundedPayment),
  'wallet-fund-on-clear': wrapWrite(handleProductionMoovWalletFundOnClear),
};

const LIVE_READ_HANDLERS = {
  'moov-wallet-status': wrapRead(handleProductionMoovWalletStatus),
  'moov-readiness': wrapRead(handleProductionMoovReadiness),
  'moov-wallet-sync': wrapRead(handleProductionMoovWalletSync),
  'moov-sweep-config': wrapRead(handleProductionMoovSweepConfig),
};

export const runProductionMoovHandler = (name, event, deps = {}) => {
  if (productionMoovAmbiguousMode()) return denyAmbiguousMoovMode(name);
  if (!productionMoovExecutionAllowed()) return null;
  const handler = HANDLERS[name];
  if (!handler) return null;
  return handler(event, deps);
};

export const runProductionMoovLiveReadHandler = (name, event, deps = {}) => {
  if (!productionMoovLiveReadsAllowed()) return null;
  const handler = LIVE_READ_HANDLERS[name];
  if (!handler) return null;
  return handler(event, deps);
};
