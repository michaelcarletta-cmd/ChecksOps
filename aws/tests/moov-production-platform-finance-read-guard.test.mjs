/**
 * Production Platform Finance read-only guard.
 * Fixtures only. No live Moov, ACH, AWS writes, or money movement.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';

const PLATFORM_OWNER = '7dbb3009-f059-4767-b5dc-1c5c72379330';
const PLATFORM_EMAIL = 'checksopsadmin@gmail.com';
const PROD_FACILITATOR = '41cb5d67-4911-4bef-aad5-d8ee9c582208';
const SANDBOX_FACILITATOR = '36b79957-ce7a-4ca7-a68f-30986c9e47bb';
const TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const TENANT_MOOV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const BANK_ID = '44c48005-1cc0-4dbe-8ba4-324b0a526188';
const WALLET_ID = '72630a70-4954-4761-b652-e8beff1ad02c';

const jwtEvent = (path, method, body, extra = {}) => ({
  rawPath: path,
  headers: {
    authorization: extra.auth === null ? undefined : 'Bearer test-id-token',
    ...(extra.headers || {}),
  },
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: extra.stage || 'prod',
    http: { method, path },
    authorizer: extra.auth === null ? undefined : {
      jwt: {
        claims: {
          sub: extra.sub || COGNITO_SUB,
          email: extra.email || PLATFORM_EMAIL,
          token_use: 'id',
        },
      },
    },
  },
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

const productionFlags = {
  CHECKSOPS_ENV: 'production-prep',
  AWS_PROVIDER_EXECUTION_ENABLED: 'true',
  AWS_MOOV_ENABLED: 'true',
  AWS_PROVIDER_LIVE_READS_ENABLED: 'true',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: PROD_FACILITATOR,
};

const jsonRes = (body) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
});

const platformFetch = (calls) => async (url, init = {}) => {
  const path = String(url);
  const method = String(init.method || 'GET').toUpperCase();
  calls.push({ method, path });
  if (path.includes('/oauth2/token')) {
    assert.equal(method, 'POST');
    return jsonRes({ access_token: 'tok', expires_in: 300 });
  }
  assert.equal(method, 'GET', `Platform Finance production-read may not ${method} ${path}`);
  assert.doesNotMatch(path, new RegExp(SANDBOX_FACILITATOR));
  assert.doesNotMatch(path, new RegExp(TENANT_MOOV));
  assert.doesNotMatch(path, /\/transfers/);
  assert.doesNotMatch(path, /\/sweep/);
  assert.match(path, new RegExp(`/accounts/${PROD_FACILITATOR}`));
  if (path.endsWith(`/accounts/${PROD_FACILITATOR}`)) {
    return jsonRes({
      displayName: 'ChecksOps',
      accountType: 'business',
      verificationStatus: 'verified',
      mode: 'production',
    });
  }
  if (path.endsWith('/capabilities')) {
    return jsonRes([{ capability: 'wallet.balance', status: 'enabled' }]);
  }
  if (path.endsWith('/bank-accounts')) {
    return jsonRes([{
      bankAccountID: BANK_ID,
      bankName: 'JPMORGAN CHASE BANK, NA',
      lastFourAccountNumber: '7649',
      bankAccountType: 'checking',
      holderName: 'ChecksOps',
      status: 'verified',
    }]);
  }
  if (path.endsWith('/wallets')) {
    return jsonRes([{
      walletID: WALLET_ID,
      walletType: 'default',
      accountID: PROD_FACILITATOR,
      availableBalance: { value: 0, currency: 'USD' },
    }]);
  }
  if (path.includes('/transactions')) return jsonRes([]);
  return jsonRes([]);
};

const identity = (body) => async (_event, fn) => fn({
  client: { query: async () => ({ rows: [] }) },
  mapping: { application_user_id: PLATFORM_OWNER, email: PLATFORM_EMAIL },
  claims: { sub: COGNITO_SUB, email: PLATFORM_EMAIL },
  body,
  spoof: [],
});

const invokePf = (name, body, extra = {}) => handleProviderRequest(
  jwtEvent(`/functions/v1/${name}`, 'POST', body),
  `/functions/v1/${name}`,
  'POST',
  {
    withIdentity: extra.withIdentity || identity(body),
    loadSandboxCredentials: async () => ({
      moov: {
        publicKey: 'pk_sandbox',
        secretKey: 'sk_sandbox',
        platformAccountId: SANDBOX_FACILITATOR,
      },
    }),
    loadProviderSecrets: extra.loadProviderSecrets || (async () => ({
      MOOV_PUBLIC_KEY: 'pk_prod',
      MOOV_SECRET_KEY: 'sk_prod',
      MOOV_SANDBOX_PLATFORM_ACCOUNT_ID: SANDBOX_FACILITATOR,
    })),
    fetchImpl: extra.fetchImpl,
  },
);

test('accepted UI only invokes platform-bank status and treasury overview', () => {
  const bank = readFileSync(new URL('../../src/components/admin/PlatformBankPanel.tsx', import.meta.url), 'utf8');
  const treasury = readFileSync(new URL('../../src/components/admin/PlatformTreasuryPanel.tsx', import.meta.url), 'utf8');
  assert.match(bank, /action:\s*["']status["']/);
  assert.match(treasury, /action:\s*["']overview["']/);
  assert.doesNotMatch(bank, /action:\s*["']wallet["']/);
  assert.doesNotMatch(bank, /action:\s*["']add["']/);
  assert.doesNotMatch(bank, /Add bank/);
  assert.doesNotMatch(treasury, /action:\s*["']wallet["']/);
  assert.doesNotMatch(treasury, /action:\s*["']pnl["']/);
});

test('production status and overview pass the hard-block and read the ChecksOps facilitator', async () => {
  await withEnv(productionFlags, async () => {
    const statusCalls = [];
    const status = await invokePf('moov-platform-bank', { action: 'status', tenant_id: TENANT_ID }, {
      fetchImpl: platformFetch(statusCalls),
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.environment, 'production');
    assert.equal(status.platform_account_id, PROD_FACILITATOR);
    assert.equal(status.identity, 'checksops_facilitator');
    assert.equal(status.tenant_context_used, false);
    assert.equal(status.methods[0].last_four, '7649');
    assert.equal(status.methods[0].bank_account_id, BANK_ID);
    assert.equal(status.ach_initiated, false);
    assert.equal(status.fee_pull, false);
    assert.equal(status.bankAccountAddInvoked, false);
    assert.equal(status.productionExecution, false);
    assert.ok(statusCalls.every((call) => call.method === 'GET' || call.path.includes('/oauth2/token')));
    assert.ok(statusCalls.some((call) => call.path.includes(`/accounts/${PROD_FACILITATOR}`)));

    const overviewCalls = [];
    const overview = await invokePf('platform-treasury', { action: 'overview', tenant_id: TENANT_ID }, {
      fetchImpl: platformFetch(overviewCalls),
    });
    assert.equal(overview.statusCode, 200);
    assert.equal(overview.environment, 'production');
    assert.equal(overview.platform_account_id, PROD_FACILITATOR);
    assert.equal(overview.wallet.wallet_id, WALLET_ID);
    assert.equal(overview.tenant_context_used, false);
    assert.equal(overview.productionExecution, false);
    assert.ok(overviewCalls.every((call) => call.method === 'GET' || call.path.includes('/oauth2/token')));
  });
});

test('unused Platform Finance reads and all writes stay production_execution_blocked', async () => {
  await withEnv(productionFlags, async () => {
    const blocked = [
      ['moov-platform-bank', { action: 'wallet' }],
      ['moov-platform-bank', { action: 'pnl' }],
      ['moov-platform-bank', { action: 'list' }],
      ['moov-platform-bank', { action: 'get' }],
      ['moov-platform-bank', {}],
      ['platform-treasury', { action: 'wallet' }],
      ['platform-treasury', { action: 'pnl' }],
      ['platform-treasury', { action: 'list' }],
      ['platform-treasury', { action: 'get' }],
      ['platform-treasury', {}],
      ['moov-platform-bank', { action: 'add', routing_number: '021000021', account_number: '9999' }],
      ['moov-platform-bank', { action: 'initiate_micro_deposit' }],
      ['moov-platform-bank', { action: 'confirm_micro_deposit' }],
      ['platform-treasury', { action: 'transfer' }],
      ['platform-treasury', { action: 'sweep' }],
      ['platform-treasury', { action: 'pull' }],
      ['moov-bank-account-add', { action: 'add' }],
      ['moov-transfer-create', { amount: 10 }],
      ['moov-tenant-fee-charge', { action: 'charge' }],
      ['moov-sweep-config', { action: 'create' }],
      ['moov-sweep-config', { action: 'update' }],
      ['moov-wallet-fund', { amount: 10 }],
    ];
    for (const [name, body] of blocked) {
      const result = await handleProviderRequest(
        jwtEvent(`/functions/v1/${name}`, 'POST', body),
        `/functions/v1/${name}`,
        'POST',
        {
          fetchImpl: async () => {
            throw new Error(`Moov must not run for blocked ${name} ${body.action || ''}`);
          },
        },
      );
      assert.equal(result.statusCode, 403, `${name} ${body.action}`);
      assert.equal(result.error, 'production_execution_blocked', `${name} ${body.action}`);
      assert.equal(result.tranche4HardBlock, true, `${name} ${body.action}`);
    }
  });
});

test('wrapPlatformFinance write path never reaches bankAccountAdd', async () => {
  const { wrapPlatformFinance, platformFinanceBank } = await import(
    '../functions/api/providers/parity/platform-finance.mjs'
  );
  await withEnv(productionFlags, async () => {
    const result = await wrapPlatformFinance(platformFinanceBank, 'moov-platform-bank')(
      { body: JSON.stringify({ action: 'add', tenant_id: TENANT_ID }) },
      {
        withIdentity: identity({ action: 'add', tenant_id: TENANT_ID }),
        loadProviderSecrets: async () => ({
          MOOV_PUBLIC_KEY: 'pk_prod',
          MOOV_SECRET_KEY: 'sk_prod',
        }),
        fetchImpl: async () => {
          throw new Error('bankAccountAdd / Moov write must not run');
        },
      },
    );
    assert.equal(result.statusCode, 403);
    assert.equal(result.write_blocked, true);
    assert.equal(result.bankAccountAddInvoked, false);
  });
});

test('production cannot select the sandbox facilitator', async () => {
  await withEnv({
    ...productionFlags,
    AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: SANDBOX_FACILITATOR,
  }, async () => {
    const result = await invokePf('moov-platform-bank', { action: 'status' }, {
      fetchImpl: async () => {
        throw new Error('Moov must not run when production facilitator resolves to sandbox');
      },
    });
    assert.equal(result.statusCode, 503);
    assert.equal(result.sandbox_selected, false);
    assert.equal(result.liveProviderCalled, false);
    assert.notEqual(result.platform_account_id, SANDBOX_FACILITATOR);
  });
});

test('staging continues using the sandbox facilitator', async () => {
  await withEnv({
    CHECKSOPS_ENV: 'staging',
    AWS_PROVIDER_EXECUTION_ENABLED: undefined,
    AWS_MOOV_ENABLED: undefined,
    AWS_PROVIDER_LIVE_READS_ENABLED: undefined,
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
    AWS_MOOV_BILLING_DESTINATION_ACCOUNT_ID: PROD_FACILITATOR,
  }, async () => {
    const calls = [];
    const result = await invokePf('moov-platform-bank', { action: 'status' }, {
      fetchImpl: async (url, init = {}) => {
        const path = String(url);
        calls.push({ method: String(init.method || 'GET').toUpperCase(), path });
        if (path.includes('/oauth2/token')) return jsonRes({ access_token: 'tok', expires_in: 300 });
        assert.match(path, new RegExp(`/accounts/${SANDBOX_FACILITATOR}`));
        assert.doesNotMatch(path, new RegExp(PROD_FACILITATOR));
        if (path.endsWith(`/accounts/${SANDBOX_FACILITATOR}`)) {
          return jsonRes({ displayName: 'ChecksOps', verificationStatus: 'verified', mode: 'sandbox' });
        }
        if (path.endsWith('/bank-accounts')) return jsonRes([]);
        return jsonRes([]);
      },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.environment, 'sandbox');
    assert.equal(result.platform_account_id, SANDBOX_FACILITATOR);
  });
});

test('existing production sweep-read exception still works', async () => {
  const mapping = {
    application_user_id: FREEDOM_APP,
    cognito_sub: COGNITO_SUB,
    email: 'checksops-tester@freedomadj.com',
    status: 'active',
  };
  const mockClient = () => ({
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rows: [] };
      if (sql === 'SET TRANSACTION READ WRITE') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
      if (sql.includes('FROM public.tenant_users')) {
        return { rows: [{ tenant_id: TENANT_ID, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }] };
      }
      if (sql.includes('FROM public.user_roles')) return { rows: [] };
      if (sql.includes('FROM public.tenants WHERE id')) {
        return { rows: [{ moov_allowlisted: true, moov_environment: 'production' }] };
      }
      if (sql.includes('FROM public.payment_provider_accounts')) {
        return { rows: [{
          id: 'acct-1',
          tenant_id: TENANT_ID,
          provider: 'moov',
          environment: 'production',
          provider_account_id: 'moov-acct-freedom',
        }] };
      }
      if (sql.includes('FROM public.payment_wallets')) {
        return { rows: [{
          id: 'wallet-1',
          tenant_id: TENANT_ID,
          provider: 'moov',
          environment: 'production',
          wallet_type: 'operating',
          provider_wallet_id: 'wallet-freedom',
          provider_account_id: 'moov-acct-freedom',
          status: 'active',
          available_cents: 0,
          pending_cents: 0,
        }] };
      }
      if (sql.includes('FROM public.payment_provider_methods')) {
        return { rows: [{
          id: '8eb5b26e-6f66-435c-a578-880fb7fc14dd',
          tenant_id: TENANT_ID,
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
          created_at: '2026-08-28T00:00:00Z',
        }] };
      }
      return { rows: [] };
    },
  });
  await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: 'true',
    AWS_MOOV_ENABLED: 'true',
    AWS_PROVIDER_LIVE_READS_ENABLED: 'true',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  }, async () => {
    const result = await handleProviderRequest(
      jwtEvent('/functions/v1/moov-sweep-config', 'POST', {
        action: 'get',
        tenant_id: TENANT_ID,
        wallet_type: 'operating',
      }, { email: 'checksops-tester@freedomadj.com' }),
      '/functions/v1/moov-sweep-config',
      'POST',
      {
        loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
        createClient: () => mockClient(),
        loadProviderSecrets: async () => ({
          MOOV_PUBLIC_KEY: 'pk_live_x',
          MOOV_SECRET_KEY: 'sk_live_x',
          MOOV_ENVIRONMENT: 'production',
        }),
        fetchImpl: async (url) => {
          if (String(url).includes('/oauth2/token')) {
            return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'token-1', expires_in: 300 }) };
          }
          return { ok: false, status: 404, text: async () => JSON.stringify({}) };
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.environment, 'production');
    assert.equal(result.settlement_method.last_four, '4573');
  });
});
