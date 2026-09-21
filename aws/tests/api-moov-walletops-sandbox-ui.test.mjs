import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TENANT_MEMBERSHIP_SQL } from '../functions/api/identity.mjs';
import { PIPELINE_TEST_SANDBOX } from '../functions/api/providers/production/moov-sandbox-wallet-fund.mjs';
import { KNOWN_APPROVED_MOOV } from '../functions/api/providers/production/moov-accounts.mjs';
import {
  projectWalletSnapshot,
  runMoovWalletProjection,
  walletSnapshotIsSynchronized,
} from '../functions/api/providers/production/moov-wallet-projection.mjs';
import {
  PENDING_SETUP_LABEL,
  PENDING_SYNC_LABEL,
  walletActivityTitle,
  walletBalanceLabel,
  walletIsSynchronized,
  walletOpsDisplayStatus,
} from '../../src/lib/payments/walletDisplay.ts';

const sourceOf = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const PIPELINE = PIPELINE_TEST_SANDBOX.tenantId;
const FREEDOM = KNOWN_APPROVED_MOOV.freedom.tenantId;
const USER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COMPLETED_IN = 'dec24b01-e559-4014-b072-af1ac0e4d013';
const COMPLETED_OUT = 'c2d1078a-0261-4a3b-9782-777fad834af9';
const CURRENT_FUND = 'e42635e8-7a75-4d25-ad2f-dd0e5696372d';
const FUNDING_INTENT = '985f487b-74f2-4d9f-8e6f-7cad9ae10c97';
const M712_OPERATION = '69704e23-9ddd-52f8-a2b1-d48bdb500926';
const SANDBOX_WALLET_ROW = '34f86d69-c84a-41f9-b5f1-781ebe9b5884';
const PROD_WALLET_ROW = '8c2b96f1-79c8-4c80-bbfd-fd5906c2bb73';

const sandboxTransfers = [
  {
    id: FUNDING_INTENT,
    tenant_id: PIPELINE,
    environment: 'sandbox',
    amount_cents: 1,
    status: 'processing',
    provider_status: 'source.originated',
    leg_role: 'wallet_funding',
    provider_transfer_id: CURRENT_FUND,
    created_at: '2026-09-21T14:00:00.000Z',
    is_facilitator_fee: false,
  },
  {
    id: '80f4648b-0000-4000-8000-000000000010',
    tenant_id: PIPELINE,
    environment: 'sandbox',
    amount_cents: 1,
    status: 'completed',
    provider_status: 'completed',
    leg_role: 'wallet_disbursement',
    provider_transfer_id: COMPLETED_OUT,
    created_at: '2026-09-21T05:00:00.000Z',
    is_facilitator_fee: false,
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
    created_at: '2026-09-21T04:16:07.000Z',
    is_facilitator_fee: false,
  },
];

const productionTransfers = [
  {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    tenant_id: FREEDOM,
    environment: 'production',
    amount_cents: 99,
    status: 'completed',
    provider_status: 'completed',
    leg_role: 'wallet_funding',
    provider_transfer_id: '15946bc6-7e80-42d2-99a3-5a3793b24d2e',
    created_at: '2026-01-01T00:00:00.000Z',
  },
];

const mockClient = ({
  tenantId = PIPELINE,
  environment = 'sandbox',
  wallets = [],
  accounts = [],
  transfers = [],
  ledger = [],
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
        const env = id === FREEDOM ? 'production' : 'sandbox';
        return { rows: [{ id, moov_allowlisted: true, moov_environment: env }] };
      }
      if (sql.includes('FROM public.payment_provider_accounts')) {
        return {
          rows: accounts.filter((row) => row.tenant_id === params[0] && row.environment === params[1]),
        };
      }
      if (sql.includes('FROM public.payment_wallets')) {
        return {
          rows: wallets.filter((row) => (
            row.tenant_id === params[0]
            && row.environment === params[1]
            && row.wallet_type === params[2]
          )),
        };
      }
      if (sql.includes('FROM public.payment_transfers')) {
        return {
          rows: transfers.filter((row) => row.tenant_id === params[0] && row.environment === params[1]),
        };
      }
      if (sql.includes('FROM public.payment_wallet_ledger')) {
        return { rows: ledger.filter((row) => row.wallet_id === params[0]) };
      }
      if (sql.includes('FROM public.payment_wallet_sub_ledgers')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
};

test('synchronized zero displays $0.00 and never-synced stays Pending sync', () => {
  assert.equal(walletBalanceLabel(null), PENDING_SYNC_LABEL);
  assert.equal(walletBalanceLabel({ available_cents: 0 }), PENDING_SYNC_LABEL);
  assert.equal(walletBalanceLabel({ available_cents: 0, status: 'active' }), PENDING_SYNC_LABEL);
  assert.equal(
    walletBalanceLabel({
      available_cents: 0,
      status: 'active',
      provider_wallet_id: PIPELINE_TEST_SANDBOX.walletId,
    }),
    '$0.00',
  );
  assert.equal(
    walletBalanceLabel({ available_cents: 0, last_synced_at: '2026-09-21T14:00:00.000Z' }),
    '$0.00',
  );
  assert.equal(
    walletBalanceLabel({ available_cents: 0, synchronized: true }),
    '$0.00',
  );
  assert.equal(walletIsSynchronized(null), false);
  assert.equal(walletBalanceLabel(null, { setupRequired: true }), PENDING_SETUP_LABEL);
  assert.equal(walletActivityTitle({ leg_role: 'wallet_funding' }), 'Money In');
  assert.equal(walletActivityTitle({ leg_role: 'funding' }), 'Money In');
  assert.equal(walletActivityTitle({ leg_role: 'wallet_disbursement' }), 'Money Out');
  assert.equal(walletOpsDisplayStatus({ status: 'processing', provider_status: 'source.originated' }), 'originated');
  assert.equal(walletOpsDisplayStatus({ status: 'completed' }), 'completed');
});

test('projection treats linked active 0 as synchronized without fabricating a wallet', () => {
  const pending = projectWalletSnapshot({ wallet: null });
  assert.equal(pending.synchronized, false);
  assert.equal(pending.wallet, null);

  const linkedZero = projectWalletSnapshot({
    wallet: {
      available_cents: 0,
      pending_cents: 0,
      status: 'active',
      provider_wallet_id: PIPELINE_TEST_SANDBOX.walletId,
      last_synced_at: null,
    },
  });
  assert.equal(walletSnapshotIsSynchronized(linkedZero.wallet), true);
  assert.equal(linkedZero.synchronized, true);
  assert.equal(linkedZero.wallet.available_cents, 0);

  const liveZero = projectWalletSnapshot({
    wallet: { available_cents: 0, status: 'active', provider_wallet_id: PIPELINE_TEST_SANDBOX.walletId },
    liveAvailableCents: 0,
    livePendingCents: 0,
    liveOk: true,
  });
  assert.equal(liveZero.wallet.available_cents, 0);
  assert.equal(liveZero.synchronized, true);
});

test('Pipeline Test sandbox projection is GET-only and shows existing activity', async () => {
  const fetchCalls = [];
  const client = mockClient({
    tenantId: PIPELINE,
    wallets: [{
      id: SANDBOX_WALLET_ROW,
      tenant_id: PIPELINE,
      environment: 'sandbox',
      wallet_type: 'operating',
      status: 'active',
      available_cents: 0,
      pending_cents: 0,
      provider_wallet_id: PIPELINE_TEST_SANDBOX.walletId,
      last_synced_at: null,
    }, {
      id: PROD_WALLET_ROW,
      tenant_id: PIPELINE,
      environment: 'production',
      wallet_type: 'operating',
      status: 'active',
      available_cents: 99,
      provider_wallet_id: KNOWN_APPROVED_MOOV.freedom.walletId,
    }],
    accounts: [{
      id: 'acct-sandbox',
      tenant_id: PIPELINE,
      environment: 'sandbox',
      provider_account_id: PIPELINE_TEST_SANDBOX.accountId,
    }, {
      id: 'acct-prod-unused',
      tenant_id: PIPELINE,
      environment: 'production',
      provider_account_id: '7597a1f1-79c8-4c80-bbfd-fd5906c2bb73',
    }],
    transfers: [...sandboxTransfers, ...productionTransfers],
  });
  const result = await runMoovWalletProjection({
    client,
    mapping: { application_user_id: USER },
    body: { tenant_id: PIPELINE, environment: 'production' },
    fetchImpl: async (url, init = {}) => {
      fetchCalls.push({ url: String(url), method: init.method || 'GET' });
      throw new Error('network_should_not_run_when_getWallet_provided');
    },
    getWallet: async ({ accountId, walletId, environment }) => {
      fetchCalls.push({ method: 'GET', accountId, walletId, environment });
      assert.equal(environment, 'sandbox');
      assert.equal(accountId, PIPELINE_TEST_SANDBOX.accountId);
      assert.equal(walletId, PIPELINE_TEST_SANDBOX.walletId);
      return { availableBalance: { valueDecimal: '0.00' }, pendingBalance: { valueDecimal: '0.00' } };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.environment, 'sandbox');
  assert.deepEqual(result.ignoredClientEnvironment, ['environment']);
  assert.equal(result.wallet.available_cents, 0);
  assert.equal(result.synchronized, true);
  assert.equal(result.liveProviderPosted, false);
  assert.equal(result.createdPaymentTransfer, false);
  assert.equal(result.productionExecution, false);
  assert.equal(result.productionMoneyMoved, false);
  assert.equal(client.writes.length, 0);
  assert.equal(result.transfers.some((row) => row.provider_transfer_id === COMPLETED_IN && row.leg_role === 'wallet_funding'), true);
  assert.equal(result.transfers.some((row) => row.provider_transfer_id === COMPLETED_OUT && row.leg_role === 'wallet_disbursement'), true);
  assert.equal(result.transfers.some((row) => row.provider_transfer_id === CURRENT_FUND && row.status === 'processing'), true);
  assert.equal(result.transfers.some((row) => row.environment === 'production'), false);
  assert.equal(result.wallet.available_cents, 0);
  assert.equal(result.wallet.environment, 'sandbox');
  assert.ok(fetchCalls.every((call) => String(call.method || 'GET').toUpperCase() === 'GET'));
  assert.equal(result.transfers.some((row) => row.provider_transfer_id === '15946bc6-7e80-42d2-99a3-5a3793b24d2e'), false);
});

test('Freedom production projection never reads sandbox history or POSTs', async () => {
  const fetchCalls = [];
  const client = mockClient({
    tenantId: FREEDOM,
    wallets: [{
      id: 'freedom-prod-wallet',
      tenant_id: FREEDOM,
      environment: 'production',
      wallet_type: 'operating',
      status: 'active',
      available_cents: 0,
      pending_cents: 0,
      provider_wallet_id: KNOWN_APPROVED_MOOV.freedom.walletId,
      last_synced_at: '2026-01-01T00:00:00.000Z',
    }, {
      id: SANDBOX_WALLET_ROW,
      tenant_id: PIPELINE,
      environment: 'sandbox',
      wallet_type: 'operating',
      status: 'active',
      available_cents: 0,
      provider_wallet_id: PIPELINE_TEST_SANDBOX.walletId,
    }],
    accounts: [{
      id: 'acct-freedom',
      tenant_id: FREEDOM,
      environment: 'production',
      provider_account_id: KNOWN_APPROVED_MOOV.freedom.moovAccountId,
    }],
    transfers: [...sandboxTransfers, ...productionTransfers],
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
  assert.equal(result.freedomTenant, true);
  assert.equal(result.wallet.provider_wallet_id, KNOWN_APPROVED_MOOV.freedom.walletId);
  assert.equal(result.liveProviderCalled, false);
  assert.equal(result.liveProviderPosted, false);
  assert.equal(result.transfers.every((row) => row.environment === 'production'), true);
  assert.equal(result.transfers.some((row) => row.provider_transfer_id === COMPLETED_IN), false);
  assert.equal(result.transfers.some((row) => row.provider_transfer_id === CURRENT_FUND), false);
  assert.equal(fetchCalls.length, 0);
});

test('sandbox projection refuses known production Moov object ids', async () => {
  const client = mockClient({
    wallets: [{
      id: SANDBOX_WALLET_ROW,
      tenant_id: PIPELINE,
      environment: 'sandbox',
      wallet_type: 'operating',
      status: 'active',
      available_cents: 0,
      provider_wallet_id: KNOWN_APPROVED_MOOV.freedom.walletId,
    }],
    accounts: [{
      tenant_id: PIPELINE,
      environment: 'sandbox',
      provider_account_id: PIPELINE_TEST_SANDBOX.accountId,
    }],
  });
  const result = await runMoovWalletProjection({
    client,
    mapping: { application_user_id: USER },
    body: { tenant_id: PIPELINE },
    getWallet: async () => ({ availableBalance: { valueDecimal: '9.99' } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'production_object_refused');
  assert.equal(result.liveProviderPosted, false);
});

test('WalletOps intercept is GET-only and cannot fall through to parity POST', () => {
  const providers = sourceOf('../functions/api/providers.mjs');
  const projection = sourceOf('../functions/api/providers/production/moov-wallet-projection.mjs');
  const parityWallet = sourceOf('../functions/api/providers/parity/moov-wallet.mjs');
  const walletOps = sourceOf('../../src/pages/WalletOps.tsx');
  const useWallet = sourceOf('../../src/hooks/useWallet.ts');
  const useWalletOps = sourceOf('../../src/hooks/useWalletOps.ts');
  const wallets = sourceOf('../../src/lib/payments/wallets.ts');
  const display = sourceOf('../../src/lib/payments/walletDisplay.ts');
  const fund = sourceOf('../functions/api/providers/production/moov-sandbox-wallet-fund.mjs');
  const disburse = sourceOf('../functions/api/providers/production/moov-sandbox-wallet-disburse.mjs');

  const interceptAt = providers.indexOf("name === 'moov-wallet-sync'");
  const parityAt = providers.indexOf('hasParityHandler(name)');
  const blockedAt = providers.indexOf('production_execution_blocked');
  assert.ok(interceptAt > 0);
  assert.ok(interceptAt < parityAt);
  assert.ok(interceptAt < blockedAt);
  assert.match(providers, /handleMoovWalletProjection/);
  assert.match(providers, /wallet_projection_failed/);
  assert.doesNotMatch(providers, /fall through to existing stubs/);
  assert.doesNotMatch(providers, /from '\.\/providers\/production\/moov-dispatch\.mjs'/);

  assert.match(projection, /Never POSTs to Moov/);
  assert.match(projection, /method: 'GET'/);
  assert.doesNotMatch(projection, /method:\s*'POST'/);
  assert.doesNotMatch(projection, /INSERT INTO public\.payment_transfers/);
  assert.doesNotMatch(projection, /\/transfers/);
  assert.doesNotMatch(projection, new RegExp(M712_OPERATION));
  assert.doesNotMatch(projection, new RegExp(CURRENT_FUND));

  assert.match(parityWallet, /method: 'POST'/);
  assert.match(walletOps, /walletBalanceLabel/);
  assert.match(walletOps, /walletActivityTitle/);
  assert.match(walletOps, /walletOpsDisplayStatus/);
  assert.match(walletOps, /MoovEnvironmentBadge/);
  assert.match(walletOps, /Automatic Funding/);
  assert.match(walletOps, /Payout Preferences/);
  assert.match(walletOps, /Recent Wallet Activity/);
  assert.doesNotMatch(walletOps, /PayoutOrchestratorPanel/);
  assert.doesNotMatch(walletOps, /Shortfall-aware/);
  assert.doesNotMatch(walletOps, /Funding required/);
  assert.doesNotMatch(walletOps, /Funding pending/);
  assert.doesNotMatch(walletOps, /Funds available/);
  assert.doesNotMatch(walletOps, /Ready to send/);
  assert.doesNotMatch(walletOps, /Payment pending/);
  assert.doesNotMatch(walletOps, /Payment completed/);
  assert.match(display, /PENDING_SYNC_LABEL = "Pending sync"/);
  assert.match(display, /formatWalletCents/);
  assert.match(useWallet, /readWalletSnapshot/);
  assert.match(useWalletOps, /originated/);
  assert.match(walletOps, /walletOpsDisplayStatus/);
  assert.match(wallets, /eq\("environment", environment\)/);
  assert.match(wallets, /readWalletSnapshot/);

  assert.match(fund, /SANDBOX_FUNDING_LEG = 'wallet_funding'/);
  assert.match(disburse, /wallet_disbursement/);
});
