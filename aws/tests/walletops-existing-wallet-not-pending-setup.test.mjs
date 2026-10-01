/**
 * Existing production wallets must not be labeled Pending setup when
 * moov-wallet-sync returns 409/502. Fixtures only. No provider writes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWalletSnapshot } from '../../src/lib/payments/loadWalletSnapshot.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const EXISTING = {
  id: 'freedom-production-wallet',
  tenant_id: FREEDOM,
  wallet_type: 'operating',
  name: 'Freedom Adjustment Wallet',
  currency: 'USD',
  available_cents: 0,
  pending_cents: 500,
  status: 'active',
  last_synced_at: '2026-09-30T18:00:00.000Z',
};

test('sync 409 with an existing production wallet is not pending setup', async () => {
  const snapshot = await loadWalletSnapshot({
    tenantId: FREEDOM,
    tenantMoovEnvironment: 'production',
    syncWallet: async () => {
      throw new Error('Edge function returned a non-2xx status code: status 409');
    },
    readWallet: async () => EXISTING,
  });
  assert.equal(snapshot.setup_required, false);
  assert.equal(snapshot.wallet.id, EXISTING.id);
  assert.equal(snapshot.wallet.available_cents, 0);
  assert.equal(snapshot.wallet.pending_cents, 500);
});

test('sync 502 with an existing wallet still shows the local balance', async () => {
  const snapshot = await loadWalletSnapshot({
    tenantId: FREEDOM,
    syncWallet: async () => {
      throw new Error('moov-wallet-sync failed status 502');
    },
    readWallet: async () => EXISTING,
  });
  assert.equal(snapshot.setup_required, false);
  assert.equal(snapshot.wallet.status, 'active');
});

test('true setup with no local wallet still reports setup_required', async () => {
  const snapshot = await loadWalletSnapshot({
    tenantId: FREEDOM,
    syncWallet: async () => {
      throw new Error('Set up your payment account first.');
    },
    readWallet: async () => null,
  });
  assert.equal(snapshot.setup_required, true);
  assert.equal(snapshot.wallet, null);
});

test('non-setup errors with no local wallet still throw', async () => {
  await assert.rejects(
    () => loadWalletSnapshot({
      tenantId: FREEDOM,
      syncWallet: async () => {
        throw new Error('permission denied');
      },
      readWallet: async () => null,
    }),
    /permission denied/,
  );
});

test('useWallet routes through loadWalletSnapshot and environment-aware readWallet', () => {
  const hook = readFileSync(path.join(ROOT, 'src/hooks/useWallet.ts'), 'utf8');
  const helper = readFileSync(path.join(ROOT, 'src/lib/payments/loadWalletSnapshot.ts'), 'utf8');
  const wallets = readFileSync(path.join(ROOT, 'src/lib/payments/wallets.ts'), 'utf8');
  assert.match(hook, /loadWalletSnapshot/);
  assert.match(hook, /tenantMoovEnvironment/);
  assert.match(hook, /readWallet/);
  assert.match(helper, /readWallet/);
  assert.match(helper, /setup_required:\s*false/);
  assert.match(wallets, /selectPaymentWallet/);
  assert.match(wallets, /resolveWalletOpsEnvironment/);
});
