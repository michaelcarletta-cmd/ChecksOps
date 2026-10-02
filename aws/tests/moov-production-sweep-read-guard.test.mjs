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

