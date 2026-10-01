/**
 * WalletOps automatic-payout (sweep) activity. Fixtures only. No provider writes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  isAutomaticPayoutDescription,
  isSweepInFlight,
  summarizeSweepActivity,
  sweepAmountCents,
  sweepTimestamp,
} from '../../src/lib/payments/walletSweepActivity.ts';
import { purposeOfTransfer } from '../../src/lib/payments/walletRelativeTransfers.ts';

test('1 dollar-string sweep amounts become cents', () => {
  assert.equal(sweepAmountCents({ transferAmount: '5.00', accruedAmount: '5.00' }), 500);
  assert.equal(sweepAmountCents({ accruedAmount: '0.01' }), 1);
  assert.equal(sweepAmountCents({ accruedAmount: '0.00' }), 0);
});

test('2 closed $5 sweep is Pending Out and Automatic payout', () => {
  const summary = summarizeSweepActivity({
    sweeps: [{
      sweepID: '2d11f2b6-16ad-4b2e-af4d-d8a1d2aad238',
      status: 'closed',
      transferID: '5e3f49e4-d12d-4ba1-93e1-c830c672a648',
      transferAmount: '5.00',
      accruedAmount: '5.00',
    }],
    settlementLabel: 'WELLS FARGO BANK ••••4573',
  });
  assert.equal(summary.pendingOutCents, 500);
  assert.equal(summary.rows.length, 1);
  assert.equal(summary.rows[0].title, 'Automatic payout');
  assert.match(summary.rows[0].detail, /WELLS FARGO/);
});

test('3 paid sweep stays in activity but not Pending Out', () => {
  const summary = summarizeSweepActivity({
    sweeps: [{
      sweepID: '4afcef2f-f091-4571-93c5-89fc32ef47e5',
      status: 'paid',
      transferID: '4e39f67f-383f-44d4-b5f8-212d4cc29bb0',
      transferAmount: '0.01',
    }],
  });
  assert.equal(summary.pendingOutCents, 0);
  assert.equal(summary.rows.length, 1);
});

test('4 accruing zero-dollar sweep is omitted', () => {
  const summary = summarizeSweepActivity({
    sweeps: [{ sweepID: 'ea0757eb-43b8-45eb-b888-19652351f4f4', status: 'accruing', accruedAmount: '0.00' }],
  });
  assert.equal(summary.pendingOutCents, 0);
  assert.equal(summary.rows.length, 0);
});

test('5 already-listed transfer is not double counted', () => {
  const summary = summarizeSweepActivity({
    sweeps: [{
      sweepID: '2d11f2b6-16ad-4b2e-af4d-d8a1d2aad238',
      status: 'closed',
      transferID: '5e3f49e4-d12d-4ba1-93e1-c830c672a648',
      transferAmount: '5.00',
    }],
    knownTransferIds: ['5e3f49e4-d12d-4ba1-93e1-c830c672a648'],
  });
  assert.equal(summary.pendingOutCents, 0);
  assert.equal(summary.rows.length, 0);
});

test('6 sweepID description is labeled Automatic payout', () => {
  assert.equal(isAutomaticPayoutDescription('sweepID: 2d11f2b6-16ad-4b2e-af4d-d8a1d2aad238'), true);
  assert.equal(isSweepInFlight('closed'), true);
  assert.equal(isSweepInFlight('paid'), false);
  assert.equal(purposeOfTransfer({
    id: 'local',
    amount_cents: 500,
    description: 'sweepID: 2d11f2b6-16ad-4b2e-af4d-d8a1d2aad238',
  }, { isWalletSource: true, isWalletDestination: false }), 'Automatic payout');
});

test('7 sweep history uses the wallet-scoped Moov path', () => {
  const shared = readFileSync(new URL('../../supabase/functions/_shared/moovSweeps.ts', import.meta.url), 'utf8');
  const reader = readFileSync(new URL('../../aws/functions/api/providers/parity/sweep-read.mjs', import.meta.url), 'utf8');
  assert.match(shared, /\/accounts\/\$\{accountId\}\/wallets\/\$\{encodeURIComponent\(walletId\)\}\/sweeps/);
  assert.match(reader, /\/accounts\/\$\{accountId\}\/wallets\/\$\{encodeURIComponent\(walletId\)\}\/sweeps/);
  assert.doesNotMatch(shared, /\/accounts\/\$\{accountId\}\/sweeps\?walletID=/);
  assert.doesNotMatch(reader, /\/accounts\/\$\{accountId\}\/sweeps\?walletID=/);
});

test('8 last payout date uses accrualEndedOn when createdOn is missing', () => {
  const at = sweepTimestamp({
    sweepID: '2d11f2b6-16ad-4b2e-af4d-d8a1d2aad238',
    transferAmount: '5.00',
    accrualEndedOn: '2026-10-01T20:00:15Z',
  });
  assert.equal(at, '2026-10-01T20:00:15Z');
});

test('9 disable looks up the sweep config when the id is omitted', () => {
  const onboard = readFileSync(new URL('../../aws/functions/api/providers/parity/moov-onboard.mjs', import.meta.url), 'utf8');
  assert.match(onboard, /There is no automatic payout to turn off/);
  assert.match(onboard, /sweepConfigID/);
});
