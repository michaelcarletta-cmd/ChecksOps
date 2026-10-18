import { parseBody, withIdentityWrite } from '../../data.mjs';
import { IDENTITY_ENV_PRODUCTION, identityEnvFromChecksopsEnv } from '../../identity-env.mjs';
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
import { handleProductionCheckAltRegister, handleProductionCheckAltVerify } from './checkalt-register.mjs';
import { handleProductionCheckAltSubmit } from './checkalt-submit.mjs';
import {
  checkaltStatusReadAllowed,
  denyCheckAltMutationUnderStatusRead,
  denyCheckAltStatusReadDisabled,
  isCheckAltStatusReadFunction,
  isCheckAltStoredStatusRead,
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
  'checkalt-register-account': wrap(handleProductionCheckAltRegister),
  'checkalt-verify-account': wrap(handleProductionCheckAltVerify),
};

// The stored registration read (verify action "status") under status-read
// mode: identity GUCs only, status-only fetch, and any other action refused.
const verifyStoredStatus = wrap((args) => (
  args.body?.action === 'status'
    ? handleProductionCheckAltVerify(args)
    : denyCheckAltMutationUnderStatusRead('checkalt-verify-account')
), { statusRead: true });

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
    if (checkaltStatusReadAllowed()) {
      // Stored registration read: production answers from checkalt_tenant_accounts;
      // any other runtime falls through to the UAT handler (isolated UAT rows).
      if (isCheckAltStoredStatusRead(name, parseBody(event))) {
        return identityEnvFromChecksopsEnv(process.env.CHECKSOPS_ENV) === IDENTITY_ENV_PRODUCTION
          ? verifyStoredStatus(event, deps)
          : null;
      }
      return denyCheckAltMutationUnderStatusRead(name);
    }
    return null;
  }
  return handler(event, deps);
};
