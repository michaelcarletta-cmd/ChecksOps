import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONFIRMED_MONEY_STATUSES,
  MONEY_IN_OPERATION_TYPES,
} from '../functions/api/financial-remaining.mjs';
import {
  PAYEE_LINE_LOCKED,
  isCheckDeposited,
  payeeLineValuesEqual,
  rejectPayeeLineIfDeposited,
  resolveWritablePayeeLine,
} from '../functions/api/check-deposited.mjs';

const CHECK_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const mockClient = ({
  deposited_at = null,
  payee_line = 'Original Payee Line',
  confirmedDeposit = false,
  throwOn = null,
  missing = false,
} = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql: String(sql), params });
      if (throwOn && String(sql).includes(throwOn)) throw new Error('synthetic lookup failure');
      if (/SELECT deposited_at, payee_line/.test(sql)) {
        return { rows: missing ? [] : [{ deposited_at, payee_line }] };
      }
      if (/FROM public.aws_financial_operations/.test(sql)) {
        assert.deepEqual(params[1], [...MONEY_IN_OPERATION_TYPES]);
        assert.deepEqual(params[2], [...CONFIRMED_MONEY_STATUSES]);
        return { rows: confirmedDeposit ? [{ ok: 1 }] : [] };
      }
      return { rows: [] };
    },
  };
};

test('isCheckDeposited is false when deposited_at is null and no confirmed deposit', async () => {
  const state = await isCheckDeposited(mockClient(), CHECK_ID);
  assert.equal(state.deposited, false);
  assert.equal(state.reason, 'not_deposited');
  assert.equal(state.failClosed, false);
});

test('isCheckDeposited is true when deposited_at is set', async () => {
  const state = await isCheckDeposited(mockClient({ deposited_at: '2026-09-25T00:00:00Z' }), CHECK_ID);
  assert.equal(state.deposited, true);
  assert.equal(state.reason, 'deposited_at');
});

test('isCheckDeposited is true when a confirmed provider deposit exists', async () => {
  const state = await isCheckDeposited(mockClient({ confirmedDeposit: true }), CHECK_ID);
  assert.equal(state.deposited, true);
  assert.equal(state.reason, 'confirmed_provider_deposit');
});

test('isCheckDeposited fails closed on lookup errors, missing rows, and invalid ids', async () => {
  const failed = await isCheckDeposited(mockClient({ throwOn: 'check_intake_items' }), CHECK_ID);
  assert.equal(failed.deposited, true);
  assert.equal(failed.failClosed, true);
  assert.equal(failed.reason, 'lookup_failed');

  const missing = await isCheckDeposited(mockClient({ missing: true }), CHECK_ID);
  assert.equal(missing.deposited, true);
  assert.equal(missing.reason, 'check_not_found');

  const invalid = await isCheckDeposited(mockClient(), 'not-a-uuid');
  assert.equal(invalid.deposited, true);
  assert.equal(invalid.reason, 'invalid_check_id');

  const noClient = await isCheckDeposited(null, CHECK_ID);
  assert.equal(noClient.deposited, true);
  assert.equal(noClient.reason, 'lookup_failed');
});

test('same-value payee_line is a no-op and never locked', async () => {
  assert.equal(payeeLineValuesEqual('  Foo  ', 'Foo'), true);
  const guard = await rejectPayeeLineIfDeposited(
    mockClient({ deposited_at: '2026-09-25T00:00:00Z' }),
    CHECK_ID,
    { current: 'Corrected Payee Line', next: 'Corrected Payee Line' },
  );
  assert.equal(guard.locked, false);
  assert.equal(guard.noop, true);
});

test('changed payee_line is rejected after deposited_at or confirmed deposit', async () => {
  const afterStamp = await rejectPayeeLineIfDeposited(
    mockClient({ deposited_at: '2026-09-25T00:00:00Z' }),
    CHECK_ID,
    { current: 'Corrected Payee Line', next: 'Anything Else' },
  );
  assert.equal(afterStamp.locked, true);
  assert.equal(afterStamp.error, PAYEE_LINE_LOCKED);
  assert.equal(afterStamp.reason, 'deposited_at');

  const afterConfirm = await rejectPayeeLineIfDeposited(
    mockClient({ confirmedDeposit: true }),
    CHECK_ID,
    { current: 'Corrected Payee Line', next: 'Anything Else' },
  );
  assert.equal(afterConfirm.locked, true);
  assert.equal(afterConfirm.reason, 'confirmed_provider_deposit');
});

test('lookup failure while changing payee_line fails closed', async () => {
  const guard = await rejectPayeeLineIfDeposited(
    mockClient({ throwOn: 'aws_financial_operations' }),
    CHECK_ID,
    { current: 'Corrected Payee Line', next: 'Anything Else' },
  );
  assert.equal(guard.locked, true);
  assert.equal(guard.failClosed, true);
  assert.equal(guard.reason, 'lookup_failed');
});

test('resolveWritablePayeeLine returns incoming only when not deposited', async () => {
  const open = await resolveWritablePayeeLine(
    mockClient({ payee_line: 'Original Payee Line' }),
    CHECK_ID,
    'Corrected Payee Line',
  );
  assert.equal(open.value, 'Corrected Payee Line');
  assert.equal(open.locked, false);

  const locked = await resolveWritablePayeeLine(
    mockClient({ confirmedDeposit: true, payee_line: 'Corrected Payee Line' }),
    CHECK_ID,
    'OCR Rewrite',
  );
  assert.equal(locked.value, null);
  assert.equal(locked.locked, true);
});
