/**
 * Shared S14 deposited-state predicate for payee_line locks.
 * A check is deposited when deposited_at is set OR a confirmed provider
 * deposit exists (same money-in types/statuses as the AWS financial path).
 * Lookup failures fail closed.
 */
import {
  CONFIRMED_MONEY_STATUSES,
  MONEY_IN_OPERATION_TYPES,
} from './financial-remaining.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PAYEE_LINE_LOCKED = 'payee_line_locked';

export const payeeLineValuesEqual = (left, right) => {
  const a = left == null ? '' : String(left).trim();
  const b = right == null ? '' : String(right).trim();
  return a === b;
};

export const isCheckDeposited = async (client, checkId) => {
  if (!client || typeof client.query !== 'function') {
    return {
      deposited: true,
      failClosed: true,
      reason: 'lookup_failed',
      payee_line: null,
    };
  }
  if (!UUID_RE.test(String(checkId || ''))) {
    return {
      deposited: true,
      failClosed: true,
      reason: 'invalid_check_id',
      payee_line: null,
    };
  }
  try {
    const intake = await client.query(
      `SELECT deposited_at, payee_line
         FROM public.check_intake_items
        WHERE id = $1::uuid`,
      [checkId],
    );
    if (!intake.rows?.length) {
      return {
        deposited: true,
        failClosed: true,
        reason: 'check_not_found',
        payee_line: null,
      };
    }
    const row = intake.rows[0];
    const payeeLine = row.payee_line ?? null;
    if (row.deposited_at) {
      return {
        deposited: true,
        failClosed: false,
        reason: 'deposited_at',
        payee_line: payeeLine,
      };
    }
    const ops = await client.query(
      `SELECT 1
         FROM public.aws_financial_operations
        WHERE resource_type = 'check'
          AND resource_id = $1::uuid
          AND operation_type = ANY($2::text[])
          AND status = ANY($3::text[])
        LIMIT 1`,
      [checkId, [...MONEY_IN_OPERATION_TYPES], [...CONFIRMED_MONEY_STATUSES]],
    );
    if (ops.rows?.length) {
      return {
        deposited: true,
        failClosed: false,
        reason: 'confirmed_provider_deposit',
        payee_line: payeeLine,
      };
    }
    return {
      deposited: false,
      failClosed: false,
      reason: 'not_deposited',
      payee_line: payeeLine,
    };
  } catch {
    return {
      deposited: true,
      failClosed: true,
      reason: 'lookup_failed',
      payee_line: null,
    };
  }
};

export const rejectPayeeLineIfDeposited = async (client, checkId, { current, next } = {}) => {
  if (payeeLineValuesEqual(current, next)) {
    return { locked: false, noop: true };
  }
  const state = await isCheckDeposited(client, checkId);
  if (state.deposited) {
    return {
      locked: true,
      noop: false,
      error: PAYEE_LINE_LOCKED,
      message: 'payee_line cannot change after deposit',
      reason: state.reason,
      failClosed: state.failClosed === true,
    };
  }
  return { locked: false, noop: false, reason: state.reason };
};

export const resolveWritablePayeeLine = async (client, checkId, incoming, current) => {
  const state = await isCheckDeposited(client, checkId);
  const resolvedCurrent = current !== undefined ? current : state.payee_line;
  if (payeeLineValuesEqual(resolvedCurrent, incoming)) {
    return {
      value: null,
      locked: false,
      noop: true,
      deposited: state.deposited,
      reason: state.reason,
    };
  }
  if (state.deposited) {
    return {
      value: null,
      locked: true,
      noop: false,
      error: PAYEE_LINE_LOCKED,
      message: 'payee_line cannot change after deposit',
      reason: state.reason,
      failClosed: state.failClosed === true,
    };
  }
  return { value: incoming, locked: false, noop: false, reason: state.reason };
};

export const __test__ = {
  PAYEE_LINE_LOCKED,
  payeeLineValuesEqual,
};
