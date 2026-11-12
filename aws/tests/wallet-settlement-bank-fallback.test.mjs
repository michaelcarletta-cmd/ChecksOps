/**
 * Wallet & Treasury settlement bank (owner, 2026-11-12: Condition One's settlement bank showed nothing
 * although its own verified production bank row exists; Freedom Adjustment's showed).
 * The read-only production check of 2026-11-12 (SSM f0d7da90, BEGIN READ ONLY) found Condition One's
 * own, default, verified production payment_provider_methods row with connection_status pending and no
 * Moov payment-method id. pickSettlementMethod/settlementFromSources display such a row, so the tile
 * was empty because the whole snapshot failed: any Moov read error other than 403/404 threw.
 *
 *  - readSweepSnapshot: a failing Moov read no longer fails the snapshot; the bank from the database
 *    still shows, marked stale / provider_unavailable;
 *  - 404 from Moov (no sweep configs) is unchanged: no stale flag;
 * The page side (settlementBankTile: "Couldn't load" instead of "Not connected", and the pending
 * status) is in the website PR, aws/tests/wallet-settlement-bank-tile.test.mjs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readSweepSnapshot } from '../functions/api/providers/parity/sweep-read.mjs';

const TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const PENDING_BANK = {
  id: 'm1', provider_payment_method_id: null, provider_bank_account_id: 'ba1', bank_name: 'FIRST BANK', last_four: '1234',
  is_default: true, connection_status: 'pending', verification_status: 'verified',
  supported_rails: ['ach-credit-standard', 'ach-credit-same-day'], rail_payment_method_ids: {}, rails_synced_at: null,
};
function fakeClient(methods = [PENDING_BANK]) {
  return {
    query: async (sql) => {
      if (/FROM public\.payment_wallets/.test(sql)) return { rows: [{ id: 'w1', provider_wallet_id: 'pw1', available_cents: 2862172, pending_cents: 0, status: 'active' }] };
      if (/FROM public\.payment_provider_methods/.test(sql)) return { rows: methods };
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  };
}

test('Moov unreachable: the bank from the database still shows, marked stale and provider_unavailable', async () => {
  const snapshot = await readSweepSnapshot({
    client: fakeClient(), tenantId: TENANT, accountId: 'acct1', environment: 'production',
    fetchImpl: async () => { throw new Error('network down'); },
  });
  assert.deepEqual(snapshot.settlement_method, { id: 'm1', bank_name: 'FIRST BANK', last_four: '1234', connection_status: 'pending' });
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.provider_unavailable, true);
  assert.deepEqual(snapshot.provider_errors.map((e) => e.read), ['sweep_configs', 'payment_methods']);
  assert.equal(snapshot.wallet.available_cents, 2862172);
});

test('Moov 404 (no sweep configs, no methods) is tolerated as before: no stale flag', async () => {
  const fetchImpl = async (url) => {
    if (/oauth2\/token/.test(String(url))) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 't', expires_in: 3600 }) };
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
  };
  const prev = { k: process.env.MOOV_PUBLIC_KEY, s: process.env.MOOV_SECRET_KEY };
  process.env.MOOV_PUBLIC_KEY = process.env.MOOV_PUBLIC_KEY || 'test-public';
  process.env.MOOV_SECRET_KEY = process.env.MOOV_SECRET_KEY || 'test-secret';
  try {
    const snapshot = await readSweepSnapshot({ client: fakeClient(), tenantId: TENANT, accountId: 'acct1', environment: 'production', fetchImpl });
    assert.equal(snapshot.settlement_method.last_four, '1234');
    if (!snapshot.provider_unavailable) assert.equal(snapshot.stale, false);
  } finally {
    if (prev.k === undefined) delete process.env.MOOV_PUBLIC_KEY; else process.env.MOOV_PUBLIC_KEY = prev.k;
    if (prev.s === undefined) delete process.env.MOOV_SECRET_KEY; else process.env.MOOV_SECRET_KEY = prev.s;
  }
});
