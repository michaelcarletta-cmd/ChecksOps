import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  buildWalletActivityFeed as buildTs,
  WALLET_ACTIVITY_LABEL,
} from '../../src/lib/payments/walletActivityFeed.ts';
import {
  buildWalletActivityFeed as buildJs,
} from '../functions/api/providers/production/moov-wallet-activity.mjs';
import { runMoovWalletProjection } from '../functions/api/providers/production/moov-wallet-projection.mjs';
import { TENANT_MEMBERSHIP_SQL } from '../functions/api/identity.mjs';
import { PIPELINE_TEST_SANDBOX } from '../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import { KNOWN_APPROVED_MOOV } from '../functions/api/providers/production/moov-accounts.mjs';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const PIPELINE = PIPELINE_TEST_SANDBOX.tenantId;
const FREEDOM = KNOWN_APPROVED_MOOV.freedom.tenantId;
const USER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM_FUND = '15946bc6-7e80-42d2-99a3-5a3793b24d2e';
const FREEDOM_SWEEP = '4e39f67f-383f-44d4-b5f8-212d4cc29bb0';
const FREEDOM_FUND_ROW = '257b6033-eac0-4555-877e-a8cb4f801c8f';
const FREEDOM_SWEEP_ROW = '3017ab0e-ae69-49cd-8c2c-8df4f6f9d52e';
const COMPLETED_IN = 'dec24b01-e559-4014-b072-af1ac0e4d013';
const COMPLETED_OUT = 'c2d1078a-0261-4a3b-9782-777fad834af9';
const CURRENT_FUND = 'e42635e8-7a75-4d25-ad2f-dd0e5696372d';
const FUNDING_INTENT = '985f487b-74f2-4d9f-8e6f-7cad9ae10c97';
const PAYOUT_INTENT = '80f4648b-551c-4ec6-a9fc-921b85bc8320';
const SWEEP_PULL = 'aaaaaaaa-bbbb-4ccc-8ddd-111111111111';

const pipelineTransfers = [
  {
    id: FUNDING_INTENT,
    tenant_id: PIPELINE,
    environment: 'sandbox',
    amount_cents: 1,
    status: 'completed',
    provider_status: 'completed',
    leg_role: 'wallet_funding',
    provider_transfer_id: CURRENT_FUND,
    created_at: '2026-09-21T13:37:39.000Z',
    completed_at: '2026-09-21T14:16:02.000Z',
  },
  {
    id: PAYOUT_INTENT,
    tenant_id: PIPELINE,
    environment: 'sandbox',
    amount_cents: 1,
    status: 'completed',
    provider_status: 'completed',
    leg_role: 'wallet_disbursement',
    provider_transfer_id: COMPLETED_OUT,
    created_at: '2026-09-21T12:14:43.000Z',
    completed_at: '2026-09-21T12:46:00.000Z',
  },
  {
    id: 'b18a96d7-4415-4df8-992f-70d5a17365a9',
    tenant_id: PIPELINE,
    environment: 'sandbox',
    amount_cents: 1,
    status: 'completed',
    provider_status: 'completed',
    leg_role: 'wallet_funding',
    provider_transfer_id: COMPLETED_IN,
    created_at: '2026-09-20T20:35:51.000Z',
    completed_at: '2026-09-21T04:16:07.000Z',
  },
];

const freedomTransfers = [
  {
    id: FREEDOM_FUND_ROW,
    tenant_id: FREEDOM,
    environment: 'production',
    amount_cents: 1,
    status: 'completed',
    provider_status: 'completed',
    leg_role: 'wallet_funding',
    provider_transfer_id: FREEDOM_FUND,
    created_at: '2026-09-16T11:06:12.000Z',
    completed_at: '2026-09-18T15:16:05.000Z',
  },
];

const freedomActivity = [
  {
    id: FREEDOM_SWEEP_ROW,
    tenant_id: FREEDOM,
    environment: 'production',
    origin: 'provider_sweep',
    activity_kind: 'sweep_push',
    provider_transfer_id: FREEDOM_SWEEP,
    status: 'completed',
    amount_cents: 1,
    source_rail: 'moov-wallet',
    destination_rail: 'ach-credit-standard',
    provider_created_at: '2026-09-18T16:00:00.000Z',
    observed_at: '2026-09-19T11:01:42.000Z',
  },
  {
    id: '0e02ce37-1dde-483f-974a-e6bec745d48d',
    tenant_id: FREEDOM,
    environment: 'production',
    origin: 'provider_unknown',
    activity_kind: 'transfer',
    provider_transfer_id: FREEDOM_FUND,
    payment_transfer_id: FREEDOM_FUND_ROW,
    status: 'completed',
    amount_cents: 1,
    observed_at: '2026-09-19T11:01:42.000Z',
  },
];

const sweepPull = {
  id: 'bbbbbbbb-cccc-4ddd-8eee-222222222222',
  tenant_id: FREEDOM,
  environment: 'production',
  origin: 'provider_sweep',
  activity_kind: 'sweep_pull',
  provider_transfer_id: SWEEP_PULL,
  status: 'pending',
  amount_cents: 1,
  source_rail: 'ach-debit-fund',
  destination_rail: 'moov-wallet',
  provider_created_at: '2026-09-18T17:00:00.000Z',
  observed_at: '2026-09-18T17:00:01.000Z',
};

const duplicateLedger = [{
  id: 'ledger-dup-fund',
  wallet_id: 'freedom-prod-wallet',
  entry_type: 'funding',
  direction: 'credit',
  amount_cents: 1,
  provider_transfer_id: FREEDOM_FUND,
  transfer_id: FREEDOM_FUND_ROW,
  created_at: '2026-09-16T11:06:12.000Z',
}];

const mockClient = ({
  tenantId = PIPELINE,
  wallets = [],
  accounts = [],
  transfers = [],
  ledger = [],
  providerActivity = [],
} = {}) => {
  const queries = [];
  const writes = [];
  return {
    queries,
    writes,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/INSERT|UPDATE|DELETE|upsert/i.test(sql) && !sql.startsWith('SELECT')) {
        writes.push(sql);
        throw new Error('wallet_projection_write_forbidden');
      }
      if (sql === TENANT_MEMBERSHIP_SQL || sql.includes('FROM public.tenant_users')) {
        return {
          rows: [
            { tenant_id: PIPELINE, role: 'admin', tenant_name: 'Pipeline Test', tenant_slug: 'pipeline-test' },
            { tenant_id: FREEDOM, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' },
          ],
        };
      }
      if (sql.includes('FROM public.tenants')) {
        const id = params[0];
        return { rows: [{ id, moov_allowlisted: true, moov_environment: id === FREEDOM ? 'production' : 'sandbox' }] };
      }
      if (sql.includes('FROM public.payment_provider_accounts')) {
        return { rows: accounts.filter((row) => row.tenant_id === params[0] && row.environment === params[1]) };
      }
      if (sql.includes('FROM public.payment_wallets')) {
        return {
          rows: wallets.filter((row) => (
            row.tenant_id === params[0] && row.environment === params[1] && row.wallet_type === params[2]
          )),
        };
      }
      if (sql.includes('FROM public.payment_provider_activity')) {
        return { rows: providerActivity.filter((row) => row.tenant_id === params[0] && row.environment === params[1]) };
      }
      if (sql.includes('FROM public.payment_transfers')) {
        return { rows: transfers.filter((row) => row.tenant_id === params[0] && row.environment === params[1]) };
      }
      if (sql.includes('FROM public.payment_wallet_ledger')) {
        return { rows: ledger.filter((row) => row.wallet_id === params[0]) };
      }
      if (sql.includes('FROM public.payment_wallet_sub_ledgers')) return { rows: [] };
      return { rows: [] };
    },
  };
};

const ids = (feed) => feed.map((row) => row.provider_transfer_id || row.id);
const byProvider = (feed, id) => feed.find((row) => row.provider_transfer_id === id);

test('TS and JS activity builders stay identical', () => {
  const input = {
    transfers: [...pipelineTransfers, ...freedomTransfers],
    providerActivity: [...freedomActivity, sweepPull],
    ledger: duplicateLedger,
    environment: 'production',
  };
  assert.deepEqual(buildTs(input), buildJs(input));
  assert.equal(WALLET_ACTIVITY_LABEL.sweep_out, 'Sweep Out');
});

test('explicit funding, payout, sweep push/pull, pending status, and chronological order', () => {
  const feed = buildTs({
    transfers: [...pipelineTransfers, ...freedomTransfers],
    providerActivity: [...freedomActivity, sweepPull],
    ledger: duplicateLedger,
  });
  assert.equal(byProvider(feed, COMPLETED_IN)?.label, 'Money In');
  assert.equal(byProvider(feed, COMPLETED_OUT)?.label, 'Money Out');
  assert.equal(byProvider(feed, CURRENT_FUND)?.label, 'Money In');
  assert.equal(byProvider(feed, FREEDOM_FUND)?.label, 'Money In');
  assert.equal(byProvider(feed, FREEDOM_FUND)?.status, 'completed');
  assert.equal(byProvider(feed, FREEDOM_SWEEP)?.label, 'Sweep Out');
  assert.equal(byProvider(feed, SWEEP_PULL)?.label, 'Sweep In');
  assert.equal(byProvider(feed, SWEEP_PULL)?.status, 'pending');
  const times = feed.map((row) => Date.parse(row.timestamp));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test('duplicate provider movement from two sources is shown once, transfer wins', () => {
  const feed = buildTs({
    transfers: freedomTransfers,
    providerActivity: freedomActivity,
    ledger: duplicateLedger,
    environment: 'production',
  });
  const fundHits = feed.filter((row) => row.provider_transfer_id === FREEDOM_FUND);
  assert.equal(fundHits.length, 1);
  assert.equal(fundHits[0].source, 'payment_transfer');
  assert.equal(feed.filter((row) => row.provider_transfer_id === FREEDOM_SWEEP).length, 1);
  assert.equal(feed.some((row) => row.source === 'wallet_ledger'), false);
});

test('incomplete unkeyed ledger does not hide transfers or fabricate duplicates', () => {
  const feed = buildTs({
    transfers: pipelineTransfers,
    providerActivity: [],
    ledger: [{
      id: 'ledger-no-key',
      entry_type: 'funding',
      direction: 'credit',
      amount_cents: 1,
      created_at: '2026-09-21T18:00:00.000Z',
    }],
    environment: 'sandbox',
  });
  assert.equal(feed.some((row) => row.id === 'ledger-no-key'), false);
  assert.ok(byProvider(feed, COMPLETED_IN));
  assert.ok(byProvider(feed, COMPLETED_OUT));
});

test('sandbox and production histories cannot mix', () => {
  const sandbox = buildTs({
    transfers: [...pipelineTransfers, ...freedomTransfers],
    providerActivity: freedomActivity,
    environment: 'sandbox',
  });
  const production = buildTs({
    transfers: [...pipelineTransfers, ...freedomTransfers],
    providerActivity: freedomActivity,
    environment: 'production',
  });
  assert.equal(sandbox.every((row) => ids(sandbox).includes(row.provider_transfer_id)), true);
  assert.ok(byProvider(sandbox, COMPLETED_IN));
  assert.ok(byProvider(sandbox, COMPLETED_OUT));
  assert.equal(byProvider(sandbox, FREEDOM_FUND), undefined);
  assert.equal(byProvider(sandbox, FREEDOM_SWEEP), undefined);
  assert.ok(byProvider(production, FREEDOM_FUND));
  assert.ok(byProvider(production, FREEDOM_SWEEP));
  assert.equal(byProvider(production, COMPLETED_IN), undefined);
  assert.equal(byProvider(production, COMPLETED_OUT), undefined);
});

test('Freedom projection is GET-only, shows funding+sweep, and excludes sandbox', async () => {
  const fetchCalls = [];
  const client = mockClient({
    wallets: [{
      id: 'freedom-prod-wallet',
      tenant_id: FREEDOM,
      environment: 'production',
      wallet_type: 'operating',
      status: 'active',
      available_cents: 0,
      provider_wallet_id: KNOWN_APPROVED_MOOV.freedom.walletId,
      last_synced_at: '2026-09-18T15:16:05.000Z',
    }],
    accounts: [{
      tenant_id: FREEDOM,
      environment: 'production',
      provider_account_id: KNOWN_APPROVED_MOOV.freedom.moovAccountId,
    }],
    transfers: [...pipelineTransfers, ...freedomTransfers],
    providerActivity: [...freedomActivity, {
      ...freedomActivity[0],
      id: 'sandbox-sweep',
      tenant_id: PIPELINE,
      environment: 'sandbox',
      provider_transfer_id: COMPLETED_OUT,
    }],
    ledger: duplicateLedger,
  });
  const result = await runMoovWalletProjection({
    client,
    mapping: { application_user_id: USER },
    body: { tenant_id: FREEDOM, environment: 'sandbox' },
    fetchImpl: async (url, init = {}) => {
      fetchCalls.push({ url: String(url), method: init.method || 'GET' });
      throw new Error('production_must_not_call_provider');
    },
    getWallet: async () => {
      throw new Error('production_must_not_get_wallet');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.environment, 'production');
  assert.equal(result.liveProviderPosted, false);
  assert.equal(result.createdPaymentTransfer, false);
  assert.equal(fetchCalls.length, 0);
  assert.equal(client.writes.length, 0);
  assert.ok(byProvider(result.activity, FREEDOM_FUND));
  assert.ok(byProvider(result.activity, FREEDOM_SWEEP));
  assert.equal(byProvider(result.activity, COMPLETED_IN), undefined);
  assert.equal(result.activity.filter((row) => row.provider_transfer_id === FREEDOM_FUND).length, 1);
});

test('Pipeline Test projection is GET-only and cannot include Freedom production rows', async () => {
  const fetchCalls = [];
  const client = mockClient({
    wallets: [{
      id: 'sandbox-wallet',
      tenant_id: PIPELINE,
      environment: 'sandbox',
      wallet_type: 'operating',
      status: 'active',
      available_cents: 1,
      provider_wallet_id: PIPELINE_TEST_SANDBOX.walletId,
      last_synced_at: '2026-09-21T14:16:02.000Z',
    }],
    accounts: [{
      tenant_id: PIPELINE,
      environment: 'sandbox',
      provider_account_id: PIPELINE_TEST_SANDBOX.accountId,
    }],
    transfers: [...pipelineTransfers, ...freedomTransfers],
    providerActivity: freedomActivity,
  });
  const result = await runMoovWalletProjection({
    client,
    mapping: { application_user_id: USER },
    body: { tenant_id: PIPELINE, environment: 'production' },
    getWallet: async ({ environment }) => {
      fetchCalls.push({ method: 'GET', environment });
      return { availableBalance: { valueDecimal: '0.01' }, pendingBalance: { valueDecimal: '0.00' } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.environment, 'sandbox');
  assert.equal(result.liveProviderPosted, false);
  assert.ok(fetchCalls.every((call) => call.method === 'GET'));
  assert.ok(byProvider(result.activity, COMPLETED_IN));
  assert.ok(byProvider(result.activity, COMPLETED_OUT));
  assert.ok(byProvider(result.activity, CURRENT_FUND));
  assert.equal(byProvider(result.activity, FREEDOM_FUND), undefined);
  assert.equal(byProvider(result.activity, FREEDOM_SWEEP), undefined);
});

test('missing provider_activity table fails soft and still shows transfers', async () => {
  const client = mockClient({
    wallets: [{
      id: 'sandbox-wallet',
      tenant_id: PIPELINE,
      environment: 'sandbox',
      wallet_type: 'operating',
      status: 'active',
      available_cents: 1,
      provider_wallet_id: PIPELINE_TEST_SANDBOX.walletId,
      last_synced_at: '2026-09-21T14:16:02.000Z',
    }],
    accounts: [{
      tenant_id: PIPELINE,
      environment: 'sandbox',
      provider_account_id: PIPELINE_TEST_SANDBOX.accountId,
    }],
    transfers: pipelineTransfers,
  });
  const original = client.query;
  client.query = async (sql, params = []) => {
    if (String(sql).includes('FROM public.payment_provider_activity')) {
      throw new Error('relation "payment_provider_activity" does not exist');
    }
    return original(sql, params);
  };
  const result = await runMoovWalletProjection({
    client,
    mapping: { application_user_id: USER },
    body: { tenant_id: PIPELINE },
    getWallet: async () => ({ availableBalance: { valueDecimal: '0.01' }, pendingBalance: { valueDecimal: '0.00' } }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider_activity.length, 0);
  assert.ok(byProvider(result.activity, COMPLETED_IN));
  assert.ok(byProvider(result.activity, COMPLETED_OUT));
  assert.equal(result.liveProviderPosted, false);
});

test('WalletOps customer feed uses the union helper and does not remount shortfall UX', () => {
  const page = sourceOf('../../src/pages/WalletOps.tsx');
  const projection = sourceOf('../functions/api/providers/production/moov-wallet-projection.mjs');
  assert.match(page, /buildWalletActivityFeed/);
  assert.match(page, /row\.label/);
  assert.doesNotMatch(page, /PayoutOrchestratorPanel/);
  assert.doesNotMatch(page, /Shortfall-aware/);
  assert.match(projection, /loadProviderActivity/);
  assert.match(projection, /buildWalletActivityFeed/);
  assert.doesNotMatch(projection, /method:\s*'POST'/);
});
