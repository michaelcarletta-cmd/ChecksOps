import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resetMoovTokenCache, withMoovContext } from '../functions/api/providers/parity/moov-client.mjs';
import { resolveTenant } from '../functions/api/providers/parity/caller.mjs';
import { loadConnectedMethod } from '../functions/api/providers/parity/db.mjs';
import { resolveWalletFundContext } from '../functions/api/providers/parity/moov-money.mjs';
import { sweepConfig } from '../functions/api/providers/parity/moov-onboard.mjs';
import {
  requireMoovProviderEnvironment,
  failClosedMissingAccount,
} from '../functions/api/providers/parity/moov-provider-env.mjs';
import {
  availablePushRails,
  buildSweepSnapshot,
  minimumBalanceToCents,
  normalizeSweepConfig,
  paymentMethodIdOf,
  unwrapSweepConfigs,
} from '../functions/api/providers/parity/sweep-read.mjs';
const isProductionChecksOpsHostname = (hostname) => {
  const host = String(hostname ?? '').toLowerCase();
  return host === 'checksops.com' || host === 'www.checksops.com';
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const FREEDOM = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const PLATFORM = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const OTHER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FREEDOM_ACCOUNT = '60922058-7eca-4889-81dd-5720d7b9de96';
const FREEDOM_WALLET = '3e6286ca-a19c-45f6-aad9-f73dac5f0358';
const FREEDOM_SWEEP = '2d2c900d-6efb-43a2-ba90-2fd77e22afdd';
const PUSH = '7a78a544-340d-46fd-a4a4-228661374da7';
const PULL = 'a02c1c81-9ca6-434d-accc-ea4471a70ef2';
const SAME_DAY = '248ef2ec-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';

const FREEDOM_SWEEP_RAW = {
  sweepConfigID: FREEDOM_SWEEP,
  walletID: FREEDOM_WALLET,
  status: 'enabled',
  minimumBalance: '0.00',
  statementDescriptor: 'CHECKOPS',
  pushPaymentMethod: {
    paymentMethodID: PUSH,
    paymentMethodType: 'ach-credit-standard',
    bankAccount: {
      bankName: 'Wells Fargo',
      lastFourAccountNumber: '4573',
      bankAccountID: '61062c38-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
  },
  pullPaymentMethod: {
    paymentMethodID: PULL,
    paymentMethodType: 'ach-debit-fund',
  },
};

const FREEDOM_METHODS = [
  {
    paymentMethodID: PUSH,
    paymentMethodType: 'ach-credit-standard',
    bankAccount: { bankName: 'Wells Fargo', lastFourAccountNumber: '4573', bankAccountID: '61062c38-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  },
  {
    paymentMethodID: SAME_DAY,
    paymentMethodType: 'ach-credit-same-day',
    bankAccount: { bankName: 'Wells Fargo', lastFourAccountNumber: '4573', bankAccountID: '61062c38-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  },
  {
    paymentMethodID: PULL,
    paymentMethodType: 'ach-debit-fund',
    bankAccount: { bankName: 'Wells Fargo', lastFourAccountNumber: '4573', bankAccountID: '61062c38-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  },
];

test('nested Moov sweep normalizes to WalletOps frontend contract', () => {
  const snapshot = buildSweepSnapshot({
    tenantId: FREEDOM,
    walletType: 'operating',
    wallet: {
      id: 'wallet-row',
      provider_wallet_id: FREEDOM_WALLET,
      available_cents: 0,
      pending_cents: 0,
      status: 'active',
    },
    sweepCfg: FREEDOM_SWEEP_RAW,
    localMethods: [],
    paymentMethods: FREEDOM_METHODS,
  });
  assert.equal(snapshot.settlement_method.bank_name, 'Wells Fargo');
  assert.equal(snapshot.settlement_method.last_four, '4573');
  assert.equal(snapshot.sweep_config.id, FREEDOM_SWEEP);
  assert.equal(snapshot.sweep_config.status, 'enabled');
  assert.equal(snapshot.sweep_config.minimum_balance_cents, 0);
  assert.equal(snapshot.sweep_config.push_rail, 'ach-credit-standard');
  assert.equal(snapshot.sweep_config.push_payment_method_id, PUSH);
  assert.equal(snapshot.sweep_config.pull_payment_method_id, PULL);
  assert.deepEqual(snapshot.available_push_rails, ['ach-credit-same-day', 'ach-credit-standard']);
  assert.equal(snapshot.wallet.available_cents, 0);
  assert.equal(paymentMethodIdOf(FREEDOM_SWEEP_RAW.pushPaymentMethod), PUSH);
  assert.equal(minimumBalanceToCents('0.00'), 0);
  assert.deepEqual(unwrapSweepConfigs({ sweepConfigs: [FREEDOM_SWEEP_RAW] }), [FREEDOM_SWEEP_RAW]);
  assert.equal(normalizeSweepConfig(FREEDOM_SWEEP_RAW, { tenantId: FREEDOM }).provider_sweep_config_id, FREEDOM_SWEEP);
  assert.deepEqual(availablePushRails({
    railPaymentMethodIds: { 'ach-credit-standard': PUSH, 'ach-debit-fund': PULL },
  }), ['ach-credit-standard']);
});

test('local connected bank still wins for settlement display', () => {
  const snapshot = buildSweepSnapshot({
    tenantId: FREEDOM,
    sweepCfg: FREEDOM_SWEEP_RAW,
    localMethods: [{
      id: 'method-row',
      bank_name: 'Wells Fargo',
      last_four: '4573',
      connection_status: 'connected',
      verification_status: 'verified',
      is_default: true,
      rail_payment_method_ids: {
        'ach-credit-standard': PUSH,
        'ach-debit-fund': PULL,
      },
    }],
    paymentMethods: [],
  });
  assert.equal(snapshot.settlement_method.id, 'method-row');
  assert.equal(snapshot.settlement_method.last_four, '4573');
  assert.equal(snapshot.sweep_config.push_rail, 'ach-credit-standard');
});

test('provider environment fail-closed never falls back to sandbox', () => {
  assert.deepEqual(requireMoovProviderEnvironment({ environment: 'production' }), {
    ok: true, environment: 'production',
  });
  assert.deepEqual(requireMoovProviderEnvironment({ environment: 'sandbox' }), {
    ok: true, environment: 'sandbox',
  });
  assert.equal(requireMoovProviderEnvironment({}).error, 'provider_environment_unresolved');
  assert.equal(failClosedMissingAccount(null, 'production').error, 'production_provider_context_unresolved');
  assert.equal(failClosedMissingAccount(null, 'sandbox').statusCode, 409);
  assert.equal(failClosedMissingAccount({ provider_account_id: FREEDOM_ACCOUNT }, 'production'), null);
});

test('cross-tenant remains 403 cross_tenant_denied', async () => {
  const client = {
    query: async (sql) => {
      if (/user_roles/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
  const denied = await resolveTenant(client, {
    userId: USER,
    body: { tenant_id: OTHER },
    memberships: [{ tenant_id: FREEDOM, role: 'owner' }],
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.error, 'cross_tenant_denied');
  const allowed = await resolveTenant(client, {
    userId: USER,
    body: { tenant_id: FREEDOM },
    memberships: [{ tenant_id: FREEDOM, role: 'owner' }],
  });
  assert.equal(allowed.tenantId, FREEDOM);
});

const mockClient = ({
  accounts = [],
  methods = [],
  wallets = [],
} = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/FROM public\.payment_provider_accounts/.test(sql)) {
        const env = params[1];
        return { rows: accounts.filter((row) => row.environment === env && row.tenant_id === params[0]) };
      }
      if (/FROM public\.payment_provider_methods/.test(sql)) {
        const env = params[2] ?? params[1];
        return {
          rows: methods.filter((row) => (
            row.tenant_id === params[0]
            && row.environment === env
            && (!params[1] || row.provider_account_id === params[1] || sql.includes('external_recipient'))
          )),
        };
      }
      if (/FROM public\.payment_wallets/.test(sql)) {
        return {
          rows: wallets.filter((row) => (
            row.tenant_id === params[0] && row.environment === params[1] && row.wallet_type === params[2]
          )),
        };
      }
      return { rows: [] };
    },
  };
};

test('walletFund context resolves production account and debit method without posting', async () => {
  const client = mockClient({
    accounts: [{
      tenant_id: FREEDOM,
      environment: 'production',
      provider_account_id: FREEDOM_ACCOUNT,
      onboarding_status: 'active',
      can_ach_debit: true,
    }],
    methods: [{
      id: 'src-row',
      tenant_id: FREEDOM,
      environment: 'production',
      provider_account_id: FREEDOM_ACCOUNT,
      connection_status: 'connected',
      provider_payment_method_id: PULL,
    }],
    wallets: [{
      id: 'wallet-row',
      tenant_id: FREEDOM,
      environment: 'production',
      wallet_type: 'operating',
      provider_wallet_id: FREEDOM_WALLET,
      provider_payment_method_id: '744ea734-f5e3-4b31-bb92-38f85fd29b91',
    }],
  });
  const resolved = await resolveWalletFundContext({
    client,
    tenantId: FREEDOM,
    environment: 'production',
    skipWalletSync: true,
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.account.provider_account_id, FREEDOM_ACCOUNT);
  assert.equal(resolved.source.provider_payment_method_id, PULL);
  assert.equal(resolved.wallet.provider_wallet_id, FREEDOM_WALLET);
  assert.ok(client.queries.some((q) => q.sql.includes('payment_provider_accounts') && q.params[1] === 'production'));
  assert.ok(client.queries.some((q) => q.sql.includes('payment_provider_methods') && q.params[2] === 'production'));
  assert.ok(!client.queries.some((q) => q.params.includes('sandbox') && q.sql.includes('payment_provider_accounts')));

  const missing = await resolveWalletFundContext({
    client: mockClient({ accounts: [] }),
    tenantId: FREEDOM,
    environment: 'production',
    skipWalletSync: true,
  });
  assert.equal(missing.error, 'production_provider_context_unresolved');

  const staging = await resolveWalletFundContext({
    client: mockClient({
      accounts: [{
        tenant_id: FREEDOM, environment: 'sandbox', provider_account_id: 'sandbox-acct',
        onboarding_status: 'active', can_ach_debit: true,
      }],
      methods: [{
        id: 'stg', tenant_id: FREEDOM, environment: 'sandbox',
        provider_account_id: 'sandbox-acct', connection_status: 'connected',
      }],
    }),
    tenantId: FREEDOM,
    environment: 'sandbox',
    skipWalletSync: true,
  });
  assert.equal(staging.ok, true);
  assert.equal(staging.account.provider_account_id, 'sandbox-acct');
});

test('loadConnectedMethod uses the requested environment', async () => {
  const client = mockClient({
    methods: [{
      id: 'prod-method',
      tenant_id: FREEDOM,
      environment: 'production',
      provider_account_id: FREEDOM_ACCOUNT,
      connection_status: 'connected',
    }],
  });
  const row = await loadConnectedMethod(client, {
    tenantId: FREEDOM,
    providerAccountId: FREEDOM_ACCOUNT,
    environment: 'production',
  });
  assert.equal(row.id, 'prod-method');
  assert.equal(client.queries[0].params[2], 'production');
});

test('sweep GET uses production account and never posts', async () => {
  resetMoovTokenCache();
  const posts = [];
  const client = mockClient({
    accounts: [{
      tenant_id: FREEDOM,
      environment: 'production',
      provider_account_id: FREEDOM_ACCOUNT,
    }],
    methods: [{
      id: 'method-row',
      tenant_id: FREEDOM,
      environment: 'production',
      bank_name: 'Wells Fargo',
      last_four: '4573',
      connection_status: 'connected',
      verification_status: 'verified',
      is_default: true,
      rail_payment_method_ids: {
        'ach-credit-standard': PUSH,
        'ach-credit-same-day': SAME_DAY,
        'ach-debit-fund': PULL,
      },
    }],
    wallets: [{
      id: 'wallet-row',
      tenant_id: FREEDOM,
      environment: 'production',
      wallet_type: 'operating',
      provider_wallet_id: FREEDOM_WALLET,
      available_cents: 0,
      pending_cents: 0,
      status: 'active',
    }],
  });
  const fetchImpl = async (url, opts = {}) => {
    const method = String(opts.method || 'GET').toUpperCase();
    if (method !== 'GET' && !String(url).includes('/oauth2/token')) {
      posts.push({ url, method, body: opts.body });
    }
    if (String(url).includes('/oauth2/token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok', expires_in: 300 }) };
    }
    if (String(url).includes('/sweep-configs')) {
      return { ok: true, status: 200, text: async () => JSON.stringify([FREEDOM_SWEEP_RAW]) };
    }
    if (String(url).includes('/payment-methods')) {
      return { ok: true, status: 200, text: async () => JSON.stringify(FREEDOM_METHODS) };
    }
    if (String(url).includes('/wallets')) {
      return { ok: true, status: 200, text: async () => JSON.stringify([{ walletID: FREEDOM_WALLET }]) };
    }
    return { ok: false, status: 404, text: async () => '{"error":"not found"}' };
  };
  const result = await withMoovContext({
    environment: 'production',
    productionPublicKey: 'pk',
    productionSecretKey: 'sk',
    apiVersion: 'v2024.01.00',
    fetchImpl,
  }, () => sweepConfig.run({
    client,
    body: { action: 'get', tenant_id: FREEDOM, wallet_type: 'operating' },
    ctx: { tenantId: FREEDOM, environment: 'production' },
    fetchImpl,
  }));
  assert.equal(result.success, true);
  assert.equal(result.environment, 'production');
  assert.equal(result.settlement_method.bank_name, 'Wells Fargo');
  assert.equal(result.settlement_method.last_four, '4573');
  assert.equal(result.sweep_config.id, FREEDOM_SWEEP);
  assert.equal(result.sweep_config.status, 'enabled');
  assert.equal(result.sweep_config.push_rail, 'ach-credit-standard');
  assert.equal(result.sweep_config.minimum_balance_cents, 0);
  assert.ok(result.available_push_rails.includes('ach-credit-standard'));
  assert.equal(result.wallet.available_cents, 0);
  assert.deepEqual(posts, []);
  assert.ok(client.queries.some((q) => q.sql.includes('payment_provider_accounts') && q.params[1] === 'production'));
  assert.ok(!client.queries.some((q) => q.params[1] === 'sandbox' && q.sql.includes('payment_provider_accounts')));
});

test('production sweep GET fails closed when production account is missing', async () => {
  const result = await sweepConfig.run({
    client: mockClient({ accounts: [] }),
    body: { action: 'get', tenant_id: FREEDOM },
    ctx: { tenantId: FREEDOM, environment: 'production' },
    fetchImpl: async () => { throw new Error('moov should not be called'); },
  });
  assert.equal(result.success, false);
  assert.equal(result.error, 'production_provider_context_unresolved');
  assert.equal(result.statusCode, 503);
});

test('application logic does not hard-code Freedom or platform treasury IDs', () => {
  const env = read('aws/functions/api/providers/parity/moov-provider-env.mjs');
  const sweep = read('aws/functions/api/providers/parity/sweep-read.mjs');
  const onboard = read('aws/functions/api/providers/parity/moov-onboard.mjs');
  const sweepHandler = onboard.slice(onboard.indexOf('export const sweepConfig'), onboard.indexOf('const INVOICE_API_VERSION'));
  for (const src of [env, sweep, sweepHandler]) {
    assert.doesNotMatch(src, /2eff5f1a-929d-4ce3-9a8b-cd96b98df42a/);
    assert.doesNotMatch(src, /41cb5d67-4911-4bef-aad5-d8ee9c582208/);
    assert.doesNotMatch(src, /60922058-7eca-4889-81dd-5720d7b9de96/);
    assert.doesNotMatch(src, /2d2c900d-6efb-43a2-ba90-2fd77e22afdd/);
  }
  assert.match(sweepHandler, /resolveSweepAccount/);
  assert.match(sweepHandler, /readSweepSnapshot/);
  assert.doesNotMatch(sweepHandler, /loadMoovAccount\(client, ctx\.tenantId, 'sandbox'\)/);
  const money = read('aws/functions/api/providers/parity/moov-money.mjs');
  assert.match(money, /requireMoovProviderEnvironment/);
  assert.match(money, /resolveWalletFundContext/);
  const db = read('aws/functions/api/providers/parity/db.mjs');
  assert.match(db, /environment = \$3/);
});

test('hostname guard hides staging chrome on production hosts only', () => {
  assert.equal(isProductionChecksOpsHostname('checksops.com'), true);
  assert.equal(isProductionChecksOpsHostname('www.checksops.com'), true);
  assert.equal(isProductionChecksOpsHostname('staging.checksops.com'), false);
  assert.equal(isProductionChecksOpsHostname('mortgage.checksops.com'), false);
  const helper = read('src/lib/awsStaging.ts');
  assert.match(helper, /export function isAwsStaging/);
  assert.match(helper, /VITE_AUTH_PROVIDER \|\| ""\)\.toLowerCase\(\) === "cognito"/);
  assert.match(helper, /export function shouldShowAwsStagingBanner/);
  assert.doesNotMatch(helper, /return !isAwsStaging/);
  assert.match(read('src/components/AwsStagingBanner.tsx'), /shouldShowAwsStagingBanner/);
  assert.match(read('src/pages/checkops/CheckOpsLogin.tsx'), /awsStagingChrome \? " AWS staging\."/);
  assert.match(read('src/components/white-label/WhiteLabelLogin.tsx'), /awsStagingChrome \? " · AWS staging"/);
});

test('WalletOps still reads settlement from the existing frontend contract', () => {
  const page = read('src/pages/WalletOps.tsx');
  assert.match(page, /settlementMethod\.bank_name/);
  assert.match(page, /config\?\.push_rail/);
  assert.match(page, /Automatic payouts on/);
  assert.doesNotMatch(page, /72630a70/);
});
