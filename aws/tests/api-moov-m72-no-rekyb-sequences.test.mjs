import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL } from '../functions/api/identity.mjs';
import { handler } from '../functions/api/index.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import { capabilitiesStillNeeded } from '../functions/api/providers/readiness.mjs';
import { capabilityFlags } from '../functions/api/providers/parity/moov-client.mjs';
import {
  capabilitiesToRequest,
  refuseKycOrCapabilityWrite,
} from '../functions/api/providers/production/moov-capability-policy.mjs';
import {
  FIRST_PRODUCTION_TRANSFER_CENTS,
  productionMoovExecutionAllowed,
} from '../functions/api/providers/production/moov-holds.mjs';
import { KNOWN_APPROVED_MOOV } from '../functions/api/providers/production/moov-accounts.mjs';
import {
  assertProductionMoovGet,
  assertProductionMoovTransferPost,
  ProductionMoovError,
  resetProductionMoovTokenCache,
} from '../functions/api/providers/production/moov-http.mjs';
import { sweepBlocksFirstCent } from '../functions/api/providers/production/moov-preflight.mjs';
import { loadProductionMoovReadSecrets } from '../functions/api/providers/production/moov-secrets.mjs';
import { handleProductionMoovWalletFund } from '../functions/api/providers/production/moov-wallet-fund.mjs';
import { handleProductionMoovWalletDisburse } from '../functions/api/providers/production/moov-wallet-disburse.mjs';

const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM_TENANT = KNOWN_APPROVED_MOOV.freedom.tenantId;
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';

const jwtEvent = (pathName, method, body, extra = {}) => ({
  rawPath: pathName,
  headers: {
    authorization: extra.auth === null ? undefined : 'Bearer test-id-token',
    ...(extra.headers || {}),
  },
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method, path: pathName },
    authorizer: extra.auth === null ? undefined : {
      jwt: { claims: { sub: extra.sub || COGNITO_SUB, email: 'owner@freedomadj.com', token_use: 'id' } },
    },
  },
});

const mapping = {
  application_user_id: FREEDOM_APP,
  cognito_sub: COGNITO_SUB,
  email: 'owner@freedomadj.com',
  status: 'active',
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

const productionFlags = {
  AWS_PROVIDER_EXECUTION_ENABLED: 'true',
  AWS_MOOV_ENABLED: 'true',
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  AWS_CHECKALT_ENABLED: 'false',
  PROVIDER_SECRETS_ARN: 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/providers',
};

const productionSecrets = {
  MOOV_PUBLIC_KEY: 'pk_live_test',
  MOOV_SECRET_KEY: 'sk_live_test',
  MOOV_ENVIRONMENT: 'production',
  MOOV_ALLOWED_ORIGIN: 'https://checksops.com',
};

const grantStepUp = (store, extra = {}) => {
  store.stepups.push({
    id: crypto.randomUUID(),
    user_id: FREEDOM_APP,
    tenant_id: FREEDOM_TENANT,
    action_key: extra.actionKey || 'wallet.fund',
    factor_type: 'totp',
    succeeded: true,
    metadata: {
      amount_cents: extra.amountCents ?? 1,
      source_payment_method_id: extra.sourcePm || KNOWN_APPROVED_MOOV.freedom.achDebitFundPm,
      destination_payment_method_id: extra.destPm || KNOWN_APPROVED_MOOV.freedom.walletPm,
    },
    created_at: new Date().toISOString(),
  });
};

const createStore = () => ({
  memberships: [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  stepups: [],
  transfers: [],
  role: 'admin',
});

const identityClient = (store) => ({
  connect: async () => {},
  end: async () => {},
  query: async (sql, params = []) => {
    const text = String(sql);
    if (text === 'BEGIN' || text === 'ROLLBACK' || text === 'COMMIT' || text === 'SET TRANSACTION READ WRITE'
      || text.startsWith('SAVEPOINT') || text.startsWith('RELEASE SAVEPOINT') || text.startsWith('ROLLBACK TO SAVEPOINT')) {
      return { rows: [] };
    }
    if (text.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
    if (text === LOOKUP_MAPPING_SQL) return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
    if (text === TENANT_MEMBERSHIP_SQL || text.includes('FROM public.tenant_users tu')) {
      return { rows: store.memberships };
    }
    if (text.includes('FROM public.user_roles')) {
      return { rows: [{ role: 'admin' }] };
    }
    if (text.includes('FROM public.tenant_users WHERE user_id') && text.includes('AND tenant_id')) {
      const match = store.memberships.find((row) => row.tenant_id === params[1]);
      return { rows: match ? [{ role: match.role }] : [] };
    }
    if (text.includes('FROM public.financial_stepup_log')) {
      const [userId, tenantId, actionKey, since, amountCents] = params;
      return {
        rows: store.stepups.filter((row) => (
          row.user_id === userId
          && row.tenant_id === tenantId
          && row.action_key === actionKey
          && row.succeeded === true
          && Number(row.metadata?.amount_cents) === Number(amountCents)
          && new Date(row.created_at) >= new Date(since)
        )),
      };
    }
    if (text.includes('INSERT INTO public.payment_transfers')) {
      const row = {
        id: crypto.randomUUID(),
        tenant_id: params[0],
        provider: 'moov',
        environment: 'production',
        status: 'ready',
        idempotency_key: params[1],
        amount_cents: params[2],
        description: params[3],
        source_tenant_account_id: params[4],
        source_payment_method_id: params[5],
        destination_tenant_id: params[6],
        destination_recipient_id: params[7],
        destination_payment_method_id: params[8],
        wallet_id: params[9],
        leg_role: params[10],
        created_by: params[11],
        provider_transfer_id: null,
      };
      store.transfers.push(row);
      return { rows: [row] };
    }
    if (text.includes('UPDATE public.payment_transfers') && text.includes("status = 'submitting'")) {
      const row = store.transfers.find((item) => item.id === params[0] && item.status === 'ready' && !item.provider_transfer_id);
      if (!row) return { rows: [] };
      row.status = 'submitting';
      return { rows: [row] };
    }
    if (text.includes('UPDATE public.payment_transfers')) {
      const row = store.transfers.find((item) => item.id === params[0]);
      if (!row) return { rows: [] };
      row.provider_transfer_id = params[1];
      row.provider_status = params[2];
      row.status = params[3];
      row.provider_metadata = typeof params[4] === 'string' ? JSON.parse(params[4]) : params[4];
      row.failure_reason = params[5];
      row.submitted_at = new Date().toISOString();
      return { rows: [row] };
    }
    if (text.includes('FROM public.payment_transfers')) {
      return { rows: store.transfers.filter((row) => row.tenant_id === params[0] && row.idempotency_key === params[1]) };
    }
    return { rows: [] };
  },
});

const jsonResponse = (body, status = 200) => ({
  ok: status < 400,
  status,
  text: async () => JSON.stringify(body),
});

const mockMoovFetch = (store, { sweepMin = '0.00', sweepStatus = 'enabled', walletAvailable = 0 } = {}) => {
  store.moovCalls = [];
  return async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    store.moovCalls.push({ method, url: target, body: options.body || null });
    if (target.includes('/oauth2/token')) {
      return jsonResponse({ access_token: 'tok_live', expires_in: 300, token_type: 'Bearer' });
    }
    if (method === 'POST' && /\/accounts\/[^/]+\/capabilities/.test(target)) {
      store.capabilityPosts = (store.capabilityPosts || 0) + 1;
      return jsonResponse({ error: 'should_not_post_capabilities' }, 500);
    }
    if (method === 'POST' && /\/accounts\/[^/]+\/transfers$/.test(target)) {
      store.transferPosts = (store.transferPosts || 0) + 1;
      return jsonResponse({ transferID: 'tr_test_1', status: 'pending' });
    }
    if (target.includes('/capabilities')) {
      return jsonResponse([
        { capability: 'collect-funds', status: 'enabled' },
        { capability: 'send-funds', status: 'enabled' },
        { capability: 'transfers', status: 'enabled' },
        { capability: 'wallet', status: 'enabled' },
      ]);
    }
    if (target.includes('/bank-accounts')) {
      return jsonResponse([{
        bankAccountID: KNOWN_APPROVED_MOOV.freedom.bankId,
        bankName: 'WELLS FARGO BANK',
        lastFourAccountNumber: '4573',
        status: 'verified',
      }]);
    }
    if (target.includes('/payment-methods')) {
      const accountId = target.match(/accounts\/([^/]+)/)?.[1];
      if (accountId === KNOWN_APPROVED_MOOV.recipient.moovAccountId) {
        return jsonResponse([{
          paymentMethodID: KNOWN_APPROVED_MOOV.recipient.achCreditStandardPm,
          paymentMethodType: 'ach-credit-standard',
          bankAccountID: KNOWN_APPROVED_MOOV.recipient.bankId,
        }]);
      }
      return jsonResponse([
        {
          paymentMethodID: KNOWN_APPROVED_MOOV.freedom.achDebitFundPm,
          paymentMethodType: 'ach-debit-fund',
          bankAccountID: KNOWN_APPROVED_MOOV.freedom.bankId,
        },
        {
          paymentMethodID: KNOWN_APPROVED_MOOV.freedom.walletPm,
          paymentMethodType: 'moov-wallet',
          walletID: KNOWN_APPROVED_MOOV.freedom.walletId,
          wallet: { walletID: KNOWN_APPROVED_MOOV.freedom.walletId, partnerAccountID: KNOWN_APPROVED_MOOV.platform.moovAccountId },
          partnerAccountID: KNOWN_APPROVED_MOOV.platform.moovAccountId,
        },
      ]);
    }
    if (target.includes('/sweeps')) {
      return jsonResponse([{
        sweepID: 'sweep-1',
        status: sweepStatus,
        minimumBalance: { value: sweepMin, currency: 'USD' },
      }]);
    }
    if (target.includes('/wallets/')) {
      return jsonResponse({
        walletID: KNOWN_APPROVED_MOOV.freedom.walletId,
        status: 'active',
        availableBalance: { value: walletAvailable, currency: 'USD' },
      });
    }
    if (/\/accounts\/[^/]+$/.test(target)) {
      const accountId = target.split('/').pop();
      const business = accountId === KNOWN_APPROVED_MOOV.recipient.moovAccountId
        ? null
        : { legalBusinessName: 'Freedom Adjustment', verification: { status: 'verified' } };
      return jsonResponse({
        accountID: accountId,
        termsOfService: { acceptedDate: '2026-01-01T00:00:00Z' },
        profile: business
          ? { business }
          : { individual: { verification: { status: 'verified' }, name: { firstName: 'Recipient' } } },
      });
    }
    return jsonResponse({ error: 'unexpected' }, 404);
  };
};

const fundDeps = (store, extra = {}) => ({
  loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
  createClient: () => identityClient(store),
  fetchImpl: extra.fetchImpl || mockMoovFetch(store, extra),
  loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets),
});

describe('M7.2 no-re-KYC Moov sequences', { concurrency: 1 }, () => {
test('family-enabled capabilities are never requested again', () => {
  const freedom = [
    { capability: 'collect-funds', status: 'enabled' },
    { capability: 'send-funds', status: 'enabled' },
    { capability: 'transfers', status: 'enabled' },
    { capability: 'wallet', status: 'enabled' },
  ];
  assert.deepEqual(capabilitiesToRequest(freedom), []);
  assert.deepEqual(capabilitiesStillNeeded(freedom, ['send-funds.ach', 'wallet.balance']), []);
  const flags = capabilityFlags(freedom);
  assert.equal(flags.can_ach_debit, true);
  assert.equal(flags.can_ach_credit, true);
  assert.equal(flags.can_send_payments, true);
});

test('KYC, capability POST, and account create are blocked', () => {
  assert.equal(refuseKycOrCapabilityWrite({ method: 'POST', path: '/accounts/abc/capabilities' }).error, 'moov_kyc_rerequest_blocked');
  assert.equal(refuseKycOrCapabilityWrite({ method: 'POST', path: '/accounts' }).error, 'moov_kyc_rerequest_blocked');
  assert.equal(refuseKycOrCapabilityWrite({ method: 'GET', path: '/accounts/abc/capabilities' }), null);
});

test('production HTTP allowlist allows GET and transfer POST only', () => {
  assert.doesNotThrow(() => assertProductionMoovGet({
    method: 'GET',
    path: `/accounts/${KNOWN_APPROVED_MOOV.freedom.moovAccountId}/capabilities`,
  }));
  assert.doesNotThrow(() => assertProductionMoovTransferPost({
    method: 'POST',
    path: `/accounts/${KNOWN_APPROVED_MOOV.platform.moovAccountId}/transfers`,
  }));
  assert.throws(
    () => assertProductionMoovTransferPost({
      method: 'POST',
      path: `/accounts/${KNOWN_APPROVED_MOOV.freedom.moovAccountId}/capabilities`,
    }),
    (error) => error instanceof ProductionMoovError && error.code === 'moov_kyc_rerequest_blocked',
  );
  assert.throws(
    () => assertProductionMoovGet({
      method: 'POST',
      path: `/accounts/${KNOWN_APPROVED_MOOV.freedom.moovAccountId}/capabilities`,
    }),
    (error) => error.code === 'read_only_method_denied',
  );
});

test('enabled sweep with $0 minimum blocks Test 1', () => {
  assert.equal(sweepBlocksFirstCent([{ status: 'enabled', minimumBalance: { value: 0 } }]), true);
  assert.equal(sweepBlocksFirstCent([{ status: 'enabled', minimumBalance: { value: '0.00' } }]), true);
  assert.equal(sweepBlocksFirstCent([{ status: 'disabled', minimumBalance: { value: 0 } }]), false);
  assert.equal(sweepBlocksFirstCent([{ status: 'enabled', minimumBalance: { value: 150 } }]), false);
});

test('default holds keep production Moov writers unreachable', async () => {
  const result = await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: undefined,
    AWS_MOOV_ENABLED: undefined,
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: undefined,
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  }, () => handler(jwtEvent('/functions/v1/moov-wallet-fund', 'POST', {
    tenant_id: FREEDOM_TENANT,
    amount_cents: 1,
  })));
  const body = JSON.parse(result.body);
  assert.equal(result.statusCode, 403);
  assert.ok(['provider_disabled', 'production_execution_blocked'].includes(body.error));
  assert.equal(productionMoovExecutionAllowed(), false);
  assert.notEqual(body.liveProviderCalled, true);
});

test('initiate-wallet-funding is refused so A and B stay separate', async () => {
  const store = createStore();
  const result = await withEnv(productionFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/initiate-wallet-funding', 'POST', { tenant_id: FREEDOM_TENANT, amount_cents: 1 }),
    '/functions/v1/initiate-wallet-funding',
    'POST',
    fundDeps(store),
  ));
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'use_separate_fund_and_disburse');
  assert.equal(result.liveProviderCalled, false);
  assert.equal(store.transferPosts || 0, 0);
});

test('BANK→WALLET refuses amounts above the 1 cent first-transfer cap', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  grantStepUp(store, { amountCents: 2 });
  const result = await withEnv(productionFlags, () => handleProductionMoovWalletFund({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 2 },
    spoof: {},
    fetchImpl: mockMoovFetch(store),
    deps: fundDeps(store),
  }));
  assert.equal(result.error, 'first_transfer_cap');
  assert.equal(result.liveProviderCalled, false);
  assert.equal(FIRST_PRODUCTION_TRANSFER_CENTS, 1);
});

test('BANK→WALLET refuses when Sweep minimum is $0; no transfer POST', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  grantStepUp(store);
  const result = await withEnv(productionFlags, () => handleProductionMoovWalletFund({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 1 },
    spoof: {},
    fetchImpl: mockMoovFetch(store, { sweepMin: '0.00', sweepStatus: 'enabled' }),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(result.error, 'sweep_minimum_blocks_test');
  assert.equal(result.kycRequested, false);
  assert.equal(result.capabilitiesPosted, false);
  assert.equal(store.transferPosts || 0, 0);
  assert.equal(store.capabilityPosts || 0, 0);
  assert.ok(store.moovCalls.every((call) => call.method === 'GET' || call.url.includes('/oauth2/token')));
});

test('BANK→WALLET requires Financial TOTP bound to wallet.fund', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  const result = await withEnv(productionFlags, () => handleProductionMoovWalletFund({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 1 },
    spoof: {},
    fetchImpl: mockMoovFetch(store, { sweepStatus: 'disabled' }),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(result.error, 'financial_totp_required');
  assert.equal(store.transferPosts || 0, 0);
});

test('BANK→WALLET posts one facilitator transfer after TOTP when sweep is contained', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  grantStepUp(store);
  const result = await withEnv(productionFlags, () => handleProductionMoovWalletFund({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 1, idempotency_key: 'fund-test-1' },
    spoof: {},
    fetchImpl: mockMoovFetch(store, { sweepStatus: 'disabled' }),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(result.ok, true, result.error || JSON.stringify(result));
  assert.equal(result.operation, 'wallet.fund');
  assert.equal(result.kycRequested, false);
  assert.equal(result.capabilitiesPosted, false);
  assert.equal(result.autoSendAfterFunding, false);
  assert.equal(store.transferPosts, 1);
  assert.equal(store.capabilityPosts || 0, 0);
  assert.equal(store.transfers[0].environment, 'production');
  assert.equal(store.transfers[0].provider_transfer_id, 'tr_test_1');
  assert.ok(store.moovCalls.some((call) => call.method === 'POST' && /\/transfers$/.test(call.url)));
  assert.ok(!store.moovCalls.some((call) => /capabilities/.test(call.url) && call.method === 'POST'));
});

test('WALLET→RECIPIENT refuses internal bypass and bank fallback', async () => {
  const store = createStore();
  const bypass = await withEnv(productionFlags, () => handleProductionMoovWalletDisburse({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 1 },
    spoof: {},
    fetchImpl: mockMoovFetch(store),
    deps: { internalBypass: true },
  }));
  assert.equal(bypass.error, 'internal_bypass_refused');
  assert.equal(bypass.liveProviderCalled, false);

  const bank = await withEnv(productionFlags, () => handleProductionMoovWalletDisburse({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 1, source_kind: 'bank' },
    spoof: {},
    fetchImpl: mockMoovFetch(store),
    deps: {},
  }));
  assert.equal(bank.error, 'bank_to_recipient_refused');
  assert.equal(store.transferPosts || 0, 0);
});

test('WALLET→RECIPIENT refuses when wallet available is below 1 cent', async () => {
  resetProductionMoovTokenCache();
  const store = createStore();
  grantStepUp(store, {
    actionKey: 'wallet.disburse',
    sourcePm: KNOWN_APPROVED_MOOV.freedom.walletPm,
    destPm: KNOWN_APPROVED_MOOV.recipient.achCreditStandardPm,
  });
  const result = await withEnv(productionFlags, () => handleProductionMoovWalletDisburse({
    client: identityClient(store),
    mapping,
    claims: { sub: COGNITO_SUB },
    body: { tenant_id: FREEDOM_TENANT, amount_cents: 1, source_kind: 'wallet' },
    spoof: {},
    fetchImpl: mockMoovFetch(store, { walletAvailable: 0 }),
    deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
  }));
  assert.equal(result.error, 'wallet_balance_insufficient');
  assert.equal(result.bankFallback, false);
  assert.equal(store.transferPosts || 0, 0);
});
});
