import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GIT_API_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../functions/api');
const API_ROOT = process.env.M75B1_LIVE_LAMBDA_ROOT || GIT_API_ROOT;

const [{ handleProductionMoovWalletFund }, { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL }, { KNOWN_APPROVED_MOOV }, { loadProductionMoovReadSecrets }, { resetProductionMoovTokenCache }, idempotency, sequenceAuthz, firstTest] = await Promise.all([
  import(`${API_ROOT}/providers/production/moov-wallet-fund.mjs`),
  import(`${API_ROOT}/identity.mjs`),
  import(`${API_ROOT}/providers/production/moov-accounts.mjs`),
  import(`${API_ROOT}/providers/production/moov-secrets.mjs`),
  import(`${API_ROOT}/providers/production/moov-http.mjs`),
  import(`${API_ROOT}/providers/production/moov-idempotency.mjs`),
  import(`${API_ROOT}/providers/production/moov-sequence-authz.mjs`),
  import(`${API_ROOT}/providers/production/moov-first-test.mjs`),
]);

const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const FREEDOM_TENANT = KNOWN_APPROVED_MOOV.freedom.tenantId;
const LOCAL_BANK_METHOD_ID = '55555555-6666-4777-8888-999999999901';
const LOCAL_WALLET_ROW_ID = '55555555-6666-4777-8888-999999999902';
const MOOV_IDS = KNOWN_APPROVED_MOOV.freedom;

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

const productionSecrets = {
  MOOV_PUBLIC_KEY: 'pk_live_test',
  MOOV_SECRET_KEY: 'sk_live_test',
  MOOV_ENVIRONMENT: 'production',
  MOOV_ALLOWED_ORIGIN: 'https://checksops.com',
};

const fkError = (constraint) => {
  const error = new Error(`insert or update on table "payment_transfers" violates foreign key constraint "${constraint}"`);
  error.code = '23503';
  error.constraint = constraint;
  return error;
};

const createStore = () => ({
  memberships: [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  stepups: [],
  transfers: [],
  queries: [],
  submittingUpdates: 0,
  checkaltQueries: 0,
  plaidQueries: 0,
  supabaseQueries: 0,
  role: 'admin',
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

const grantStepUp = (store) => {
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
    if (text === LOOKUP_MAPPING_SQL) {
      return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
    }
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
      const methodIds = new Set(store.methods.map((row) => row.id));
      const walletIds = new Set(store.wallets.map((row) => row.id));
      if (params[5] && !methodIds.has(params[5])) throw fkError('payment_transfers_source_payment_method_id_fkey');
      if (params[8] && !walletIds.has(params[8]) && !methodIds.has(params[8])) {
        throw fkError('payment_transfers_destination_payment_method_id_fkey');
      }
      if (params[9] && !walletIds.has(params[9])) throw fkError('payment_transfers_wallet_id_fkey');
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
      store.submittingUpdates += 1;
      const row = store.transfers.find((item) => item.id === params[0] && item.status === 'ready' && !item.provider_transfer_id);
      if (!row) return { rows: [] };
      row.status = 'submitting';
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

const mockMoovFetch = (store) => {
  store.moovCalls = [];
  store.transferPosts = 0;
  store.capabilityPosts = 0;
  store.sweepWrites = 0;
  store.checkaltHttp = 0;
  store.plaidHttp = 0;
  store.supabaseHttp = 0;
  return async (url, options = {}) => {
    const target = String(url);
    const method = String(options.method || 'GET').toUpperCase();
    store.moovCalls.push({ method, url: target });
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
      return jsonResponse({ transferID: 'tr_must_not_create', status: 'pending' });
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

const runDarkFund = (store, body) => withEnv(darkFlags, () => handleProductionMoovWalletFund({
  client: identityClient(store),
  mapping,
  claims: { sub: COGNITO_SUB, email: mapping.email },
  body,
  spoof: {},
  fetchImpl: mockMoovFetch(store),
  deps: { loadProductionSecrets: async () => loadProductionMoovReadSecrets(async () => productionSecrets) },
}));

describe('M7.5B.1 dark wallet.fund validation', { concurrency: 1 }, () => {
  test('live-compatible module graph exports TOTP actions and idempotency helpers', () => {
    assert.equal(firstTest.MOOV_FUND_TOTP_ACTION, 'wallet.fund');
    assert.equal(firstTest.MOOV_DISBURSE_TOTP_ACTION, 'wallet.disburse');
    assert.equal(sequenceAuthz.MOOV_FUND_TOTP_ACTION, 'wallet.fund');
    assert.equal(sequenceAuthz.MOOV_DISBURSE_TOTP_ACTION, 'wallet.disburse');
    for (const name of [
      'bindMoovProductionGucs',
      'resolveLocalFundIntentRefs',
      'resolveLocalDisburseIntentRefs',
      'productionTransferInsertFkError',
      'insertProductionTransferDraft',
      'casMarkSubmitting',
      'existingProductionTransferByKey',
    ]) {
      assert.equal(typeof idempotency[name], 'function', `missing export ${name}`);
    }
    if (process.env.M75B1_LIVE_LAMBDA_ROOT) {
      for (const name of [
        'insertQueuedTransfer',
        'markHttpAttempted',
        'providerIdempotencyKeyFromIntent',
        'persistPollOutcome',
        'replayTransferResponse',
        'loadTransferById',
      ]) {
        assert.equal(typeof idempotency[name], 'function', `live package missing export ${name}`);
      }
    }
  });

  test('mocked Financial TOTP dark path inserts local FKs and holds provider POST', async () => {
    resetProductionMoovTokenCache();
    const store = createStore();
    grantStepUp(store);
    const result = await runDarkFund(store, {
      tenant_id: FREEDOM_TENANT,
      amount_cents: 1,
      idempotency_key: 'm75b1-dark-fund-1',
    });

    assert.equal(result.error, 'transfer_post_held', result.error || JSON.stringify(result));
    assert.equal(result.statusCode, 403);
    assert.equal(result.darkMode, true);
    assert.equal(result.liveProviderCalled, false);
    assert.equal(result.productionExecution, false);
    assert.notEqual(result.error, 'data_query_failed');
    assert.equal(store.transfers.length, 1);

    const draft = store.transfers[0];
    assert.equal(draft.status, 'ready');
    assert.equal(draft.source_payment_method_id, LOCAL_BANK_METHOD_ID);
    assert.equal(draft.wallet_id, LOCAL_WALLET_ROW_ID);
    assert.equal(draft.destination_payment_method_id, null);
    assert.notEqual(draft.source_payment_method_id, MOOV_IDS.achDebitFundPm);
    assert.notEqual(draft.wallet_id, MOOV_IDS.walletId);
    assert.equal(draft.amount_cents, 1);
    assert.equal(draft.created_by, FREEDOM_APP);
    assert.equal(draft.idempotency_key, 'm75b1-dark-fund-1');

    assert.equal(store.submittingUpdates, 0);
    assert.equal(store.transferPosts, 0);
    assert.equal(store.capabilityPosts, 0);
    assert.equal(store.sweepWrites, 0);
    assert.equal(store.checkaltHttp, 0);
    assert.equal(store.plaidHttp, 0);
    assert.equal(store.supabaseHttp, 0);
    assert.equal(store.checkaltQueries, 0);
    assert.equal(store.plaidQueries, 0);
    assert.equal(store.supabaseQueries, 0);
    assert.ok(!store.moovCalls.some((call) => call.method === 'POST' && /\/transfers$/.test(call.url)));
    assert.ok(store.queries.some((sql) => sql.includes('FROM public.tenant_users')));
    assert.ok(store.queries.some((sql) => sql.includes('FROM public.financial_stepup_log')));
    assert.ok(store.queries.some((sql) => sql.includes('FROM public.payment_provider_methods')));
    assert.ok(store.queries.some((sql) => sql.includes('FROM public.payment_wallets')));
  });

  test('repeat idempotency key does not insert a second dark intent or POST', async () => {
    resetProductionMoovTokenCache();
    const store = createStore();
    grantStepUp(store);
    const first = await runDarkFund(store, {
      tenant_id: FREEDOM_TENANT,
      amount_cents: 1,
      idempotency_key: 'm75b1-dark-fund-dup',
    });
    const second = await runDarkFund(store, {
      tenant_id: FREEDOM_TENANT,
      amount_cents: 1,
      idempotency_key: 'm75b1-dark-fund-dup',
    });
    assert.equal(first.error, 'transfer_post_held');
    assert.equal(second.duplicate, true);
    assert.equal(second.ok, true);
    assert.equal(store.transfers.length, 1);
    assert.equal(store.transferPosts, 0);
    assert.equal(store.submittingUpdates, 0);
  });

  test('Moov payment-method IDs still fail the FK mock the way production failed before the local-ref fix', async () => {
    const store = createStore();
    const client = identityClient(store);
    await assert.rejects(
      () => client.query(
        `INSERT INTO public.payment_transfers
          (tenant_id, provider, environment, status, idempotency_key, amount_cents,
           platform_fee_cents, net_amount_cents, speed, description,
           source_tenant_account_id, source_payment_method_id,
           destination_tenant_id, destination_recipient_id, destination_payment_method_id,
           wallet_id, leg_role, created_by)
         VALUES ($1::uuid, 'moov', 'production', 'ready', $2, $3, 0, $3, 'standard', $4,
                 $5, $6, $7, $8, $9, $10, $11, $12::uuid)`,
        [
          FREEDOM_TENANT,
          'legacy-moov-ids',
          1,
          'bad',
          MOOV_IDS.moovAccountId,
          MOOV_IDS.achDebitFundPm,
          FREEDOM_TENANT,
          null,
          null,
          MOOV_IDS.walletId,
          'wallet_funding',
          FREEDOM_APP,
        ],
      ),
      (error) => error.constraint === 'payment_transfers_source_payment_method_id_fkey'
        && idempotency.productionTransferInsertFkError(error) === true,
    );
    assert.equal(store.transfers.length, 0);
  });
});
