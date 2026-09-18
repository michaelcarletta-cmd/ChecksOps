import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handler } from '../functions/api/index.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import {
  denyProviderExecution,
  executionAllowed,
  flagSnapshot,
  providerEnabled,
  providerExecutionEnabled,
  providerWebhookDryRun,
} from '../functions/api/provider-flags.mjs';
import { PROVIDER_EXECUTION_PERMISSIONS } from '../functions/api/provider-authz.mjs';
import { FUNCTION_BY_NAME, PROVIDER_FUNCTIONS, classifyFunction } from '../functions/api/providers/catalog.mjs';
import { dollarsToIntegerCents, extractFinCaptureDepositDate, formatCheckAltUserAmount, mapCheckAltStatus } from '../functions/api/providers/amounts.mjs';
import { hmacHex, safeEqual, verifyHmacBodySignature, verifyMoovSignature } from '../functions/api/providers/hmac.mjs';
import { evaluateReadiness } from '../functions/api/providers/readiness.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import { sanitizeWebhookPayload } from '../functions/api/providers/webhooks.mjs';

const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const SPOOF_ID = '00000000-0000-0000-0000-000000000099';
const NINTH = 'dd24eea5-5d12-47d1-999e-d5930c278b7d';
const MOOV_ACCOUNT = 'moov-acct-freedom';
const WALLET_ID = '11111111-1111-4111-8111-111111111111';

const jwtEvent = (path, method, body, extra = {}) => ({
  rawPath: path,
  headers: {
    authorization: extra.auth === null ? undefined : 'Bearer test-id-token',
    'x-user-id': SPOOF_ID,
    'x-tenant-id': C1C_TENANT,
    'x-role': 'admin',
    ...(extra.headers || {}),
  },
  queryStringParameters: { user_id: SPOOF_ID, tenant_id: C1C_TENANT, ...(extra.query || {}) },
  body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
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

const mockClient = ({
  mapping = mappingFor(),
  accounts = [{
    id: 'acct-1',
    tenant_id: FREEDOM_TENANT,
    provider: 'moov',
    provider_account_id: MOOV_ACCOUNT,
    environment: 'sandbox',
    account_type: 'business',
    onboarding_status: 'complete',
    verification_status: 'verified',
    tos_accepted_at: '2024-01-01T00:00:00Z',
    tos_source: 'hosted',
    can_send_payments: true,
    can_receive_payments: true,
    can_ach_credit: true,
    can_ach_debit: false,
    disabled: false,
    restricted: false,
    fee_plan_code: 'standard',
    display_name: 'Freedom',
    last_synced_at: '2024-01-01T00:00:00Z',
    capabilities: [
      { capability: 'send-funds.ach', status: 'enabled' },
      { capability: 'collect-funds.ach', status: 'enabled' },
      { capability: 'wallet.balance', status: 'enabled' },
    ],
    readiness: {},
    provider_metadata: { banks: [{ status: 'verified' }] },
  }],
  wallets = [{
    id: WALLET_ID,
    tenant_id: FREEDOM_TENANT,
    provider: 'moov',
    provider_wallet_id: 'wallet-freedom',
    provider_account_id: MOOV_ACCOUNT,
    wallet_type: 'default',
    status: 'active',
    available_cents: 0,
    pending_cents: 0,
    currency: 'USD',
    environment: 'sandbox',
    last_synced_at: null,
  }],
  transfers = [],
  checkaltAccounts = [{
    id: 'ca-1',
    tenant_id: FREEDOM_TENANT,
    enabled: true,
    registered_at: '2024-01-01T00:00:00Z',
    auto_approve_enabled: false,
    deposit_account_number: '****',
    sso_user_id: 'sso-1',
  }],
  deposits = [],
  memberships = [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  receipts = [],
  throwOn = null,
} = {}) => {
  const queries = [];
  const store = [...receipts];
  return {
    queries,
    store,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (throwOn && String(sql).includes(throwOn)) {
        const error = new Error('synthetic provider failure');
        error.code = '40001';
        throw error;
      }
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT' || sql === 'SET TRANSACTION READ WRITE') {
        return { rows: [] };
      }
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: params[0] === mapping.cognito_sub ? [mapping] : [] };
      }
      if (sql.includes('FROM public.tenant_users')) {
        return { rows: memberships };
      }
      if (sql.includes('FROM public.payment_provider_accounts')) {
        const wanted = params[0];
        return { rows: wanted ? accounts.filter((row) => row.provider_account_id === wanted) : accounts };
      }
      if (sql.includes('FROM public.payment_wallets')) {
        if (params[0] && sql.includes('id =')) return { rows: wallets.filter((row) => row.id === params[0]) };
        if (params[0] && sql.includes('provider_wallet_id')) {
          return { rows: wallets.filter((row) => row.provider_wallet_id === params[0]) };
        }
        return { rows: wallets };
      }
      if (sql.includes('FROM public.payment_transfers')) {
        return { rows: transfers };
      }
      if (sql.includes('FROM public.checkalt_tenant_accounts')) {
        return { rows: checkaltAccounts };
      }
      if (sql.includes('FROM public.checkalt_deposits')) {
        if (params[0] && sql.includes('id =')) return { rows: deposits.filter((row) => row.id === params[0]) };
        if (params[0] && sql.includes('checkalt_reference')) {
          return { rows: deposits.filter((row) => row.checkalt_reference === params[0]) };
        }
        return { rows: deposits };
      }
      if (sql.includes('FROM public.disbursement_splits')) {
        return { rows: [] };
      }
      if (sql.includes('aws_lookup_provider_account')) {
        const match = accounts.find((row) => row.provider === params[0] && row.provider_account_id === params[1]);
        return { rows: match ? [match] : [] };
      }
      if (sql.includes('aws_lookup_checkalt_deposit')) {
        const match = deposits.find((row) => row.checkalt_reference === params[0]);
        return { rows: match ? [match] : [] };
      }
      if (sql.includes('INSERT INTO public.aws_provider_webhook_receipts')) {
        const existing = store.find((row) => row.provider === params[0] && row.external_event_id === params[1]);
        if (existing) return { rows: [] };
        const row = {
          id: `receipt-${store.length + 1}`,
          provider: params[0],
          external_event_id: params[1],
          dry_run: params[6],
          received_at: new Date().toISOString(),
        };
        store.push(row);
        return { rows: [row] };
      }
      if (sql.includes('FROM public.aws_provider_webhook_receipts')) {
        return { rows: store.filter((row) => row.provider === params[0] && row.external_event_id === params[1]) };
      }
      return { rows: [] };
    },
  };
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

test('provider flags default false and fail closed', () => {
  return withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: undefined,
    AWS_MOOV_ENABLED: undefined,
    AWS_CHECKALT_ENABLED: 'false',
  }, () => {
    assert.equal(providerExecutionEnabled(), false);
    assert.equal(providerEnabled('moov'), false);
    assert.equal(executionAllowed('moov'), false);
    assert.equal(providerWebhookDryRun(), true);
    const denied = denyProviderExecution('moov', 'moov-transfer-create');
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.error, 'provider_disabled');
    const snap = flagSnapshot();
    assert.equal(snap.AWS_PROVIDER_EXECUTION_ENABLED, false);
    assert.equal(snap.AWS_MOOV_ENABLED, false);
  });
});

test('inventory classifies every provider function', () => {
  assert.ok(PROVIDER_FUNCTIONS.length >= 60);
  assert.equal(classifyFunction('moov-readiness').aws, 'sandbox_parity');
  assert.equal(classifyFunction('moov-transfer-create').aws, 'sandbox_parity');
  assert.equal(classifyFunction('checkalt-submit-deposit').class, 5);
  assert.equal(classifyFunction('plaid-disburse').class, 7);
  assert.equal(FUNCTION_BY_NAME['moov-webhook'].aws, 'webhook');
  for (const name of ['deposit_submission', 'disbursement', 'ach', 'rtp', 'wallet_transfer', 'stakeholder_payment', 'provider_configuration']) {
    assert.equal(PROVIDER_EXECUTION_PERMISSIONS[name].activated, false);
  }
});

test('CheckAlt integer-cents formatting', () => {
  assert.equal(formatCheckAltUserAmount(123.45).userAmount, 12345);
  assert.equal(formatCheckAltUserAmount('780.00').userAmount, 78000);
  assert.equal(dollarsToIntegerCents(0.1).cents, 10);
  assert.equal(mapCheckAltStatus({ statusCode: 40 }), 'pending_approval');
  assert.equal(mapCheckAltStatus({ statusCode: 127 }), 'submitted');
  assert.equal(mapCheckAltStatus({ status: 'Approved' }), 'submitted');
  assert.equal(mapCheckAltStatus({ status: 'cleared', depositDate: '2026-09-16' }), 'cleared');
  assert.equal(mapCheckAltStatus({ status: 'cleared' }), 'submitted');
  assert.equal(mapCheckAltStatus({ statusCode: 120 }), 'rejected');
  assert.equal(mapCheckAltStatus({ statusCode: 200, depositDate: '2026-09-16' }), 'cleared');
  assert.equal(mapCheckAltStatus({ statusCode: 200 }), 'submitted');
});

test('FinCapture depositDate is extracted and submittedDate is ignored', () => {
  assert.equal(extractFinCaptureDepositDate({ depositDate: '2026-09-16' }), '2026-09-16T12:00:00.000Z');
  assert.equal(
    extractFinCaptureDepositDate({ status: 'cleared', history: { depositDate: '2026-09-16' } }),
    '2026-09-16T12:00:00.000Z',
  );
  assert.equal(extractFinCaptureDepositDate({ submittedDate: '2026-09-01', createdDate: '2026-09-02' }), null);
  assert.equal(extractFinCaptureDepositDate({ DepositDate: '09/16/2026' }), '2026-09-16T12:00:00.000Z');
});

test('Moov readiness is local-only and does not claim live provider state', () => {
  const ready = evaluateReadiness({
    environment: 'sandbox',
    accountId: 'acct',
    capabilities: [
      { capability: 'send-funds.ach', status: 'enabled' },
      { capability: 'collect-funds.ach', status: 'enabled' },
    ],
    banks: [{ status: 'verified' }],
    verificationStatus: 'verified',
    termsAccepted: true,
    feePlanCode: 'standard',
  });
  assert.equal(ready.canMoveMoney, true);
  assert.equal(ready.liveProviderCalled, false);
  assert.equal(ready.source, 'local_snapshot');
  const empty = evaluateReadiness({
    environment: 'sandbox',
    accountId: null,
    capabilities: [],
    banks: [],
    termsAccepted: false,
  });
  assert.equal(empty.overall, 'not_started');
  assert.equal(empty.canMoveMoney, false);
});

test('Moov webhook signature accepts SHA512 and rejects invalid/replay', () => {
  const secret = 'staging-webhook-secret';
  const webhookId = 'evt_1';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'n1';
  const rawBody = JSON.stringify({ eventID: webhookId, type: 'account.updated', accountID: MOOV_ACCOUNT });
  const signature = hmacHex(secret, `${timestamp}|${nonce}|${webhookId}`, 'sha512');
  const event = jwtEvent('/webhooks/moov', 'POST', rawBody, {
    auth: null,
    headers: {
      'x-webhook-id': webhookId,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signature,
    },
  });
  const ok = verifyMoovSignature({ event, rawBody, secret });
  assert.equal(ok.ok, true);
  const bad = verifyMoovSignature({
    event: { ...event, headers: { ...event.headers, 'x-signature': 'deadbeef' } },
    rawBody,
    secret,
  });
  assert.equal(bad.ok, false);
  const replay = verifyMoovSignature({
    event,
    rawBody,
    secret,
    nowMs: Date.now() + 10 * 60 * 1000,
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'timestamp_outside_window');
});

test('generic HMAC webhook rejects missing headers', () => {
  const result = verifyHmacBodySignature({
    event: jwtEvent('/webhooks/plaid', 'POST', { webhook_code: 'TRANSFER_EVENTS_UPDATE' }, { auth: null }),
    rawBody: '{}',
    secret: 's',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_signature_headers');
});

test('webhook sanitizer drops bank data and untrusted tenant ids', () => {
  const clean = sanitizeWebhookPayload({
    type: 'transfer.completed',
    tenant_id: C1C_TENANT,
    account_number: '123456789',
    routing_number: '021000021',
    data: { transferID: 'tr_1' },
  });
  assert.equal(clean.account_number, '[redacted]');
  assert.equal(clean.routing_number, '[redacted]');
  assert.equal(clean.tenant_id, '[ignored-untrusted]');
  assert.equal(clean.data.transferID, 'tr_1');
});

test('GET /providers/status never returns secret values', async () => {
  process.env.AWS_MOOV_WEBHOOK_SECRET = 'super-secret-value-do-not-leak';
  const response = await handler(jwtEvent('/providers/status', 'GET'));
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.flags.AWS_PROVIDER_EXECUTION_ENABLED, false);
  assert.equal(body.productionWebhooksRedirected, false);
  assert.ok(!JSON.stringify(body).includes('super-secret-value-do-not-leak'));
  assert.equal(body.permissions.disbursement.activated, false);
});

test('unauthenticated provider status is 401', async () => {
  const response = await handler(jwtEvent('/providers/moov/status', 'POST', {}, { auth: null }));
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 401);
  assert.ok(['missing_cognito_token', 'invalid_cognito_token'].includes(body.error));
});

test('Freedom Moov/CheckAlt local status succeeds and ignores spoofed tenant headers', async () => {
  const client = mockClient();
  const result = await handleProviderRequest(
    jwtEvent('/providers/moov/status', 'POST', { tenant_id: C1C_TENANT, user_id: NINTH }),
    '/providers/moov/status',
    'POST',
    {
      loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
      createClient: () => client,
    },
  );
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'cross_tenant_denied');

  const owned = await handleProviderRequest(
    jwtEvent('/providers/moov/status', 'POST', { tenant_id: FREEDOM_TENANT, provider_account_id: MOOV_ACCOUNT }),
    '/providers/moov/status',
    'POST',
    {
      loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
      createClient: () => mockClient(),
    },
  );
  assert.equal(owned.ok, true);
  assert.equal(owned.account.provider_account_id, MOOV_ACCOUNT);
  assert.equal(owned.liveProviderCalled, false);
  assert.equal(owned.spoofFieldsIgnored.bodyTenantId, FREEDOM_TENANT);
});

test('spoofed Moov account and wallet ids are denied', async () => {
  const deps = {
    loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
    createClient: () => mockClient(),
  };
  const spoofAccount = await handleProviderRequest(
    jwtEvent('/providers/moov/status', 'POST', { provider_account_id: 'moov-acct-c1c' }),
    '/providers/moov/status',
    'POST',
    deps,
  );
  assert.equal(spoofAccount.statusCode, 403);
  assert.equal(spoofAccount.error, 'spoofed_provider_id');

  const spoofWallet = await handleProviderRequest(
    jwtEvent('/providers/moov/status', 'POST', { provider_wallet_id: 'wallet-other' }),
    '/providers/moov/status',
    'POST',
    deps,
  );
  assert.equal(spoofWallet.statusCode, 403);
  assert.equal(spoofWallet.error, 'spoofed_provider_id');
});

test('money-moving production flags stay blocked; sandbox flag is required for ports', async () => {
  await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: 'true',
    AWS_MOOV_ENABLED: 'true',
    AWS_CHECKALT_ENABLED: 'true',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  }, async () => {
    const transfer = await handler(jwtEvent('/functions/v1/moov-transfer-create', 'POST', { amount: 10 }));
    const transferBody = JSON.parse(transfer.body);
    assert.equal(transfer.statusCode, 403);
    assert.equal(transferBody.error, 'production_execution_blocked');
    assert.equal(transferBody.tranche4HardBlock, true);

    const deposit = await handler(jwtEvent('/functions/v1/checkalt-submit-deposit', 'POST', { check_id: WALLET_ID }));
    assert.equal(deposit.statusCode, 403);
    assert.equal(JSON.parse(deposit.body).error, 'production_execution_blocked');
  });
});

test('individual provider flag false returns 403', async () => {
  await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: 'true',
    AWS_MOOV_ENABLED: 'false',
  }, async () => {
    const response = await handler(jwtEvent('/functions/v1/moov-account-onboard', 'POST', {}));
    const body = JSON.parse(response.body);
    assert.equal(response.statusCode, 403);
    assert.equal(body.error, 'provider_disabled');
    assert.equal(body.providerEnabled, false);
  });
});

test('valid synthetic webhook is accepted once and duplicate is ignored', async () => {
  const secret = 'staging-webhook-secret';
  process.env.AWS_MOOV_WEBHOOK_SECRET = secret;
  const webhookId = 'evt_dup';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'n-dup';
  const rawBody = JSON.stringify({
    eventID: webhookId,
    type: 'account.updated',
    accountID: MOOV_ACCOUNT,
    tenant_id: C1C_TENANT,
    account_number: '999999',
  });
  const signature = hmacHex(secret, `${timestamp}|${nonce}|${webhookId}`, 'sha512');
  const client = mockClient();
  const deps = {
    loadProviderSecrets: async () => ({ MOOV_WEBHOOK_SECRET: secret }),
    loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
    createClient: () => client,
  };
  const event = jwtEvent('/webhooks/moov', 'POST', rawBody, {
    auth: null,
    headers: {
      'x-webhook-id': webhookId,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signature,
    },
  });
  const first = await handleProviderRequest(event, '/webhooks/moov', 'POST', deps);
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.dry_run, true);
  assert.equal(first.applied, false);
  assert.equal(first.financialTablesMutated, false);
  assert.equal(first.payload.account_number, '[redacted]');
  assert.equal(first.payload.tenant_id, '[ignored-untrusted]');
  assert.equal(first.mapped_tenant_id, FREEDOM_TENANT);

  const second = await handleProviderRequest(event, '/webhooks/moov', 'POST', deps);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.applied, false);
});

test('malformed webhook and invalid signature are rejected', async () => {
  process.env.AWS_MOOV_WEBHOOK_SECRET = 'staging-webhook-secret';
  const malformed = await handler({
    rawPath: '/webhooks/moov',
    body: '{not-json',
    headers: {
      'x-webhook-id': 'x',
      'x-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-signature': 'aa',
    },
    requestContext: { stage: 'staging', http: { method: 'POST', path: '/webhooks/moov' } },
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(JSON.parse(malformed.body).error, 'malformed_webhook');

  const invalid = await handler({
    rawPath: '/webhooks/plaid',
    body: JSON.stringify({ webhook_code: 'TRANSFER_EVENTS_UPDATE', event_id: 'e1' }),
    headers: {
      'x-webhook-id': 'e1',
      'x-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-signature': '00'.repeat(32),
    },
    requestContext: { stage: 'staging', http: { method: 'POST', path: '/webhooks/plaid' } },
  });
  process.env.AWS_PLAID_WEBHOOK_SECRET = 'plaid-secret';
  const invalid2 = await handleProviderRequest({
    rawPath: '/webhooks/plaid',
    body: JSON.stringify({ webhook_code: 'TRANSFER_EVENTS_UPDATE', event_id: 'e1' }),
    headers: {
      'x-webhook-id': 'e1',
      'x-timestamp': String(Math.floor(Date.now() / 1000)),
      'x-signature': '00'.repeat(32),
    },
    requestContext: { stage: 'staging', http: { method: 'POST', path: '/webhooks/plaid' } },
  }, '/webhooks/plaid', 'POST', {
    loadProviderSecrets: async () => ({ PLAID_WEBHOOK_SECRET: 'plaid-secret' }),
  });
  assert.equal(invalid2.statusCode, 401);
  assert.equal(invalid2.error, 'invalid_signature');
  assert.ok(invalid.statusCode === 401 || invalid.statusCode === 400);
});

test('provider failure rolls back and does not persist a receipt', async () => {
  const secret = 'staging-webhook-secret';
  const webhookId = 'evt_fail';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'n-fail';
  const rawBody = JSON.stringify({ eventID: webhookId, type: 'account.updated', accountID: MOOV_ACCOUNT });
  const signature = hmacHex(secret, `${timestamp}|${nonce}|${webhookId}`, 'sha512');
  const client = mockClient({ throwOn: 'INSERT INTO public.aws_provider_webhook_receipts' });
  const result = await handleProviderRequest(jwtEvent('/webhooks/moov', 'POST', rawBody, {
    auth: null,
    headers: {
      'x-webhook-id': webhookId,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signature,
    },
  }), '/webhooks/moov', 'POST', {
    loadProviderSecrets: async () => ({ MOOV_WEBHOOK_SECRET: secret }),
    loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
    createClient: () => client,
  });
  assert.equal(result.ok, false);
  assert.equal(result.financialTablesMutated, false);
  assert.ok(client.queries.some((item) => item.sql === 'ROLLBACK'));
  assert.equal(client.store.length, 0);
});

test('timing-safe compare rejects different lengths', () => {
  assert.equal(safeEqual('abc', 'ab'), false);
  assert.equal(safeEqual('abc', 'abc'), true);
});
