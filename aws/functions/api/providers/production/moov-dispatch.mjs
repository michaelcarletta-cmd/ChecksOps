import { withIdentity, withIdentityWrite } from '../../data.mjs';
import { isProviderNetworkError, providerEgressFailure } from '../../sandbox-credentials.mjs';
import { ProductionMoovError, publicMoovErrorBody, redactMoovText } from './moov-client.mjs';
import {
  denyAmbiguousMoovMode,
  denyProductionMoovHolds,
  PRODUCTION_MOOV_FUNCTIONS,
  PRODUCTION_MOOV_MONEY_FUNCTIONS,
  PRODUCTION_MOOV_READ_FUNCTIONS,
  productionMoovAmbiguousMode,
  productionMoovExecutionAllowed,
  productionMoovReadsAllowed,
} from './moov-holds.mjs';
import { bindMoovProductionGucs } from './moov-idempotency.mjs';
import { handleProductionMoovReadiness, handleProductionMoovTransferStatus } from './moov-read.mjs';
import { handleProductionMoovDisburse, handleProductionMoovTransferCreate } from './moov-transfer.mjs';

export const hasProductionMoovHandler = (name) => PRODUCTION_MOOV_FUNCTIONS.has(name);

const wrapMoney = (handler) => async (event, deps = {}) => (
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

const wrapRead = (handler, persistOutcome = false) => async (event, deps = {}) => (
  withIdentity(event, async ({ client, mapping, claims, body, spoof }) => {
    try {
      return await handler({
        client,
        mapping,
        claims,
        body,
        spoof,
        fetchImpl: deps.fetchImpl || fetch,
        deps,
        persistOutcome,
      });
    } catch (error) {
      if (error?.code === 'read_only_method_denied' || error?.code === 'read_only_path_denied') {
        return {
          ok: false,
          statusCode: 403,
          error: error.code,
          provider: 'moov',
          liveProviderCalled: false,
          productionExecution: false,
          productionRead: true,
          message: redactMoovText(error.message),
          spoofFieldsIgnored: spoof,
        };
      }
      if (error instanceof ProductionMoovError || error?.name === 'ProductionMoovError') {
        const status = Number(error.status);
        const statusCode = status >= 400 && status < 600 ? status : 502;
        return {
          ok: false,
          statusCode,
          error: 'moov_read_failed',
          provider: 'moov',
          liveProviderCalled: true,
          productionExecution: false,
          productionRead: true,
          providerHttpStatus: Number.isFinite(status) ? status : null,
          message: redactMoovText(error.message),
          providerError: publicMoovErrorBody(error.body),
          auth_diagnosis: error.diagnosis || error.oauth || null,
          spoofFieldsIgnored: spoof,
        };
      }
      if (isProviderNetworkError(error)) {
        return {
          ...providerEgressFailure('moov'),
          spoofFieldsIgnored: spoof,
          applicationUserId: mapping.application_user_id,
          liveProviderCalled: true,
          productionExecution: false,
          productionRead: true,
        };
      }
      throw error;
    }
  }, deps)
);

const MONEY_HANDLERS = {
  'moov-transfer-create': wrapMoney(handleProductionMoovTransferCreate),
  'moov-disburse': wrapMoney(handleProductionMoovDisburse),
};

const READ_HANDLERS = {
  'moov-readiness': wrapRead(handleProductionMoovReadiness, false),
  'moov-transfer-status': wrapRead(handleProductionMoovTransferStatus, false),
};

const isProductionPrep = () => String(process.env.CHECKSOPS_ENV || '') === 'production-prep';

export const runProductionMoovHandler = (name, event, deps = {}) => {
  if (productionMoovAmbiguousMode()) return denyAmbiguousMoovMode(name);

  if (PRODUCTION_MOOV_MONEY_FUNCTIONS.has(name)) {
    if (productionMoovExecutionAllowed()) return MONEY_HANDLERS[name](event, deps);
    // Live-reads or production-prep: fail closed before identity/DB/provider HTTP.
    // Staging still returns null so sandbox parity can own money routes.
    if (productionMoovReadsAllowed() || isProductionPrep()) {
      return denyProductionMoovHolds(name, {
        error: 'production_execution_blocked',
        message: 'Live reads cannot create transfers, fund wallets, or mutate Moov. Money flags remain false.',
      });
    }
    return null;
  }

  if (PRODUCTION_MOOV_READ_FUNCTIONS.has(name)) {
    if (productionMoovExecutionAllowed() || productionMoovReadsAllowed()) {
      const persistOutcome = productionMoovExecutionAllowed() && name === 'moov-transfer-status';
      if (name === 'moov-transfer-status') {
        return wrapRead(handleProductionMoovTransferStatus, persistOutcome)(event, deps);
      }
      return READ_HANDLERS[name](event, deps);
    }
    return null;
  }

  return null;
};
