import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleProductionMoovWalletFundContinue } from '../functions/api/providers/production/moov-wallet-fund-continue.mjs';
import { KNOWN_APPROVED_MOOV } from '../functions/api/providers/production/moov-accounts.mjs';
import { loadProductionMoovReadSecrets } from '../functions/api/providers/production/moov-secrets.mjs';
import { resetProductionMoovTokenCache } from '../functions/api/providers/production/moov-http.mjs';
import {
  loadProductionTransferById,
  providerFundIdempotencyKey,
} from '../functions/api/providers/production/moov-idempotency.mjs';
import { hasProductionMoovHandler } from '../functions/api/providers/production/moov-dispatch.mjs';
import { PRODUCTION_MOOV_FUNCTIONS } from '../functions/api/providers/production/moov-holds.mjs';
import { FUNCTION_BY_NAME } from '../functions/api/providers/catalog.mjs';

const GIT_API_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../functions/api');
const [{ TENANT_MEMBERSHIP_SQL }] = await Promise.all([
  import(`${GIT_API_ROOT}/identity.mjs`),
]);

const HELD_INTENT_ID = '257b6033-eac0-4555-877e-a8cb4f801c8f';
const FREEDOM_APP = '7dbb3009-f059-4767-b5dc-1c5c72379330';
const OTHER_APP = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const COGNITO_SUB = 'a45884b8-d051-70e2-b19d-ca704964c6e8';
const FREEDOM_TENANT = KNOWN_APPROVED_MOOV.freedom.tenantId;
const OTHER_TENANT = KNOWN_APPROVED_MOOV.c1c.tenantId;
const LOCAL_BANK_METHOD_ID = '8eb5b26e-6f66-435c-a578-880fb7fc14dd';
const LOCAL_WALLET_ROW_ID = '473ceaca-3534-467b-8d92-49baa53f6c68';
const OTHER_BANK_METHOD_ID = '11111111-2222-4333-8444-555555555501';
const OTHER_WALLET_ROW_ID = '11111111-2222-4333-8444-555555555502';
const MOOV_IDS = KNOWN_APPROVED_MOOV.freedom;
const EXPECTED_PROVIDER_KEY = `checksops-wallet-fund-${HELD_INTENT_ID}`;

const mapping = {
  application_user_id: FREEDOM_APP,
  cognito_sub: COGNITO_SUB,
  email: 'michael@freedomadj.com',
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

const darkFlags = {
  AWS_PROVIDER_EXECUTION_ENABLED: 'true',
  AWS_MOOV_ENABLED: 'true',
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  AWS_CHECKALT_ENABLED: 'true',
  AWS_PLAID_ENABLED: 'false',
  AWS_MOOV_TRANSFER_POST_ENABLED: 'false',
  PROVIDER_SECRETS_ARN: 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/providers',
};

const armedFlags = {
  ...darkFlags,
  AWS_MOOV_TRANSFER_POST_ENABLED: 'true',
};

const productionSecrets = {
  MOOV_PUBLIC_KEY: 'pk_live_test',
  MOOV_SECRET_KEY: 'sk_live_test',
  MOOV_ENVIRONMENT: 'production',
  MOOV_ALLOWED_ORIGIN: 'https://checksops.com',
};

const heldIntent = (overrides = {}) => ({
  id: HELD_INTENT_ID,
  tenant_id: FREEDOM_TENANT,
  provider: 'moov',
  environment: 'production',
  status: 'ready',
  idempotency_key: 'c3f84c4d-3aee-479e-bd6c-0164bf569ce2',
  amount_cents: 1,
  description: 'ChecksOps BANK→WALLET Test 1',
  source_tenant_account_id: MOOV_IDS.moovAccountId,
  source_payment_method_id: LOCAL_BANK_METHOD_ID,
  destination_tenant_id: FREEDOM_TENANT,
  destination_recipient_id: null,
  destination_payment_method_id: null,
  wallet_id: LOCAL_WALLET_ROW_ID,
  leg_role: 'wallet_funding',
  created_by: FREEDOM_APP,
  provider_transfer_id: null,
  submitted_at: null,
  completed_at: null,
  failure_reason: null,
  provider_metadata: {},
  ...overrides,
});

const createStore = (intentOverrides = {}) => ({
  memberships: [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  stepups: [],
  transfers: [heldIntent(intentOverrides)],
  queries: [],
  inserts: 0,
  submittingUpdates: 0,
  checkaltQueries: 0,
  plaidQueries: 0,
  supabaseQueries: 0,
  role: 'admin',
  casWaiters: [],
  accounts: [{
    tenant_id: FREEDOM_TENANT,
    provider_account_id: MOOV_IDS.moovAccountId,
    onboarding_status: 'active',
    verification_status: 'verified',
    disabled: false,
  }],
  wallets: [{
    id: LOCAL_WALLET_ROW_ID,
    tenant_id: FREEDOM_TENANT,
    provider: 'moov',
    environment: 'production',
    provider_wallet_id: MOOV_IDS.walletId,
    wallet_type: 'operating',
    status: 'active',
  }],
  methods: [{
    id: LOCAL_BANK_METHOD_ID,
    tenant_id: FREEDOM_TENANT,
    provider: 'moov',
    environment: 'production',
    provider_bank_account_id: MOOV_IDS.bankId,
    provider_payment_method_id: MOOV_IDS.achDebitFundPm,
    connection_status: 'connected',
    is_default: true,
  }],
});

const grantStepUp = (store, overrides = {}) => {
  store.stepups.push({
    id: crypto.randomUUID(),
    user_id: FREEDOM_APP,
    tenant_id: FREEDOM_TENANT,
    action_key: 'wallet.fund',
    factor_type: 'totp',
    succeeded: true,
    metadata: {
      amount_cents: 1,
      source_payment_method_id: MOOV_IDS.achDebitFundPm,
      destination_payment_method_id: MOOV_IDS.walletPm,
    },
    created_at: new Date().toISOString(),
    ...overrides,
  });
};

const identityClient = (store) => ({
  connect: async () => {},
  end: async () => {},
  query: async (sql, params = []) => {
    const text = String(sql);
    store.queries.push(text.replace(/\s+/g, ' ').slice(0, 240));
    if (/checkalt/i.test(text)) store.checkaltQueries += 1;
    if (/plaid/i.test(text)) store.plaidQueries += 1;
    if (/supabase/i.test(text)) store.supabaseQueries += 1;
    if (text === 'BEGIN' || text === 'ROLLBACK' || text === 'COMMIT' || text === 'SET TRANSACTION READ WRITE'
      || text.startsWith('SAVEPOINT') || text.startsWith('RELEASE SAVEPOINT') || text.startsWith('ROLLBACK TO SAVEPOINT')) {
      return { rows: [] };
    }
    if (text.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
    if (text === TENANT_MEMBERSHIP_SQL || text.includes('FROM public.tenant_users tu')) {
      return { rows: store.memberships };
    }
    if (text.includes('FROM public.user_roles')) {
      return { rows: [{ role: store.role || 'admin' }] };
    }
    if (text.includes('FROM public.tenant_users WHERE user_id') && text.includes('AND tenant_id')) {
      const match = store.memberships.find((row) => row.tenant_id === params[1]);
      return { rows: match ? [{ role: match.role }] : [] };
    }
    if (text.includes('FROM public.payment_provider_accounts')) {
      return { rows: store.accounts.filter((row) => row.tenant_id === params[0]) };
    }
    if (text.includes('FROM public.payment_wallets') && text.includes('provider_wallet_id = $2')) {
      return {
        rows: store.wallets.filter((row) => row.tenant_id === params[0] && row.provider_wallet_id === params[1]),
      };
    }
    if (text.includes('FROM public.payment_wallets')) {
      return { rows: store.wallets.filter((row) => row.tenant_id === params[0]) };
    }
    if (text.includes('FROM public.payment_provider_methods') && text.includes('provider_bank_account_id = $2')) {
      return {
        rows: store.methods.filter((row) => (
          row.tenant_id === params[0]
          && row.provider_bank_account_id === params[1]
          && row.connection_status === 'connected'
        )),
      };
    }
    if (text.includes('FROM public.payment_provider_methods') && text.includes('provider_payment_method_id = $2')) {
      return {
        rows: store.methods.filter((row) => (
          row.tenant_id === params[0]
          && row.provider_payment_method_id === params[1]
          && row.connection_status === 'connected'
        )),
      };
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
      store.inserts += 1;
      const row = heldIntent({
        id: crypto.randomUUID(),
        tenant_id: params[0],
        idempotency_key: params[1],
        amount_cents: params[2],
        source_payment_method_id: params[5],
        wallet_id: params[9],
        leg_role: params[10],
        created_by: params[11],
      });
      store.transfers.push(row);
      return { rows: [row] };
    }
    if (text.includes('UPDATE public.payment_transfers') && text.includes("status = 'submitting'")) {
      store.submittingUpdates += 1;
      if (typeof store.onCasAttempt === 'function') await store.onCasAttempt(store);
      const row = store.transfers.find((item) => item.id === params[0] && item.status === 'ready' && !item.provider_transfer_id);
      if (!row) return { rows: [] };
      row.status = 'submitting';
      return { rows: [{ ...row }] };
    }
    if (text.includes('UPDATE public.payment_transfers') && text.includes('provider_transfer_id')) {
      const row = store.transfers.find((item) => item.id === params[0]);
      if (!row) return { rows: [] };
      row.provider_transfer_id = params[1];
      row.provider_status = params[2];
      row.status = params[3];
      row.submitted_at = new Date().toISOString();
      row.provider_metadata = JSON.parse(params[4] || '{}');
      row.failure_reason = params[5];
      return { rows: [{ ...row }] };
    }
    if (text.includes('FROM public.payment_transfers') && text.includes('WHERE id = $1')) {
      return { rows: store.transfers.filter((row) => row.id === params[0]) };
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

const mockMoovFetch = (store) => {
  store.moovCalls ||= [];
  store.transferPosts ||= 0;
  store.transferPostKeys ||= [];
  store.capabilityPosts ||= 0;
  store.sweepWrites ||= 0;
  store.checkaltHttp ||= 0;
  store.plaidHttp ||= 0;
  store.supabaseHttp ||= 0;
  store.moovAcceptedTransfers ||= [];
  return async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    store.moovCalls.push({ method, url: target, headers: options.headers || {} });
    if (/checkalt/i.test(target)) store.checkaltHttp += 1;
    if (/plaid/i.test(target)) store.plaidHttp += 1;
    if (/supabase/i.test(target)) store.supabaseHttp += 1;
    if (target.includes('/oauth2/token')) {
      return jsonResponse({ access_token: 'tok_live', expires_in: 300, token_type: 'Bearer' });
    }
    if (method === 'POST' && /\/accounts\/[^/]+\/capabilities/.test(target)) {
      store.capabilityPosts += 1;
      return jsonResponse({ error: 'should_not_post_capabilities' }, 500);
    }
    if (method === 'POST' && /\/accounts\/[^/]+\/transfers$/.test(target)) {
      store.transferPosts += 1;
      const key = options.headers?.['X-Idempotency-Key'] || null;
      store.transferPostKeys.push(key);
      if (store.transferPostMode === 'timeout' || store.transferPostMode === 'lost_response') {
        if (store.transferPostMode === 'lost_response') {
          store.moovAcceptedTransfers.push({ transferID: 'tr_accepted_lost', idempotencyKey: key });
        }
        const error = new Error('fetch failed');
        error.code = 'ETIMEDOUT';
        throw error;
      }
      return jsonResponse({ transferID: 'tr_continue_1', status: 'pending' });
    }
    if ((method === 'POST' || method === 'PATCH') && target.includes('/sweep-configs')) {
      store.sweepWrites += 1;
      return jsonResponse({ error: 'should_not_write_sweep' }, 500);
    }
    if (target.includes('/sweep-configs')) {
      return jsonResponse([{
        sweepConfigID: '2d2c900d-6efb-43a2-ba90-2fd77e22afdd',
        walletID: MOOV_IDS.walletId,
        status: 'disabled',
        minimumBalance: { value: '150.00', currency: 'USD' },
      }]);
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
        bankAccountID: MOOV_IDS.bankId,
        bankName: 'WELLS FARGO BANK',
        lastFourAccountNumber: '4573',
        status: 'verified',
      }]);
    }
    if (target.includes('/payment-methods')) {
      return jsonResponse([
        {
          paymentMethodID: MOOV_IDS.achDebitFundPm,
          paymentMethodType: 'ach-debit-fund',
          bankAccountID: MOOV_IDS.bankId,
        },
        {
          paymentMethodID: MOOV_IDS.walletPm,
          paymentMethodType: 'moov-wallet',
          walletID: MOOV_IDS.walletId,
          wallet: { walletID: MOOV_IDS.walletId, partnerAccountID: KNOWN_APPROVED_MOOV.platform.moovAccountId },
          partnerAccountID: KNOWN_APPROVED_MOOV.platform.moovAccountId,
        },
      ]);
    }
    if (/\/wallets\/[^/]+$/.test(target) || target.includes('/wallets')) {
      return jsonResponse({
        walletID: MOOV_IDS.walletId,
        status: 'active',
        availableBalance: { value: 0, currency: 'USD' },
        pendingBalance: { value: 0, currency: 'USD' },
      });
    }
    if (/\/accounts\/[^/]+$/.test(target)) {
      return jsonResponse({
        accountID: MOOV_IDS.moovAccountId,
        termsOfService: { acceptedDate: '2026-01-01T00:00:00Z' },
        profile: { business: { legalBusinessName: 'Freedom Adjustment LLC', verification: { status: 'verified' } } },
      });
    }
    return jsonResponse({ error: 'unexpected' }, 404);
  };
};

const runContinue = (store, body, flags = darkFlags, caller = mapping) => {
  store.fetchImpl ||= mockMoovFetch(store);
  return withEnv(flags, () => (
    handleProductionMoovWalletFundContinue({
      client: identityClient(store),
      mapping: caller,
      claims: { sub: caller.cognito_sub, email: caller.email },
      body,
      spoof: {},
      fetchImpl: store.fetchImpl,
      deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
    })
  ));
};

const continueBody = (extra = {}) => ({
  payment_transfer_id: HELD_INTENT_ID,
  tenant_id: FREEDOM_TENANT,
  amount_cents: 999,
  idempotency_key: 'browser-must-not-win',
  source_payment_method_id: 'spoof-source',
  wallet_id: 'spoof-wallet',
  ...extra,
});

const assertNoSideChannels = (store) => {
  assert.equal(store.inserts, 0);
  assert.equal(store.capabilityPosts, 0);
  assert.equal(store.sweepWrites, 0);
  assert.equal(store.checkaltHttp, 0);
  assert.equal(store.plaidHttp, 0);
  assert.equal(store.supabaseHttp, 0);
  assert.equal(store.checkaltQueries, 0);
  assert.equal(store.plaidQueries, 0);
  assert.equal(store.supabaseQueries, 0);
};

describe('M7.5B.4 continue existing wallet.fund intent', { concurrency: 1 }, () => {
  test('route and deterministic provider idempotency are registered', () => {
    assert.equal(hasProductionMoovHandler('moov-wallet-fund-continue'), true);
    assert.equal(PRODUCTION_MOOV_FUNCTIONS.has('moov-wallet-fund-continue'), true);
    assert.equal(FUNCTION_BY_NAME['moov-wallet-fund-continue']?.name, 'moov-wallet-fund-continue');
    assert.equal(providerFundIdempotencyKey(HELD_INTENT_ID), EXPECTED_PROVIDER_KEY);
    assert.equal(typeof loadProductionTransferById, 'function');
  });

  test('exact valid ready row stays ready in dark mode with zero provider POSTs', async () => {
    resetProductionMoovTokenCache();
    const store = createStore();
    grantStepUp(store);
    const result = await runContinue(store, continueBody());

    assert.equal(result.error, 'transfer_post_held', result.error || JSON.stringify(result));
    assert.equal(result.statusCode, 403);
    assert.equal(result.darkMode, true);
    assert.equal(result.continueExisting, true);
    assert.equal(result.casClaimed, false);
    assert.equal(result.liveProviderCalled, false);
    assert.equal(result.productionExecution, false);
    assert.equal(result.providerIdempotencyKey, EXPECTED_PROVIDER_KEY);
    assert.equal(result.transfer.id, HELD_INTENT_ID);
    assert.equal(store.transfers.length, 1);
    assert.equal(store.transfers[0].status, 'ready');
    assert.equal(store.transfers[0].provider_transfer_id, null);
    assert.equal(store.submittingUpdates, 0);
    assert.equal(store.transferPosts, 0);
    assert.ok(!store.moovCalls.some((call) => call.method === 'POST' && /\/transfers$/.test(call.url)));
    assertNoSideChannels(store);
  });

  test('wrong tenant is refused and does not insert or POST', async () => {
    resetProductionMoovTokenCache();
    const store = createStore({ tenant_id: OTHER_TENANT });
    grantStepUp(store);
    const result = await runContinue(store, continueBody());
    assert.equal(result.error, 'continue_tenant_mismatch');
    assert.equal(result.statusCode, 403);
    assert.equal(store.transfers[0].status, 'ready');
    assert.equal(store.transferPosts, 0);
    assert.equal(store.inserts, 0);
  });

  test('wrong user without financial authority is refused', async () => {
    resetProductionMoovTokenCache();
    const store = createStore();
    store.memberships = [{ tenant_id: FREEDOM_TENANT, role: 'staff', tenant_name: 'Freedom', tenant_slug: 'freedom' }];
    store.role = 'staff';
    grantStepUp(store);
    const result = await runContinue(store, continueBody(), darkFlags, {
      application_user_id: OTHER_APP,
      cognito_sub: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      email: 'staff@freedomadj.com',
      status: 'active',
    });
    assert.equal(result.error, 'continue_created_by_denied');
    assert.equal(store.transferPosts, 0);
    assert.equal(store.inserts, 0);
    assert.equal(store.transfers[0].status, 'ready');
  });

  test('wrong action / leg_role is refused', async () => {
    resetProductionMoovTokenCache();
    const store = createStore({ leg_role: 'wallet_disbursement' });
    grantStepUp(store);
    const result = await runContinue(store, continueBody());
    assert.equal(result.error, 'continue_leg_role_mismatch');
    assert.equal(store.transferPosts, 0);
    assert.equal(store.inserts, 0);
  });

  test('amount != 1 cent is refused', async () => {
    resetProductionMoovTokenCache();
    const store = createStore({ amount_cents: 2 });
    grantStepUp(store);
    const result = await runContinue(store, continueBody({ amount_cents: 1 }));
    assert.equal(result.error, 'first_transfer_cap');
    assert.equal(result.amountCents, 2);
    assert.equal(store.transferPosts, 0);
    assert.equal(store.inserts, 0);
  });

  test('wrong source bank is refused', async () => {
    resetProductionMoovTokenCache();
    const store = createStore({ source_payment_method_id: OTHER_BANK_METHOD_ID });
    store.methods.push({
      id: OTHER_BANK_METHOD_ID,
      tenant_id: FREEDOM_TENANT,
      provider: 'moov',
      environment: 'production',
      provider_bank_account_id: '99999999-aaaa-4bbb-8ccc-dddddddddddd',
      connection_status: 'connected',
    });
    grantStepUp(store);
    const result = await runContinue(store, continueBody());
    assert.equal(result.error, 'continue_source_bank_mismatch');
    assert.equal(store.transferPosts, 0);
    assert.equal(store.inserts, 0);
  });

  test('wrong wallet is refused', async () => {
    resetProductionMoovTokenCache();
    const store = createStore({ wallet_id: OTHER_WALLET_ROW_ID });
    store.wallets.push({
      id: OTHER_WALLET_ROW_ID,
      tenant_id: FREEDOM_TENANT,
      provider: 'moov',
      environment: 'production',
      provider_wallet_id: '99999999-aaaa-4bbb-8ccc-dddddddddddd',
      wallet_type: 'operating',
      status: 'active',
    });
    grantStepUp(store);
    const result = await runContinue(store, continueBody());
    assert.equal(result.error, 'continue_wallet_mismatch');
    assert.equal(store.transferPosts, 0);
    assert.equal(store.inserts, 0);
  });

  test('status != ready is refused without POST', async () => {
    resetProductionMoovTokenCache();
    const store = createStore({ status: 'pending' });
    grantStepUp(store);
    const result = await runContinue(store, continueBody());
    assert.equal(result.error, 'continue_status_not_ready');
    assert.equal(store.transferPosts, 0);
    assert.equal(store.submittingUpdates, 0);
  });

  test('existing provider_transfer_id reconciles without a second POST', async () => {
    resetProductionMoovTokenCache();
    const store = createStore({
      provider_transfer_id: 'tr_already_exists',
      status: 'submitted',
      submitted_at: '2026-09-16T11:10:00.000Z',
    });
    grantStepUp(store);
    const result = await runContinue(store, continueBody(), armedFlags);
    assert.equal(result.duplicate, true);
    assert.equal(result.reconcile, true);
    assert.equal(store.transferPosts, 0);
    assert.equal(store.submittingUpdates, 0);
    assert.equal(store.inserts, 0);
  });

  test('expired wallet.fund TOTP requires a fresh step-up', async () => {
    resetProductionMoovTokenCache();
    const store = createStore();
    grantStepUp(store, { created_at: new Date(Date.now() - (31 * 60 * 1000)).toISOString() });
    const result = await runContinue(store, continueBody());
    assert.equal(result.error, 'financial_totp_required');
    assert.equal(store.transferPosts, 0);
    assert.equal(store.transfers[0].status, 'ready');
  });

  test('dark replay does not insert or CAS or POST', async () => {
    resetProductionMoovTokenCache();
    const store = createStore();
    grantStepUp(store);
    const first = await runContinue(store, continueBody());
    const second = await runContinue(store, continueBody());
    assert.equal(first.error, 'transfer_post_held');
    assert.equal(second.error, 'transfer_post_held');
    assert.equal(store.transfers.length, 1);
    assert.equal(store.transfers[0].status, 'ready');
    assert.equal(store.submittingUpdates, 0);
    assert.equal(store.transferPosts, 0);
    assert.equal(store.inserts, 0);
  });

  test('armed continue CAS-claims once with deterministic idempotency and no new row', async () => {
    resetProductionMoovTokenCache();
    const store = createStore();
    grantStepUp(store);
    const result = await runContinue(store, continueBody(), armedFlags);
    assert.equal(result.ok, true, result.error || JSON.stringify(result));
    assert.equal(result.casClaimed, true);
    assert.equal(result.duplicate, false);
    assert.equal(result.liveProviderCalled, true);
    assert.equal(result.providerIdempotencyKey, EXPECTED_PROVIDER_KEY);
    assert.equal(store.transferPosts, 1);
    assert.deepEqual(store.transferPostKeys, [EXPECTED_PROVIDER_KEY]);
    assert.equal(store.inserts, 0);
    assert.equal(store.transfers.length, 1);
    assert.equal(store.transfers[0].id, HELD_INTENT_ID);
    assert.equal(store.transfers[0].status, 'submitted');
    assert.equal(store.transfers[0].provider_transfer_id, 'tr_continue_1');
  });

  test('concurrent armed continue allows only one CAS winner and one POST', async () => {
    resetProductionMoovTokenCache();
    const store = createStore();
    grantStepUp(store);
    const waiters = [];
    store.onCasAttempt = () => new Promise((resolve) => {
      waiters.push(resolve);
      if (waiters.length >= 2) waiters.forEach((release) => release());
    });
    const [first, second] = await Promise.all([
      runContinue(store, continueBody(), armedFlags),
      runContinue(store, continueBody(), armedFlags),
    ]);
    const errors = [first, second].map((row) => row.error || (row.ok ? 'ok' : 'unknown')).sort();
    assert.equal(store.submittingUpdates, 2);
    assert.equal(store.transferPosts, 1);
    assert.equal(store.inserts, 0);
    assert.ok(errors.includes('ok'));
    assert.ok(errors.includes('cas_lost') || errors.includes('reconcile_existing_intent'));
    const submitted = store.transfers.filter((row) => row.provider_transfer_id === 'tr_continue_1');
    assert.equal(submitted.length, 1);
  });

  test('armed replay after submit returns existing state without a second POST', async () => {
    resetProductionMoovTokenCache();
    const store = createStore();
    grantStepUp(store);
    const first = await runContinue(store, continueBody(), armedFlags);
    const second = await runContinue(store, continueBody(), armedFlags);
    assert.equal(first.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.reconcile, true);
    assert.equal(store.transferPosts, 1);
    assert.equal(store.inserts, 0);
  });

  test('provider timeout marks unknown and never blind-retries POST', async () => {
    resetProductionMoovTokenCache();
    const store = createStore();
    grantStepUp(store);
    store.transferPostMode = 'timeout';
    const first = await runContinue(store, continueBody(), armedFlags);
    assert.equal(first.error, 'provider_outcome_unknown');
    assert.equal(store.transfers[0].status, 'unknown');
    assert.equal(store.transferPosts, 1);
    store.transferPostMode = 'ok';
    const second = await runContinue(store, continueBody(), armedFlags);
    assert.equal(second.duplicate, true);
    assert.equal(second.reconcile, true);
    assert.equal(store.transferPosts, 1);
    assert.equal(store.inserts, 0);
  });

  test('provider accepted but response lost reconciles without a second POST', async () => {
    resetProductionMoovTokenCache();
    const store = createStore();
    grantStepUp(store);
    store.transferPostMode = 'lost_response';
    const first = await runContinue(store, continueBody(), armedFlags);
    assert.equal(first.error, 'provider_outcome_unknown');
    assert.equal(store.moovAcceptedTransfers.length, 1);
    assert.equal(store.moovAcceptedTransfers[0].idempotencyKey, EXPECTED_PROVIDER_KEY);
    assert.equal(store.transfers[0].status, 'unknown');
    store.transferPostMode = 'ok';
    const second = await runContinue(store, continueBody(), armedFlags);
    assert.equal(second.duplicate, true);
    assert.equal(store.transferPosts, 1);
    assert.equal(store.inserts, 0);
  });
});
