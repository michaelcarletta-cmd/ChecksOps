/**
 * Poll Now client call and Bank Deposits grouping (2026-10-22).
 * Owner: "Bank deposit should only show the checks that were deposited and on
 * what day they were deposited."
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { invokeAwsCheckAltProviderFunction } from '../../src/lib/awsCheckAltMoneyPath.ts';
import { checkAltPollErrorText, checkAltPollSummary } from '../../src/lib/checkAltPollResult.ts';
import {
  bankDepositDayKey,
  groupBankDeposits,
  inTransitStatusLabel,
  isBankDepositSettled,
} from '../../src/lib/bankDepositGroups.ts';

const SPA = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src');

test('Poll Now posts an empty body to same-origin /prep/functions/v1/checkalt-poll-status with the Cognito id token', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ polled: 1, updated: 1, errors: 0, deposits: [] }) };
  };
  const result = await invokeAwsCheckAltProviderFunction('checkalt-poll-status', { body: {} }, {
    authProvider: 'cognito',
    apiBaseUrl: 'https://checksops.com/prep',
    idToken: 'id-token',
    fetchImpl,
  });
  assert.equal(result.error, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://checksops.com/prep/functions/v1/checkalt-poll-status');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer id-token');
  assert.equal(calls[0].init.body, '{}');
});

test('Poll Now turns the production 503 into plain words', async () => {
  const fetchImpl = async () => ({ ok: false, json: async () => ({ ok: false, error: 'checkalt_config_unreadable' }) });
  const result = await invokeAwsCheckAltProviderFunction('checkalt-poll-status', { body: {} }, {
    authProvider: 'cognito', apiBaseUrl: 'https://checksops.com/prep', idToken: 't', fetchImpl,
  });
  assert.equal(result.error.message, 'checkalt_config_unreadable');
  assert.equal(checkAltPollErrorText(result.error.message), 'ChecksOps could not read its Check Alt settings, so nothing was checked.');
  assert.equal(checkAltPollErrorText('something_new'), 'something_new');
});

test('Poll Now summary names each deposit and why an unresolved one was left unchanged', () => {
  const summary = checkAltPollSummary({
    polled: 2,
    updated: 1,
    errors: 1,
    deposits: [
      { checkalt_reference: '127491751', status: 'submitted', previous_status: 'pending_approval', reconciled: true },
      {
        checkalt_reference: '9002',
        status: 'pending_approval',
        previous_status: 'pending_approval',
        reconciled: false,
        message: 'Check Alt returned its full page of 50 recent deposits and this deposit was not among them. The status was left unchanged; it will be checked again.',
      },
    ],
  });
  assert.equal(summary.title, 'Checked 2 deposits; 1 not resolved');
  assert.match(summary.description, /Ref 127491751: now approved, not yet deposited\./);
  assert.match(summary.description, /Ref 9002: Check Alt returned its full page of 50/);
  assert.deepEqual(checkAltPollSummary({ polled: 0, deposits: [] }), {
    title: 'Nothing to refresh', description: 'No deposits are waiting on Check Alt.',
  });
});

test('Waiting in Check Alt Poll Now shows the per-deposit result and refreshes Bank Deposits', () => {
  const settings = fs.readFileSync(path.join(SPA, 'components/settings/CheckAltSettings.tsx'), 'utf8');
  const waiting = settings.split('export function PendingApprovalDeposits')[1].split('export function CheckAltDepositHistory')[0];
  assert.match(waiting, /checkAltPollSummary\(data\)/);
  assert.match(waiting, /checkAltPollErrorText\(/);
  assert.match(waiting, /queryKey: \["bank-deposit-reconciliation"\]/);
  assert.match(waiting, /body: \{\}/);
});

const row = (id, status, extra = {}) => ({ id, status, amount: 5, cleared_at: null, submitted_at: '2026-10-22T01:53:56.000Z', ...extra });

test('Bank Deposits lists only deposited checks, grouped by the Check Alt deposit day with daily totals', () => {
  const rows = [
    row('a', 'cleared', { amount: 5, cleared_at: '2026-10-22T12:00:00.000Z' }),
    row('b', 'cleared', { amount: 7.5, cleared_at: '2026-10-22T12:00:00.000Z' }),
    row('c', 'cleared', { amount: 10, cleared_at: '2026-10-20T12:00:00.000Z' }),
    row('d', 'pending_approval'),
    row('e', 'submitted', { submitted_at: '2026-10-21T10:00:00.000Z' }),
    // cleared without a stored deposit date is not deposited
    row('f', 'cleared', { cleared_at: null }),
    row('g', 'cleared', { cleared_at: 'not-a-date' }),
  ];
  const grouped = groupBankDeposits(rows);
  assert.deepEqual(grouped.days.map((d) => [d.dayKey, d.total, d.rows.map((r) => r.id)]), [
    ['2026-10-22', 12.5, ['a', 'b']],
    ['2026-10-20', 10, ['c']],
  ]);
  assert.equal(grouped.depositedTotal, 22.5);
  assert.deepEqual(grouped.inTransit.map((r) => r.id).sort(), ['d', 'e', 'f', 'g']);
  assert.equal(grouped.inTransitTotal, 20);
  // submitted_at is never a deposit day.
  assert.equal(grouped.days.some((d) => d.dayKey === '2026-10-21'), false);
  assert.equal(isBankDepositSettled({ status: 'submitted', cleared_at: '2026-10-22T12:00:00.000Z' }), false);
  assert.equal(bankDepositDayKey(null), 'unknown');
  assert.equal(inTransitStatusLabel('pending_approval'), 'Waiting in Check Alt');
  assert.equal(inTransitStatusLabel('submitted'), 'Approved, not yet deposited');
});

test('Bank Deposits page renders deposit days and a separate In transit / waiting in Check Alt section', () => {
  const src = fs.readFileSync(path.join(SPA, 'components/deposit-ops/BankDepositReconciliation.tsx'), 'utf8');
  assert.match(src, /groupBankDeposits\(rows\)/);
  assert.match(src, /In transit \/ waiting in Check Alt/);
  assert.match(src, /Deposited into your bank/);
  assert.equal(/row\.cleared_at \?\? row\.submitted_at/.test(src), false);
  assert.equal(/"Pending"/.test(src), false);
});
