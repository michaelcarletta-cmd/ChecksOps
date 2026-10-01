/**
 * Sweep history path and row normalization. No provider writes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSweepHistoryRows } from '../functions/api/providers/parity/sweep-read.mjs';

test('normalize fills createdOn/completedOn from accrual timestamps', () => {
  const [row] = normalizeSweepHistoryRows([{
    sweepID: '2d11f2b6-16ad-4b2e-af4d-d8a1d2aad238',
    status: 'closed',
    transferID: '5e3f49e4-d12d-4ba1-93e1-c830c672a648',
    transferAmount: '5.00',
    accrualStartedOn: '2026-10-01T00:00:00Z',
    accrualEndedOn: '2026-10-01T20:00:15Z',
  }]);
  assert.equal(row.createdOn, '2026-10-01T00:00:00Z');
  assert.equal(row.completedOn, '2026-10-01T20:00:15Z');
  assert.equal(row.transferAmount, '5.00');
});
