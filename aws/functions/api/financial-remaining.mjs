/**
 * Server-authoritative remaining balance for S11 partial disbursement.
 * Browser amounts are not a source. Failed/cancelled out counts as $0.
 */

export const MONEY_IN_OPERATION_TYPES = new Set(['checkalt_deposit']);

export const MONEY_OUT_OPERATION_TYPES = new Set([
  'disbursement',
  'pay_homeowner',
  'pay_contractor',
  'pay_vendor',
  'ach',
  'rtp',
  'wire',
]);

export const CONFIRMED_MONEY_STATUSES = new Set([
  'provider_confirmed',
  'settled',
]);

export const RESERVED_MONEY_OUT_STATUSES = new Set([
  'ready_for_provider',
  'submitting',
  'provider_pending',
]);

export const UNSUCCESSFUL_MONEY_OUT_STATUSES = new Set([
  'provider_failed',
  'cancelled',
  'returned',
  'reversed',
]);

const positiveCents = (value) => {
  const cents = Number(value);
  return Number.isInteger(cents) && cents > 0 ? cents : 0;
};

export const isMoneyOutOperation = (operationType) => (
  MONEY_OUT_OPERATION_TYPES.has(String(operationType || ''))
);

export const summarizeCheckMoney = (operations = []) => {
  let confirmedIn = 0;
  let confirmedOut = 0;
  let reservedOut = 0;
  const successfulOut = [];
  for (const operation of operations) {
    const cents = positiveCents(operation?.amount_cents);
    const type = String(operation?.operation_type || '');
    const status = String(operation?.status || '');
    if (MONEY_IN_OPERATION_TYPES.has(type) && CONFIRMED_MONEY_STATUSES.has(status)) {
      confirmedIn += cents;
    }
    if (!MONEY_OUT_OPERATION_TYPES.has(type)) continue;
    if (CONFIRMED_MONEY_STATUSES.has(status)) {
      confirmedOut += cents;
      successfulOut.push({
        id: operation.id,
        operation_type: type,
        amount_cents: cents,
        status,
        disbursement_sequence: Number(operation.metadata?.disbursement_sequence) || null,
      });
    } else if (RESERVED_MONEY_OUT_STATUSES.has(status)) {
      reservedOut += cents;
    }
  }
  const remaining = Math.max(0, confirmedIn - confirmedOut);
  const available = Math.max(0, confirmedIn - confirmedOut - reservedOut);
  return {
    confirmed_in_cents: confirmedIn,
    confirmed_out_cents: confirmedOut,
    reserved_out_cents: reservedOut,
    remaining_cents: remaining,
    available_to_reserve_cents: available,
    fully_disbursed: confirmedIn > 0 && remaining === 0,
    successful_out: successfulOut,
  };
};

export const parseRequestedPartialCents = (body = {}) => {
  const present = Object.prototype.hasOwnProperty.call(body, 'requested_partial_cents')
    || Object.prototype.hasOwnProperty.call(body, 'requestedPartialCents');
  if (!present) return { present: false };
  const raw = body.requested_partial_cents ?? body.requestedPartialCents;
  if (raw === null || raw === '') {
    return { error: 'invalid_partial_amount', message: 'requested_partial_cents must be integer cents > 0' };
  }
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) {
      return { error: 'invalid_partial_amount', message: 'requested_partial_cents must be integer cents' };
    }
    if (raw <= 0) {
      return { error: 'invalid_partial_amount', message: 'requested_partial_cents must be > 0' };
    }
    return { present: true, cents: raw };
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^[0-9]+$/.test(trimmed)) {
      return { error: 'invalid_partial_amount', message: 'requested_partial_cents must be integer cents' };
    }
    const cents = Number(trimmed);
    if (!Number.isInteger(cents) || cents <= 0) {
      return { error: 'invalid_partial_amount', message: 'requested_partial_cents must be > 0' };
    }
    return { present: true, cents };
  }
  return { error: 'invalid_partial_amount', message: 'requested_partial_cents must be integer cents' };
};

export const parseDisbursementSequence = (body = {}) => {
  const present = Object.prototype.hasOwnProperty.call(body, 'disbursement_sequence')
    || Object.prototype.hasOwnProperty.call(body, 'disbursementSequence');
  if (!present) return { present: false };
  const raw = body.disbursement_sequence ?? body.disbursementSequence;
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw <= 0) {
      return { error: 'invalid_disbursement_sequence', message: 'disbursement_sequence must be a positive integer' };
    }
    return { present: true, sequence: raw };
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^[0-9]+$/.test(trimmed)) {
      return { error: 'invalid_disbursement_sequence', message: 'disbursement_sequence must be a positive integer' };
    }
    const sequence = Number(trimmed);
    if (!Number.isInteger(sequence) || sequence <= 0) {
      return { error: 'invalid_disbursement_sequence', message: 'disbursement_sequence must be a positive integer' };
    }
    return { present: true, sequence };
  }
  return { error: 'invalid_disbursement_sequence', message: 'disbursement_sequence must be a positive integer' };
};

export const nextDisbursementSequence = (operations, operationType) => {
  let max = 0;
  for (const operation of operations) {
    if (String(operation?.operation_type || '') !== String(operationType || '')) continue;
    const sequence = Number(operation?.metadata?.disbursement_sequence);
    if (Number.isInteger(sequence) && sequence > max) max = sequence;
  }
  return max + 1;
};

export const findOperationBySequence = (operations, operationType, sequence) => (
  operations.find((operation) => (
    String(operation?.operation_type || '') === String(operationType || '')
    && Number(operation?.metadata?.disbursement_sequence) === Number(sequence)
  )) || null
);

export const findReservedRemainingDraw = (operations, operationType) => {
  const reserved = operations.filter((operation) => (
    String(operation?.operation_type || '') === String(operationType || '')
    && operation?.metadata?.draw_kind === 'remaining'
    && RESERVED_MONEY_OUT_STATUSES.has(String(operation?.status || ''))
  ));
  return reserved.at(-1) || null;
};

export const lockCheckMoney = async (client, checkId) => {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [checkId]);
};

export const loadCheckOperations = async (client, checkId) => (
  (await client.query(
    `SELECT * FROM public.aws_financial_operations
      WHERE resource_type = 'check' AND resource_id = $1::uuid
      ORDER BY created_at ASC`,
    [checkId],
  )).rows
);
