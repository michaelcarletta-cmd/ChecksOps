import { withIdentity, withIdentityWrite } from '../../data.mjs';
import { isProviderNetworkError, providerEgressFailure } from '../../sandbox-credentials.mjs';
import { executionAllowed, providerLiveReadsEnabled } from '../../provider-flags.mjs';
import { providerSandboxExecutionEnabled } from '../../sandbox-flags.mjs';
import { handleProductionMoovTransferStatus } from './moov-transfer-status.mjs';
import { handleProductionMoovPayoutOrchestrate } from './moov-payout-orchestrate.mjs';
import { handleMoovTenantEnvironment } from '../moov-tenant-environment.mjs';
import { handleProductionPayoutE2e } from './moov-production-payout-e2e.mjs';
import { refuseIndependentMustKeepInvocation } from './moov-production-transfer-primitives.mjs';

const PRODUCTION_MOOV_FUNCTIONS = new Set([
  'moov-transfer-status',
  'moov-payout-orchestrate',
  'moov-tenant-environment',
  'moov-production-payout-e2e',
  'moov-wallet-fund',
  'moov-wallet-disburse',
]);

/** Live zip providers.mjs still routes these names before money handlers. */
const PRODUCTION_MOOV_LIVE_READ_FUNCTIONS = new Set([
  'moov-wallet-status',
  'moov-readiness',
  'moov-wallet-sync',
  'moov-sweep-config',
  'moov-payout-orchestrate',
]);

export const hasProductionMoovHandler = (name) => PRODUCTION_MOOV_FUNCTIONS.has(name);

export const hasProductionMoovLiveReadHandler = (name) => PRODUCTION_MOOV_LIVE_READ_FUNCTIONS.has(name);

export const productionMoovGetReconcileAllowed = () => (
  executionAllowed('moov') && !providerSandboxExecutionEnabled()
);

const wrapNetwork = (handler, identityFn, productionExecution) => async (event, deps = {}) => (
  identityFn(event, async ({ client, mapping, claims, body, spoof }) => {
    try {
      try {
        const { bindMoovProductionGucs } = await import('./moov-idempotency.mjs');
        await bindMoovProductionGucs(client, mapping, claims);
      } catch {
        /* Live zip has this helper. Git tests do not. */
      }
      const result = await handler({
        client,
        mapping,
        claims,
        body,
        spoof,
        fetchImpl: deps.fetchImpl || fetch,
        loadSecrets: deps.loadProductionMoovReadSecrets,
        loadSandboxSecrets: deps.loadSandboxMoovReadSecrets,
        store: deps.store || null,
        deps,
      });
      return {
        ...result,
        spoofFieldsIgnored: spoof,
        applicationUserId: mapping.application_user_id,
        authUid: mapping.application_user_id,
        cognitoSub: claims.sub,
        createdPaymentTransfer: false,
        liveProviderPosted: false,
      };
    } catch (error) {
      if (isProviderNetworkError(error)) {
        return {
          ...providerEgressFailure('moov'),
          spoofFieldsIgnored: spoof,
          applicationUserId: mapping.application_user_id,
          createdPaymentTransfer: false,
          liveProviderPosted: false,
          productionExecution,
        };
      }
      throw error;
    }
  }, deps)
);

const wrap = (handler) => wrapNetwork(handler, withIdentityWrite, true);
const wrapRead = (handler) => wrapNetwork(handler, withIdentity, false);

const HANDLERS = {
  'moov-transfer-status': wrap(handleProductionMoovTransferStatus),
  'moov-payout-orchestrate': wrap(handleProductionMoovPayoutOrchestrate),
  'moov-tenant-environment': wrap(handleMoovTenantEnvironment),
  'moov-production-payout-e2e': wrap(handleProductionPayoutE2e),
  'moov-wallet-fund': wrap(async () => refuseIndependentMustKeepInvocation('moov-wallet-fund')),
  'moov-wallet-disburse': wrap(async () => refuseIndependentMustKeepInvocation('moov-wallet-disburse')),
};

export const runProductionMoovHandler = (name, event, deps = {}) => {
  if (name === 'moov-tenant-environment' || name === 'moov-wallet-fund' || name === 'moov-wallet-disburse' || name === 'moov-production-payout-e2e') {
    const handler = HANDLERS[name];
    return handler ? handler(event, deps) : null;
  }
  if (!productionMoovGetReconcileAllowed()) return null;
  const handler = HANDLERS[name];
  if (!handler) return null;
  return handler(event, deps);
};

const productionMoovLiveReadsAllowed = () => (
  providerLiveReadsEnabled() && !providerSandboxExecutionEnabled()
);

export const runProductionMoovLiveReadHandler = async (name, event, deps = {}) => {
  if (!productionMoovLiveReadsAllowed()) return null;
  if (name === 'moov-payout-orchestrate') return null;
  let liveRead;
  let sweep;
  try {
    liveRead = await import('./moov-live-read.mjs');
    sweep = await import('./moov-sweep-config.mjs');
  } catch {
    return null;
  }
  const LIVE_READ_HANDLERS = {
    'moov-wallet-status': wrapRead(liveRead.handleProductionMoovWalletStatus),
    'moov-readiness': wrapRead(liveRead.handleProductionMoovReadiness),
    'moov-wallet-sync': wrapRead(liveRead.handleProductionMoovWalletSync),
    'moov-sweep-config': wrapRead(sweep.handleProductionMoovSweepConfig),
  };
  const handler = LIVE_READ_HANDLERS[name];
  if (!handler) return null;
  return handler(event, deps);
};
