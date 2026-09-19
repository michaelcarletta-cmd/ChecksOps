/**
 * Dark, server-authoritative shortfall-aware payout orchestrator (M7.7).
 *
 * Sweep is observe-only treasury. It never funds a specific outgoing payment
 * and never creates ChecksOps money intents. Authoritative funding is one
 * ChecksOps BANK→WALLET wallet_funding intent for the exact shortage, then
 * one WALLET→RECIPIENT wallet_disbursement. This phase never POSTs to Moov
 * and never INSERTs payment_transfers.
 */
import { createHash } from 'node:crypto';
import { KNOWN_APPROVED_MOOV } from './moov-accounts.mjs';
import {
  FIRST_PRODUCTION_TRANSFER_CENTS,
  MOOV_DEPOSIT_TOTP_ACTION,
  MOOV_DISBURSE_TOTP_ACTION,
  MOOV_FUND_TOTP_ACTION,
  firstTestDisburseBinding,
  firstTestFundBinding,
} from './moov-first-test.mjs';
import { AUTHORITATIVE_DISBURSEMENT_FUNDING } from '../moov-funding-sequence.mjs';

export const M77_PHASE = 'M7.7';
export const FIRST_PAYOUT_CENTS = FIRST_PRODUCTION_TRANSFER_CENTS;
export const PERSIST_MONEY_INTENTS_THIS_PHASE = false;
export const CONSUME_TOTP_THIS_PHASE = false;

export const DECISION = Object.freeze({
  FUND_FIRST: 'FUND_FIRST',
  PAYOUT_READY: 'PAYOUT_READY',
});

export const FUNDING_STATES = Object.freeze([
  'funding_required',
  'funding_submitted',
  'funding_unknown',
  'funding_completed',
  'funding_failed',
  'funding_returned',
]);

export const PAYOUT_STATES = Object.freeze([
  'payout_requested',
  'payout_ready',
  'payout_submitting',
  'payout_submitted',
  'payout_unknown',
  'payout_completed',
  'payout_failed',
]);

export const UX_STAGES = Object.freeze([
  'funding_required',
  'funding_pending',
  'funds_available',
  'ready_to_send',
  'payment_pending',
  'payment_completed',
]);

export const UX_STAGE_LABEL = Object.freeze({
  funding_required: 'Funding required',
  funding_pending: 'Funding pending',
  funds_available: 'Funds available',
  ready_to_send: 'Ready to send',
  payment_pending: 'Payment pending',
  payment_completed: 'Payment completed',
});

const FUNDING_TRANSITIONS = Object.freeze({
  funding_required: Object.freeze(['funding_submitted']),
  funding_submitted: Object.freeze(['funding_completed', 'funding_failed', 'funding_returned', 'funding_unknown']),
  funding_unknown: Object.freeze(['funding_submitted', 'funding_completed', 'funding_failed', 'funding_returned']),
  funding_completed: Object.freeze([]),
  funding_failed: Object.freeze([]),
  funding_returned: Object.freeze([]),
});

const PAYOUT_TRANSITIONS = Object.freeze({
  payout_requested: Object.freeze(['payout_ready']),
  payout_ready: Object.freeze(['payout_submitting']),
  payout_submitting: Object.freeze(['payout_submitted', 'payout_failed', 'payout_unknown']),
  payout_submitted: Object.freeze(['payout_completed', 'payout_failed', 'payout_unknown']),
  payout_unknown: Object.freeze(['payout_submitted', 'payout_completed', 'payout_failed']),
  payout_completed: Object.freeze([]),
  payout_failed: Object.freeze([]),
});

const FUNDING_IN_FLIGHT = new Set(['funding_submitted', 'funding_unknown']);
const PAYOUT_IN_FLIGHT = new Set(['payout_submitting', 'payout_submitted', 'payout_unknown']);
const FUNDING_TERMINAL_FAIL = new Set(['funding_failed', 'funding_returned']);
const PAYOUT_TERMINAL = new Set(['payout_completed', 'payout_failed']);

export const amountToCents = (amount) => {
  if (amount === undefined || amount === null) return 0;
  if (typeof amount === 'object') {
    if (amount.valueDecimal !== undefined && amount.valueDecimal !== null) {
      const dollars = Number(amount.valueDecimal);
      return Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
    }
    const raw = amount.value ?? amount.amount ?? 0;
    if (typeof raw === 'string' && raw.includes('.')) {
      const dollars = Number(raw);
      return Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  if (typeof amount === 'string' && amount.includes('.')) {
    const dollars = Number(amount);
    return Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
  }
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

export const computeShortfallCents = (payoutCents, availableCents) => {
  const payout = Math.max(0, Number(payoutCents) || 0);
  const available = Math.max(0, Number(availableCents) || 0);
  return Math.max(0, payout - available);
};

export const decidePayoutFunding = ({ payoutCents, availableCents } = {}) => {
  const payout = Number.isInteger(payoutCents) ? payoutCents : FIRST_PAYOUT_CENTS;
  const available = Math.max(0, Number(availableCents) || 0);
  const shortfall_cents = computeShortfallCents(payout, available);
  return {
    payout_cents: payout,
    available_cents: available,
    shortfall_cents,
    decision: shortfall_cents > 0 ? DECISION.FUND_FIRST : DECISION.PAYOUT_READY,
  };
};

const uuidV5 = (name, namespaceHex) => {
  const ns = Buffer.from(String(namespaceHex).replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(String(name)).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/** Durable first-test payout business operation. Independent of Sweep and prior funds. */
export const firstTestPayoutOperationId = () => uuidV5(
  [
    'checksops:m77:first-payout',
    KNOWN_APPROVED_MOOV.freedom.tenantId,
    KNOWN_APPROVED_MOOV.recipient.recipientId,
    String(FIRST_PAYOUT_CENTS),
  ].join(':'),
  '6ba7b8109dad11d180b400c04fd430c8',
);

export const fundingIdempotencyKey = (operationId, shortfallCents) =>
  `checksops:m77:wallet_funding:op:${operationId}:cents:${Number(shortfallCents)}`;

export const payoutIdempotencyKey = (operationId, payoutCents) =>
  `checksops:m77:wallet_disbursement:op:${operationId}:cents:${Number(payoutCents)}`;

export const canTransitionFunding = (from, to) => {
  if (from === to) return { ok: true, noop: true, reason: 'idempotent_same_status' };
  const allowed = FUNDING_TRANSITIONS[from];
  if (!allowed) return { ok: false, noop: false, reason: 'unknown_funding_state' };
  if (allowed.includes(to)) return { ok: true, noop: false, reason: null };
  return {
    ok: false,
    noop: false,
    reason: allowed.length === 0 ? 'terminal_regression' : 'illegal_funding_transition',
  };
};

export const canTransitionPayout = (from, to) => {
  if (from === to) return { ok: true, noop: true, reason: 'idempotent_same_status' };
  const allowed = PAYOUT_TRANSITIONS[from];
  if (!allowed) return { ok: false, noop: false, reason: 'unknown_payout_state' };
  if (allowed.includes(to)) return { ok: true, noop: false, reason: null };
  return { ok: false, noop: false, reason: PAYOUT_TRANSITIONS[from]?.length === 0 ? 'terminal_regression' : 'illegal_payout_transition' };
};

export const isSweepActivity = (row = {}) => {
  const origin = String(row.origin || row.observed_origin || '').toLowerCase();
  const kind = String(row.activity_kind || row.kind || '').toLowerCase();
  const description = String(row.description || '').toLowerCase();
  return origin === 'provider_sweep'
    || kind.startsWith('sweep')
    || description.includes('sweep');
};

export const isAuthoritativeFundingIntent = (row, operationId) => {
  if (!row) return false;
  if (isSweepActivity(row)) return false;
  const role = String(row.leg_role || row.kind || '').toLowerCase();
  if (role !== 'wallet_funding' && role !== 'funding') return false;
  if (row.payout_operation_id && String(row.payout_operation_id) !== String(operationId)) return false;
  if (row.idempotency_key && operationId && !String(row.idempotency_key).includes(String(operationId))) {
    return false;
  }
  return true;
};

const intentStatusToFundingState = (status) => {
  const s = String(status || '').toLowerCase();
  if (s === 'completed') return 'funding_completed';
  if (s === 'failed') return 'funding_failed';
  if (s === 'returned') return 'funding_returned';
  if (s === 'unknown') return 'funding_unknown';
  if (['pending', 'processing', 'submitted', 'queued', 'created', 'submitting'].includes(s)) {
    return 'funding_submitted';
  }
  if (s === 'planned' || s === 'funding_required') return 'funding_required';
  return 'funding_required';
};

const intentStatusToPayoutState = (status) => {
  const s = String(status || '').toLowerCase();
  if (s === 'completed') return 'payout_completed';
  if (s === 'failed' || s === 'returned' || s === 'canceled') return 'payout_failed';
  if (s === 'unknown') return 'payout_unknown';
  if (s === 'submitting') return 'payout_submitting';
  if (['pending', 'processing', 'submitted', 'queued', 'created'].includes(s)) return 'payout_submitted';
  if (s === 'ready' || s === 'payout_ready') return 'payout_ready';
  return 'payout_requested';
};

export const uxStageFor = ({
  decision,
  fundingState,
  payoutState,
  walletAvailableConfirmed,
} = {}) => {
  if (payoutState === 'payout_completed') return 'payment_completed';
  if (PAYOUT_IN_FLIGHT.has(payoutState) || payoutState === 'payout_failed') {
    return payoutState === 'payout_failed' ? 'payment_pending' : 'payment_pending';
  }
  if (payoutState === 'payout_ready' && walletAvailableConfirmed) return 'ready_to_send';
  if (fundingState === 'funding_completed' && walletAvailableConfirmed) return 'funds_available';
  if (fundingState === 'funding_completed' && !walletAvailableConfirmed) return 'funding_pending';
  if (FUNDING_IN_FLIGHT.has(fundingState)) return 'funding_pending';
  if (decision === DECISION.FUND_FIRST || fundingState === 'funding_required' || FUNDING_TERMINAL_FAIL.has(fundingState)) {
    return fundingState && FUNDING_TERMINAL_FAIL.has(fundingState) ? 'funding_required' : 'funding_required';
  }
  if (walletAvailableConfirmed) return 'ready_to_send';
  return 'funding_required';
};

export const exclusiveUiActions = (uxStage, { persistMoneyIntents = false, transferPostEnabled = false } = {}) => {
  const prepareFunding = uxStage === 'funding_required';
  const preparePayout = uxStage === 'ready_to_send' || uxStage === 'funds_available';
  return {
    prepare_funding: prepareFunding && !preparePayout,
    prepare_payout: preparePayout && !prepareFunding,
    submit_funding: false,
    submit_payout: false,
    both_enabled: false,
    transfer_post_enabled: transferPostEnabled === true,
    persist_money_intents: persistMoneyIntents === true,
  };
};

export const createMemoryPayoutStore = (seed = {}) => {
  const ops = new Map(Object.entries(seed.operations || {}));
  const intents = new Map(Object.entries(seed.intents || {}));
  return {
    inserts: [],
    async getIntent(key) {
      return intents.get(String(key)) || null;
    },
    async putIntent(intent) {
      const key = String(intent.idempotency_key);
      const existing = intents.get(key);
      if (existing) return { reused: true, intent: existing };
      this.inserts.push(intent.kind);
      intents.set(key, { ...intent });
      return { reused: false, intent: intents.get(key) };
    },
    async getOperation(id) {
      return ops.get(String(id)) || null;
    },
    snapshot() {
      return {
        operations: Object.fromEntries(ops),
        intents: Object.fromEntries(intents),
      };
    },
  };
};

const plannedFundingIntent = ({ operationId, shortfallCents, decision }) => {
  const fund = firstTestFundBinding();
  return {
    kind: 'wallet_funding',
    leg_role: 'wallet_funding',
    payout_operation_id: operationId,
    idempotency_key: fundingIdempotencyKey(operationId, shortfallCents),
    amount_cents: shortfallCents,
    status: 'planned',
    source_label: fund.sourceLabel,
    destination_label: fund.destinationLabel,
    source_rail: 'ach-debit-fund',
    destination_rail: 'moov-wallet',
    totp_action: MOOV_FUND_TOTP_ACTION,
    required: decision === DECISION.FUND_FIRST && shortfallCents > 0,
    provider_transfer_id: null,
    origin: 'checksops',
  };
};

const plannedPayoutIntent = ({ operationId, payoutCents }) => {
  const disburse = firstTestDisburseBinding();
  return {
    kind: 'wallet_disbursement',
    leg_role: 'wallet_disbursement',
    payout_operation_id: operationId,
    idempotency_key: payoutIdempotencyKey(operationId, payoutCents),
    amount_cents: payoutCents,
    status: 'planned',
    source_label: disburse.sourceLabel,
    destination_label: disburse.destinationLabel,
    recipient_label: disburse.recipientLabel,
    source_rail: 'moov-wallet',
    destination_rail: 'ach-credit-standard',
    totp_action: MOOV_DISBURSE_TOTP_ACTION,
    provider_transfer_id: null,
    origin: 'checksops',
  };
};

const reuseOrPlan = async (store, persist, planned, prior = null) => {
  const fromStore = store ? await store.getIntent(planned.idempotency_key) : null;
  const existing = fromStore || prior || null;
  if (existing) {
    return { reused: true, created: false, intent: { ...planned, ...existing } };
  }
  if (!persist || !store) {
    return { reused: false, created: false, intent: planned };
  }
  const saved = await store.putIntent(planned);
  return {
    reused: saved.reused === true,
    created: saved.reused !== true,
    intent: saved.intent,
  };
};

export const orchestratePayout = async ({
  availableCents,
  payoutCents = FIRST_PAYOUT_CENTS,
  recipientVerified = false,
  totpFundPresent = false,
  totpDisbursePresent = false,
  transferPostEnabled = false,
  persistMoneyIntents = PERSIST_MONEY_INTENTS_THIS_PHASE,
  store = null,
  existingRows = [],
  sweepActivity = [],
} = {}) => {
  const operationId = firstTestPayoutOperationId();
  const amounts = decidePayoutFunding({ payoutCents, availableCents });
  const ignoredSweep = [...sweepActivity, ...existingRows].filter(isSweepActivity);
  const unrelatedFunding = existingRows.filter((row) => (
    !isSweepActivity(row)
    && (String(row.leg_role || '').toLowerCase() === 'wallet_funding'
      || String(row.leg_role || '').toLowerCase() === 'funding')
    && !isAuthoritativeFundingIntent(row, operationId)
  ));

  let existingFunding = null;
  let existingPayout = null;
  if (store) {
    existingFunding = await store.getIntent(fundingIdempotencyKey(operationId, amounts.shortfall_cents));
    existingPayout = await store.getIntent(payoutIdempotencyKey(operationId, amounts.payout_cents));
  }
  for (const row of existingRows) {
    if (isAuthoritativeFundingIntent(row, operationId) && !existingFunding) existingFunding = row;
    if (String(row.leg_role || row.kind || '') === 'wallet_disbursement'
      && String(row.payout_operation_id || '') === operationId
      && !existingPayout) {
      existingPayout = row;
    }
  }

  const fundingPlan = amounts.decision === DECISION.FUND_FIRST
    ? plannedFundingIntent({
      operationId,
      shortfallCents: amounts.shortfall_cents,
      decision: amounts.decision,
    })
    : null;

  const fundingResult = fundingPlan
    ? await reuseOrPlan(store, persistMoneyIntents === true, fundingPlan, existingFunding)
    : { reused: false, created: false, intent: null };

  const payoutResult = await reuseOrPlan(
    store,
    persistMoneyIntents === true,
    plannedPayoutIntent({ operationId, payoutCents: amounts.payout_cents }),
    existingPayout,
  );

  const fundingState = fundingResult.intent
    ? intentStatusToFundingState(fundingResult.intent.status)
    : (amounts.decision === DECISION.FUND_FIRST ? 'funding_required' : null);
  const payoutState = intentStatusToPayoutState(payoutResult.intent?.status);
  const walletAvailableConfirmed = amounts.available_cents >= amounts.payout_cents;
  const fundingCompleted = fundingState === 'funding_completed' || amounts.decision === DECISION.PAYOUT_READY;
  const fundingPending = FUNDING_IN_FLIGHT.has(fundingState);
  const fundingFailed = FUNDING_TERMINAL_FAIL.has(fundingState);
  const payoutInFlight = PAYOUT_IN_FLIGHT.has(payoutState);

  const payoutReady = fundingCompleted
    && walletAvailableConfirmed
    && recipientVerified === true
    && !fundingPending
    && !fundingFailed
    && !payoutInFlight
    && !PAYOUT_TERMINAL.has(payoutState);

  const effectivePayoutState = PAYOUT_TERMINAL.has(payoutState) || payoutInFlight
    ? payoutState
    : (payoutReady ? 'payout_ready' : 'payout_requested');

  const blockedReasons = [];
  if (amounts.decision === DECISION.FUND_FIRST && !fundingCompleted) blockedReasons.push('wallet_shortfall');
  if (fundingPending) blockedReasons.push('funding_pending');
  if (fundingFailed) blockedReasons.push('funding_failed');
  if (!walletAvailableConfirmed) blockedReasons.push('wallet_available_unconfirmed');
  if (recipientVerified !== true) blockedReasons.push('recipient_not_verified');
  if (totpDisbursePresent !== true) blockedReasons.push('wallet_disburse_totp_required');
  if (payoutInFlight) blockedReasons.push('payout_in_flight');

  const mayCreateSecondFunding = false;
  const mayCreateSecondPayout = false;
  const mayPostFunding = transferPostEnabled === true
    && persistMoneyIntents === true
    && fundingState === 'funding_required'
    && !fundingPending
    && totpFundPresent === true;
  const mayPostPayout = transferPostEnabled === true
    && persistMoneyIntents === true
    && effectivePayoutState === 'payout_ready'
    && blockedReasons.length === 0
    && totpDisbursePresent === true
    && !fundingPending;

  const ux_stage = uxStageFor({
    decision: amounts.decision,
    fundingState,
    payoutState: effectivePayoutState,
    walletAvailableConfirmed: walletAvailableConfirmed && fundingCompleted,
  });
  const actions = exclusiveUiActions(ux_stage, { persistMoneyIntents, transferPostEnabled });

  return {
    ok: true,
    phase: M77_PHASE,
    operation: 'payout.orchestrate',
    payout_operation_id: operationId,
    ...amounts,
    funding_mechanism: amounts.decision === DECISION.FUND_FIRST
      ? AUTHORITATIVE_DISBURSEMENT_FUNDING
      : 'none_wallet_already_funded',
    funding_state: fundingState,
    payout_state: effectivePayoutState,
    ux_stage,
    ux_label: UX_STAGE_LABEL[ux_stage],
    wallet_available_confirmed: walletAvailableConfirmed && fundingCompleted,
    recipient_verified: recipientVerified === true,
    payout_submittable: mayPostPayout,
    funding_post_allowed: mayPostFunding,
    duplicate_funding_prevented: true,
    duplicate_payout_prevented: true,
    may_create_second_funding: mayCreateSecondFunding,
    may_create_second_payout: mayCreateSecondPayout,
    sweep_used_as_funding: false,
    sweep_observe_only: true,
    ignored_sweep_count: ignoredSweep.length,
    unrelated_prior_funding_ignored: unrelatedFunding.length,
    persist_money_intents: persistMoneyIntents === true,
    persisted_money_intents: persistMoneyIntents === true
      ? Number(fundingResult.created) + Number(payoutResult.created)
      : 0,
    created_payment_transfer: persistMoneyIntents === true && (fundingResult.created || payoutResult.created),
    live_provider_posted: false,
    transfer_post_enabled: transferPostEnabled === true,
    totp_consumed: false,
    blocked_reasons: blockedReasons,
    funding_intent: fundingResult.intent ? {
      kind: 'wallet_funding',
      amount_cents: fundingResult.intent.amount_cents,
      idempotency_key: fundingResult.intent.idempotency_key,
      status: fundingResult.intent.status,
      source_label: fundingResult.intent.source_label || KNOWN_APPROVED_MOOV.freedom.fundingBankLabel,
      destination_label: fundingResult.intent.destination_label || KNOWN_APPROVED_MOOV.freedom.walletLabel,
      reused: fundingResult.reused,
      created: fundingResult.created,
      required: amounts.decision === DECISION.FUND_FIRST,
    } : null,
    payout_intent: {
      kind: 'wallet_disbursement',
      amount_cents: payoutResult.intent.amount_cents,
      idempotency_key: payoutResult.intent.idempotency_key,
      status: payoutResult.intent.status,
      source_label: payoutResult.intent.source_label || KNOWN_APPROVED_MOOV.freedom.walletLabel,
      destination_label: payoutResult.intent.destination_label || KNOWN_APPROVED_MOOV.recipient.bankLabel,
      recipient_label: payoutResult.intent.recipient_label || KNOWN_APPROVED_MOOV.recipient.displayName,
      reused: payoutResult.reused,
      created: payoutResult.created,
      blocked: effectivePayoutState !== 'payout_ready',
    },
    totp: {
      funding: amounts.decision === DECISION.FUND_FIRST ? {
        action: MOOV_FUND_TOTP_ACTION,
        amount_cents: amounts.shortfall_cents,
        source_label: KNOWN_APPROVED_MOOV.freedom.fundingBankLabel,
        destination_label: KNOWN_APPROVED_MOOV.freedom.walletLabel,
        consumed: false,
      } : null,
      payout: {
        action: MOOV_DISBURSE_TOTP_ACTION,
        amount_cents: amounts.payout_cents,
        source_label: KNOWN_APPROVED_MOOV.freedom.walletLabel,
        recipient_label: KNOWN_APPROVED_MOOV.recipient.displayName,
        destination_label: KNOWN_APPROVED_MOOV.recipient.bankLabel,
        consumed: false,
      },
      deposit_submit_reused: false,
      deposit_submit_action: MOOV_DEPOSIT_TOTP_ACTION,
    },
    ux: {
      payout_requested: amounts.payout_cents,
      wallet_available: amounts.available_cents,
      funding_required: amounts.shortfall_cents,
      funding_source: KNOWN_APPROVED_MOOV.freedom.fundingBankLabel,
      recipient: KNOWN_APPROVED_MOOV.recipient.bankLabel,
      recipient_name: KNOWN_APPROVED_MOOV.recipient.displayName,
      stage: ux_stage,
      stage_label: UX_STAGE_LABEL[ux_stage],
      actions,
    },
    webhook_role: 'read_update_existing_intents_only',
    get_reconciliation_role: 'read_update_existing_intents_only',
  };
};

export const webhookMayCreateMoneyIntent = () => false;
export const getReconciliationMayCreateMoneyIntent = () => false;
