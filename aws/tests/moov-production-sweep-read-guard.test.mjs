import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';

const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';

const jwtEvent = (path, method, body, extra = {}) => ({
  rawPath: path,
  headers: {
    authorization: extra.auth === null ? undefined : 'Bearer test-id-token',
    ...(extra.headers || {}),
  },
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path },
    authorizer: extra.auth === null ? undefined : {
      jwt: { claims: { sub: extra.sub || COGNITO_SUB, email: 'checksops-tester@freedomadj.com', token_use: 'id' } },
    },
  },
});

const mappingFor = (sub = COGNITO_SUB) => ({
  application_user_id: FREEDOM_APP,
  cognito_sub: sub,
  email: 'checksops-tester@freedomadj.com',
  status: 'active',
});

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

const mockClient = ({
  mapping = mappingFor(),
  memberships = [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom Adjustment', tenant_slug: 'freedom' }],
  tenant = { moov_allowlisted: true, moov_environment: 'production' },
  account = {
    id: 'acct-1',
    tenant_id: FREEDOM_TENANT,
    provider: 'moov',
    environment: 'production',
    provider_account_id: 'moov-acct-freedom',
  },
  wallet = {
    id: 'wallet-1',
    tenant_id: FREEDOM_TENANT,
    provider: 'moov',
    environment: 'production',
    wallet_type: 'operating',
    provider_wallet_id: 'wallet-freedom',
    provider_account_id: 'moov-acct-freedom',
    status: 'active',
    available_cents: 0,
    pending_cents: 0,
  },
  method = {
    id: '8eb5b26e-6f66-435c-a578-880fb7fc14dd',
    tenant_id: FREEDOM_TENANT,
    provider: 'moov',
    environment: 'production',
    external_recipient_id: null,
    provider_account_id: 'moov-acct-freedom',
    provider_bank_account_id: 'bank-4573',
    provider_payment_method_id: 'pm-4573',
    bank_name: 'WELLS FARGO BANK',
    last_four: '4573',
    is_default: false,
    connection_status: 'connected',
    verification_status: 'verified',
    supported_rails: [],
    rail_payment_method_ids: {},
    rails_synced_at: null,
    created_at: '2026-08-28T00:00:00Z',
  },
} = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rows: [] };
      if (sql === 'SET TRANSACTION READ WRITE') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
      }
      if (sql.includes('FROM public.tenant_users')) return { rows: memberships };
      if (sql.includes('FROM public.user_roles')) return { rows: [] };
      if (sql.includes('FROM public.tenants WHERE id')) return { rows: [tenant] };
      if (sql.includes('FROM public.payment_provider_accounts')) {
        const tenantId = params[0];
        const env = params[1];
        if (tenantId && env) {
          return { rows: account.tenant_id === tenantId && account.environment === env ? [account] : [] };
        }
        return { rows: [account] };
      }
      if (sql.includes('FROM public.payment_wallets')) {
        const tenantId = params[0];
        const env = params[1];
        const walletType = params[2];
        if (tenantId && env && walletType) {
          const ok = wallet.tenant_id === tenantId && wallet.environment === env && wallet.wallet_type === walletType;
          return { rows: ok ? [wallet] : [] };
        }
        return { rows: [wallet] };
      }
      if (sql.includes('FROM public.payment_provider_methods')) {
        const tenantId = params[0];
        const env = params[1];
        const ok = method.tenant_id === tenantId && method.environment === env && method.external_recipient_id === null;
        return { rows: ok ? [method] : [] };
      }
      return { rows: [] };
    },
  };
};

const moovFetchStub = async (url) => {
  if (String(url).includes('/oauth2/token')) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: 'token-1', expires_in: 300 }),
    };
  }
  // Read-only snapshot calls are allowed to miss provider state; local method must still render.
  if (String(url).includes('/sweep-configs') || String(url).includes('/payment-methods') || String(url).includes('/wallets/')) {
    return {
      ok: false,
      status: 404,
      text: async () => JSON.stringify({}),
    };
  }
  return { ok: false, status: 500, text: async () => JSON.stringify({ message: 'unexpected' }) };
};

test('production moov-sweep-config get is allowed and returns settlement bank from connected production method', async () => {
  await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: 'true',
    AWS_MOOV_ENABLED: 'true',
    AWS_PROVIDER_LIVE_READS_ENABLED: 'true',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  }, async () => {
    const result = await handleProviderRequest(
      jwtEvent('/functions/v1/moov-sweep-config', 'POST', { action: 'get', tenant_id: FREEDOM_TENANT, wallet_type: 'operating' }),
      '/functions/v1/moov-sweep-config',
      'POST',
      {
        loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
        createClient: () => mockClient(),
        loadProviderSecrets: async () => ({ MOOV_PUBLIC_KEY: 'pk_live_x', MOOV_SECRET_KEY: 'sk_live_x', MOOV_ENVIRONMENT: 'production' }),
        fetchImpl: moovFetchStub,
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.environment, 'production');
    assert.equal(result.settlement_method.bank_name, 'WELLS FARGO BANK');
    assert.equal(result.settlement_method.last_four, '4573');
  });
});

test('production moov-sweep-config mutations remain hard-blocked', async () => {
  await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: 'true',
    AWS_MOOV_ENABLED: 'true',
    AWS_PROVIDER_LIVE_READS_ENABLED: 'true',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  }, async () => {
    for (const action of ['create', 'update', 'enable', 'disable']) {
      const result = await handleProviderRequest(
        jwtEvent('/functions/v1/moov-sweep-config', 'POST', { action, tenant_id: FREEDOM_TENANT }),
        '/functions/v1/moov-sweep-config',
        'POST',
        {},
      );
      assert.equal(result.statusCode, 403);
      assert.equal(result.error, 'production_execution_blocked');
    }
  });
});

test('staging parity behavior remains gated by AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED', async () => {
  await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: undefined,
    AWS_MOOV_ENABLED: undefined,
    AWS_PROVIDER_LIVE_READS_ENABLED: undefined,
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  }, async () => {
    const result = await handleProviderRequest(
      jwtEvent('/functions/v1/moov-sweep-config', 'POST', { action: 'get', tenant_id: FREEDOM_TENANT }),
      '/functions/v1/moov-sweep-config',
      'POST',
      {
        loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
        createClient: () => mockClient(),
      },
    );
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, 'provider_disabled');
  });
});


const PRODUCTION_FLAGS = {
  AWS_PROVIDER_EXECUTION_ENABLED: 'true',
  AWS_MOOV_ENABLED: 'true',
  AWS_PROVIDER_LIVE_READS_ENABLED: 'true',
  AWS_MOOV_TRANSFER_POST_ENABLED: 'true',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
};

const PRODUCTION_DEPS = (client, fetchImpl) => ({
  loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
  createClient: () => client,
  loadProviderSecrets: async () => ({ MOOV_PUBLIC_KEY: 'pk_live_x', MOOV_SECRET_KEY: 'sk_live_x', MOOV_ENVIRONMENT: 'production' }),
  fetchImpl,
});

// Records every provider call; answers the two wallet reads and fails anything else.
const walletReadFetch = ({ wallets }) => {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ url: String(url), method });
    if (String(url).includes('/oauth2/token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'token-1', expires_in: 300 }) };
    }
    if (method === 'GET' && /\/accounts\/[^/]+\/wallets$/.test(String(url).split('?')[0])) {
      return { ok: true, status: 200, text: async () => JSON.stringify(wallets) };
    }
    if (method === 'GET' && String(url).includes('/payment-methods')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{ paymentMethodType: 'moov-wallet', paymentMethodID: 'pm-wallet', wallet: { walletID: 'wallet-freedom' } }]),
      };
    }
    return { ok: false, status: 500, text: async () => JSON.stringify({ message: `unexpected ${method} ${url}` }) };
  };
  return { calls, impl };
};

const walletSyncClient = (options = {}) => {
  const client = mockClient(options);
  const base = client.query;
  client.query = async (sql, params = []) => {
    if (sql.includes('INSERT INTO public.payment_wallets')) {
      client.queries.push({ sql, params });
      return {
        rows: [{
          id: 'wallet-1',
          tenant_id: params[0],
          provider: 'moov',
          environment: params[1],
          wallet_type: params[2],
          provider_wallet_id: params[4],
          provider_payment_method_id: params[6],
          available_cents: params[7],
          pending_cents: params[8],
          status: 'active',
        }],
      };
    }
    return base(sql, params);
  };
  return client;
};

const walletSyncEvent = (overrides = {}) => jwtEvent('/functions/v1/moov-wallet-sync', 'POST', {
  tenant_id: FREEDOM_TENANT,
  wallet_type: 'operating',
  force: true,
  ...overrides,
});

const NO_PRODUCTION_WALLET_ROW = {
  id: 'wallet-sbx',
  tenant_id: FREEDOM_TENANT,
  provider: 'moov',
  environment: 'sandbox',
  wallet_type: 'operating',
  provider_wallet_id: 'wallet-sandbox',
};

const runWalletSync = (client, fetch, body) => handleProviderRequest(
  walletSyncEvent(body),
  '/functions/v1/moov-wallet-sync',
  'POST',
  PRODUCTION_DEPS(client, fetch.impl),
);

const upsertsOf = (client) => client.queries.filter((q) => q.sql.includes('INSERT INTO public.payment_wallets'));

test('production moov-wallet-sync refreshes the production wallet using provider reads only', async () => {
  await withEnv(PRODUCTION_FLAGS, async () => {
    const client = walletSyncClient();
    const fetch = walletReadFetch({
      wallets: [{ walletID: 'wallet-freedom', name: 'Operating wallet', availableBalance: { value: 1234 }, pendingBalance: { value: 500 } }],
    });
    const result = await handleProviderRequest(
      walletSyncEvent(),
      '/functions/v1/moov-wallet-sync',
      'POST',
      PRODUCTION_DEPS(client, fetch.impl),
    );

    assert.equal(result.ok, true);
    assert.equal(result.environment, 'production');
    assert.equal(result.wallet.environment, 'production');
    assert.equal(result.wallet.available_cents, 1234);
    assert.equal(result.wallet.pending_cents, 500);
    const providerCalls = fetch.calls.filter((c) => !c.url.includes('/oauth2/token'));
    assert.ok(providerCalls.length > 0);
    assert.deepEqual([...new Set(providerCalls.map((c) => c.method))], ['GET']);
    const upserts = client.queries.filter((q) => q.sql.includes('INSERT INTO public.payment_wallets'));
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].params[1], 'production');
    assert.equal(client.queries.some((q) => /INSERT INTO public\.(payment_wallet_ledger|payment_transfers)/.test(q.sql)), false);
  });
});

test('production moov-wallet-sync never creates a missing provider wallet', async () => {
  await withEnv(PRODUCTION_FLAGS, async () => {
    const client = walletSyncClient({ wallet: NO_PRODUCTION_WALLET_ROW });
    const fetch = walletReadFetch({ wallets: [] });
    const result = await handleProviderRequest(
      walletSyncEvent(),
      '/functions/v1/moov-wallet-sync',
      'POST',
      PRODUCTION_DEPS(client, fetch.impl),
    );

    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 409);
    assert.equal(result.error, 'wallet_not_found');
    assert.equal(fetch.calls.some((c) => c.method !== 'GET'), false);
    assert.equal(client.queries.some((q) => q.sql.includes('INSERT INTO public.payment_wallets')), false);
  });
});

test('production moov-wallet-sync refuses to repoint a recorded wallet the provider did not return', async () => {
  await withEnv(PRODUCTION_FLAGS, async () => {
    const client = walletSyncClient();
    const fetch = walletReadFetch({ wallets: [{ walletID: 'wallet-other', availableBalance: { value: 999 } }] });
    const result = await runWalletSync(client, fetch);
    assert.equal(result.statusCode, 409);
    assert.equal(result.error, 'wallet_mismatch');
    assert.equal(upsertsOf(client).length, 0);
    assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), false);
    assert.equal(client.queries.some((q) => q.sql === 'ROLLBACK'), true);
  });
});

test('production moov-wallet-sync commits only the production wallet row on success', async () => {
  await withEnv(PRODUCTION_FLAGS, async () => {
    const client = walletSyncClient();
    const fetch = walletReadFetch({ wallets: [{ walletID: 'wallet-freedom', availableBalance: { value: 42 } }] });
    const result = await runWalletSync(client, fetch);
    assert.equal(result.ok, true);
    assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), true);
    assert.match(upsertsOf(client)[0].sql, /COALESCE\(EXCLUDED\.provider_payment_method_id, payment_wallets\.provider_payment_method_id\)/);
  });
});

test('a new production trust wallet row never claims the operating wallet', async () => {
  await withEnv(PRODUCTION_FLAGS, async () => {
    // Existing production operating row is bound to wallet-freedom; there is no trust row yet.
    const client = walletSyncClient();
    const unnamedOnly = walletReadFetch({ wallets: [{ walletID: 'wallet-freedom' }] });
    const refused = await runWalletSync(client, unnamedOnly, { wallet_type: 'trust' });
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.error, 'wallet_not_found');
    assert.equal(upsertsOf(client).length, 0);

    const client2 = walletSyncClient();
    const withTrust = walletReadFetch({
      wallets: [{ walletID: 'wallet-freedom' }, { walletID: 'wallet-trust', name: 'Trust wallet', availableBalance: { value: 7 } }],
    });
    const ok = await runWalletSync(client2, withTrust, { wallet_type: 'trust' });
    assert.equal(ok.ok, true);
    assert.equal(upsertsOf(client2)[0].params[2], 'trust');
    assert.equal(upsertsOf(client2)[0].params[4], 'wallet-trust');
  });
});

test('production moov-wallet-sync without force on a non-active account reads the local row only', async () => {
  await withEnv(PRODUCTION_FLAGS, async () => {
    const client = walletSyncClient();
    const fetch = walletReadFetch({ wallets: [] });
    const result = await runWalletSync(client, fetch, { force: false });
    assert.equal(result.ok, true);
    assert.equal(result.wallet.provider_wallet_id, 'wallet-freedom');
    assert.equal(fetch.calls.filter((c) => !c.url.includes('/oauth2/token')).length, 0);
    assert.equal(upsertsOf(client).length, 0);
  });
});

test('production moov-wallet-sync denies other tenants and non-production tenants before any provider call', async () => {
  await withEnv(PRODUCTION_FLAGS, async () => {
    const other = walletSyncClient();
    const otherFetch = walletReadFetch({ wallets: [] });
    const denied = await runWalletSync(other, otherFetch, { tenant_id: '11111111-1111-4111-8111-111111111111' });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, 'cross_tenant_denied');
    assert.equal(otherFetch.calls.length, 0);

    const sandboxTenant = walletSyncClient({ tenant: { moov_allowlisted: true, moov_environment: 'sandbox' } });
    const sandboxFetch = walletReadFetch({ wallets: [] });
    const refused = await runWalletSync(sandboxTenant, sandboxFetch);
    assert.equal(refused.ok, false);
    assert.equal(refused.statusCode, 503);
    assert.equal(sandboxFetch.calls.length, 0);
    assert.equal(upsertsOf(sandboxTenant).length, 0);
  });
});

test('production moov-wallet-sync requires production live reads', async () => {
  await withEnv({ ...PRODUCTION_FLAGS, AWS_PROVIDER_LIVE_READS_ENABLED: 'false' }, async () => {
    const client = walletSyncClient();
    const fetch = walletReadFetch({ wallets: [] });
    const result = await runWalletSync(client, fetch);
    assert.equal(result.statusCode, 403);
    assert.equal(result.error, 'provider_disabled');
    assert.equal(fetch.calls.length, 0);
  });
});

test('production money movement stays hard-blocked even with transfer posting enabled', async () => {
  await withEnv(PRODUCTION_FLAGS, async () => {
    const blocked = [
      'moov-transfer-create', 'moov-transfer-group-create', 'moov-disburse', 'moov-wallet-fund',
      'moov-tenant-fee-charge', 'initiate-wallet-funding', 'process-funded-payment',
      'wallet-fund-on-clear', 'homeowner-deductible-pay', 'moov-micro-deposit-initiate',
      'moov-bank-account-add', 'moov-account-create',
    ];
    for (const name of blocked) {
      const result = await handleProviderRequest(
        jwtEvent(`/functions/v1/${name}`, 'POST', { tenant_id: FREEDOM_TENANT, amount_cents: 100 }),
        `/functions/v1/${name}`,
        'POST',
        {},
      );
      assert.equal(result.statusCode, 403, name);
      assert.equal(result.error, 'production_execution_blocked', name);
    }
  });
});

test('Platform Finance production exceptions stay limited to status and overview reads', async () => {
  await withEnv(PRODUCTION_FLAGS, async () => {
    for (const [name, action] of [['moov-platform-bank', 'add'], ['moov-platform-bank', 'update'], ['platform-treasury', 'wallet'], ['platform-treasury', 'transfer']]) {
      const result = await handleProviderRequest(
        jwtEvent(`/functions/v1/${name}`, 'POST', { action, tenant_id: FREEDOM_TENANT }),
        `/functions/v1/${name}`,
        'POST',
        {},
      );
      assert.equal(result.statusCode, 403, `${name} ${action}`);
      assert.equal(result.error, 'production_execution_blocked', `${name} ${action}`);
      assert.equal(result.tranche4HardBlock, true, `${name} ${action}`);
    }
    // status/overview pass the hard block but must still fail closed on main: no secrets, no Moov call.
    for (const [name, action] of [['moov-platform-bank', 'status'], ['platform-treasury', 'overview']]) {
      let secretsLoaded = false;
      const fetch = walletReadFetch({ wallets: [] });
      const result = await handleProviderRequest(
        jwtEvent(`/functions/v1/${name}`, 'POST', { action, tenant_id: FREEDOM_TENANT }),
        `/functions/v1/${name}`,
        'POST',
        {
          ...PRODUCTION_DEPS(walletSyncClient(), fetch.impl),
          loadProviderSecrets: async () => { secretsLoaded = true; return {}; },
          loadSandboxCredentials: async () => { secretsLoaded = true; return {}; },
        },
      );
      assert.equal(result.statusCode, 403, `${name} ${action}`);
      assert.equal(fetch.calls.length, 0, `${name} ${action}`);
      assert.equal(secretsLoaded, false, `${name} ${action}`);
    }
  });
});
