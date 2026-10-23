import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { LOOKUP_PRODUCTION_IDENTITY_SQL } from '../functions/api/identity-env.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import {
  PRODUCTION_PLATFORM_FINANCE_READS,
  isProductionPlatformFinanceRead,
} from '../functions/api/providers/production/platform-finance.mjs';
import { SANDBOX_PLATFORM_ACCOUNT_ID } from '../functions/api/providers/parity/platform-finance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OWNER_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const OWNER_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const FACILITATOR = 'f0c1a7e4-0000-4000-8000-00000000c0de';

const PRODUCTION_FLAGS = {
  AWS_PROVIDER_EXECUTION_ENABLED: 'true',
  AWS_MOOV_ENABLED: 'true',
  AWS_PROVIDER_LIVE_READS_ENABLED: 'true',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: undefined,
  CHECKSOPS_ENV: 'production-prep',
};

const withEnv = async (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const jwtEvent = (name, body) => ({
  rawPath: `/functions/v1/${name}`,
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: `/functions/v1/${name}` },
    authorizer: { jwt: { claims: { sub: OWNER_SUB, email: 'checksopsadmin@gmail.com', token_use: 'id' } } },
  },
});

const mockClient = ({ isOwner = true, tenants = null, fees = null, transfers = null } = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rows: [] };
      if (sql.startsWith('SET TRANSACTION')) return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL || sql === LOOKUP_PRODUCTION_IDENTITY_SQL) {
        return {
          rows: params[0] === OWNER_SUB
            ? [{ application_user_id: OWNER_APP, cognito_sub: OWNER_SUB, email: 'checksopsadmin@gmail.com', status: 'active' }]
            : [],
        };
      }
      if (sql.includes('is_platform_owner()')) return { rows: [{ is_owner: isOwner }] };
      if (sql.includes('FROM public.payment_provider_methods')) {
        return {
          rows: params[0] === 'production' && params[1] === FACILITATOR
            ? [{
              id: 'pm-row-1',
              provider_bank_account_id: 'bank-9001',
              bank_name: 'CHASE',
              last_four: '9001',
              account_type: 'checking',
              holder_name: 'ChecksOps LLC',
              verification_status: 'verified',
              connection_status: 'connected',
              is_default: true,
              connected_at: '2026-10-01T00:00:00Z',
              provider_metadata: {},
            }]
            : [],
        };
      }
      if (sql.includes('FROM public.tenants')) return { rows: tenants || [{ id: TENANT, name: 'Freedom Adjustment', is_test_account: false }] };
      if (sql.includes('FROM public.platform_fee_line_items')) {
        return { rows: fees || [{ tenant_id: TENANT, amount_cents: 2500, occurred_at: '2026-10-05T00:00:00Z', fee_code: 'monthly', status: 'billed' }] };
      }
      if (sql.includes('FROM public.payment_transfers')) {
        const all = transfers || [{ tenant_id: TENANT, environment: 'production', amount_cents: 100000, provider_fee_cents: 30, platform_fee_cents: 100, status: 'completed', created_at: '2026-10-06T00:00:00Z' }];
        // Emulates the SQL filter: created_at >= $1 and, when given, environment = $2.
        return { rows: all.filter((row) => (params[1] === undefined || row.environment === params[1])) };
      }
      return { rows: [] };
    },
  };
};

// Records every provider call; answers the facilitator reads only, on GET.
const providerFetch = () => {
  const calls = [];
  const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  const impl = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    const href = String(url);
    calls.push({ url: href, method, body: init.body });
    if (href.includes('/oauth2/token')) return ok({ access_token: 'token-1', expires_in: 300 });
    if (method !== 'GET') return { ok: false, status: 500, text: async () => '{}' };
    const p = href.replace(/^https:\/\/[^/]+/, '').split('?')[0];
    if (p === `/accounts/${FACILITATOR}`) {
      return ok({ accountType: 'business', profile: { business: { name: 'ChecksOps LLC' } }, verification: { status: 'verified' } });
    }
    if (p === `/accounts/${FACILITATOR}/capabilities`) return ok([{ capability: 'transfers', status: 'enabled' }]);
    if (p === `/accounts/${FACILITATOR}/bank-accounts`) {
      return ok([{ bankAccountID: 'bank-9001', bankName: 'CHASE', lastFourAccountNumber: '9001', bankAccountType: 'checking', holderName: 'ChecksOps LLC', status: 'verified' }]);
    }
    if (p === `/accounts/${FACILITATOR}/wallets`) {
      return ok([{ walletID: 'wallet-platform', accountID: FACILITATOR, walletType: 'default', availableBalance: { value: 123456, currency: 'USD' }, pendingBalance: { value: 500 } }]);
    }
    if (p === `/accounts/${FACILITATOR}/wallets/wallet-platform/transactions`) {
      return ok([{ walletTransactionID: 'tx-1', transactionType: 'ach-reversal', status: 'completed', grossAmount: 2500, availableBalance: 123456, createdOn: '2026-10-06T00:00:00Z' }]);
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ message: `unexpected ${p}` }) };
  };
  return { calls, impl };
};

const deps = ({ client = mockClient(), fetch = providerFetch(), secrets = { MOOV_PUBLIC_KEY: 'pk_live_x', MOOV_SECRET_KEY: 'sk_live_x', MOOV_ACCOUNT_ID: FACILITATOR } } = {}) => {
  const seen = { secretsLoaded: 0 };
  return {
    seen,
    client,
    fetch,
    deps: {
      loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
      createClient: () => client,
      loadProviderSecrets: async () => { seen.secretsLoaded += 1; return secrets; },
      loadSandboxCredentials: async () => { throw new Error('sandbox credentials must not be loaded in production'); },
      fetchImpl: fetch.impl,
    },
  };
};

const call = (name, body, d) => handleProviderRequest(jwtEvent(name, body), `/functions/v1/${name}`, 'POST', d.deps);

test('the production reads are exactly Banking status and Wallet & P&L overview', () => {
  assert.deepEqual({ ...PRODUCTION_PLATFORM_FINANCE_READS }, { 'moov-platform-bank': 'status', 'platform-treasury': 'overview' });
  assert.equal(isProductionPlatformFinanceRead('moov-platform-bank', { action: 'status' }), true);
  assert.equal(isProductionPlatformFinanceRead('platform-treasury', { action: 'OVERVIEW' }), true);
  for (const [name, action] of [['moov-platform-bank', 'add'], ['moov-platform-bank', undefined], ['platform-treasury', 'wallet'], ['platform-treasury', 'status'], ['moov-invoice', 'status']]) {
    assert.equal(isProductionPlatformFinanceRead(name, { action }), false, `${name} ${action}`);
  }
});

test('Banking status: the platform owner reads the facilitator account on production credentials and host only', async () => {
  await withEnv(PRODUCTION_FLAGS, async () => {
    const d = deps();
    const result = await call('moov-platform-bank', { action: 'status', tenant_id: TENANT }, d);
    assert.equal(result.statusCode, 200, JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(result.environment, 'production');
    assert.equal(result.platform_account_id, FACILITATOR);
    assert.equal(result.tenant_context_used, false);
    assert.equal(result.profile.displayName, 'ChecksOps LLC');
    assert.deepEqual(result.capabilities, [{ capability: 'transfers', status: 'enabled' }]);
    assert.equal(result.methods.length, 1);
    assert.equal(result.methods[0].last_four, '9001');
    assert.equal(result.methods[0].source, 'moov+local');
    assert.equal(result.ach_initiated, false);
    assert.equal(result.bankAccountAddInvoked, false);
    assert.equal(d.seen.secretsLoaded, 1);
    const providerCalls = d.fetch.calls.filter((c) => !c.url.includes('/oauth2/token'));
    assert.ok(providerCalls.length >= 3);
    for (const c of d.fetch.calls) {
      assert.match(c.url, /^https:\/\/api\.moov\.io\//, c.url);
      assert.equal(c.url.includes(TENANT), false, 'never a tenant account');
    }
    for (const c of providerCalls) assert.equal(c.method, 'GET', c.url);
  });
});

test('Wallet & P&L overview: platform wallet balance and transactions plus the P&L totals', async () => {
  await withEnv(PRODUCTION_FLAGS, async () => {
    const d = deps();
    const result = await call('platform-treasury', { action: 'overview' }, d);
    assert.equal(result.statusCode, 200, JSON.stringify(result));
    assert.equal(result.environment, 'production');
    assert.equal(result.wallet.wallet_id, 'wallet-platform');
    assert.equal(result.wallet.available_cents, 123456);
    assert.equal(result.wallet.transactions.length, 1);
    assert.equal(result.pnl.totals.fees_cents, 2500);
    assert.equal(result.pnl.totals.transfer_fees_cents, 100);
    assert.equal(result.pnl.totals.provider_cost_cents, 30);
    assert.equal(result.pnl.totals.revenue_cents, 2600);
    assert.equal(result.fee_pull, false);
    for (const c of d.fetch.calls.filter((x) => !x.url.includes('/oauth2/token'))) assert.equal(c.method, 'GET', c.url);
  });
});

test('a caller who is not the platform owner is refused before any secret or provider call', async () => {
  await withEnv(PRODUCTION_FLAGS, async () => {
    for (const [name, action] of Object.entries(PRODUCTION_PLATFORM_FINANCE_READS)) {
      const d = deps({ client: mockClient({ isOwner: false }) });
      const result = await call(name, { action }, d);
      assert.equal(result.statusCode, 403, name);
      assert.equal(result.error, 'Platform owner access required', name);
      assert.equal(d.seen.secretsLoaded, 0, name);
      assert.equal(d.fetch.calls.length, 0, name);
    }
  });
});

test('fails closed without credentials, without a facilitator id, or on the sandbox facilitator id', async () => {
  await withEnv(PRODUCTION_FLAGS, async () => {
    for (const secrets of [
      { MOOV_ACCOUNT_ID: FACILITATOR },
      { MOOV_PUBLIC_KEY: 'pk_live_x', MOOV_SECRET_KEY: 'sk_live_x' },
      { MOOV_PUBLIC_KEY: 'pk_live_x', MOOV_SECRET_KEY: 'sk_live_x', MOOV_ACCOUNT_ID: SANDBOX_PLATFORM_ACCOUNT_ID },
    ]) {
      const d = deps({ secrets });
      const result = await call('moov-platform-bank', { action: 'status' }, d);
      assert.equal(result.statusCode, 503, JSON.stringify(secrets));
      assert.equal(d.fetch.calls.length, 0, JSON.stringify(secrets));
    }
  });
});

test('every other Platform Finance action stays hard-blocked in production', async () => {
  await withEnv(PRODUCTION_FLAGS, async () => {
    for (const [name, action] of [
      ['moov-platform-bank', 'add'], ['moov-platform-bank', 'initiate_micro_deposit'], ['moov-platform-bank', 'confirm_micro_deposit'],
      ['moov-platform-bank', 'list'], ['platform-treasury', 'wallet'], ['platform-treasury', 'pnl'], ['platform-treasury', 'transfer'],
    ]) {
      const d = deps();
      const result = await call(name, { action }, d);
      assert.equal(result.statusCode, 403, `${name} ${action}`);
      assert.equal(result.error, 'production_execution_blocked', `${name} ${action}`);
      assert.equal(d.seen.secretsLoaded, 0, `${name} ${action}`);
      assert.equal(d.fetch.calls.length, 0, `${name} ${action}`);
    }
  });
});

test('provider failures reach the panel as warnings that never name the payment provider', async () => {
  await withEnv(PRODUCTION_FLAGS, async () => {
    const fetch = providerFetch();
    const base = fetch.impl;
    fetch.impl = async (url, init) => (String(url).includes('/capabilities')
      ? { ok: false, status: 500, text: async () => JSON.stringify({ error: 'moov upstream error' }) }
      : base(url, init));
    const d = deps({ fetch });
    d.deps.fetchImpl = fetch.impl;
    const result = await call('moov-platform-bank', { action: 'status' }, d);
    assert.equal(result.statusCode, 200);
    assert.ok(result.warnings.length >= 1);
    for (const w of result.warnings) assert.equal(/moov/i.test(w), false, w);
  });
});

test('route placement: the Platform Finance route sits before the production hard block', () => {
  const src = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers.mjs'), 'utf8');
  const route = src.indexOf("import('./providers/production/platform-finance.mjs')");
  assert.ok(route > 0);
  assert.ok(route < src.indexOf("error: 'production_execution_blocked'"));
  assert.ok(src.indexOf("import('./providers/production/moov-invoice.mjs')") < route);
});

test('P&L months are calendar months (YYYY-MM) even though pg returns timestamps as Date objects', async () => {
  await withEnv(PRODUCTION_FLAGS, async () => {
    const OTHER = '6a1e3b0c-1111-4222-8333-444455556666';
    const client = mockClient({
      tenants: [{ id: TENANT, name: 'Freedom Adjustment', is_test_account: false }, { id: OTHER, name: 'Condition One', is_test_account: false }],
      fees: [
        { tenant_id: TENANT, amount_cents: 1000, occurred_at: new Date('2026-10-02T15:00:00Z'), fee_code: 'monthly', status: 'billed' },
        { tenant_id: OTHER, amount_cents: 500, occurred_at: new Date('2026-09-30T23:30:00Z'), fee_code: 'monthly', status: 'unbilled' },
        { tenant_id: OTHER, amount_cents: 999, occurred_at: new Date('2026-10-03T00:00:00Z'), fee_code: 'monthly', status: 'void' },
      ],
      transfers: [
        // Different weekdays of the same month land in one row.
        { tenant_id: TENANT, environment: 'production', amount_cents: 10000, provider_fee_cents: 0, platform_fee_cents: 0, status: 'completed', created_at: new Date('2026-10-16T12:00:00Z') },
        { tenant_id: TENANT, environment: 'production', amount_cents: 100, provider_fee_cents: 0, platform_fee_cents: 0, status: 'pending', created_at: new Date('2026-10-20T12:00:00Z') },
        { tenant_id: OTHER, environment: 'production', amount_cents: 14400, provider_fee_cents: 0, platform_fee_cents: 0, status: 'completed', created_at: new Date('2026-10-23T12:00:00Z') },
      ],
    });
    const d = deps({ client });
    const result = await call('platform-treasury', { action: 'overview' }, d);
    assert.equal(result.statusCode, 200, JSON.stringify(result));
    assert.deepEqual(result.pnl.months.map((m) => m.month), ['2026-09', '2026-10']);
    const oct = result.pnl.months.find((m) => m.month === '2026-10');
    assert.equal(oct.fees_cents, 1000);
    assert.equal(oct.volume_cents, 24500);
    assert.equal(oct.transfer_count, 3);
    assert.equal(result.pnl.months.find((m) => m.month === '2026-09').fees_cents, 500);
    for (const m of result.pnl.months) assert.match(m.month, /^\d{4}-\d{2}$/);
    assert.equal(result.pnl.totals.fees_cents, 1500);
    assert.equal(result.pnl.totals.volume_cents, 24500);
  });
});

test('production P&L counts only production money: no sandbox transfers, no test-account organizations', async () => {
  await withEnv(PRODUCTION_FLAGS, async () => {
    const DEMO = '7b2f4c1d-aaaa-4bbb-8ccc-ddddeeeeffff';
    const client = mockClient({
      tenants: [{ id: TENANT, name: 'Freedom Adjustment', is_test_account: false }, { id: DEMO, name: 'Demo Co', is_test_account: true }],
      fees: [
        { tenant_id: TENANT, amount_cents: 1000, occurred_at: '2026-10-02T00:00:00Z', fee_code: 'monthly', status: 'billed' },
        { tenant_id: DEMO, amount_cents: 7000, occurred_at: '2026-10-02T00:00:00Z', fee_code: 'monthly', status: 'billed' },
      ],
      transfers: [
        { tenant_id: TENANT, environment: 'production', amount_cents: 10000, provider_fee_cents: 0, platform_fee_cents: 0, status: 'completed', created_at: '2026-10-16T12:00:00Z' },
        { tenant_id: TENANT, environment: 'sandbox', amount_cents: 500000, provider_fee_cents: 0, platform_fee_cents: 0, status: 'completed', created_at: '2026-10-16T12:00:00Z' },
        { tenant_id: DEMO, environment: 'production', amount_cents: 88800, provider_fee_cents: 0, platform_fee_cents: 0, status: 'completed', created_at: '2026-10-16T12:00:00Z' },
      ],
    });
    const d = deps({ client });
    const result = await call('platform-treasury', { action: 'overview' }, d);
    assert.equal(result.statusCode, 200, JSON.stringify(result));
    assert.equal(result.pnl.totals.fees_cents, 1000);
    assert.equal(result.pnl.totals.volume_cents, 10000);
    assert.equal(result.pnl.totals.transfer_count, 1);
    assert.equal(result.pnl.tenants.some((t) => t.tenant_id === DEMO), false);
    const transferQuery = client.queries.find((q) => q.sql.includes('FROM public.payment_transfers'));
    assert.match(transferQuery.sql, /environment = \$2/);
    assert.equal(transferQuery.params[1], 'production');
  });
});

test('transfers that never left or came back are not processed volume', async () => {
  await withEnv(PRODUCTION_FLAGS, async () => {
    const rows = ['completed', 'pending', 'submitting', 'ready', 'failed', 'canceled', 'cancelled', 'returned', 'reversed']
      .map((status, i) => ({ tenant_id: TENANT, environment: 'production', amount_cents: 100 * (i + 1), provider_fee_cents: 0, platform_fee_cents: 0, status, created_at: '2026-10-16T12:00:00Z' }));
    const d = deps({ client: mockClient({ transfers: rows }) });
    const result = await call('platform-treasury', { action: 'overview' }, d);
    assert.equal(result.statusCode, 200, JSON.stringify(result));
    // completed 100 + pending 200 + submitting 300
    assert.equal(result.pnl.totals.volume_cents, 600);
    assert.equal(result.pnl.totals.transfer_count, 3);
  });
});
