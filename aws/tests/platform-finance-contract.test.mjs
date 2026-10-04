/**
 * Platform Finance read-model contracts.
 * Fixtures only. No live Moov, ACH, fee pulls, or AWS writes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  PLATFORM_FINANCE_WRITE_BLOCKED_MESSAGE,
  composePlatformBankDisplay,
  isPlatformFinanceFunction,
  isPlatformOwnerEmail,
  platformFinanceBank,
  platformFinanceTreasury,
  platformFinanceWriteBlocked,
  resolvePlatformFacilitatorId,
  resolvePlatformFinanceEnvironment,
  selectPlatformWallet,
  wrapPlatformFinance,
} from '../functions/api/providers/parity/platform-finance.mjs';

const PLATFORM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROD_PLATFORM_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const TENANT_MOOV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const sandboxCreds = () => ({
  moov: {
    publicKey: 'pk_sandbox',
    secretKey: 'sk_sandbox',
    platformAccountId: PLATFORM_ID,
    apiVersion: 'v2024.01.00',
  },
});

const productionSecrets = () => ({
  MOOV_PUBLIC_KEY: 'pk_prod',
  MOOV_SECRET_KEY: 'sk_prod',
  MOOV_ACCOUNT_ID: PROD_PLATFORM_ID,
});

test('status works without tenant_id and uses the facilitator', async () => {
  const fetchImpl = async (url) => {
    const path = String(url);
    if (path.includes('/oauth2/token')) return jsonRes({ access_token: 'tok', expires_in: 300 });
    assert.match(path, new RegExp(`/accounts/${PLATFORM_ID}`));
    assert.doesNotMatch(path, new RegExp(TENANT_MOOV));
    if (path.endsWith(`/accounts/${PLATFORM_ID}`)) {
      return jsonRes({ displayName: 'ChecksOps', verificationStatus: 'verified' });
    }
    if (path.endsWith('/capabilities')) {
      return jsonRes([{ capability: 'wallet.balance', status: 'enabled' }]);
    }
    if (path.endsWith('/bank-accounts')) {
      return jsonRes([{
        bankAccountID: 'bank_live',
        bankName: 'Facilitator Bank',
        lastFourAccountNumber: '4321',
        bankAccountType: 'checking',
        holderName: 'ChecksOps',
        status: 'verified',
      }]);
    }
    return jsonRes([]);
  };
  const client = {
    query: async () => ({ rows: [] }),
  };
  const result = await invokeWrapped('moov-platform-bank', platformFinanceBank, {
    body: { action: 'status' },
    fetchImpl,
    client,
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.success, true);
  assert.equal(result.platform_account_id, PLATFORM_ID);
  assert.equal(result.identity, 'checksops_facilitator');
  assert.equal(result.tenant_context_used, false);
  assert.equal(result.methods[0].last_four, '4321');
  assert.equal(result.ach_initiated, false);
  assert.equal(result.fee_pull, false);
});

test('overview works without tenant_id', async () => {
  const fetchImpl = async (url) => {
    const path = String(url);
    if (path.includes('/oauth2/token')) return jsonRes({ access_token: 'tok', expires_in: 300 });
    assert.match(path, new RegExp(`/accounts/${PLATFORM_ID}`));
    if (path.endsWith('/wallets')) {
      return jsonRes([{
        walletID: 'wal_op',
        walletType: 'operating',
        accountID: PLATFORM_ID,
        availableBalance: { value: 2500 },
        pendingBalance: { value: 100 },
      }]);
    }
    if (path.includes('/transactions')) return jsonRes([]);
    return jsonRes([]);
  };
  const result = await invokeWrapped('platform-treasury', platformFinanceTreasury, {
    body: { action: 'overview' },
    fetchImpl,
    client: { query: async () => ({ rows: [] }) },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.wallet.available_cents, 2500);
  assert.equal(result.wallet.pending_cents, 100);
  assert.equal(result.wallet.wallet_id, 'wal_op');
  assert.equal(result.tenant_context_used, false);
  assert.ok(result.pnl);
});

test('tenant membership cannot select the platform account', () => {
  const id = resolvePlatformFacilitatorId({
    environment: 'sandbox',
    sandboxPlatformAccountId: PLATFORM_ID,
    productionPlatformAccountId: PROD_PLATFORM_ID,
    claimedTenantId: TENANT_ID,
    membershipTenantId: TENANT_ID,
  });
  assert.equal(id, PLATFORM_ID);
  assert.notEqual(id, TENANT_ID);
});

test('staging resolves sandbox facilitator and production resolves production facilitator', () => {
  assert.equal(resolvePlatformFinanceEnvironment({ checksopsEnv: 'staging' }), 'sandbox');
  assert.equal(resolvePlatformFinanceEnvironment({ hostname: 'staging.checksops.com' }), 'sandbox');
  assert.equal(resolvePlatformFinanceEnvironment({ checksopsEnv: 'production' }), 'production');
  assert.equal(resolvePlatformFinanceEnvironment({ hostname: 'checksops.com' }), 'production');
  assert.equal(
    resolvePlatformFacilitatorId({
      environment: resolvePlatformFinanceEnvironment({ checksopsEnv: 'staging' }),
      sandboxPlatformAccountId: PLATFORM_ID,
      productionPlatformAccountId: PROD_PLATFORM_ID,
    }),
    PLATFORM_ID,
  );
  assert.equal(
    resolvePlatformFacilitatorId({
      environment: resolvePlatformFinanceEnvironment({ checksopsEnv: 'production' }),
      sandboxPlatformAccountId: PLATFORM_ID,
      productionPlatformAccountId: PROD_PLATFORM_ID,
    }),
    PROD_PLATFORM_ID,
  );
});

test('platform bank display accepts live Moov banks without local rows', () => {
  const rows = composePlatformBankDisplay({
    providerBanks: [{
      bank_account_id: 'bank_live',
      bank_name: 'Moov Bank',
      last_four: '9876',
      status: 'verified',
    }],
    localMethods: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].last_four, '9876');
  assert.equal(rows[0].source, 'moov');
});

test('wallet selection is deterministic and never wallets[0] when ambiguous', () => {
  const missingEnv = selectPlatformWallet([{ walletID: 'a' }], {});
  assert.equal(missingEnv.reason, 'environment_required');
  const unique = selectPlatformWallet([
    { walletID: 'wal_op', walletType: 'operating', accountID: PLATFORM_ID },
    { walletID: 'wal_other', walletType: 'reserve', accountID: PLATFORM_ID },
  ], { environment: 'sandbox', platformAccountId: PLATFORM_ID });
  assert.equal(unique.wallet.walletID, 'wal_op');
  const ambiguous = selectPlatformWallet([
    { walletID: 'one', walletType: 'operating' },
    { walletID: 'two', walletType: 'operating' },
  ], { environment: 'sandbox', platformAccountId: PLATFORM_ID });
  assert.equal(ambiguous.wallet, null);
  assert.equal(ambiguous.reason, 'ambiguous_wallet');
});

test('Platform Finance cannot invoke tenant bankAccountAdd and blocks writes', async () => {
  const write = platformFinanceWriteBlocked('add');
  assert.equal(write.statusCode, 403);
  assert.equal(write.write_blocked, true);
  assert.equal(write.bankAccountAddInvoked, false);
  const result = await invokeWrapped('moov-platform-bank', platformFinanceBank, {
    body: { action: 'add', tenant_id: TENANT_ID, routing_number: '123456789', account_number: '9999' },
    fetchImpl: async () => {
      throw new Error('Moov write must not run');
    },
  });
  assert.equal(result.statusCode, 403);
  assert.equal(result.write_blocked, true);
  assert.equal(result.bankAccountAddInvoked, false);
  assert.match(result.error, /disabled/i);
});

test('read operations never initiate ACH or fee pulls', async () => {
  const fetchImpl = async (url, init = {}) => {
    const path = String(url);
    if (path.includes('/oauth2/token')) return jsonRes({ access_token: 'tok', expires_in: 300 });
    assert.notEqual(String(init.method || 'GET').toUpperCase(), 'POST');
    assert.notEqual(String(init.method || 'GET').toUpperCase(), 'PUT');
    assert.doesNotMatch(path, /transfers/);
    return jsonRes([]);
  };
  const status = await invokeWrapped('moov-platform-bank', platformFinanceBank, {
    body: { action: 'status' },
    fetchImpl,
  });
  const overview = await invokeWrapped('platform-treasury', platformFinanceTreasury, {
    body: { action: 'overview' },
    fetchImpl,
  });
  assert.equal(status.ach_initiated, false);
  assert.equal(status.fee_pull, false);
  assert.equal(overview.ach_initiated, false);
  assert.equal(overview.fee_pull, false);
});

test('existing tenant WalletOps contracts remain unchanged', () => {
  const hooks = read('src/hooks/useWalletOps.ts');
  const wallet = read('src/hooks/useWallet.ts');
  const select = read('src/lib/payments/selectPaymentWallet.ts');
  assert.match(hooks, /eq\("tenant_id", tenantId!\)/);
  assert.match(hooks, /selectPaymentWallet/);
  assert.match(wallet, /usePaymentProviderEligibility/);
  assert.match(select, /Never picks rows\[0\]/);
  assert.doesNotMatch(hooks, /platformFinance/);
});

test('source wiring stays platform-scoped and does not reuse onboard add', () => {
  const fns = read('aws/functions/api/providers/parity/moov-functions.mjs');
  const platform = read('aws/functions/api/providers/parity/platform-finance.mjs');
  const bankPanel = read('src/components/admin/PlatformBankPanel.tsx');
  const treasury = read('src/components/admin/PlatformTreasuryPanel.tsx');
  const admin = read('src/pages/admin/AdminTenants.tsx');
  assert.match(fns, /wrapPlatformFinance/);
  assert.match(fns, /platformFinanceBank/);
  assert.match(fns, /platformFinanceTreasury/);
  assert.doesNotMatch(fns, /'moov-platform-bank': platformBank/);
  assert.doesNotMatch(fns, /'platform-treasury': platformTreasury/);
  assert.doesNotMatch(platform, /bankAccountAdd/);
  assert.doesNotMatch(platform, /moov-tenant-fee-charge/);
  assert.doesNotMatch(bankPanel, /action:\s*["']add["']/);
  assert.doesNotMatch(bankPanel, /initiate_micro_deposit/);
  assert.match(bankPanel, /composePlatformBankDisplay/);
  assert.match(treasury, /platform-treasury/);
  assert.match(admin, /<PlatformBankPanel \/>/);
  assert.equal(isPlatformFinanceFunction('moov-platform-bank'), true);
  assert.equal(isPlatformOwnerEmail('checksopsadmin@gmail.com'), true);
  assert.equal(isPlatformOwnerEmail('tenant@example.com'), false);
  assert.match(PLATFORM_FINANCE_WRITE_BLOCKED_MESSAGE, /disabled/);
});

async function invokeWrapped(name, handler, {
  body,
  fetchImpl,
  client = { query: async () => ({ rows: [] }) },
} = {}) {
  const wrapped = wrapPlatformFinance(handler, name);
  const previous = process.env.CHECKSOPS_ENV;
  process.env.CHECKSOPS_ENV = 'staging';
  try {
    return await wrapped({ body: JSON.stringify(body) }, {
      withIdentity: async (_event, fn) => fn({
        client,
        mapping: { application_user_id: '7dbb3009-f059-4767-b5dc-1c5c72379330', email: 'checksopsadmin@gmail.com' },
        claims: { sub: 'cognito-sub', email: 'checksopsadmin@gmail.com' },
        body,
        spoof: [],
      }),
      loadSandboxCredentials: sandboxCreds,
      loadProviderSecrets: productionSecrets,
      fetchImpl,
    });
  } finally {
    if (previous === undefined) delete process.env.CHECKSOPS_ENV;
    else process.env.CHECKSOPS_ENV = previous;
  }
}

function jsonRes(body) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  };
}
