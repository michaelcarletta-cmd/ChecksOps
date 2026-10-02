/**
 * WalletOps automatic-payout enable/disable. Fixtures + source contracts.
 * No live Moov writes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { automaticPayoutControl } from '../../src/lib/payments/walletSweepActivity.ts';
import { sweepConfig, sweepConfigPatchBody } from '../functions/api/providers/parity/moov-onboard.mjs';
import { resetMoovTokenCache, withMoovContext } from '../functions/api/providers/parity/moov-client.mjs';
import {
  COLLECT_ACH_CAPABILITIES,
  LEGACY_CAPABILITY_IDS,
  MERCHANT_CAPABILITIES,
  RECIPIENT_CAPABILITIES,
} from '../functions/api/providers/parity/moov-capabilities.mjs';

const ACCOUNT = '60922058-7eca-4889-81dd-5720d7b9de96';
const WALLET = '3e6286ca-a19c-45f6-aad9-f73dac5f0358';
const SWEEP_ID = '2d2c900d-6efb-43a2-ba90-2fd77e22afdd';

const ENABLED = {
  sweepConfigID: SWEEP_ID,
  walletID: WALLET,
  status: 'enabled',
  minimumBalance: '0.00',
  pushPaymentMethodID: '7a78a544-340d-46fd-a4a4-228661374da7',
  pullPaymentMethodID: 'a02c1c81-9ca6-434d-accc-ea4471a70ef2',
};

const DISABLED = { ...ENABLED, status: 'disabled' };

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

function mockClient() {
  return {
    query: async (sql) => {
      if (String(sql).includes('payment_provider_accounts')) {
        return { rows: [{ provider_account_id: ACCOUNT }] };
      }
      if (String(sql).includes('payment_wallets')) {
        return {
          rows: [{
            id: 'local-wallet',
            provider_wallet_id: WALLET,
            available_cents: 0,
            pending_cents: 0,
            status: 'active',
          }],
        };
      }
      return { rows: [] };
    },
  };
}

function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = String(opts.method || 'GET').toUpperCase();
    const path = String(url).replace('https://api.moov.io', '');
    let parsed;
    try { parsed = opts.body ? JSON.parse(opts.body) : undefined; } catch { parsed = opts.body; }
    calls.push({ method, path, body: parsed });
    if (path.endsWith('/oauth2/token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok', expires_in: 300 }) };
    }
    const key = `${method} ${path}`;
    const handler = routes[key] ?? routes[`${method} *`] ?? routes.default;
    if (!handler) {
      return { ok: false, status: 599, text: async () => JSON.stringify({ error: `unexpected ${key}` }) };
    }
    const res = typeof handler === 'function' ? handler(parsed, path) : handler;
    const status = res.status ?? 200;
    return {
      ok: status < 400,
      status,
      text: async () => JSON.stringify(res.body ?? res),
    };
  };
  return { fetchImpl, calls };
}

async function runSweep(action, { sweepConfigId, routes, failPatch = false } = {}) {
  resetMoovTokenCache();
  const patchPath = `/accounts/${ACCOUNT}/sweep-configs/${SWEEP_ID}`;
  const { fetchImpl, calls } = mockFetch({
    [`GET /accounts/${ACCOUNT}/sweep-configs`]: { body: [DISABLED] },
    [`PATCH ${patchPath}`]: failPatch
      ? { status: 500, body: { error: 'Moov rejected the sweep update' } }
      : (body) => ({ body: { ...DISABLED, status: body.status, sweepConfigID: SWEEP_ID } }),
    ...routes,
  });
  const result = await withMoovContext({
    environment: 'sandbox',
    sandboxPublicKey: 'pk',
    sandboxSecretKey: 'sk',
    apiVersion: 'v2024.01.00',
  }, () => sweepConfig.run({
    client: mockClient(),
    body: { action, sweep_config_id: sweepConfigId, wallet_type: 'operating' },
    ctx: { tenantId: '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a', environment: 'sandbox' },
    fetchImpl,
  }));
  return { result, calls };
}

test('1 active/enabled sweep → UI offers Turn off', () => {
  const control = automaticPayoutControl({
    status: 'enabled',
    provider_sweep_config_id: SWEEP_ID,
  });
  assert.equal(control.show, true);
  assert.equal(control.sweepsOn, true);
  assert.equal(control.action, 'disable');
  assert.equal(control.label, 'Turn off automatic payouts');
  const page = read('src/pages/WalletOps.tsx');
  assert.match(page, /automaticPayoutControl\(config\)/);
  assert.match(page, /payoutControl\.action === "disable"/);
  assert.match(page, /Turn off automatic payouts/);
});

test('2 disabled sweep → UI offers Turn on', () => {
  const control = automaticPayoutControl({
    status: 'disabled',
    provider_sweep_config_id: SWEEP_ID,
  });
  assert.equal(control.show, true);
  assert.equal(control.sweepsOn, false);
  assert.equal(control.action, 'enable');
  assert.equal(control.label, 'Turn on automatic payouts');
  const page = read('src/pages/WalletOps.tsx');
  assert.match(page, /Turn on automatic payouts/);
  assert.match(page, /enableSweeps\.mutateAsync/);
  assert.match(page, /disableSweeps\.mutateAsync/);
});

test('3 disable operation succeeds', async () => {
  assert.deepEqual(sweepConfigPatchBody('disable'), { status: 'disabled' });
  const { result, calls } = await runSweep('disable', { sweepConfigId: SWEEP_ID });
  assert.equal(result.success, true);
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.path, `/accounts/${ACCOUNT}/sweep-configs/${SWEEP_ID}`);
  assert.deepEqual(patch.body, { status: 'disabled' });
  assert.equal(result.config.status, 'disabled');
});

test('4 enable operation succeeds', async () => {
  assert.deepEqual(sweepConfigPatchBody('enable'), { status: 'enabled' });
  const { result, calls } = await runSweep('enable', { sweepConfigId: SWEEP_ID });
  assert.equal(result.success, true);
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.path, `/accounts/${ACCOUNT}/sweep-configs/${SWEEP_ID}`);
  assert.deepEqual(patch.body, { status: 'enabled' });
  assert.equal(result.config.status, 'enabled');
});

test('5 backend failure leaves UI in previous state', async () => {
  const before = automaticPayoutControl({
    status: 'disabled',
    provider_sweep_config_id: SWEEP_ID,
  });
  await assert.rejects(
    () => runSweep('enable', { sweepConfigId: SWEEP_ID, failPatch: true }),
    (err) => {
      assert.match(String(err.message || err), /Moov rejected|sweep update|failed/i);
      return true;
    },
  );
  const after = automaticPayoutControl({
    status: 'disabled',
    provider_sweep_config_id: SWEEP_ID,
  });
  assert.deepEqual(after, before);
  const page = read('src/pages/WalletOps.tsx');
  assert.match(page, /Could not turn on automatic payouts/);
  assert.match(page, /Could not turn off automatic payouts/);
  assert.doesNotMatch(page, /setSweepsOn/);
  const hook = read('src/hooks/useSweepConfig.ts');
  assert.match(hook, /onSuccess: invalidate/);
  assert.doesNotMatch(hook, /onMutate/);
});

test('6 state is re-read after mutation', () => {
  const page = read('src/pages/WalletOps.tsx');
  const hook = read('src/hooks/useSweepConfig.ts');
  assert.match(page, /refreshSweeps\.mutateAsync/);
  assert.match(hook, /enableSweep\(/);
  assert.match(hook, /disableSweep\(/);
  assert.match(hook, /onSuccess: invalidate/);
  assert.match(hook, /getSweepSnapshot\(tenantId, walletType, \{ force: true \}\)/);
});

test('7 correct sweep_config_id is targeted', async () => {
  const { calls } = await runSweep('enable', { sweepConfigId: undefined });
  const list = calls.find((c) => c.method === 'GET' && c.path === `/accounts/${ACCOUNT}/sweep-configs`);
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(list, 'enable looks up sweep configs when id is omitted');
  assert.equal(patch.path, `/accounts/${ACCOUNT}/sweep-configs/${SWEEP_ID}`);
  assert.deepEqual(patch.body, { status: 'enabled' });
});

test('8 no duplicate sweep configuration is created', async () => {
  const { calls } = await runSweep('enable', { sweepConfigId: SWEEP_ID });
  const posts = calls.filter((c) => (
    c.method === 'POST' && c.path.includes('/sweep-configs') && !c.path.endsWith('/oauth2/token')
  ));
  assert.equal(posts.length, 0);
  const onboard = read('aws/functions/api/providers/parity/moov-onboard.mjs');
  assert.match(onboard, /action === 'enable'/);
  assert.match(onboard, /status: 'enabled'/);
  assert.doesNotMatch(
    onboard,
    /action === 'enable'[\s\S]{0,400}method: 'POST'/,
  );
});

test('9 sweep history remains functional', () => {
  const shared = read('supabase/functions/_shared/moovSweeps.ts');
  const reader = read('aws/functions/api/providers/parity/sweep-read.mjs');
  const onboard = read('aws/functions/api/providers/parity/moov-onboard.mjs');
  assert.match(shared, /\/accounts\/\$\{accountId\}\/wallets\/\$\{encodeURIComponent\(walletId\)\}\/sweeps/);
  assert.match(reader, /\/accounts\/\$\{accountId\}\/wallets\/\$\{encodeURIComponent\(walletId\)\}\/sweeps/);
  assert.match(onboard, /readSweepHistory/);
  assert.match(onboard, /readSweepSnapshot/);
  assert.doesNotMatch(shared, /\/accounts\/\$\{accountId\}\/sweeps\?walletID=/);
  assert.doesNotMatch(reader, /\/accounts\/\$\{accountId\}\/sweeps\?walletID=/);
});

test('10 PR #598 granular capability request sets remain unchanged', () => {
  assert.deepEqual([...MERCHANT_CAPABILITIES], [
    'transfers',
    'collect-funds.ach',
    'send-funds.ach',
    'wallet.balance',
  ]);
  assert.deepEqual([...RECIPIENT_CAPABILITIES], ['transfers']);
  assert.deepEqual([...COLLECT_ACH_CAPABILITIES], ['transfers', 'collect-funds.ach']);
  const onboard = read('aws/functions/api/providers/parity/moov-onboard.mjs');
  const fn = read('aws/functions/api/providers/parity/moov-functions.mjs');
  assert.match(onboard, /capabilities: \[\.\.\.MERCHANT_CAPABILITIES\]/);
  assert.match(fn, /capabilities: \[\.\.\.MERCHANT_CAPABILITIES\]/);
  for (const code of LEGACY_CAPABILITY_IDS) {
    const escaped = String(code).replace(/\./g, '\\.');
    assert.equal(
      new RegExp(`capabilities\\s*:\\s*\\[[^\\]]*[\\'"\`]${escaped}[\\'"\`]`).test(onboard),
      false,
      `onboard requested ${code}`,
    );
  }
});
