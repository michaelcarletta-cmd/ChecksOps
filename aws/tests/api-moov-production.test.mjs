import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL } from '../functions/api/identity.mjs';
import { handler } from '../functions/api/index.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import { applyMoovWebhook } from '../functions/api/providers/webhook-apply.mjs';
import {
  FREEDOM_PRODUCTION_MOOV_ACCOUNT_ID,
  FREEDOM_PRODUCTION_TENANT_ID,
  productionMoovExecutionAllowed,
} from '../functions/api/providers/production/moov-holds.mjs';
import {
  evaluateMoovProductionAuthorization,
  stepUpMatchesDisbursement,
} from '../functions/api/providers/production/moov-authz.mjs';
import { handleProductionMoovDisbursement } from '../functions/api/providers/production/moov-submit.mjs';
import { resetProviderSecretsCache } from '../functions/api/provider-secrets.mjs';

const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const TRANSFER_ID = '11111111-1111-4111-8111-111111111111';
const BATCH_ID = '22222222-2222-4222-8222-222222222222';
const SPLIT_ID = '33333333-3333-4333-8333-333333333333';
const RECIPIENT_ID = '44444444-4444-4444-8444-444444444444';
const METHOD_ID = '55555555-5555-4555-8555-555555555555';
const WALLET_ID = '66666666-6666-4666-8666-666666666666';
const SOURCE_METHOD_ID = '77777777-7777-4777-8777-777777777777';
const AMOUNT_CENTS = 12500;

const mapping = {
  application_user_id: FREEDOM_APP,
  cognito_sub: COGNITO_SUB,
  email: 'owner@freedomadj.com',
  status: 'active',
};

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
  AWS_MOOV_TRANSFER_POST_ENABLED: 'true',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  AWS_CHECKALT_ENABLED: 'true',
  AWS_ENDORSEMENT_AUTO_ADVANCE: 'false',
  PROVIDER_SECRETS_ARN: 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/providers',
};

const productionSecrets = () => ({
  ok: true,
  credentials: {
    environment: 'production',
    publicKey: 'prod-public',
    secretKey: 'prod-secret',
    platformAccountId: FREEDOM_PRODUCTION_MOOV_ACCOUNT_ID,
  },
});

const createStore = ({
  role = 'admin',
  tenantId = FREEDOM_PRODUCTION_TENANT_ID,
  transferOverrides = {},
  methodOverrides = {},
  walletOverrides = {},
} = {}) => {
  const transfer = {
    id: TRANSFER_ID,
    tenant_id: tenantId,
    provider: 'moov',
    environment: 'production',
    status: 'ready',
    idempotency_key: 'existing-key',
    amount_cents: AMOUNT_CENTS,
    destination_recipient_id: RECIPIENT_ID,
    destination_payment_method_id: METHOD_ID,
    provider_transfer_id: null,
    provider_status: null,
    provider_metadata: { provider_http_attempted: false },
    check_id: null,
    ...transferOverrides,
  };
  return {
    role,
    memberships: [{ tenant_id: tenantId, role, tenant_name: 'Freedom', tenant_slug: 'freedom' }],
    transfers: [transfer],
    stepups: [],
    events: [],
    providerPosts: 0,
    lastProviderBody: null,
    providerResult: {
      transferID: 'moov-xfer-1',
      status: 'created',
    },
    providerError: null,
    tenant: {
      id: tenantId,
      moov_allowlisted: true,
      moov_environment: 'production',
    },
    account: {
      tenant_id: tenantId,
      provider: 'moov',
      environment: 'production',
      provider_account_id: FREEDOM_PRODUCTION_MOOV_ACCOUNT_ID,
      onboarding_status: 'active',
      can_send_payments: true,
      disabled: false,
      restricted: false,
    },
    recipient: {
      id: RECIPIENT_ID,
      tenant_id: tenantId,
      display_name: 'Michael Carletta',
      provider_account_id: 'dest-acct-1',
    },
    method: {
      id: METHOD_ID,
      tenant_id: tenantId,
      provider: 'moov',
      environment: 'production',
      provider_account_id: 'dest-acct-1',
      provider_payment_method_id: 'pm-dest-prod',
      connection_status: 'connected',
      external_recipient_id: RECIPIENT_ID,
      ...methodOverrides,
    },
    sourceMethod: {
      id: SOURCE_METHOD_ID,
      tenant_id: tenantId,
      provider: 'moov',
      environment: 'production',
      provider_account_id: FREEDOM_PRODUCTION_MOOV_ACCOUNT_ID,
      provider_payment_method_id: 'pm-source-prod',
      connection_status: 'connected',
    },
    wallet: {
      id: WALLET_ID,
      tenant_id: tenantId,
      provider: 'moov',
      environment: 'production',
      provider_account_id: FREEDOM_PRODUCTION_MOOV_ACCOUNT_ID,
      wallet_type: 'operating',
      provider_payment_method_id: 'pm-wallet-prod',
      available_cents: 0,
      ...walletOverrides,
    },
    batch: {
      id: BATCH_ID,
      tenant_id: tenantId,
      status: 'pending',
      approved_amount_cents: AMOUNT_CENTS,
      approved_at: new Date().toISOString(),
      delivery_speed: 'standard',
      check_intake_item_id: null,
    },
    splits: [{
      id: SPLIT_ID,
      amount: 125,
      status: 'pending',
      moov_transfer_id: null,
      stakeholder_account_id: RECIPIENT_ID,
      recipient_name: 'Michael Carletta',
      acct_id: METHOD_ID,
      provider: 'moov',
      provider_environment: 'production',
      provider_account_id: 'dest-acct-1',
      provider_payment_method_id: METHOD_ID,
    }],
  };
};

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
      return { rows: store.role === 'operator' || store.role === 'staff' ? [{ role: 'staff' }] : [{ role: 'admin' }] };
    }
    if (text.includes('FROM public.tenant_users WHERE user_id') && text.includes('AND tenant_id')) {
      const match = store.memberships.find((row) => row.tenant_id === params[1]);
      return { rows: match ? [{ role: match.role }] : [] };
    }
    if (text.includes('FROM public.tenants')) {
      return { rows: store.tenant.id === params[0] ? [store.tenant] : [] };
    }
    if (text.includes('FROM public.payment_provider_accounts')) {
      return { rows: store.account.tenant_id === params[0] ? [store.account] : [] };
    }
    if (text.includes('FROM public.payment_wallets')) {
      return { rows: [store.wallet] };
    }
    if (text.includes('FROM public.external_payment_recipients')) {
      return { rows: params[0] === store.recipient.id && params[1] === store.recipient.tenant_id ? [store.recipient] : [] };
    }
    if (text.includes('FROM public.payment_provider_methods') && text.includes('WHERE id =')) {
      const found = [store.method, store.sourceMethod].find((row) => row.id === params[0]);
      return { rows: found ? [found] : [] };
    }
    if (text.includes('FROM public.payment_provider_methods') && text.includes('external_recipient_id')) {
      return { rows: store.method.external_recipient_id === params[0] ? [store.method] : [] };
    }
    if (text.includes('FROM public.payment_provider_methods')) {
      if (params[0] === store.account.tenant_id && params[2] === store.account.provider_account_id) {
        return { rows: [store.sourceMethod] };
      }
      return { rows: [store.method] };
    }
    if (text.includes('FROM public.disbursement_batches')) {
      return { rows: params[0] === store.batch.id ? [store.batch] : [] };
    }
    if (text.includes('FROM public.disbursement_splits')) {
      return { rows: store.splits };
    }
    if (text.includes('FROM public.financial_stepup_log')) {
      return {
        rows: store.stepups.filter((row) => (
          row.user_id === params[0]
          && row.tenant_id === params[1]
          && row.action_key === params[2]
          && row.succeeded === true
          && Number(row.metadata?.amount_cents) === Number(params[4])
        )),
      };
    }
    if (text.includes('FROM public.payment_transfers') && text.includes('idempotency_key')) {
      const found = store.transfers.find((row) => row.tenant_id === params[0] && row.idempotency_key === params[1]);
      return { rows: found ? [found] : [] };
    }
    if (text.includes('FROM public.payment_transfers')) {
      const found = store.transfers.find((row) => row.id === params[0]);
      return { rows: found ? [found] : [] };
    }
    if (text.includes('INSERT INTO public.payment_transfers')) {
      if (store.transfers.some((row) => row.idempotency_key === params[2] && row.tenant_id === params[0])) {
        const error = new Error('duplicate key');
        error.code = '23505';
        throw error;
      }
      const row = {
        id: crypto.randomUUID(),
        tenant_id: params[0],
        environment: params[1],
        status: 'ready',
        idempotency_key: params[2],
        amount_cents: params[3],
        provider_transfer_id: null,
        provider_metadata: { provider_http_attempted: false },
      };
      store.transfers.push(row);
      return { rows: [row] };
    }
    if (text.includes('UPDATE public.payment_transfers') && text.includes("status = 'submitting'")) {
      const row = store.transfers.find((item) => item.id === params[0]);
      if (!row || row.provider_transfer_id || !['ready', 'queued', 'draft'].includes(row.status)) {
        return { rows: [] };
      }
      row.status = 'submitting';
      row.provider_metadata = { provider_http_attempted: true };
      row.provider_http_attempted_at = new Date().toISOString();
      return { rows: [row] };
    }
    if (text.includes('UPDATE public.payment_transfers')) {
      const row = store.transfers.find((item) => item.id === params[0]);
      if (!row) return { rows: [] };
      row.status = params[1];
      if (params[2]) row.provider_transfer_id = params[2];
      if (params[3]) row.provider_status = params[3];
      if (params[4]) row.failure_reason = params[4];
      return { rows: [row] };
    }
    if (text.includes('UPDATE public.disbursement_splits')) {
      const split = store.splits.find((item) => item.id === params[0]);
      if (split && !split.moov_transfer_id) {
        split.moov_transfer_id = params[1];
        split.moov_status = params[2];
        split.status = params[3];
      }
      return { rows: split ? [split] : [] };
    }
    if (text.includes('INSERT INTO public.payment_event_log')) {
      store.events.push(params);
      return { rows: [] };
    }
    return { rows: [] };
  },
});

const fetchImpl = (store) => async (url, options = {}) => {
  const target = String(url);
  if (target.includes('/oauth2/token')) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: 'tok', expires_in: 300 }),
    };
  }
  if (target.includes('/transfers') && String(options.method || 'GET').toUpperCase() === 'POST') {
    store.providerPosts += 1;
    store.lastProviderBody = options.body ? JSON.parse(options.body) : null;
    if (store.providerError) {
      const error = store.providerError;
      store.providerError = null;
      throw error;
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(store.providerResult),
    };
  }
  return { ok: true, status: 200, text: async () => '[]' };
};

const grantStepUp = (store, extra = {}) => {
  store.stepups.push({
    id: crypto.randomUUID(),
    user_id: FREEDOM_APP,
    tenant_id: store.tenant.id,
    action_key: 'disbursement.send',
    succeeded: true,
    created_at: new Date().toISOString(),
    metadata: {
      transfer_id: extra.transferId === undefined ? TRANSFER_ID : extra.transferId,
      batch_id: extra.batchId || null,
      disbursement_id: extra.transferId === undefined ? TRANSFER_ID : extra.transferId,
      amount_cents: extra.amountCents === undefined ? AMOUNT_CENTS : extra.amountCents,
      destination_id: extra.destinationId === undefined ? RECIPIENT_ID : extra.destinationId,
      operation: extra.operation || 'disbursement.send',
      source: 'app_financial_totp',
    },
  });
};

const runOnce = (store, body = { transfer_id: TRANSFER_ID }, extra = {}) => (
  withEnv(productionFlags, () => {
    resetProviderSecretsCache();
    return handleProductionMoovDisbursement({
      client: identityClient(store),
      mapping,
      claims: { sub: COGNITO_SUB, email: 'owner@freedomadj.com' },
      body,
      spoof: {},
      fetchImpl: extra.fetchImpl || fetchImpl(store),
      deps: { loadProductionSecrets: async () => productionSecrets() },
    });
  })
);

test('production Moov flags stay fail-closed by default', () => {
  assert.equal(productionMoovExecutionAllowed(), false);
});

test('Moov disabled → fail closed', async () => {
  const result = await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: 'true',
    AWS_MOOV_ENABLED: 'false',
    AWS_MOOV_TRANSFER_POST_ENABLED: 'false',
  }, async () => {
    const response = await handler(jwtEvent('/functions/v1/moov-transfer-create', 'POST', { amount_cents: 100 }));
    return JSON.parse(response.body);
  });
  assert.equal(result.error, 'provider_disabled');
  assert.notEqual(result.liveProviderCalled, true);
  assert.notEqual(result.ok, true);
});

test('transfer-post disabled → fail closed', async () => {
  const result = await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: 'true',
    AWS_MOOV_ENABLED: 'true',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
    AWS_MOOV_TRANSFER_POST_ENABLED: 'false',
  }, async () => {
    const response = await handler(jwtEvent('/functions/v1/moov-transfer-create', 'POST', { transfer_id: TRANSFER_ID }));
    return JSON.parse(response.body);
  });
  assert.equal(result.error, 'production_execution_blocked');
  assert.equal(result.tranche4HardBlock, true);
  assert.equal(result.liveProviderCalled, false);
});

test('wrong tenant → denied', async () => {
  const store = createStore({ tenantId: C1C_TENANT });
  store.tenant.moov_environment = 'production';
  grantStepUp(store);
  const result = await runOnce(store);
  assert.equal(result.error, 'cross_tenant_denied');
  assert.equal(store.providerPosts, 0);
});

test('wrong role → denied', async () => {
  const store = createStore({ role: 'operator' });
  grantStepUp(store);
  const result = await runOnce(store);
  assert.equal(result.error, 'financial_unauthorized');
  assert.equal(store.providerPosts, 0);
});

test('stale/missing TOTP → denied', async () => {
  const store = createStore();
  const result = await runOnce(store);
  assert.equal(result.error, 'step_up_required');
  assert.equal(store.providerPosts, 0);
});

test('TOTP for different operation → denied', async () => {
  const store = createStore();
  grantStepUp(store, { operation: 'deposit.submit' });
  store.stepups[0].action_key = 'deposit.submit';
  const result = await runOnce(store);
  assert.equal(result.error, 'step_up_required');
  assert.equal(store.providerPosts, 0);
});

test('TOTP for different amount → denied', async () => {
  const store = createStore();
  grantStepUp(store, { amountCents: 1 });
  const result = await runOnce(store);
  assert.equal(result.error, 'step_up_required');
  assert.equal(store.providerPosts, 0);
});

test('TOTP for different destination → denied', async () => {
  const store = createStore();
  grantStepUp(store, { destinationId: '99999999-9999-4999-8999-999999999999' });
  const result = await runOnce(store);
  assert.equal(result.error, 'step_up_required');
  assert.equal(store.providerPosts, 0);
});

test('browser amount tampering is ignored in favor of server amount', async () => {
  const store = createStore();
  grantStepUp(store);
  const result = await runOnce(store, { transfer_id: TRANSFER_ID, amount_cents: 1 });
  assert.equal(result.error, 'amount_mismatch');
  assert.equal(store.providerPosts, 0);
});

test('browser destination tampering → denied', async () => {
  const store = createStore();
  grantStepUp(store);
  const result = await runOnce(store, {
    transfer_id: TRANSFER_ID,
    external_recipient_id: '99999999-9999-4999-8999-999999999999',
  });
  assert.equal(result.error, 'destination_tamper');
  assert.equal(store.providerPosts, 0);
});

test('sandbox method in production → denied', async () => {
  const store = createStore({ methodOverrides: { environment: 'sandbox', provider_payment_method_id: 'pm-sandbox' } });
  grantStepUp(store);
  const result = await runOnce(store);
  assert.equal(result.error, 'sandbox_method_refused');
  assert.equal(store.providerPosts, 0);
});

test('missing production method → denied', async () => {
  const store = createStore({ methodOverrides: { provider_payment_method_id: null } });
  grantStepUp(store);
  const result = await runOnce(store);
  assert.equal(result.error, 'production_method_missing');
  assert.equal(store.providerPosts, 0);
});

test('duplicate idempotency key and existing provider reference do not create a second transfer', async () => {
  const store = createStore();
  grantStepUp(store);
  const first = await runOnce(store);
  assert.equal(first.ok, true);
  assert.equal(first.provider_transfer_id, 'moov-xfer-1');
  assert.equal(store.providerPosts, 1);
  const second = await runOnce(store);
  assert.equal(second.duplicate, true);
  assert.equal(second.liveProviderCalled, false);
  assert.equal(store.providerPosts, 1);
});

test('existing provider reference prevents another create', async () => {
  const store = createStore({
    transferOverrides: {
      provider_transfer_id: 'already-there',
      status: 'submitted',
      provider_metadata: { provider_http_attempted: true },
    },
  });
  grantStepUp(store);
  const result = await runOnce(store);
  assert.equal(result.duplicate, true);
  assert.equal(result.provider_transfer_id, 'already-there');
  assert.equal(store.providerPosts, 0);
});

test('simulated provider failure does not mark local success', async () => {
  const store = createStore();
  grantStepUp(store);
  store.providerError = new Error('moov_unavailable');
  const result = await runOnce(store);
  assert.equal(result.ok, false);
  assert.equal(result.success, false);
  assert.equal(store.transfers[0].status, 'failed');
  assert.ok(!store.transfers[0].provider_transfer_id);
});

test('simulated provider success persists reference and status', async () => {
  const store = createStore();
  grantStepUp(store);
  const result = await runOnce(store);
  assert.equal(result.ok, true);
  assert.equal(result.productionExecution, true);
  assert.equal(result.provider_transfer_id, 'moov-xfer-1');
  assert.equal(result.provider_status, 'created');
  assert.equal(store.transfers[0].provider_transfer_id, 'moov-xfer-1');
  assert.equal(store.transfers[0].status, 'submitted');
  assert.equal(store.lastProviderBody.amount.value, AMOUNT_CENTS);
});

test('HTTP without a documented provider transfer id is not success', async () => {
  const store = createStore();
  grantStepUp(store);
  store.providerResult = { status: 'unknown' };
  const result = await runOnce(store);
  assert.equal(result.error, 'provider_result_unsuccessful');
  assert.equal(store.transfers[0].status, 'failed');
});

test('webhook apply still skips production rows and can look up provider_transfer_id later', async () => {
  const store = createStore({
    transferOverrides: {
      provider_transfer_id: 'moov-xfer-1',
      status: 'submitted',
    },
  });
  const client = {
    query: async (sql, params = []) => {
      const text = String(sql);
      if (text.includes("set_config")) return { rows: [] };
      if (text.includes("environment = 'sandbox'")) return { rows: [] };
      if (text.includes("environment = 'production'")) {
        return { rows: [{ id: store.account.provider_account_id, environment: 'production' }] };
      }
      if (text.includes('FROM public.payment_transfers')) {
        return { rows: store.transfers.filter((row) => row.provider_transfer_id === params[0] && row.environment === 'production') };
      }
      return { rows: [] };
    },
  };
  const skipped = await applyMoovWebhook(client, {
    type: 'transfer.completed',
    accountID: FREEDOM_PRODUCTION_MOOV_ACCOUNT_ID,
    data: { transferID: 'moov-xfer-1', status: 'completed' },
  });
  assert.equal(skipped.skipped, 'production_environment_row');
  assert.equal(skipped.financialTablesMutated, false);
  const lookup = store.transfers.find((row) => row.provider_transfer_id === 'moov-xfer-1');
  assert.equal(lookup.environment, 'production');
});

test('step-up binding rejects another amount or destination', () => {
  const row = {
    tenant_id: FREEDOM_PRODUCTION_TENANT_ID,
    action_key: 'disbursement.send',
    succeeded: true,
    metadata: {
      transfer_id: TRANSFER_ID,
      amount_cents: AMOUNT_CENTS,
      destination_id: RECIPIENT_ID,
      operation: 'disbursement.send',
    },
  };
  assert.equal(stepUpMatchesDisbursement(row, {
    tenantId: FREEDOM_PRODUCTION_TENANT_ID,
    transferId: TRANSFER_ID,
    amountCents: AMOUNT_CENTS,
    destinationId: RECIPIENT_ID,
  }), true);
  assert.equal(stepUpMatchesDisbursement(row, {
    tenantId: FREEDOM_PRODUCTION_TENANT_ID,
    transferId: TRANSFER_ID,
    amountCents: 1,
    destinationId: RECIPIENT_ID,
  }), false);
  assert.equal(evaluateMoovProductionAuthorization({
    identityOk: true,
    membershipOk: true,
    roles: ['admin'],
    totpOk: true,
    flagsOk: false,
    tenantOk: true,
    accountOk: true,
  }).canExecuteProductionMoov, false);
});

test('disburse batch path uses server-approved amount', async () => {
  const store = createStore({ transferOverrides: { id: 'not-used' } });
  store.transfers = [];
  grantStepUp(store, { transferId: BATCH_ID, batchId: BATCH_ID });
  const result = await runOnce(store, { batch_id: BATCH_ID });
  assert.equal(result.ok, true);
  assert.equal(result.amount_cents, AMOUNT_CENTS);
  assert.equal(store.providerPosts, 1);
  assert.equal(store.splits[0].moov_transfer_id, 'moov-xfer-1');
});

test('routing still uses the dedicated production handler and does not fall through to sandbox', async () => {
  const routed = await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: 'true',
    AWS_MOOV_ENABLED: 'true',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
    AWS_MOOV_TRANSFER_POST_ENABLED: 'false',
  }, () => handleProviderRequest(
    jwtEvent('/functions/v1/moov-disburse', 'POST', { batch_id: BATCH_ID }),
    '/functions/v1/moov-disburse',
    'POST',
  ));
  assert.equal(routed.error, 'production_execution_blocked');
  assert.equal(routed.provider, 'moov');
});
