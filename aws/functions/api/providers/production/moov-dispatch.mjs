import { withIdentity, withIdentityWrite } from '../../data.mjs';
import { parseBody } from '../../data.mjs';
import { isProviderNetworkError, providerEgressFailure } from '../../sandbox-credentials.mjs';
import { ProductionMoovError, publicMoovErrorBody, redactMoovText } from './moov-client.mjs';
import {
  denyAmbiguousMoovMode,
  denyProductionMoovHolds,
  PRODUCTION_MOOV_FUNCTIONS,
  PRODUCTION_MOOV_MONEY_FUNCTIONS,
  PRODUCTION_MOOV_ONBOARDING_WRITE_FUNCTIONS,
  PRODUCTION_MOOV_PUBLIC_RECIPIENT_FUNCTIONS,
  PRODUCTION_MOOV_READ_FUNCTIONS,
  productionMoovAmbiguousMode,
  productionMoovExecutionAllowed,
  productionMoovOnboardingWritesAllowed,
  productionMoovReadsAllowed,
} from './moov-holds.mjs';
import { bindMoovProductionGucs } from './moov-idempotency.mjs';
import { handleProductionMoovReadiness, handleProductionMoovTransferStatus } from './moov-read.mjs';
import { handleProductionMoovDisburse, handleProductionMoovTransferCreate } from './moov-transfer.mjs';
import { handleProductionOnboardingWrite } from './moov-onboarding-writes.mjs';
import {
  handleProductionRecipientReadiness,
  handleProductionWalletActivity,
  handleProductionAccountFiles,
} from './moov-onboarding-reads.mjs';
import { handlePublicRecipientFunction } from './moov-recipient-public.mjs';
import { classifyWalletOperation, WALLET_OP } from './moov-wallet-foundation.mjs';

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

const wrapOnboarding = (name) => async (event, deps = {}) => (
  withIdentity(event, async ({ client, mapping, claims, body, spoof }) => (
    handleProductionOnboardingWrite(name, {
      client, mapping, claims, body, spoof, deps,
    })
  ), deps)
);

const MONEY_HANDLERS = {
  'moov-transfer-create': wrapMoney(handleProductionMoovTransferCreate),
  'moov-disburse': wrapMoney(handleProductionMoovDisburse),
};

const READ_HANDLERS = {
  'moov-readiness': wrapRead(handleProductionMoovReadiness, false),
  'moov-transfer-status': wrapRead(handleProductionMoovTransferStatus, false),
  'moov-recipient-readiness': wrapRead(handleProductionRecipientReadiness, false),
  'moov-wallet-activity': wrapRead(handleProductionWalletActivity, false),
  'moov-account-files': wrapRead(handleProductionAccountFiles, false),
  'moov-underwriting': wrapRead(handleProductionWalletActivity, false),
};

const isProductionPrep = () => String(process.env.CHECKSOPS_ENV || '') === 'production-prep';

const denyMoney = (name) => denyProductionMoovHolds(name, {
  error: 'production_execution_blocked',
  message: 'Live reads cannot create transfers, fund wallets, or mutate Moov. Money flags remain false.',
  wallet_op: classifyWalletOperation(name),
});

export const runProductionMoovHandler = (name, event, deps = {}) => {
  if (productionMoovAmbiguousMode()) return denyAmbiguousMoovMode(name);

  if (PRODUCTION_MOOV_PUBLIC_RECIPIENT_FUNCTIONS.has(name)) {
    return handlePublicRecipientFunction(name, event, deps);
  }

  if (PRODUCTION_MOOV_MONEY_FUNCTIONS.has(name)) {
    if (productionMoovExecutionAllowed() && MONEY_HANDLERS[name]) return MONEY_HANDLERS[name](event, deps);
    if (productionMoovReadsAllowed() || isProductionPrep()) return denyMoney(name);
    return null;
  }

  const body = parseBody(event);
  const underwritingSave = name === 'moov-underwriting' && body?.action === 'save';
  if (PRODUCTION_MOOV_ONBOARDING_WRITE_FUNCTIONS.has(name) || underwritingSave) {
    if (productionMoovReadsAllowed() || isProductionPrep() || productionMoovOnboardingWritesAllowed()) {
      return wrapOnboarding(name)(event, deps);
    }
    return null;
  }

  if (PRODUCTION_MOOV_READ_FUNCTIONS.has(name)) {
    if (productionMoovExecutionAllowed() || productionMoovReadsAllowed()) {
      if (name === 'moov-account-files' || (name === 'moov-underwriting' && body?.action === 'save')) {
        return wrapOnboarding(name)(event, deps);
      }
      const persistOutcome = productionMoovExecutionAllowed() && name === 'moov-transfer-status';
      if (name === 'moov-transfer-status') {
        return wrapRead(handleProductionMoovTransferStatus, persistOutcome)(event, deps);
      }
      if (READ_HANDLERS[name]) return READ_HANDLERS[name](event, deps);
    }
    return null;
  }

  return null;
};

export { WALLET_OP };
