import { withIdentityWrite } from '../../data.mjs';
import { isProviderNetworkError, providerEgressFailure } from '../../sandbox-credentials.mjs';
import {
  denyAmbiguousCheckAltMode,
  PRODUCTION_CHECKALT_FUNCTIONS,
  productionCheckAltAmbiguousMode,
  productionCheckAltExecutionAllowed,
} from './checkalt-holds.mjs';
import { bindCheckAltProductionGucs, bindCheckAltStatusReadGucs } from './checkalt-idempotency.mjs';
import { handleProductionCheckAltApprove } from './checkalt-approve.mjs';
import { handleProductionCheckAltPoll } from './checkalt-poll.mjs';
import { handleProductionCheckAltSubmit } from './checkalt-submit.mjs';
import {
  checkaltStatusReadAllowed,
  denyCheckAltMutationUnderStatusRead,
  denyCheckAltStatusReadDisabled,
  isCheckAltStatusReadFunction,
  statusReadOnlyFetch,
} from './checkalt-status-read.mjs';

export const hasProductionCheckAltHandler = (name) => PRODUCTION_CHECKALT_FUNCTIONS.has(name);

const wrap = (handler, { statusRead = false } = {}) => async (event, deps = {}) => (
  withIdentityWrite(event, async ({ client, mapping, claims, body, spoof }) => {
    if (statusRead) await bindCheckAltStatusReadGucs(client, mapping, claims);
    else await bindCheckAltProductionGucs(client, mapping, claims);
    try {
      return await handler({
        client,
        mapping,
        claims,
        body,
        spoof,
        fetchImpl: statusRead
          ? statusReadOnlyFetch(deps.fetchImpl || fetch)
          : (deps.fetchImpl || fetch),
        deps,
      });
    } catch (error) {
      if (error?.statusReadDenied) {
        return denyCheckAltMutationUnderStatusRead('checkalt-http', {
          message: 'Status-read adapter refused a non-status CheckAlt path.',
          spoofFieldsIgnored: spoof,
          applicationUserId: mapping.application_user_id,
        });
      }
      if (isProviderNetworkError(error)) {
        return {
          ...providerEgressFailure('checkalt'),
          spoofFieldsIgnored: spoof,
          applicationUserId: mapping.application_user_id,
          createdDeposit: false,
          productionExecution: !statusRead,
        };
      }
      throw error;
    }
  }, deps)
);

const HANDLERS = {
  'checkalt-submit-deposit': wrap(handleProductionCheckAltSubmit),
  'checkalt-poll-status': wrap(handleProductionCheckAltPoll, { statusRead: true }),
  'checkalt-approve-deposit': wrap(handleProductionCheckAltApprove),
};

/**
 * Poll uses AWS_CHECKALT_STATUS_RECONCILE_ENABLED only.
 * Submit/approve still require the existing money-movement holds.
 * Returning a deny object (never null) for poll prevents sandbox fallthrough.
 */
export const runProductionCheckAltHandler = (name, event, deps = {}) => {
  const handler = HANDLERS[name];
  if (!handler) return null;

  if (isCheckAltStatusReadFunction(name)) {
    if (!checkaltStatusReadAllowed()) return denyCheckAltStatusReadDisabled({ operation: name });
    return handler(event, deps);
  }

  if (productionCheckAltAmbiguousMode()) return denyAmbiguousCheckAltMode(name);
  if (!productionCheckAltExecutionAllowed()) {
    if (checkaltStatusReadAllowed()) return denyCheckAltMutationUnderStatusRead(name);
    return null;
  }
  return handler(event, deps);
};
