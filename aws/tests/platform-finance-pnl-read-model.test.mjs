/**
 * Platform Finance Wallet & P&L read-model corrections.
 * Fixtures only. No live Moov, ACH, fee pulls, SQL apply, or AWS writes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  PRODUCTION_PLATFORM_ACCOUNT_ID,
  PRODUCTION_PLATFORM_WALLET_ID,
  V2_COLLECTION_CONTRACT,
  assembleV2Collections,
  buildPlatformPnl,
  classifyFeeCollection,
  classifyV2Collection,
  isAttributableCollectionCost,
  isCompletedProductionTransfer,
  monthOf,
  knownProductionWalletId,
  platformFinanceBank,
  platformFinanceTreasury,
  selectPlatformWallet,
  shapePlatformLedger,
  walletReadScopes,
  wrapPlatformFinance,
} from '../functions/api/providers/parity/platform-finance.mjs';

const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const FREEDOM_PAYMENT = '72b622f9-b68f-4032-a971-a854dbcfbf57';
const FREEDOM_XFER = 'b31c7752-031f-4b8b-9b6e-82dd0aaed2cb';
const FREEDOM_SETTLED = '2026-10-02T19:16:01.649638Z';
const PLATFORM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_TENANT = '11111111-1111-4111-8111-111111111111';

const mortgageFee = () => ({
  id: 'fee-10',
  tenant_id: FREEDOM,
  amount_cents: 1000,
  occurred_at: new Date('2026-08-20T16:00:00.000Z'),
  fee_code: 'mortgage_handling',
  status: 'unbilled',
  source_reference: 'mortgage_handling:aa3d85f9-ebed-4100-acf6-34d73109539d',
});

function freedomV2Evidence(overrides = {}) {
  return {
    payments: [{
      id: FREEDOM_PAYMENT,
      tenant_id: FREEDOM,
      amount_cents: 13900,
      status: 'submitted',
      method: 'moov_ach_consolidated',
      notes: `Moov ACH pull (monthly_subscription) for 2026-09 · moov:${FREEDOM_XFER}`,
      period_start: '2026-09-01',
      period_end: '2026-10-01',
      kind: 'monthly_subscription',
      collection_contract: V2_COLLECTION_CONTRACT,
    }],
    events: [{
      tenant_id: FREEDOM,
      provider_transfer_id: FREEDOM_XFER,
      new_status: 'completed',
      environment: 'production',
      created_at: FREEDOM_SETTLED,
      event_type: 'transfer.updated',
      provider_metadata: {
        collection_contract: V2_COLLECTION_CONTRACT,
        checksops_kind: 'monthly_subscription',
        checksops_payment_id: FREEDOM_PAYMENT,
        checksops_period: '2026-09',
        amount_cents: 13900,
      },
    }],
    transfers: [
      {
        id: 'sandbox-1',
        tenant_id: FREEDOM,
        amount_cents: 7200,
        status: 'ready',
        environment: 'sandbox',
        created_at: new Date('2026-10-03T12:00:00Z'),
        completed_at: null,
        provider_transfer_id: null,
        platform_fee_cents: 0,
        provider_fee_cents: null,
      },
      {
        id: 'sandbox-2',
        tenant_id: FREEDOM,
        amount_cents: 7200,
        status: 'ready',
        environment: 'sandbox',
        created_at: new Date('2026-10-03T13:00:00Z'),
        completed_at: null,
        provider_transfer_id: null,
        platform_fee_cents: 0,
        provider_fee_cents: null,
      },
    ],
    walletTransactions: [
      {
        walletTransactionID: 'ef5672b6-credit',
        transactionType: 'account-funding',
        grossAmount: 13900,
        status: 'completed',
        provider_transfer_id: FREEDOM_XFER,
        tenant_id: FREEDOM,
        collection_contract: V2_COLLECTION_CONTRACT,
        kind: 'monthly_subscription',
        completed_at: FREEDOM_SETTLED,
      },
      {
        walletTransactionID: '2b8076fe-fee',
        transactionType: 'moov-fee',
        memo: 'Fee for ACH payment',
        grossAmount: 40,
        provider_transfer_id: FREEDOM_XFER,
      },
      {
        walletTransactionID: 'unrelated-credit',
        transactionType: 'account-funding',
        grossAmount: 50000,
        provider_transfer_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        tenant_id: FREEDOM,
      },
      {
        walletTransactionID: 'kyc-fee',
        transactionType: 'moov-fee',
        memo: 'KYC verification fee',
        grossAmount: 350,
        provider_transfer_id: FREEDOM_XFER,
      },
      {
        walletTransactionID: 'min-commit',
        transactionType: 'moov-fee',
        memo: 'Minimum commitment',
        grossAmount: 2500,
      },
    ],
    ...overrides,
  };
}

function freedomPnl(overrides = {}) {
  const { evidence: evidenceOverrides, ...pnlOverrides } = overrides;
  return buildPlatformPnl({
    tenants: [{ id: FREEDOM, name: 'Freedom Adjustment' }],
    fees: [mortgageFee()],
    ...freedomV2Evidence(evidenceOverrides || {}),
    ...pnlOverrides,
  });
}
const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const sandboxCreds = () => ({
  moov: {
    publicKey: 'pk_sandbox',
    secretKey: 'sk_sandbox',
    platformAccountId: PLATFORM_ID,
    apiVersion: 'v2024.01.00',
  },
});

test('wallet read requests wallets.read and never profile.read', () => {
  const scopes = walletReadScopes(PRODUCTION_PLATFORM_ACCOUNT_ID);
  assert.deepEqual(scopes, [`/accounts/${PRODUCTION_PLATFORM_ACCOUNT_ID}/wallets.read`]);
  assert.equal(knownProductionWalletId(PRODUCTION_PLATFORM_ACCOUNT_ID, 'production'), PRODUCTION_PLATFORM_WALLET_ID);
  assert.equal(knownProductionWalletId(PLATFORM_ID, 'production'), null);
  const source = read('aws/functions/api/providers/parity/platform-finance.mjs');
  const walletFn = source.slice(source.indexOf('async function walletPayload'), source.indexOf('async function pnlPayload'));
  assert.match(source, /walletReadScopes/);
  assert.match(walletFn, /walletReadScopes/);
  assert.match(walletFn, /wallets\.read|scopesForRead/);
  assert.doesNotMatch(walletFn, /scopes\.accountRead/);
});

test('node-pg Date values produce valid year-month keys', () => {
  const feeDate = new Date('2026-08-20T16:00:00.000Z');
  const transferDate = new Date('2026-10-03T18:00:00.000Z');
  assert.equal(monthOf(feeDate), '2026-08');
  assert.equal(monthOf(transferDate), '2026-10');
  assert.equal(monthOf('2026-08-20T16:00:00.000Z'), '2026-08');
  assert.notEqual(monthOf(feeDate), String(feeDate).slice(0, 7));
  const label = (m) => {
    const [y, mo] = m.split('-');
    return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  };
  assert.equal(label(monthOf(feeDate)), 'Aug 2026');
  assert.notEqual(label(monthOf(feeDate)), 'Invalid Date');
});

test('unbilled $10 is outstanding, not collected revenue or profit', () => {
  const pnl = buildPlatformPnl({
    tenants: [{ id: FREEDOM, name: 'Freedom Adjustment' }],
    fees: [{
      id: 'fee-10',
      tenant_id: FREEDOM,
      amount_cents: 1000,
      occurred_at: new Date('2026-08-20T16:00:00.000Z'),
      fee_code: 'mortgage_handling',
      status: 'unbilled',
      source_reference: 'mortgage_handling:aa3d85f9-ebed-4100-acf6-34d73109539d',
    }],
    transfers: [],
  });
  assert.equal(pnl.totals.charged_cents, 1000);
  assert.equal(pnl.totals.outstanding_cents, 1000);
  assert.equal(pnl.totals.billed_processing_cents, 0);
  assert.equal(pnl.totals.collected_cents, 0);
  assert.equal(pnl.totals.revenue_cents, 0);
  assert.equal(pnl.totals.profit_cents, 0);
  assert.equal(pnl.totals.profit_available, true);
  assert.equal(pnl.totals.volume_cents, 0);
  assert.equal(pnl.tenants[0].tenant_name, 'Freedom Adjustment');
  assert.equal(pnl.tenants[0].outstanding_cents, pnl.totals.outstanding_cents);
  assert.equal(pnl.tenants[0].collected_cents, pnl.totals.collected_cents);
  assert.equal(pnl.months[0].month, '2026-08');
});

test('billed-but-not-completed fees are not collected revenue', () => {
  assert.equal(classifyFeeCollection({ status: 'billed', occurrence_status: 'scheduled' }), 'billed_processing');
  assert.equal(classifyFeeCollection({
    status: 'billed',
    occurrence_status: 'completed',
    provider_transfer_id: '',
  }), 'billed_processing');
  const pnl = buildPlatformPnl({
    tenants: [{ id: FREEDOM, name: 'Freedom Adjustment' }],
    fees: [{
      id: 'fee-billed',
      tenant_id: FREEDOM,
      amount_cents: 1000,
      occurred_at: '2026-09-01T00:00:00Z',
      status: 'billed',
      occurrence_status: 'scheduled',
      provider_transfer_id: null,
    }],
  });
  assert.equal(pnl.totals.billed_processing_cents, 1000);
  assert.equal(pnl.totals.collected_cents, 0);
  assert.equal(pnl.totals.revenue_cents, 0);
  assert.equal(pnl.totals.profit_cents, 0);
});

test('completed collection is counted exactly once', () => {
  const fee = {
    id: 'fee-collected',
    tenant_id: FREEDOM,
    amount_cents: 1000,
    occurred_at: '2026-09-01T00:00:00Z',
    status: 'billed',
    occurrence_status: 'completed',
    provider_transfer_id: 'xfer-collected-1',
    occurrence_id: 'occ-1',
  };
  const pnl = buildPlatformPnl({
    tenants: [{ id: FREEDOM, name: 'Freedom Adjustment' }],
    fees: [fee, { ...fee }],
  });
  assert.equal(classifyFeeCollection(fee), 'collected');
  assert.equal(pnl.totals.collected_cents, 1000);
  assert.equal(pnl.totals.revenue_cents, 1000);
  assert.equal(pnl.totals.profit_available, false);
  assert.equal(pnl.activity.filter((item) => item.kind === 'fee').length, 1);
});

test('sandbox and ready transfers are excluded from processed volume', () => {
  const pnl = buildPlatformPnl({
    tenants: [{ id: FREEDOM, name: 'Freedom Adjustment' }],
    transfers: [
      {
        id: 't1',
        tenant_id: FREEDOM,
        amount_cents: 7200,
        status: 'ready',
        environment: 'sandbox',
        created_at: new Date('2026-10-03T12:00:00Z'),
        completed_at: null,
        provider_transfer_id: null,
        platform_fee_cents: 0,
        provider_fee_cents: null,
      },
      {
        id: 't2',
        tenant_id: FREEDOM,
        amount_cents: 7200,
        status: 'ready',
        environment: 'sandbox',
        created_at: new Date('2026-10-03T13:00:00Z'),
        completed_at: null,
        provider_transfer_id: null,
        platform_fee_cents: 0,
        provider_fee_cents: null,
      },
    ],
  });
  assert.equal(pnl.totals.volume_cents, 0);
  assert.equal(pnl.totals.transfer_count, 0);
  assert.equal(isCompletedProductionTransfer({
    environment: 'sandbox',
    status: 'ready',
    provider_transfer_id: null,
    completed_at: null,
  }), false);
});

test('completed production transfers count once; failed and cancelled are excluded', () => {
  const completed = {
    id: 'prod-1',
    tenant_id: FREEDOM,
    amount_cents: 5000,
    status: 'completed',
    environment: 'production',
    completed_at: new Date('2026-10-01T12:00:00Z'),
    provider_transfer_id: 'moov-prod-1',
    platform_fee_cents: 0,
    provider_fee_cents: 25,
  };
  const pnl = buildPlatformPnl({
    tenants: [{ id: FREEDOM, name: 'Freedom Adjustment' }],
    transfers: [
      completed,
      { ...completed },
      {
        id: 'fail-1',
        tenant_id: FREEDOM,
        amount_cents: 9000,
        status: 'failed',
        environment: 'production',
        completed_at: new Date('2026-10-01T12:00:00Z'),
        provider_transfer_id: 'moov-fail',
        provider_fee_cents: 10,
      },
      {
        id: 'cancel-1',
        tenant_id: FREEDOM,
        amount_cents: 8000,
        status: 'cancelled',
        environment: 'production',
        completed_at: new Date('2026-10-01T12:00:00Z'),
        provider_transfer_id: 'moov-cancel',
        provider_fee_cents: 10,
      },
    ],
  });
  assert.equal(pnl.totals.volume_cents, 5000);
  assert.equal(pnl.totals.transfer_count, 1);
  assert.equal(pnl.totals.provider_cost_cents, 25);
  assert.equal(pnl.totals.provider_cost_available, true);
});

test('missing provider fee does not create false cost or profit certainty', () => {
  const pnl = buildPlatformPnl({
    tenants: [{ id: FREEDOM, name: 'Freedom Adjustment' }],
    fees: [{
      id: 'fee-collected',
      tenant_id: FREEDOM,
      amount_cents: 1000,
      occurred_at: '2026-09-01T00:00:00Z',
      status: 'billed',
      occurrence_status: 'completed',
      provider_transfer_id: 'xfer-collected-1',
    }],
    transfers: [{
      id: 'prod-missing-cost',
      tenant_id: FREEDOM,
      amount_cents: 5000,
      status: 'completed',
      environment: 'production',
      completed_at: '2026-10-01T12:00:00Z',
      provider_transfer_id: 'moov-prod-2',
      platform_fee_cents: 0,
      provider_fee_cents: null,
    }],
  });
  assert.equal(pnl.totals.collected_cents, 1000);
  assert.equal(pnl.totals.provider_cost_available, false);
  assert.equal(pnl.totals.provider_cost_missing, true);
  assert.equal(pnl.totals.profit_available, false);
  assert.equal(pnl.totals.profit_cents, null);
  const noVolume = shapePlatformLedger({
    charged_cents: 1000,
    outstanding_cents: 1000,
    billed_processing_cents: 0,
    collected_fee_cents: 0,
    collected_transfer_fee_cents: 0,
    provider_cost_cents: 0,
    provider_cost_rows: 0,
    provider_cost_missing_rows: 0,
    volume_cents: 0,
    transfer_count: 0,
  });
  assert.equal(noVolume.profit_cents, 0);
  assert.equal(noVolume.provider_cost_available, false);
});

test('organization totals reconcile to platform totals', () => {
  const other = '11111111-1111-4111-8111-111111111111';
  const pnl = buildPlatformPnl({
    tenants: [
      { id: FREEDOM, name: 'Freedom Adjustment' },
      { id: other, name: 'Other Org' },
    ],
    fees: [
      {
        id: 'a',
        tenant_id: FREEDOM,
        amount_cents: 1000,
        occurred_at: '2026-08-20T00:00:00Z',
        status: 'unbilled',
        fee_code: 'mortgage_handling',
        source_reference: 'mortgage_handling:aa3d85f9-ebed-4100-acf6-34d73109539d',
        claim_id: 'claim-1',
      },
      {
        id: 'b',
        tenant_id: other,
        amount_cents: 500,
        occurred_at: '2026-08-21T00:00:00Z',
        status: 'unbilled',
        fee_code: 'mortgage_handling',
      },
    ],
  });
  const summed = pnl.tenants.reduce((acc, row) => ({
    charged: acc.charged + row.charged_cents,
    outstanding: acc.outstanding + row.outstanding_cents,
    collected: acc.collected + row.collected_cents,
    volume: acc.volume + row.volume_cents,
  }), { charged: 0, outstanding: 0, collected: 0, volume: 0 });
  assert.equal(summed.charged, pnl.totals.charged_cents);
  assert.equal(summed.outstanding, pnl.totals.outstanding_cents);
  assert.equal(summed.collected, pnl.totals.collected_cents);
  assert.equal(summed.volume, pnl.totals.volume_cents);
  assert.equal(pnl.activity[0].source_reference, 'mortgage_handling:aa3d85f9-ebed-4100-acf6-34d73109539d');
  assert.equal(pnl.activity[0].claim_id, 'claim-1');
});

test('known wallet is selected without wallets[0] fallback', () => {
  const selected = selectPlatformWallet([
    { walletID: 'other', walletType: 'operating' },
    { walletID: PRODUCTION_PLATFORM_WALLET_ID, walletType: 'default' },
  ], {
    environment: 'production',
    platformAccountId: PRODUCTION_PLATFORM_ACCOUNT_ID,
    knownWalletId: PRODUCTION_PLATFORM_WALLET_ID,
  });
  assert.equal(selected.reason, 'known_wallet');
  assert.equal(selected.wallet.walletID, PRODUCTION_PLATFORM_WALLET_ID);
});

test('overview production wallet read uses wallets.read and the known wallet', async () => {
  const scopesSeen = [];
  const paths = [];
  const fetchImpl = async (url, init = {}) => {
    const path = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    paths.push({ method, path });
    if (path.includes('/oauth2/token')) {
      scopesSeen.push(String(init.body || ''));
      assert.equal(method, 'POST');
      return jsonRes({ access_token: 'tok', expires_in: 300 });
    }
    assert.equal(method, 'GET');
    assert.doesNotMatch(path, /\/transfers$/);
    if (path.endsWith(`/wallets/${PRODUCTION_PLATFORM_WALLET_ID}`)) {
      return jsonRes({
        walletID: PRODUCTION_PLATFORM_WALLET_ID,
        walletType: 'default',
        accountID: PRODUCTION_PLATFORM_ACCOUNT_ID,
        availableBalance: { value: 2500 },
        pendingBalance: { value: 100 },
      });
    }
    if (path.includes('/transactions')) return jsonRes([]);
    throw new Error(`unexpected ${method} ${path}`);
  };
  const previous = process.env.CHECKSOPS_ENV;
  const previousBilling = process.env.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID;
  process.env.CHECKSOPS_ENV = 'production-prep';
  process.env.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID = PRODUCTION_PLATFORM_ACCOUNT_ID;
  try {
    const result = await wrapPlatformFinance(platformFinanceTreasury, 'platform-treasury')(
      { body: JSON.stringify({ action: 'overview' }) },
      {
        withIdentity: async (_event, fn) => fn({
          client: { query: async () => ({ rows: [] }) },
          mapping: { application_user_id: '7dbb3009-f059-4767-b5dc-1c5c72379330', email: 'checksopsadmin@gmail.com' },
          claims: { sub: 'cognito-sub', email: 'checksopsadmin@gmail.com' },
          body: { action: 'overview' },
          spoof: [],
        }),
        loadSandboxCredentials: sandboxCreds,
        loadProviderSecrets: () => ({
          MOOV_PUBLIC_KEY: 'pk_prod',
          MOOV_SECRET_KEY: 'sk_prod',
          MOOV_SANDBOX_PLATFORM_ACCOUNT_ID: '36b79957-ce7a-4ca7-a68f-30986c9e47bb',
        }),
        fetchImpl,
      },
    );
    assert.equal(result.statusCode, 200);
    assert.equal(result.wallet.wallet_id, PRODUCTION_PLATFORM_WALLET_ID);
    assert.equal(result.wallet.available_cents, 2500);
    assert.equal(result.wallet.read_error, false);
    assert.equal(result.wallet.setup_required, false);
    assert.ok(scopesSeen.some((body) => decodeURIComponent(body).includes('wallets.read')));
    assert.ok(!scopesSeen.some((body) => decodeURIComponent(body).includes('profile.read') && decodeURIComponent(body).includes('wallets')));
    assert.ok(paths.some((call) => call.path.includes(`/wallets/${PRODUCTION_PLATFORM_WALLET_ID}`)));
    assert.ok(paths.every((call) => call.method === 'GET' || call.path.includes('/oauth2/token')));
    assert.ok(!paths.some((call) => call.method === 'POST' && call.path.includes('/wallets')));
  } finally {
    if (previous === undefined) delete process.env.CHECKSOPS_ENV;
    else process.env.CHECKSOPS_ENV = previous;
    if (previousBilling === undefined) delete process.env.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID;
    else process.env.AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID = previousBilling;
  }
});

test('wallet-read failure is not represented as zero balance or unprovisioned', async () => {
  const fetchImpl = async (url, init = {}) => {
    const path = String(url);
    if (path.includes('/oauth2/token')) return jsonRes({ access_token: 'tok', expires_in: 300 });
    return {
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: 'forbidden' }),
    };
  };
  const previous = process.env.CHECKSOPS_ENV;
  process.env.CHECKSOPS_ENV = 'staging';
  try {
    const result = await wrapPlatformFinance(platformFinanceTreasury, 'platform-treasury')(
      { body: JSON.stringify({ action: 'overview' }) },
      {
        withIdentity: async (_event, fn) => fn({
          client: { query: async () => ({ rows: [] }) },
          mapping: { application_user_id: '7dbb3009-f059-4767-b5dc-1c5c72379330', email: 'checksopsadmin@gmail.com' },
          claims: { sub: 'cognito-sub', email: 'checksopsadmin@gmail.com' },
          body: { action: 'overview' },
          spoof: [],
        }),
        loadSandboxCredentials: sandboxCreds,
        loadProviderSecrets: () => ({ MOOV_PUBLIC_KEY: 'pk_prod', MOOV_SECRET_KEY: 'sk_prod' }),
        fetchImpl,
      },
    );
    assert.equal(result.statusCode, 200);
    assert.equal(result.wallet.read_error, true);
    assert.equal(result.wallet.setup_required, false);
    assert.equal(result.wallet.available_cents, null);
    assert.equal(result.wallet.pending_cents, null);
    assert.notEqual(result.wallet.available_cents, 0);
    assert.match(result.wallet.warnings.join(' '), /Action forbidden|wallets:/);
  } finally {
    if (previous === undefined) delete process.env.CHECKSOPS_ENV;
    else process.env.CHECKSOPS_ENV = previous;
  }
});

test('no Moov writes are reachable from treasury overview or bank status', async () => {
  const fetchImpl = async (url, init = {}) => {
    const path = String(url);
    const method = String(init.method || 'GET').toUpperCase();
    if (path.includes('/oauth2/token')) return jsonRes({ access_token: 'tok', expires_in: 300 });
    assert.equal(method, 'GET', `${method} ${path}`);
    assert.doesNotMatch(path, /\/transfers$/);
    assert.doesNotMatch(path, /\/sweep/);
    if (path.endsWith('/wallets')) return jsonRes([]);
    return jsonRes([]);
  };
  const previous = process.env.CHECKSOPS_ENV;
  process.env.CHECKSOPS_ENV = 'staging';
  try {
    const overview = await wrapPlatformFinance(platformFinanceTreasury, 'platform-treasury')(
      { body: JSON.stringify({ action: 'overview' }) },
      {
        withIdentity: async (_event, fn) => fn({
          client: { query: async () => ({ rows: [] }) },
          mapping: { application_user_id: '7dbb3009-f059-4767-b5dc-1c5c72379330', email: 'checksopsadmin@gmail.com' },
          claims: { sub: 'cognito-sub', email: 'checksopsadmin@gmail.com' },
          body: { action: 'overview' },
          spoof: [],
        }),
        loadSandboxCredentials: sandboxCreds,
        loadProviderSecrets: () => ({ MOOV_PUBLIC_KEY: 'pk_prod', MOOV_SECRET_KEY: 'sk_prod' }),
        fetchImpl,
      },
    );
    const status = await wrapPlatformFinance(platformFinanceBank, 'moov-platform-bank')(
      { body: JSON.stringify({ action: 'status' }) },
      {
        withIdentity: async (_event, fn) => fn({
          client: { query: async () => ({ rows: [] }) },
          mapping: { application_user_id: '7dbb3009-f059-4767-b5dc-1c5c72379330', email: 'checksopsadmin@gmail.com' },
          claims: { sub: 'cognito-sub', email: 'checksopsadmin@gmail.com' },
          body: { action: 'status' },
          spoof: [],
        }),
        loadSandboxCredentials: sandboxCreds,
        loadProviderSecrets: () => ({ MOOV_PUBLIC_KEY: 'pk_prod', MOOV_SECRET_KEY: 'sk_prod' }),
        fetchImpl,
      },
    );
    assert.equal(overview.ach_initiated, false);
    assert.equal(overview.fee_pull, false);
    assert.equal(status.ach_initiated, false);
    assert.equal(status.fee_pull, false);
    assert.equal(status.bankAccountAddInvoked, false);
  } finally {
    if (previous === undefined) delete process.env.CHECKSOPS_ENV;
    else process.env.CHECKSOPS_ENV = previous;
  }
});

test('Freedom v2 collection is $149 charged, $10 outstanding, $139 collected, $0.40 cost, $138.60 profit', () => {
  const pnl = freedomPnl();
  assert.equal(pnl.totals.charged_cents, 14900);
  assert.equal(pnl.totals.outstanding_cents, 1000);
  assert.equal(pnl.totals.billed_processing_cents, 0);
  assert.equal(pnl.totals.collected_cents, 13900);
  assert.equal(pnl.totals.collected_v2_cents, 13900);
  assert.equal(pnl.totals.collected_fee_cents, 0);
  assert.equal(pnl.totals.provider_cost_cents, 40);
  assert.equal(pnl.totals.provider_cost_available, true);
  assert.equal(pnl.totals.profit_available, true);
  assert.equal(pnl.totals.profit_cents, 13860);
  assert.equal(pnl.totals.volume_cents, 0);
  const freedom = pnl.tenants.find((row) => row.tenant_id === FREEDOM);
  assert.equal(freedom.charged_cents, 14900);
  assert.equal(freedom.outstanding_cents, 1000);
  assert.equal(freedom.billed_processing_cents, 0);
  assert.equal(freedom.collected_cents, 13900);
  assert.equal(freedom.provider_cost_cents, 40);
  assert.equal(freedom.profit_cents, 13860);
  assert.equal(freedom.charged_cents, pnl.totals.charged_cents);
  assert.equal(freedom.collected_cents, pnl.totals.collected_cents);
  assert.equal(freedom.profit_cents, pnl.totals.profit_cents);
  const v2 = pnl.activity.filter((item) => item.kind === 'v2_collection');
  assert.equal(v2.length, 1);
  assert.equal(v2[0].payment_id, FREEDOM_PAYMENT);
  assert.equal(v2[0].provider_transfer_id, FREEDOM_XFER);
  assert.equal(v2[0].amount_cents, 13900);
  assert.equal(v2[0].provider_fee_cents, 40);
  assert.equal(v2[0].collection_contract, V2_COLLECTION_CONTRACT);
  assert.equal(v2[0].occurrence_id, undefined);
  const mortgage = pnl.activity.find((item) => item.fee_code === 'mortgage_handling');
  assert.equal(mortgage.collection_status, 'outstanding');
  assert.equal(mortgage.amount_cents, 1000);
});

test('v2 collected requires durable provider identity plus completed settlement', () => {
  assert.equal(classifyV2Collection({
    tenant_id: FREEDOM,
    amount_cents: 13900,
    kind: 'monthly_subscription',
    collection_contract: V2_COLLECTION_CONTRACT,
    status: 'submitted',
    notes: `moov:${FREEDOM_XFER}`,
  }), 'ignored');
  assert.equal(classifyV2Collection({
    tenant_id: FREEDOM,
    amount_cents: 13900,
    kind: 'monthly_subscription',
    status: 'completed',
    completed_at: FREEDOM_SETTLED,
  }), 'ignored');
  assert.equal(classifyV2Collection({
    tenant_id: FREEDOM,
    amount_cents: 13900,
    kind: 'monthly_subscription',
    provider_transfer_id: FREEDOM_XFER,
    status: 'pending',
    completed_at: FREEDOM_SETTLED,
  }), 'ignored');
  assert.equal(classifyV2Collection({
    tenant_id: FREEDOM,
    amount_cents: 13900,
    kind: 'monthly_subscription',
    provider_transfer_id: FREEDOM_XFER,
    status: 'completed',
    completed_at: FREEDOM_SETTLED,
    environment: 'production',
  }), 'collected');
  const localOnly = buildPlatformPnl({
    tenants: [{ id: FREEDOM, name: 'Freedom Adjustment' }],
    fees: [mortgageFee()],
    payments: [{
      id: FREEDOM_PAYMENT,
      tenant_id: FREEDOM,
      amount_cents: 13900,
      status: 'submitted',
      kind: 'monthly_subscription',
      collection_contract: V2_COLLECTION_CONTRACT,
      notes: 'Moov ACH pull (monthly_subscription) for 2026-09',
    }],
  });
  assert.equal(localOnly.totals.collected_cents, 0);
  assert.equal(localOnly.totals.charged_cents, 1000);
  assert.equal(localOnly.totals.outstanding_cents, 1000);
});

test('v2 payment, Moov transfer, and wallet credit are one collected event', () => {
  const assembled = assembleV2Collections(freedomV2Evidence());
  const collected = assembled.filter((row) => classifyV2Collection(row) === 'collected');
  assert.equal(collected.length, 1);
  assert.equal(collected[0].amount_cents, 13900);
  assert.equal(collected[0].provider_fee_cents, 40);
  const pnl = freedomPnl();
  assert.equal(pnl.activity.filter((item) => item.kind === 'v2_collection').length, 1);
  assert.equal(pnl.totals.collected_cents, 13900);
});

test('v2 exclusions: sandbox drafts, billing verification, pending/failed, unrelated credits, platform fees', () => {
  assert.equal(isAttributableCollectionCost({ memo: 'KYC verification fee', amount_cents: 350, associated: true }), false);
  assert.equal(isAttributableCollectionCost({ memo: 'Minimum commitment', amount_cents: 2500, associated: true }), false);
  assert.equal(isAttributableCollectionCost({ memo: 'Fee for ACH payment', amount_cents: 40, associated: true }), true);
  const pnl = buildPlatformPnl({
    tenants: [
      { id: FREEDOM, name: 'Freedom Adjustment' },
      { id: OTHER_TENANT, name: 'Other Org' },
    ],
    fees: [
      mortgageFee(),
      {
        id: 'other-unbilled',
        tenant_id: OTHER_TENANT,
        amount_cents: 500,
        occurred_at: '2026-08-21T00:00:00Z',
        status: 'unbilled',
        fee_code: 'mortgage_handling',
      },
    ],
    payments: [
      ...freedomV2Evidence().payments,
      {
        id: '367c5353-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        tenant_id: FREEDOM,
        amount_cents: 100,
        status: 'completed',
        kind: 'billing_verification',
        notes: 'billing-verification debit $1.00 · moov:11111111-2222-4333-8444-555555555555',
        provider_transfer_id: '11111111-2222-4333-8444-555555555555',
        completed_at: FREEDOM_SETTLED,
        environment: 'production',
      },
      {
        id: 'pending-v2',
        tenant_id: FREEDOM,
        amount_cents: 13900,
        status: 'pending',
        kind: 'monthly_subscription',
        collection_contract: V2_COLLECTION_CONTRACT,
        notes: 'moov:22222222-3333-4444-8555-666666666666',
      },
    ],
    events: [
      ...freedomV2Evidence().events,
      {
        tenant_id: FREEDOM,
        provider_transfer_id: '33333333-4444-4555-8666-777777777777',
        new_status: 'failed',
        environment: 'production',
        created_at: FREEDOM_SETTLED,
        provider_metadata: {
          collection_contract: V2_COLLECTION_CONTRACT,
          checksops_kind: 'monthly_subscription',
          checksops_payment_id: 'failed-v2',
          amount_cents: 13900,
        },
      },
      {
        tenant_id: FREEDOM,
        provider_transfer_id: '44444444-5555-4666-8777-888888888888',
        new_status: 'cancelled',
        environment: 'production',
        created_at: FREEDOM_SETTLED,
        provider_metadata: {
          collection_contract: V2_COLLECTION_CONTRACT,
          checksops_kind: 'monthly_subscription',
          checksops_payment_id: 'cancelled-v2',
          amount_cents: 13900,
        },
      },
    ],
    transfers: freedomV2Evidence().transfers,
    walletTransactions: freedomV2Evidence().walletTransactions,
  });
  assert.equal(classifyV2Collection({
    tenant_id: FREEDOM,
    amount_cents: 100,
    kind: 'billing_verification',
    provider_transfer_id: '11111111-2222-4333-8444-555555555555',
    status: 'completed',
    completed_at: FREEDOM_SETTLED,
    environment: 'production',
  }), 'ignored');
  assert.equal(pnl.totals.collected_cents, 13900);
  assert.equal(pnl.totals.charged_cents, 15400);
  assert.equal(pnl.totals.provider_cost_cents, 40);
  assert.equal(pnl.totals.volume_cents, 0);
  assert.equal(pnl.activity.filter((item) => item.kind === 'v2_collection').length, 1);
  const freedom = pnl.tenants.find((row) => row.tenant_id === FREEDOM);
  const other = pnl.tenants.find((row) => row.tenant_id === OTHER_TENANT);
  assert.equal(freedom.collected_cents + other.collected_cents, pnl.totals.collected_cents);
  assert.equal(freedom.charged_cents + other.charged_cents, pnl.totals.charged_cents);
  assert.equal(freedom.outstanding_cents + other.outstanding_cents, pnl.totals.outstanding_cents);
  assert.equal(freedom.provider_cost_cents + other.provider_cost_cents, pnl.totals.provider_cost_cents);
  assert.ok(!pnl.activity.some((item) => item.amount_cents === 100 && item.kind === 'v2_collection'));
  assert.ok(!pnl.activity.some((item) => item.amount_cents === 7200));
  assert.ok(!pnl.activity.some((item) => item.amount_cents === 50000));
});

test('collected v2 without attributable cost does not invent $0 profit', () => {
  const pnl = buildPlatformPnl({
    tenants: [{ id: FREEDOM, name: 'Freedom Adjustment' }],
    payments: freedomV2Evidence().payments,
    events: freedomV2Evidence().events,
  });
  assert.equal(pnl.totals.collected_cents, 13900);
  assert.equal(pnl.totals.provider_cost_cents, 0);
  assert.equal(pnl.totals.provider_cost_available, false);
  assert.equal(pnl.totals.profit_available, false);
  assert.equal(pnl.totals.profit_cents, null);
});

test('v2 does not manufacture a platform_fee_occurrence and keeps occurrence Collected intact', () => {
  const occurrence = {
    id: 'fee-collected',
    tenant_id: FREEDOM,
    amount_cents: 1000,
    occurred_at: '2026-09-01T00:00:00Z',
    status: 'billed',
    occurrence_status: 'completed',
    provider_transfer_id: 'xfer-collected-1',
    occurrence_id: 'occ-1',
  };
  const pnl = buildPlatformPnl({
    tenants: [{ id: FREEDOM, name: 'Freedom Adjustment' }],
    fees: [occurrence],
    ...freedomV2Evidence(),
  });
  assert.equal(classifyFeeCollection(occurrence), 'collected');
  assert.equal(pnl.totals.collected_fee_cents, 1000);
  assert.equal(pnl.totals.collected_v2_cents, 13900);
  assert.equal(pnl.totals.collected_cents, 14900);
  assert.ok(pnl.activity.every((item) => item.kind !== 'v2_collection' || !item.occurrence_id));
});

test('Banking panel and production hard-block remain unchanged', () => {
  const bank = read('src/components/admin/PlatformBankPanel.tsx');
  const treasury = read('src/components/admin/PlatformTreasuryPanel.tsx');
  const providers = read('aws/functions/api/providers.mjs');
  assert.match(bank, /action:\s*["']status["']/);
  assert.doesNotMatch(bank, /action:\s*["']overview["']/);
  assert.doesNotMatch(bank, /Accrued \/ Charged/);
  assert.match(treasury, /action:\s*["']overview["']/);
  assert.doesNotMatch(treasury, /action:\s*["']wallet["']/);
  assert.doesNotMatch(treasury, /action:\s*["']pnl["']/);
  assert.match(providers, /spec\.name === 'moov-platform-bank'\) return action === 'status'/);
  assert.match(providers, /spec\.name === 'platform-treasury'\) return action === 'overview'/);
  assert.doesNotMatch(providers, /action === 'wallet'/);
  assert.doesNotMatch(providers, /action === 'pnl'/);
  assert.match(treasury, /tenant-collection-v2/);
  assert.match(treasury, /subscription collection/);
  const source = read('aws/functions/api/providers/parity/platform-finance.mjs');
  assert.match(source, /FROM public\.tenant_maintenance_payments/);
  assert.match(source, /FROM public\.payment_event_log/);
  assert.match(source, /collected_v2_cents/);
  assert.doesNotMatch(source, /aws lambda update-function-code/);
});

function jsonRes(body) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  };
}
