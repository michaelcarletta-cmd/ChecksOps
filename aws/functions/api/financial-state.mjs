/**
 * Financial execution state machine.
 * Uses ChecksOps-aligned names rather than inventing a second ledger.
 *
 * Check intake provider destination remains T5 `approved_for_deposit` /
 * `ready_for_deposit`. This machine governs the *provider operation*, not
 * browser mutation of check_intake_items.status.
 */

export const FINANCIAL_STATES = {
  ready_for_provider: 'ready_for_provider',
  submitting: 'submitting',
  provider_pending: 'provider_pending',
  provider_confirmed: 'provider_confirmed',
  settled: 'settled',
  provider_failed: 'provider_failed',
  returned: 'returned',
  reversed: 'reversed',
  cancelled: 'cancelled',
};

export const TERMINAL_STATES = new Set([
  FINANCIAL_STATES.settled,
  FINANCIAL_STATES.provider_failed,
  FINANCIAL_STATES.returned,
  FINANCIAL_STATES.reversed,
  FINANCIAL_STATES.cancelled,
]);

export const PROVIDER_CONFIRMED_STATES = new Set([
  FINANCIAL_STATES.provider_confirmed,
  FINANCIAL_STATES.settled,
  FINANCIAL_STATES.returned,
  FINANCIAL_STATES.reversed,
]);

/** CheckAlt deposit.status → operation state */
export const CHECKALT_STATE_MAP = {
  submitted: FINANCIAL_STATES.provider_pending,
  pending: FINANCIAL_STATES.provider_pending,
  pending_approval: FINANCIAL_STATES.provider_pending,
  approved: FINANCIAL_STATES.provider_confirmed,
  cleared: FINANCIAL_STATES.provider_confirmed,
  settled: FINANCIAL_STATES.settled,
  rejected: FINANCIAL_STATES.provider_failed,
  declined: FINANCIAL_STATES.provider_failed,
  returned: FINANCIAL_STATES.returned,
};

/** Moov transfer.status → operation state */
export const MOOV_STATE_MAP = {
  ready: FINANCIAL_STATES.ready_for_provider,
  created: FINANCIAL_STATES.provider_pending,
  pending: FINANCIAL_STATES.provider_pending,
  completed: FINANCIAL_STATES.provider_confirmed,
  settled: FINANCIAL_STATES.settled,
  failed: FINANCIAL_STATES.provider_failed,
  canceled: FINANCIAL_STATES.cancelled,
  cancelled: FINANCIAL_STATES.cancelled,
  returned: FINANCIAL_STATES.returned,
  reversed: FINANCIAL_STATES.reversed,
};

export const TRANSITIONS = {
  prepare: {
    from: [null, FINANCIAL_STATES.ready_for_provider],
    to: FINANCIAL_STATES.ready_for_provider,
    actor: 'server_prepare',
  },
  submit: {
    from: [FINANCIAL_STATES.ready_for_provider, FINANCIAL_STATES.submitting],
    to: FINANCIAL_STATES.submitting,
    actor: 'server_submit',
  },
  provider_accepted: {
    from: [FINANCIAL_STATES.submitting, FINANCIAL_STATES.provider_pending],
    to: FINANCIAL_STATES.provider_pending,
    actor: 'server_or_provider',
  },
  provider_confirmed: {
    from: [FINANCIAL_STATES.submitting, FINANCIAL_STATES.provider_pending],
    to: FINANCIAL_STATES.provider_confirmed,
    actor: 'webhook',
  },
  settle: {
    from: [FINANCIAL_STATES.provider_confirmed],
    to: FINANCIAL_STATES.settled,
    actor: 'webhook',
  },
  fail: {
    from: [
      FINANCIAL_STATES.ready_for_provider,
      FINANCIAL_STATES.submitting,
      FINANCIAL_STATES.provider_pending,
    ],
    to: FINANCIAL_STATES.provider_failed,
    actor: 'server_or_provider',
  },
  return: {
    from: [FINANCIAL_STATES.provider_confirmed, FINANCIAL_STATES.settled, FINANCIAL_STATES.provider_pending],
    to: FINANCIAL_STATES.returned,
    actor: 'webhook',
  },
  reverse: {
    from: [FINANCIAL_STATES.provider_confirmed, FINANCIAL_STATES.settled],
    to: FINANCIAL_STATES.reversed,
    actor: 'webhook',
  },
  cancel: {
    from: [FINANCIAL_STATES.ready_for_provider, FINANCIAL_STATES.submitting, FINANCIAL_STATES.provider_pending],
    to: FINANCIAL_STATES.cancelled,
    actor: 'server',
  },
};

export const WEBHOOK_EVENT_ACTIONS = {
  'transfer.created': 'provider_accepted',
  'transfer.updated': 'provider_confirmed',
  'transfer.completed': 'provider_confirmed',
  'transfer.failed': 'fail',
  'transfer.returned': 'return',
  'transfer.reversed': 'reverse',
  'deposit.submitted': 'provider_accepted',
  'deposit.cleared': 'provider_confirmed',
  'deposit.settled': 'settle',
  'deposit.rejected': 'fail',
  'deposit.returned': 'return',
};

export const evaluateTransition = (fromStatus, action) => {
  const spec = TRANSITIONS[action];
  if (!spec) {
    return { ok: false, error: 'unknown_financial_action', action };
  }
  const from = fromStatus || null;
  const allowed = spec.from.some((state) => state === from);
  if (!allowed) {
    return {
      ok: false,
      error: 'illegal_financial_transition',
      action,
      from: fromStatus,
      allowedFrom: spec.from,
    };
  }
  return {
    ok: true,
    action,
    from: fromStatus,
    to: spec.to,
    actor: spec.actor,
  };
};

export const mapProviderStatus = (provider, rawStatus) => {
  const key = String(rawStatus || '').toLowerCase();
  if (provider === 'checkalt') return CHECKALT_STATE_MAP[key] || null;
  if (provider === 'moov') return MOOV_STATE_MAP[key] || null;
  return null;
};
