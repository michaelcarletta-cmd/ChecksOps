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
  bankDepositDayOf,
  groupBankDeposits,
  isBankDepositSettled,
  isOnBankDeposits,
  localDayKey,
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
  assert.match(summary.description, /Ref 127491751: now deposited\./);
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

test('Bank Deposits lists every check that passed to Check Alt under its deposit day; waiting checks are not listed', () => {
  const rows = [
    row('a', 'cleared', { amount: 5, cleared_at: '2026-10-22T00:00:00.000Z' }),
    row('b', 'submitted', { amount: 7.5, submitted_at: '2026-10-22T15:00:00.000Z' }),
    row('c', 'cleared', { amount: 10, cleared_at: '2026-10-20T00:00:00.000Z' }),
    row('d', 'pending_approval'),
    row('e', 'rejected'),
    // cleared without a stored deposit date: listed on the day it was sent
    row('f', 'cleared', { amount: 2, cleared_at: null, submitted_at: '2026-10-21T15:00:00.000Z' }),
  ];
  const grouped = groupBankDeposits(rows);
  assert.deepEqual(grouped.days.map((d) => [d.dayKey, d.total, d.rows.map((r) => r.id)]), [
    ['2026-10-22', 12.5, ['a', 'b']],
    ['2026-10-21', 2, ['f']],
    ['2026-10-20', 10, ['c']],
  ]);
  assert.equal(grouped.total, 24.5);
  assert.equal(isOnBankDeposits({ status: 'pending_approval' }), false);
  assert.equal(isOnBankDeposits({ status: 'submitted' }), true);
  assert.equal(isBankDepositSettled({ status: 'submitted', cleared_at: '2026-10-22T12:00:00.000Z' }), false);
  // A cleared deposit uses the Check Alt depositDate as stored (no time zone shift).
  assert.equal(bankDepositDayOf({ status: 'cleared', cleared_at: '2026-10-22T00:00:00.000Z', submitted_at: '2026-10-19T15:00:00.000Z' }), '2026-10-22');
  assert.equal(bankDepositDayOf({ status: 'submitted', submitted_at: '2026-10-22T15:00:00.000Z' }), localDayKey('2026-10-22T15:00:00.000Z'));
  assert.equal(bankDepositDayKey(null), 'unknown');
  assert.equal(localDayKey('not-a-date'), 'unknown');
});

test('Bank Deposits page shows only deposit dates that drop down to their checks', () => {
  const src = fs.readFileSync(path.join(SPA, 'components/deposit-ops/BankDepositReconciliation.tsx'), 'utf8');
  assert.match(src, /groupBankDeposits\(rows\)/);
  assert.match(src, /\.in\("status", \["submitted", "cleared"\]\)/);
  assert.match(src, /"MMMM d, yyyy"/);
  for (const gone of [/In transit/, /waiting in Check Alt/i, /Deposited into your bank/, /inTransit/]) {
    assert.equal(gone.test(src), false, String(gone));
  }
  assert.equal(/"Pending"/.test(src), false);
});

test('Poll Now summary says how many deposits are left for the next click', () => {
  const summary = checkAltPollSummary({
    polled: 1,
    updated: 1,
    errors: 0,
    remaining: 3,
    stopped_early: 'time_budget',
    deposits: [{ checkalt_reference: '9001', status: 'submitted', previous_status: 'pending_approval', reconciled: true }],
  });
  assert.equal(summary.title, 'Checked 1 deposit; 1 changed');
  assert.match(summary.description, /Ref 9001: now deposited\./);
  assert.match(summary.description, /Check Alt is slow to answer, so 3 more deposits were not checked\. Click Poll Now again to check them\./);
  const unreachable = checkAltPollSummary({ polled: 1, remaining: 1, stopped_early: 'checkalt_unreachable', deposits: [{ checkalt_reference: '9001', status: 'submitted', previous_status: 'submitted', reconciled: true }] });
  assert.match(unreachable.description, /Check Alt stopped answering in time, so 1 more deposit was not checked\. Click Poll Now again to check it\./);
});
