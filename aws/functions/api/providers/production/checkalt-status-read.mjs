/**
 * Narrow CheckAlt status-read permission.
 * AWS_CHECKALT_STATUS_RECONCILE_ENABLED authorizes item/history lookup only.
 * It does not lift money-movement / provider-execution holds.
 */
import { checkaltStatusReconcileEnabled, productionCheckAltExecutionAllowed } from './checkalt-holds.mjs';

export const CHECKALT_STATUS_READ_FUNCTION = 'checkalt-poll-status';

/** Provider functions that change money, registration, or deposit state. */
export const CHECKALT_MUTATION_FUNCTIONS = new Set([
  'checkalt-submit-deposit',
  'checkalt-approve-deposit',
  'checkalt-register-account',
  'checkalt-verify-account',
  'checkalt-deposit-history',
]);

export const CHECKALT_STATUS_READ_ALLOWED_PATHS = Object.freeze([
  '/public/fincapture/authenticate',
  '/fincapture/deposit/item',
  '/fincapture/deposit/history',
]);

export const CHECKALT_STATUS_READ_DENIED_PATHS = Object.freeze([
  '/fincapture/deposit/process',
  '/fincapture/deposit/approve',
  '/fincapture/useraccount/register',
]);

export const checkaltStatusReadAllowed = () => checkaltStatusReconcileEnabled();

/** Status-read on, financial/provider execution still off. */
export const checkaltStatusReadOnlyMode = () => (
  checkaltStatusReadAllowed() && !productionCheckAltExecutionAllowed()
);

export const isCheckAltStatusReadFunction = (name) => name === CHECKALT_STATUS_READ_FUNCTION;

export const isCheckAltMutationFunction = (name) => CHECKALT_MUTATION_FUNCTIONS.has(name);

export const denyCheckAltStatusReadDisabled = (extra = {}) => ({
  ok: false,
  statusCode: 403,
  error: 'checkalt_status_reconcile_disabled',
  provider: 'checkalt',
  liveProviderCalled: false,
  createdDeposit: false,
  approvePosted: false,
  submitPosted: false,
  moneyMoved: false,
  productionExecution: false,
  message: 'CheckAlt status reads stay disabled until AWS_CHECKALT_STATUS_RECONCILE_ENABLED=true. This flag does not enable submit, approve, or other money movement.',
  ...extra,
});

export const denyCheckAltMutationUnderStatusRead = (operation, extra = {}) => ({
  ok: false,
  statusCode: 403,
  error: 'checkalt_mutation_blocked',
  provider: 'checkalt',
  operation,
  liveProviderCalled: false,
  createdDeposit: false,
  approvePosted: false,
  submitPosted: false,
  moneyMoved: false,
  productionExecution: false,
  message: 'CheckAlt status-read permission does not authorize mutations. Financial/provider execution holds remain on.',
  ...extra,
});

const pathOf = (url) => {
  const text = String(url || '');
  try {
    return new URL(text).pathname;
  } catch {
    const noQuery = text.split('?')[0];
    const idx = noQuery.indexOf('/fincapture');
    if (idx >= 0) return noQuery.slice(idx);
    const auth = noQuery.indexOf('/public/fincapture');
    if (auth >= 0) return noQuery.slice(auth);
    return noQuery;
  }
};

export const isCheckAltStatusReadPath = (url) => {
  const pathname = pathOf(url);
  return CHECKALT_STATUS_READ_ALLOWED_PATHS.some((allowed) => pathname === allowed || pathname.endsWith(allowed));
};

export const isCheckAltStatusDeniedPath = (url) => {
  const pathname = pathOf(url);
  return CHECKALT_STATUS_READ_DENIED_PATHS.some((denied) => pathname.includes(denied));
};

/**
 * Adapter used by production poll / scheduled reconcile.
 * Allows authenticate + item + history. Refuses process/approve/register.
 */
export const statusReadOnlyFetch = (fetchImpl = fetch) => async (url, options = {}) => {
  if (isCheckAltStatusDeniedPath(url) || !isCheckAltStatusReadPath(url)) {
    const error = new Error('status_reconcile_refused_money_path');
    error.statusReadDenied = true;
    error.url = String(url || '');
    throw error;
  }
  return fetchImpl(url, options);
};
