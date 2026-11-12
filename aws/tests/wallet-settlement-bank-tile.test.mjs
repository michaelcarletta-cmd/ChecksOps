// Settlement bank tile (owner, 2026-11-12): a bank on file shows even while the provider is
// unreachable or the connection is pending; loading and errors are shown, never a blank.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settlementBankTile } from '../../src/lib/payments/walletSweepActivity.ts';

test('settlementBankTile: pending bank, connected bank, loading, error, none', () => {
  assert.deepEqual(
    settlementBankTile({ settlementMethod: { bank_name: 'FIRST BANK', last_four: '1234', connection_status: 'pending' } }),
    { text: 'FIRST BANK ••1234', note: 'Bank on file; the payment network is still finishing the connection.' },
  );
  assert.deepEqual(
    settlementBankTile({ settlementMethod: { bank_name: 'X', last_four: '9', connection_status: 'connected' } }),
    { text: 'X ••9', note: null },
  );
  assert.equal(settlementBankTile({ settlementMethod: null, isLoading: true }).text, 'Loading…');
  assert.deepEqual(settlementBankTile({ settlementMethod: null, error: { message: 'boom' } }), { text: "Couldn't load", note: 'boom' });
  assert.deepEqual(settlementBankTile({ settlementMethod: null }), { text: 'Not connected', note: null });
});
