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
import {
  PNL_SOURCES,
  PROVIDER_COST_RATES,
  SANDBOX_PLATFORM_ACCOUNT_ID,
  pnlPayload,
  pnlWindow,
  providerCostRatesAt,
} from '../functions/api/providers/parity/platform-finance.mjs';
import { feeTypeForTransfer, sendRecipientKey, transferIsQualifying } from '../functions/api/tenant-billing-engine.mjs';

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

// An hour ago: inside the P&L window whatever day the suite runs (the handler reads the real clock).
const RECENT = new Date(Date.now() - 3_600_000);
const sendLeg = (over = {}) => ({
  id: over.id || `leg-${Math.random().toString(16).slice(2)}`,
  tenant_id: TENANT,
  environment: 'production',
  amount_cents: 10000,
  status: 'completed',
  speed: 'standard',
  leg_role: 'send_bank',
  completed_at: RECENT,
  created_at: RECENT,
  provider_metadata: { destination_kind: 'bank' },
  ...over,
});
const settled = (over = {}) => ({
  tenant_id: TENANT,
  amount_cents: 2500,
  status: 'settled',
  settled_at: RECENT,
  occurrence_kind: 'monthly_subscription',
  provider_environment: 'production',
  ...over,
});
const deposit = (over = {}) => ({
  id: over.id || `dep-${Math.random().toString(16).slice(2)}`,
  tenant_id: TENANT,
  check_intake_item_id: 'check-1',
  checkalt_reference: 'ref-1',
  status: 'submitted',
  submitted_at: RECENT,
  ...over,
});

// The P&L reads return every row given: the module applies its own filters again in code, so
// these tests exercise the definitions and not an emulation of the SQL. `failing` names tables
// whose read throws (missing table or permission).
const mockClient = ({ isOwner = true, tenants = null, payments = null, transfers = null, deposits = null, failing = [] } = {}) => {
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
      for (const table of failing) {
        if (sql.includes(`FROM public.${table}`)) throw Object.assign(new Error(`permission denied for table ${table}`), { code: '42501' });
      }
      if (sql.includes('FROM public.tenants')) return { rows: tenants || [{ id: TENANT, name: 'Freedom Adjustment', is_test_account: false }] };
      if (sql.includes('FROM public.tenant_maintenance_payments')) return { rows: payments || [settled()] };
      if (sql.includes('FROM public.payment_transfers')) return { rows: transfers || [sendLeg({ amount_cents: 100000 })] };
      if (sql.includes('FROM public.checkalt_deposits')) return { rows: deposits || [deposit()] };
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
    // Collected $25.00; one check ($0.68) and one next-day payout ($0.25). No monthly minimum is applied.
    assert.equal(result.pnl.totals.revenue_cents, 2500);
    assert.equal(result.pnl.totals.checkalt_cost_cents, 68);
    assert.equal(result.pnl.totals.moov_cost_cents, 25);
    assert.equal(result.pnl.totals.moov_minimum_topup_cents, 0);
    assert.equal(result.pnl.totals.provider_cost_cents, 93);
    assert.equal(result.pnl.totals.profit_cents, 2500 - 93);
    assert.equal(result.pnl.totals.volume_cents, 100000);
    assert.equal(result.pnl.totals.payout_count, 1);
    assert.equal(result.pnl.cost_basis.estimated, true);
    assert.deepEqual(result.pnl.sources_unavailable, []);
    // The legacy fee ledger and the per-transfer fee columns are no longer read.
    assert.equal(d.client.queries.some((q) => /platform_fee_line_items|platform_fee_cents|provider_fee_cents/.test(q.sql)), false);
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

// ---- P&L definitions (owner 2026-11-25/26): collected revenue, completed payouts, provider cost ----

const NOW = new Date('2026-11-26T12:00:00Z');
const OTHER = '6a1e3b0c-1111-4222-8333-444455556666';
const DEMO = '7b2f4c1d-aaaa-4bbb-8ccc-ddddeeeeffff';
const TENANTS = [
  { id: TENANT, name: 'Freedom Adjustment', is_test_account: false },
  { id: OTHER, name: 'Condition One', is_test_account: false },
  { id: DEMO, name: 'Demo Co', is_test_account: true },
];
const at = (iso) => new Date(iso);
const pnl = (rows = {}, { environment = 'production', now = NOW } = {}) => {
  const client = mockClient({ tenants: TENANTS, payments: [], transfers: [], deposits: [], ...rows });
  return pnlPayload(client, { environment, now }).then((result) => ({ result, client }));
};
const month = (result, key) => result.months.find((m) => m.month === key);
const tenantRow = (result, id) => result.tenants.find((t) => t.tenant_id === id);

test('rates: the owner\'s figures, one dated row, picked by the item\'s date', () => {
  assert.deepEqual(PROVIDER_COST_RATES.map((row) => ({ ...row })), [{
    effective_from: '2026-01-01',
    checkalt_per_check_cents: 68,
    moov_next_day_cents: 25,
    moov_same_day_cents: 40,
    // The two monthly minimums are recorded for information and never applied (owner 2026-11-26).
    checkalt_monthly_minimum_cents: 100000,
    moov_monthly_minimum_cents: 50000,
  }]);
  assert.ok(Object.isFrozen(PROVIDER_COST_RATES) && Object.isFrozen(PROVIDER_COST_RATES[0]));
  assert.equal(providerCostRatesAt('2026-11-26T00:00:00Z'), PROVIDER_COST_RATES[0]);
  assert.equal(providerCostRatesAt(at('2030-01-01T00:00:00Z')), PROVIDER_COST_RATES[0]);
  // Before the first row, and for a value that is not a date: the first row.
  assert.equal(providerCostRatesAt('2025-06-01T00:00:00Z'), PROVIDER_COST_RATES[0]);
  assert.equal(providerCostRatesAt('not a date'), PROVIDER_COST_RATES[0]);
});

test('revenue is what was collected: settled obligations only, in the month they settled', async () => {
  const { result, client } = await pnl({
    payments: [
      settled({ amount_cents: 1000, settled_at: at('2026-10-02T15:00:00Z') }),
      // pg returns timestamptz as a Date; the last instant of September stays in September (UTC).
      settled({ tenant_id: OTHER, amount_cents: 500, settled_at: at('2026-09-30T23:30:00Z') }),
      settled({ tenant_id: OTHER, amount_cents: 700, settled_at: '2026-10-20T08:00:00Z' }),
      // Billed or in flight is not collected; failed and returned came back.
      ...['due', 'submitted', 'failed', 'returned'].map((status) => settled({ status, amount_cents: 99900, settled_at: at('2026-10-05T00:00:00Z') })),
      // Settled without a settlement date cannot be placed in a month.
      settled({ amount_cents: 88800, settled_at: null }),
    ],
  });
  assert.deepEqual(result.months.map((m) => m.month), ['2026-09', '2026-10']);
  for (const m of result.months) assert.match(m.month, /^\d{4}-\d{2}$/);
  assert.equal(month(result, '2026-09').revenue_cents, 500);
  assert.equal(month(result, '2026-10').revenue_cents, 1700);
  assert.equal(result.totals.revenue_cents, 2200);
  assert.equal(result.totals.profit_cents, 2200);
  assert.equal(tenantRow(result, TENANT).revenue_cents, 1000);
  assert.equal(tenantRow(result, OTHER).revenue_cents, 1200);
  assert.deepEqual(result.tenants.map((t) => t.tenant_name), ['Condition One', 'Freedom Adjustment']);
  const query = client.queries.find((q) => q.sql.includes('FROM public.tenant_maintenance_payments'));
  assert.match(query.sql, /status = 'settled'/);
  assert.match(query.sql, /settled_at >= \$1 AND settled_at <= \$2/);
});

test('revenue leaves out the $1.00 bank verification debits', async () => {
  const { result, client } = await pnl({
    payments: [
      settled({ amount_cents: 2500, settled_at: at('2026-11-03T00:00:00Z') }),
      settled({ amount_cents: 100, occurrence_kind: 'billing_verification', settled_at: at('2026-11-04T00:00:00Z') }),
      settled({ amount_cents: 300, occurrence_kind: null, settled_at: at('2026-11-05T00:00:00Z') }),
    ],
  });
  assert.equal(result.totals.revenue_cents, 2800);
  const query = client.queries.find((q) => q.sql.includes('FROM public.tenant_maintenance_payments'));
  assert.match(query.sql, /occurrence_kind IS DISTINCT FROM 'billing_verification'/);
});

test('each environment counts its own money only', async () => {
  const rows = {
    payments: [
      settled({ amount_cents: 1000, settled_at: at('2026-11-02T00:00:00Z') }),
      settled({ amount_cents: 7000, provider_environment: 'sandbox', settled_at: at('2026-11-02T00:00:00Z') }),
      settled({ amount_cents: 9000, provider_environment: null, settled_at: at('2026-11-02T00:00:00Z') }),
    ],
    transfers: [
      sendLeg({ amount_cents: 10000, completed_at: at('2026-11-16T12:00:00Z') }),
      sendLeg({ amount_cents: 500000, environment: 'sandbox', completed_at: at('2026-11-16T12:00:00Z') }),
    ],
  };
  const production = await pnl(rows);
  assert.equal(production.result.totals.revenue_cents, 1000);
  assert.equal(production.result.totals.volume_cents, 10000);
  assert.equal(production.result.totals.payout_count, 1);
  for (const table of ['tenant_maintenance_payments', 'payment_transfers']) {
    const query = production.client.queries.find((q) => q.sql.includes(`FROM public.${table}`));
    assert.match(query.sql, /environment = \$3/, table);
    assert.equal(query.params[2], 'production', table);
  }
  const sandbox = await pnl(rows, { environment: 'sandbox' });
  assert.equal(sandbox.result.totals.revenue_cents, 7000);
  assert.equal(sandbox.result.totals.volume_cents, 500000);
});

test('production P&L leaves test-account organizations out of revenue, payouts and checks', async () => {
  const rows = {
    payments: [settled({ amount_cents: 1000, settled_at: at('2026-11-02T00:00:00Z') }), settled({ tenant_id: DEMO, amount_cents: 7000, settled_at: at('2026-11-02T00:00:00Z') })],
    transfers: [sendLeg({ amount_cents: 10000, completed_at: at('2026-11-16T12:00:00Z') }), sendLeg({ tenant_id: DEMO, amount_cents: 88800, speed: 'same_day', completed_at: at('2026-11-16T12:00:00Z') })],
    deposits: [deposit({ submitted_at: at('2026-11-10T00:00:00Z') }), deposit({ tenant_id: DEMO, check_intake_item_id: 'check-demo', checkalt_reference: 'ref-demo', submitted_at: at('2026-11-10T00:00:00Z') })],
  };
  const { result } = await pnl(rows);
  assert.equal(result.totals.revenue_cents, 1000);
  assert.equal(result.totals.volume_cents, 10000);
  assert.equal(result.totals.payout_count, 1);
  assert.equal(result.totals.same_day_count, 0);
  assert.equal(result.totals.check_count, 1);
  assert.equal(result.tenants.some((t) => t.tenant_id === DEMO), false);
  // The sandbox ledger is where they run.
  const sandbox = await pnl({
    payments: rows.payments.map((row) => ({ ...row, provider_environment: 'sandbox' })),
    transfers: rows.transfers.map((row) => ({ ...row, environment: 'sandbox' })),
    deposits: rows.deposits,
  }, { environment: 'sandbox' });
  assert.equal(sandbox.result.totals.revenue_cents, 8000);
  assert.equal(sandbox.result.totals.payout_count, 2);
  assert.equal(sandbox.result.totals.check_count, 2);
});

test('one recipient payout is counted once: a wallet leg and its bank top-up leg are one payout, volume is both legs', async () => {
  const meta = (recipient) => ({ request_hash: 'hash-1', recipient_index: recipient, destination_kind: 'bank' });
  const legs = [
    sendLeg({ id: 'leg-a', leg_role: 'send_wallet', amount_cents: 6000, provider_metadata: meta(0), completed_at: at('2026-11-10T10:00:00Z') }),
    sendLeg({ id: 'leg-b', leg_role: 'send_bank', amount_cents: 4000, provider_metadata: meta(0), completed_at: at('2026-11-10T10:05:00Z') }),
    // A second recipient of the same send is its own payout.
    sendLeg({ id: 'leg-c', leg_role: 'send_wallet', amount_cents: 2500, provider_metadata: meta(1), completed_at: at('2026-11-10T10:00:00Z') }),
    // The same request hash under another organization is another payout.
    sendLeg({ id: 'leg-d', tenant_id: OTHER, amount_cents: 1000, provider_metadata: meta(0), completed_at: at('2026-11-11T10:00:00Z') }),
    // Legs without a request hash stand alone.
    sendLeg({ id: 'leg-e', amount_cents: 300, provider_metadata: {}, completed_at: at('2026-11-12T10:00:00Z') }),
    sendLeg({ id: 'leg-f', amount_cents: 200, provider_metadata: null, completed_at: at('2026-11-12T10:00:00Z') }),
  ];
  const { result } = await pnl({ transfers: legs });
  assert.equal(result.totals.payout_count, 5);
  assert.equal(result.totals.transfer_count, 5);
  assert.equal(result.totals.volume_cents, 14000);
  assert.equal(tenantRow(result, TENANT).payout_count, 4);
  assert.equal(tenantRow(result, TENANT).volume_cents, 13000);
  assert.equal(tenantRow(result, OTHER).payout_count, 1);
  // The grouping is the billing engine's: same key, same groups.
  const groups = new Set(legs.map((leg) => `${leg.tenant_id}|${sendRecipientKey(leg)}`));
  assert.equal(groups.size, result.totals.payout_count);
});

test('a payout whose legs complete in different months is counted in the month of its first leg', async () => {
  const meta = { request_hash: 'hash-2', recipient_index: 0, destination_kind: 'bank' };
  const { result } = await pnl({
    transfers: [
      sendLeg({ id: 'late', leg_role: 'send_bank', amount_cents: 4000, provider_metadata: meta, completed_at: at('2026-11-01T00:10:00Z') }),
      sendLeg({ id: 'early', leg_role: 'send_wallet', amount_cents: 6000, provider_metadata: meta, completed_at: at('2026-10-31T23:50:00Z') }),
    ],
  });
  assert.equal(month(result, '2026-10').payout_count, 1);
  assert.equal(month(result, '2026-11').payout_count, 0);
  // Each leg's money and fee stay in the month the leg completed.
  assert.equal(month(result, '2026-10').volume_cents, 6000);
  assert.equal(month(result, '2026-11').volume_cents, 4000);
  assert.equal(result.totals.payout_count, 1);
  assert.equal(result.totals.volume_cents, 10000);
});

test('volume is payouts to recipients only: funding, withdrawals, fee collection legs and parents are not payouts', async () => {
  const { result, client } = await pnl({
    transfers: [
      sendLeg({ id: 'send', amount_cents: 5000, completed_at: at('2026-11-10T00:00:00Z') }),
      ...['wallet_funding', 'wallet_withdrawal', 'wallet', 'ach_debit', 'parent', 'platform_fee', null].map((leg_role, i) => sendLeg({
        id: `other-${i}`, leg_role, amount_cents: 77700, completed_at: at('2026-11-10T00:00:00Z'),
      })),
      // A tenant-collection-v2 leg: part of an obligation already counted as revenue when it settled.
      sendLeg({ id: 'collection', leg_role: 'ach_debit', amount_cents: 2500, provider_metadata: { collection_contract: 'tenant-collection-v2', leg_type: 'ach_debit', billing_period: '2026-11' }, completed_at: at('2026-11-10T00:00:00Z') }),
    ],
  });
  assert.equal(result.totals.volume_cents, 5000);
  assert.equal(result.totals.payout_count, 1);
  assert.equal(result.totals.next_day_count, 1);
  assert.equal(result.totals.revenue_cents, 0);
  const query = client.queries.find((q) => q.sql.includes('FROM public.payment_transfers'));
  assert.match(query.sql, /leg_role IN \('send_wallet', 'send_bank'\)/);
});

test('only completed payouts count: nothing in flight, stopped or sent back', async () => {
  const statuses = ['completed', 'settled', 'succeeded', 'pending', 'created', 'submitted', 'processing', 'submitting', 'ready', 'failed', 'canceled', 'cancelled', 'returned', 'reversed'];
  const rows = statuses.map((status, i) => sendLeg({ id: `s-${status}`, status, amount_cents: 100 * (i + 1), completed_at: null, created_at: at('2026-11-16T12:00:00Z') }));
  const { result } = await pnl({ transfers: rows });
  // completed 100 + settled 200 + succeeded 300, dated by created_at when completed_at is missing.
  assert.equal(result.totals.volume_cents, 600);
  assert.equal(result.totals.payout_count, 3);
  assert.equal(month(result, '2026-11').payout_count, 3);
  // completed_at set by the webhook counts whatever the status text, except a leg that never left or came back.
  const stamped = statuses.map((status, i) => sendLeg({ id: `c-${status}`, status, amount_cents: 100 * (i + 1), completed_at: at('2026-11-17T12:00:00Z') }));
  const second = await pnl({ transfers: stamped });
  const counted = stamped.filter((row) => transferIsQualifying(row) && !['returned', 'reversed'].includes(row.status));
  assert.deepEqual(counted.map((row) => row.status), ['completed', 'settled', 'succeeded', 'submitted', 'processing', 'submitting']);
  assert.equal(second.result.totals.payout_count, counted.length);
  assert.equal(second.result.totals.volume_cents, counted.reduce((sum, row) => sum + row.amount_cents, 0));
});

test('payout fee: $0.25 next day, $0.40 same day, per completed ACH credit leg; a wallet destination costs nothing', async () => {
  const day = at('2026-11-10T00:00:00Z');
  const legs = [
    sendLeg({ id: 'std', speed: 'standard', completed_at: day }),
    sendLeg({ id: 'next', speed: 'next_day', completed_at: day }),
    sendLeg({ id: 'none', speed: null, completed_at: day }),
    sendLeg({ id: 'same', speed: 'same_day', completed_at: day }),
    sendLeg({ id: 'same-dash', tenant_id: OTHER, speed: 'same-day', completed_at: day }),
    // Wallet to wallet: no ACH rail, at any speed.
    sendLeg({ id: 'w1', speed: 'standard', provider_metadata: { destination_kind: 'wallet' }, completed_at: day }),
    sendLeg({ id: 'w2', speed: 'same_day', provider_metadata: { destination_kind: 'wallet' }, completed_at: day }),
    // No rate was given for instant: no fee is invented.
    sendLeg({ id: 'rtp', speed: 'instant', completed_at: day }),
  ];
  const { result } = await pnl({ transfers: legs });
  assert.equal(result.totals.next_day_count, 3);
  assert.equal(result.totals.same_day_count, 2);
  assert.equal(result.totals.payout_count, 8);
  assert.equal(tenantRow(result, TENANT).moov_cost_cents, 3 * 25 + 40);
  assert.equal(tenantRow(result, OTHER).moov_cost_cents, 40);
  assert.equal(tenantRow(result, TENANT).provider_cost_cents, 3 * 25 + 40);
  // The speed names are the billing engine's.
  for (const leg of legs.filter((row) => row.provider_metadata?.destination_kind !== 'wallet')) {
    const fee = feeTypeForTransfer(leg);
    const expected = fee === 'moov_same_day' ? 'same' : fee === 'moov_next_day' ? 'next' : 'none';
    const alone = (await pnl({ transfers: [leg] })).result.totals;
    assert.equal(alone.same_day_count === 1 ? 'same' : alone.next_day_count === 1 ? 'next' : 'none', expected, leg.id);
  }
});

test('check fee: $0.68 per check submitted, counted once however many deposit rows it has', async () => {
  const { result, client } = await pnl({
    deposits: [
      // One check, three deposit rows (a retry and a return): one fee, at the first submission.
      deposit({ id: 'd1', check_intake_item_id: 'check-1', checkalt_reference: 'ref-1b', status: 'cleared', submitted_at: at('2026-11-03T00:00:00Z') }),
      deposit({ id: 'd2', check_intake_item_id: 'check-1', checkalt_reference: 'ref-1a', status: 'returned', submitted_at: at('2026-10-28T00:00:00Z') }),
      deposit({ id: 'd3', check_intake_item_id: 'check-1', checkalt_reference: 'ref-1c', status: 'submitted', submitted_at: at('2026-11-05T00:00:00Z') }),
      deposit({ id: 'd4', tenant_id: OTHER, check_intake_item_id: 'check-2', checkalt_reference: 'ref-2', status: 'submitted', submitted_at: at('2026-11-06T00:00:00Z') }),
      // A returned check was submitted and charged.
      deposit({ id: 'd5', tenant_id: OTHER, check_intake_item_id: 'check-3', checkalt_reference: 'ref-3', status: 'returned', submitted_at: at('2026-11-07T00:00:00Z') }),
      // No check id: the provider reference identifies the check.
      deposit({ id: 'd6', check_intake_item_id: null, checkalt_reference: 'ref-4', submitted_at: at('2026-11-08T00:00:00Z') }),
      deposit({ id: 'd7', check_intake_item_id: null, checkalt_reference: 'ref-4', status: 'cleared', submitted_at: at('2026-11-09T00:00:00Z') }),
      // Never reached the provider, or not accepted by it.
      deposit({ id: 'd8', check_intake_item_id: 'check-5', checkalt_reference: null, submitted_at: at('2026-11-08T00:00:00Z') }),
      deposit({ id: 'd9', check_intake_item_id: 'check-6', checkalt_reference: 'ref-6', submitted_at: null }),
      ...['queued', 'submitting', 'pending', 'pending_approval', 'rejected', 'error', 'duplicate'].map((status, i) => deposit({
        id: `dx${i}`, check_intake_item_id: `check-x${i}`, checkalt_reference: `ref-x${i}`, status, submitted_at: at('2026-11-08T00:00:00Z'),
      })),
      // First submitted before the window: already counted then, not again for its later row.
      deposit({ id: 'd10', check_intake_item_id: 'check-7', checkalt_reference: 'ref-7a', submitted_at: at('2025-11-30T00:00:00Z') }),
      deposit({ id: 'd11', check_intake_item_id: 'check-7', checkalt_reference: 'ref-7b', submitted_at: at('2026-11-02T00:00:00Z') }),
    ],
  });
  assert.equal(result.totals.check_count, 4);
  assert.equal(result.totals.checkalt_cost_cents, 4 * 68);
  assert.equal(result.totals.provider_cost_cents, 4 * 68);
  assert.equal(result.totals.moov_minimum_topup_cents, 0);
  assert.equal(month(result, '2026-10').check_count, 1);
  assert.equal(month(result, '2026-11').check_count, 3);
  assert.equal(tenantRow(result, TENANT).checkalt_cost_cents, 2 * 68);
  assert.equal(tenantRow(result, OTHER).check_count, 2);
  const query = client.queries.find((q) => q.sql.includes('FROM public.checkalt_deposits'));
  assert.match(query.sql, /checkalt_reference IS NOT NULL/);
  assert.match(query.sql, /status IN \('submitted', 'cleared', 'returned'\)/);
});

test('no monthly minimum is applied: every month, organization and total costs only its per-item fees', async () => {
  const many = (count, over) => Array.from({ length: count }, (_, i) => sendLeg({ ...over, id: `${over.id}-${i}` }));
  const { result } = await pnl({
    payments: [
      settled({ amount_cents: 30000, settled_at: at('2026-08-15T00:00:00Z') }),
      settled({ tenant_id: OTHER, amount_cents: 90000, settled_at: at('2026-11-15T00:00:00Z') }),
    ],
    deposits: [deposit({ submitted_at: at('2026-08-20T00:00:00Z') })],
    transfers: [
      sendLeg({ id: 'sep-1', speed: 'standard', completed_at: at('2026-09-10T00:00:00Z') }),
      sendLeg({ id: 'sep-2', tenant_id: OTHER, speed: 'same_day', completed_at: at('2026-09-11T00:00:00Z') }),
      // November: 1,500 same-day legs are $600.00 of fees, more than the transfer provider's minimum.
      ...many(1500, { id: 'nov', tenant_id: OTHER, speed: 'same_day', amount_cents: 100, completed_at: at('2026-11-05T00:00:00Z') }),
    ],
  });
  // October has no activity and no minimum is owed for it: it is not a row.
  assert.deepEqual(result.months.map((m) => m.month), ['2026-08', '2026-09', '2026-11']);
  // August: one check, no payout.
  assert.deepEqual([month(result, '2026-08').checkalt_cost_cents, month(result, '2026-08').moov_cost_cents], [68, 0]);
  assert.equal(month(result, '2026-08').provider_cost_cents, 68);
  assert.equal(month(result, '2026-08').profit_cents, 30000 - 68);
  // September: two payouts cost $0.25 + $0.40, not $500.00.
  assert.equal(month(result, '2026-09').moov_cost_cents, 65);
  assert.equal(month(result, '2026-09').provider_cost_cents, 65);
  assert.equal(month(result, '2026-09').profit_cents, -65);
  // November (the current month): the fees themselves.
  assert.equal(month(result, '2026-11').moov_cost_cents, 60000);
  assert.equal(month(result, '2026-11').profit_cents, 90000 - 60000);

  assert.equal(result.totals.moov_cost_cents, 65 + 60000);
  assert.equal(result.totals.checkalt_cost_cents, 68);
  assert.equal(result.totals.provider_cost_cents, 68 + 65 + 60000);
  assert.equal(result.totals.revenue_cents, 120000);
  assert.equal(result.totals.profit_cents, 120000 - 60133);
  // The top-up key stays on months and totals and is always 0; tenant rows never carried it.
  for (const row of [result.totals, ...result.months]) assert.equal(row.moov_minimum_topup_cents, 0);
  for (const row of result.tenants) assert.equal('moov_minimum_topup_cents' in row, false);
  // The organizations add up to the total, key by key, and so do the months.
  const KEYS = ['revenue_cents', 'provider_cost_cents', 'profit_cents', 'volume_cents', 'payout_count', 'transfer_count', 'check_count',
    'next_day_count', 'same_day_count', 'checkalt_cost_cents', 'moov_cost_cents', 'check_processing_cost_cents', 'disbursement_cost_cents',
    'fees_cents', 'transfer_fees_cents'];
  assert.equal(result.tenants.reduce((sum, row) => sum + row.provider_cost_cents, 0), result.totals.provider_cost_cents);
  for (const key of KEYS) {
    assert.equal(result.tenants.reduce((sum, row) => sum + row[key], 0), result.totals[key], `tenants ${key}`);
    assert.equal(result.months.reduce((sum, m) => sum + m[key], 0), result.totals[key], `months ${key}`);
  }
  assert.equal(result.months.reduce((sum, m) => sum + m.moov_minimum_topup_cents, 0), 0);
  // The two cost columns: each row's provider cost is exactly check processing plus disbursements.
  for (const row of [result.totals, ...result.months, ...result.tenants]) {
    assert.equal(row.check_processing_cost_cents, row.checkalt_cost_cents);
    assert.equal(row.disbursement_cost_cents, row.moov_cost_cents);
    assert.equal(row.provider_cost_cents, row.check_processing_cost_cents + row.disbursement_cost_cents);
    assert.equal(row.profit_cents, row.revenue_cents - row.provider_cost_cents);
  }
});

test('the monthly minimums are information only: shown in cost_basis, applied nowhere', async () => {
  // One next-day payout in the month: far under both minimums.
  const { result } = await pnl({
    payments: [settled({ amount_cents: 5000, settled_at: at('2026-11-02T00:00:00Z') })],
    transfers: [sendLeg({ speed: 'standard', completed_at: at('2026-11-10T00:00:00Z') })],
    deposits: [deposit({ submitted_at: at('2026-11-20T00:00:00Z') })],
  });
  assert.deepEqual(result.cost_basis.provider_minimums, { deposit_cents: 100000, transfer_cents: 50000 });
  assert.equal(result.cost_basis.rates[0].checkalt_monthly_minimum_cents, 100000);
  assert.equal(result.cost_basis.rates[0].moov_monthly_minimum_cents, 50000);
  assert.ok(result.cost_basis.notes.some((note) => /monthly minimums .* not included in provider cost or profit/.test(note)));
  assert.equal(result.cost_basis.notes.some((note) => /top-up|minimum applies/.test(note)), false);
  assert.deepEqual(Object.keys(result.cost_basis), ['estimated', 'rates', 'provider_minimums', 'notes']);
  assert.equal(result.totals.checkalt_cost_cents, 68);
  assert.equal(result.totals.moov_cost_cents, 25);
  assert.equal(result.totals.provider_cost_cents, 93);
  assert.equal(result.totals.profit_cents, 5000 - 93);
  assert.equal(result.totals.moov_minimum_topup_cents, 0);
  assert.deepEqual(result.months.map((m) => [m.month, m.provider_cost_cents, m.moov_minimum_topup_cents]), [['2026-11', 93, 0]]);
  // No shortfall, minimum or top-up amount appears on any row.
  for (const row of [result.totals, ...result.months, ...result.tenants]) {
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'number') assert.ok(Math.abs(value) < 49000 || key === 'volume_cents', `${key} ${value}`);
    }
  }
  // Nothing to read: the minimums are still only information.
  const empty = await pnlPayload(null, { environment: 'production', now: NOW });
  assert.deepEqual(empty.cost_basis.provider_minimums, { deposit_cents: 100000, transfer_cents: 50000 });
  assert.equal(empty.totals.provider_cost_cents, 0);
  assert.equal(empty.totals.moov_minimum_topup_cents, 0);
  assert.equal(empty.totals.profit_cents, 0);
});

test('the owner\'s November 2026 shape: 22 checks and 7 completed bank payouts cost their per-item fees only', async () => {
  const { result } = await pnl({
    payments: [settled({ amount_cents: 27100, settled_at: at('2026-11-12T00:00:00Z') })],
    deposits: Array.from({ length: 22 }, (_, i) => deposit({
      id: `nov-check-${i}`, check_intake_item_id: `nov-item-${i}`, checkalt_reference: `nov-ref-${i}`, submitted_at: at('2026-11-03T00:00:00Z'),
    })),
    transfers: [
      ...Array.from({ length: 4 }, (_, i) => sendLeg({ id: `nov-next-${i}`, speed: 'standard', amount_cents: 500000, completed_at: at('2026-11-10T00:00:00Z') })),
      ...Array.from({ length: 3 }, (_, i) => sendLeg({ id: `nov-same-${i}`, speed: 'same_day', amount_cents: 500000, completed_at: at('2026-11-18T00:00:00Z') })),
    ],
  });
  const november = month(result, '2026-11');
  assert.deepEqual(result.months.map((m) => m.month), ['2026-11']);
  assert.equal(november.check_count, 22);
  assert.equal(november.payout_count, 7);
  assert.deepEqual([november.next_day_count, november.same_day_count], [4, 3]);
  assert.equal(november.checkalt_cost_cents, 22 * 68);
  assert.equal(november.moov_cost_cents, 4 * 25 + 3 * 40);
  assert.equal(november.provider_cost_cents, 22 * 68 + 4 * 25 + 3 * 40);
  assert.equal(november.provider_cost_cents, 1716);
  assert.ok(november.provider_cost_cents < 50000);
  assert.equal(november.moov_minimum_topup_cents, 0);
  assert.equal(november.profit_cents, 27100 - 1716);
  assert.deepEqual(result.totals, (({ month: _month, ...rest }) => rest)(november));
  assert.equal(tenantRow(result, TENANT).provider_cost_cents, 1716);
  assert.equal(tenantRow(result, TENANT).profit_cents, 27100 - 1716);
});

test('the window starts on the first day of the month 11 months back, also on the 29th to the 31st', async () => {
  // setMonth(-11) on 31 January lands on "31 February", which is 3 March: February was dropped.
  assert.equal(pnlWindow(at('2027-01-31T12:00:00Z')).since.toISOString(), '2026-02-01T00:00:00.000Z');
  assert.equal(pnlWindow(at('2026-12-31T23:59:59Z')).since.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(pnlWindow(at('2027-03-30T00:00:00Z')).since.toISOString(), '2026-04-01T00:00:00.000Z');
  assert.equal(pnlWindow(at('2026-11-01T00:00:00Z')).since.toISOString(), '2025-12-01T00:00:00.000Z');
  const now = at('2027-01-31T12:00:00Z');
  const { result, client } = await pnl({
    payments: [
      settled({ amount_cents: 1100, settled_at: at('2026-02-01T00:00:00Z') }),
      settled({ amount_cents: 2200, settled_at: at('2026-02-28T23:59:59Z') }),
      settled({ amount_cents: 99900, settled_at: at('2026-01-31T23:59:59Z') }),
    ],
    transfers: [sendLeg({ amount_cents: 700, completed_at: at('2026-01-31T23:59:59Z') })],
  }, { now });
  assert.equal(result.since, '2026-02-01T00:00:00.000Z');
  assert.equal(result.until, now.toISOString());
  assert.equal(month(result, '2026-02').revenue_cents, 3300);
  assert.equal(result.totals.revenue_cents, 3300);
  assert.equal(result.totals.volume_cents, 0);
  for (const table of ['tenant_maintenance_payments', 'payment_transfers']) {
    const query = client.queries.find((q) => q.sql.includes(`FROM public.${table}`));
    assert.deepEqual(query.params.slice(0, 2), ['2026-02-01T00:00:00.000Z', now.toISOString()], table);
  }
});

test('rows dated after now are ignored', async () => {
  const { result } = await pnl({
    payments: [settled({ amount_cents: 1000, settled_at: at('2026-11-26T11:59:59Z') }), settled({ amount_cents: 5000, settled_at: at('2026-11-26T12:00:01Z') }), settled({ amount_cents: 7000, settled_at: at('2027-01-01T00:00:00Z') })],
    transfers: [sendLeg({ amount_cents: 300, completed_at: at('2026-11-26T12:00:00Z') }), sendLeg({ amount_cents: 900, completed_at: at('2026-12-02T00:00:00Z') })],
    deposits: [deposit({ submitted_at: at('2026-11-20T00:00:00Z') }), deposit({ check_intake_item_id: 'check-9', checkalt_reference: 'ref-9', submitted_at: at('2026-11-27T00:00:00Z') })],
  });
  assert.equal(result.totals.revenue_cents, 1000);
  assert.equal(result.totals.volume_cents, 300);
  assert.equal(result.totals.payout_count, 1);
  assert.equal(result.totals.check_count, 1);
  assert.deepEqual(result.months.map((m) => m.month), ['2026-11']);
});

test('a source that cannot be read is named, never shown as a silent zero', async () => {
  const warn = console.warn;
  const logged = [];
  console.warn = (...args) => logged.push(args.join(' '));
  try {
    const rows = {
      payments: [settled({ amount_cents: 1000, settled_at: at('2026-11-02T00:00:00Z') })],
      transfers: [sendLeg({ amount_cents: 300, completed_at: at('2026-11-10T00:00:00Z') })],
      deposits: [deposit({ submitted_at: at('2026-11-20T00:00:00Z') })],
    };
    assert.deepEqual((await pnl(rows)).result.sources_unavailable, []);
    const revenue = await pnl({ ...rows, failing: ['tenant_maintenance_payments'] });
    assert.deepEqual(revenue.result.sources_unavailable, ['collected_revenue']);
    assert.equal(revenue.result.totals.revenue_cents, 0);
    // The other sources still answer: the failed read is rolled back to its savepoint.
    assert.equal(revenue.result.totals.volume_cents, 300);
    assert.equal(revenue.result.totals.check_count, 1);
    const sql = revenue.client.queries.map((q) => q.sql);
    assert.ok(sql.indexOf('SAVEPOINT pnl_collected_revenue') >= 0);
    assert.ok(sql.indexOf('ROLLBACK TO SAVEPOINT pnl_collected_revenue') > sql.indexOf('SAVEPOINT pnl_collected_revenue'));
    assert.ok(sql.includes('RELEASE SAVEPOINT pnl_payouts'));
    assert.ok(logged.some((line) => line.includes('platform_finance_pnl_source_unavailable') && line.includes('collected_revenue') && line.includes('42501')));

    const all = await pnl({ ...rows, failing: ['tenants', 'tenant_maintenance_payments', 'payment_transfers', 'checkalt_deposits'] });
    assert.deepEqual(all.result.sources_unavailable, [...PNL_SOURCES]);
    assert.deepEqual(all.result.months, []);
    assert.equal(all.result.totals.profit_cents, 0);
    // No database at all: every source is unavailable.
    assert.deepEqual((await pnlPayload(null, { environment: 'production', now: NOW })).sources_unavailable, [...PNL_SOURCES]);
    // Through the handler the page still answers 200 and carries the list.
    await withEnv(PRODUCTION_FLAGS, async () => {
      const d = deps({ client: mockClient({ failing: ['checkalt_deposits'] }) });
      const result = await call('platform-treasury', { action: 'overview' }, d);
      assert.equal(result.statusCode, 200, JSON.stringify(result));
      assert.deepEqual(result.pnl.sources_unavailable, ['check_deposits']);
      assert.equal(result.pnl.totals.revenue_cents, 2500);
    });
  } finally {
    console.warn = warn;
  }
});

test('response shape: every key the panel reads is still there, with the new fields next to them', async () => {
  const { result } = await pnl({
    payments: [settled({ amount_cents: 2500, settled_at: at('2026-11-02T00:00:00Z') })],
    transfers: [sendLeg({ amount_cents: 300, completed_at: at('2026-11-10T00:00:00Z') })],
    deposits: [deposit({ submitted_at: at('2026-11-20T00:00:00Z') })],
  });
  const OLD = ['fees_cents', 'transfer_fees_cents', 'provider_cost_cents', 'volume_cents', 'transfer_count', 'revenue_cents', 'profit_cents'];
  // The last two are the two cost columns under names that do not name a provider.
  const NEW = ['checkalt_cost_cents', 'moov_cost_cents', 'check_count', 'payout_count', 'next_day_count', 'same_day_count',
    'check_processing_cost_cents', 'disbursement_cost_cents'];
  assert.deepEqual(Object.keys(result), ['since', 'until', 'totals', 'months', 'tenants', 'cost_basis', 'sources_unavailable']);
  assert.deepEqual(Object.keys(result.totals), [...OLD, ...NEW, 'moov_minimum_topup_cents']);
  assert.deepEqual(Object.keys(result.months[0]), ['month', ...OLD, ...NEW, 'moov_minimum_topup_cents']);
  assert.deepEqual(Object.keys(result.tenants[0]), ['tenant_id', 'tenant_name', ...OLD, ...NEW]);
  for (const row of [result.totals, ...result.months, ...result.tenants]) {
    for (const key of [...OLD, ...NEW]) assert.equal(Number.isInteger(row[key]), true, key);
    // Old keys, new meaning: fees are the collected revenue, no separate transfer fee, transfers are payouts.
    assert.equal(row.fees_cents, row.revenue_cents);
    assert.equal(row.transfer_fees_cents, 0);
    assert.equal(row.transfer_count, row.payout_count);
    assert.equal(row.provider_cost_cents, row.checkalt_cost_cents + row.moov_cost_cents);
    assert.equal(row.profit_cents, row.revenue_cents - row.provider_cost_cents);
  }
  assert.equal(result.tenants[0].tenant_name, 'Freedom Adjustment');
  assert.equal(result.cost_basis.estimated, true);
  assert.deepEqual(result.cost_basis.rates, PROVIDER_COST_RATES.map((row) => ({ ...row })));
  assert.ok(Array.isArray(result.cost_basis.notes) && result.cost_basis.notes.length > 0);
  // User-facing text never names the payment provider.
  for (const note of result.cost_basis.notes) assert.equal(/moov|check ?alt/i.test(note), false, note);
  // The panel's own row type is unchanged and still satisfied.
  const panel = fs.readFileSync(path.join(ROOT, 'src/components/admin/PlatformTreasuryPanel.tsx'), 'utf8');
  for (const key of OLD) assert.match(panel, new RegExp(`\\b${key}: number;`), key);
});
