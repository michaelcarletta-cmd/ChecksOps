import { withIdentityWrite } from '../../data.mjs';
import { isProviderNetworkError, providerEgressFailure } from '../../sandbox-credentials.mjs';
import { executionAllowed } from '../../provider-flags.mjs';
import { providerSandboxExecutionEnabled } from '../../sandbox-flags.mjs';
import { handleProductionMoovTransferStatus } from './moov-transfer-status.mjs';
import { handleProductionMoovPayoutOrchestrate } from './moov-payout-orchestrate.mjs';
import { handleMoovTenantEnvironment } from '../moov-tenant-environment.mjs';

const PRODUCTION_MOOV_FUNCTIONS = new Set([
  'moov-transfer-status',
  'moov-payout-orchestrate',
  'moov-tenant-environment',
]);

export const hasProductionMoovHandler = (name) => PRODUCTION_MOOV_FUNCTIONS.has(name);

export const productionMoovGetReconcileAllowed = () => (
  executionAllowed('moov') && !providerSandboxExecutionEnabled()
);

const wrap = (handler) => async (event, deps = {}) => (
  withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    try {
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
          productionExecution: true,
        };
      }
      throw error;
    }
  }, deps)
);

const HANDLERS = {
  'moov-transfer-status': wrap(handleProductionMoovTransferStatus),
  'moov-payout-orchestrate': wrap(handleProductionMoovPayoutOrchestrate),
  'moov-tenant-environment': wrap(handleMoovTenantEnvironment),
};

export const runProductionMoovHandler = (name, event, deps = {}) => {
  if (name === 'moov-tenant-environment') {
    const handler = HANDLERS[name];
    return handler ? handler(event, deps) : null;
  }
  if (!productionMoovGetReconcileAllowed()) return null;
  const handler = HANDLERS[name];
  if (!handler) return null;
  return handler(event, deps);
};
