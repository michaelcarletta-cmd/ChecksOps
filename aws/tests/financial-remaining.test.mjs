import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stableIdempotencyKey } from '../functions/api/financial-idempotency.mjs';
import {
  parseDisbursementSequence,
  parseRequestedPartialCents,
  summarizeCheckMoney,
} from '../functions/api/financial-remaining.mjs';
import { rejectUntrustedAmountFields } from '../functions/api/providers/amounts.mjs';

test('remaining is confirmed in minus confirmed out and never negative', () => {
  const summary = summarizeCheckMoney([
    { id: 'in', operation_type: 'checkalt_deposit', amount_cents: 20000, status: 'provider_confirmed' },
    { id: 'out1', operation_type: 'disbursement', amount_cents: 5000, status: 'provider_confirmed', metadata: { disbursement_sequence: 1 } },
    { id: 'fail', operation_type: 'disbursement', amount_cents: 10000, status: 'provider_failed', metadata: { disbursement_sequence: 2 } },
    { id: 'cancel', operation_type: 'pay_homeowner', amount_cents: 4000, status: 'cancelled', metadata: { disbursement_sequence: 1 } },
    { id: 'reserved', operation_type: 'disbursement', amount_cents: 5000, status: 'ready_for_provider', metadata: { disbursement_sequence: 3 } },
  ]);
  assert.equal(summary.confirmed_in_cents, 20000);
  assert.equal(summary.confirmed_out_cents, 5000);
  assert.equal(summary.reserved_out_cents, 5000);
  assert.equal(summary.remaining_cents, 15000);
  assert.equal(summary.available_to_reserve_cents, 10000);
  assert.equal(summary.fully_disbursed, false);
  assert.equal(summary.successful_out.length, 1);
});

test('failed and cancelled money-out do not reduce remaining', () => {
  const summary = summarizeCheckMoney([
    { operation_type: 'checkalt_deposit', amount_cents: 20000, status: 'settled' },
    { operation_type: 'disbursement', amount_cents: 20000, status: 'provider_failed' },
    { operation_type: 'disbursement', amount_cents: 5000, status: 'cancelled' },
    { operation_type: 'disbursement', amount_cents: 5000, status: 'returned' },
    { operation_type: 'disbursement', amount_cents: 5000, status: 'reversed' },
  ]);
  assert.equal(summary.remaining_cents, 20000);
  assert.equal(summary.confirmed_out_cents, 0);
  assert.equal(summary.fully_disbursed, false);
});

test('fully disbursed only when remaining is exactly zero after confirmed in', () => {
  const empty = summarizeCheckMoney([]);
  assert.equal(empty.fully_disbursed, false);
  const done = summarizeCheckMoney([
    { operation_type: 'checkalt_deposit', amount_cents: 20000, status: 'provider_confirmed' },
    { operation_type: 'disbursement', amount_cents: 20000, status: 'settled' },
  ]);
  assert.equal(done.remaining_cents, 0);
  assert.equal(done.fully_disbursed, true);
});

test('requested_partial_cents is a request field and amount_cents stays untrusted', () => {
  assert.equal(parseRequestedPartialCents({}).present, false);
  assert.equal(parseRequestedPartialCents({ requested_partial_cents: 5000 }).cents, 5000);
  assert.equal(parseRequestedPartialCents({ requested_partial_cents: 0 }).error, 'invalid_partial_amount');
  assert.equal(parseRequestedPartialCents({ requested_partial_cents: -1 }).error, 'invalid_partial_amount');
  assert.equal(parseRequestedPartialCents({ requested_partial_cents: 50.5 }).error, 'invalid_partial_amount');
  assert.equal(parseRequestedPartialCents({ requested_partial_cents: 'abc' }).error, 'invalid_partial_amount');
  assert.equal(parseDisbursementSequence({ disbursement_sequence: 2 }).sequence, 2);
  assert.equal(parseDisbursementSequence({ disbursement_sequence: 0 }).error, 'invalid_disbursement_sequence');
  const untrusted = rejectUntrustedAmountFields({ requested_partial_cents: 5000, check_id: 'x' });
  assert.equal(untrusted, null);
  assert.equal(rejectUntrustedAmountFields({ amount_cents: 5000 }).error, 'untrusted_amount');
});

test('idempotency uses sequence not amount for money-out identity', () => {
  const first = stableIdempotencyKey({
    tenantId: 't', operationType: 'disbursement', resourceId: 'c', amountCents: 5000, disbursementSequence: 1,
  });
  const retry = stableIdempotencyKey({
    tenantId: 't', operationType: 'disbursement', resourceId: 'c', amountCents: 5000, disbursementSequence: 1,
  });
  const second = stableIdempotencyKey({
    tenantId: 't', operationType: 'disbursement', resourceId: 'c', amountCents: 5000, disbursementSequence: 2,
  });
  const deposit = stableIdempotencyKey({
    tenantId: 't', operationType: 'checkalt_deposit', resourceId: 'c', amountCents: 20000,
  });
  assert.equal(first, retry);
  assert.notEqual(first, second);
  assert.notEqual(first, deposit);
});
