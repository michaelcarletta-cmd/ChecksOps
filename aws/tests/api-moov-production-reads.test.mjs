import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL } from '../functions/api/identity.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import { hmacHex } from '../functions/api/providers/hmac.mjs';
import {
  productionMoovExecutionAllowed,
  productionMoovReadsAllowed,
} from '../functions/api/providers/production/moov-holds.mjs';
import {
  classifyProductionMoovSecrets,
  loadProductionMoovReadSecrets,
  loadProductionMoovSecrets,
  PRODUCTION_MOOV_READ_SECRET_NAMES,
  PRODUCTION_MOOV_SECRET_NAMES,
} from '../functions/api/providers/production/moov-secrets.mjs';
import {
  assertReadOnlyMoovRequest,
  fingerprintMoovId,
  inspectAccessTokenMetadata,
  productionMoovFetch,
  redactMoovText,
} from '../functions/api/providers/production/moov-client.mjs';
import { applyProductionMoovWebhook } from '../functions/api/providers/production/moov-webhook-apply.mjs';
import { classifySenderReadiness } from '../functions/api/providers/production/moov-read.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const C1C_APP = 'fd857564-0000-4000-8000-000000000001';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const C1C_SUB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TRANSFER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_ROW_ID = '60922058-7eca-4889-81dd-5720d7b9de96';

const jwtEvent = (pathName, method, body, extra = {}) => ({
  rawPath: pathName,
  headers: {
    authorization: extra.auth === null ? undefined : 'Bearer test-id-token',
    ...(extra.headers || {}),
  },
  body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
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

const c1cMapping = {
  application_user_id: C1C_APP,
  cognito_sub: C1C_SUB,
  email: 'owner@c1c.test',
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

const liveReadFlags = {
  AWS_PROVIDER_LIVE_READS_ENABLED: 'true',
  AWS_PROVIDER_EXECUTION_ENABLED: 'false',
  AWS_MOOV_ENABLED: 'false',
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  PROVIDER_SECRETS_ARN: 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/providers',
};

const readSecrets = () => ({
  ok: true,
  contract: 'read',
  credentials: {
    environment: 'production',
    host: 'https://api.moov.io',
    publicKey: 'prod-public',
    secretKey: 'prod-secret',
    platformAccountId: 'platform-prod',
    origin: 'https://checksops.com',
    webhookSecretConfigured: false,
    apiVersion: 'v2024.01.00',
  },
});

const clientCredentials = {
  environment: 'production',
  host: 'https://api.moov.io',
  publicKey: 'prod-public',
  secretKey: 'prod-secret',
  origin: 'https://checksops.com',
  apiVersion: 'v2024.01.00',
};

const createStore = ({
  role = 'admin',
  tenantId = FREEDOM_TENANT,
  memberships = null,
} = {}) => ({
  transfers: [{
    id: TRANSFER_ID,
    tenant_id: tenantId,
    provider: 'moov',
    environment: 'production',
    provider_transfer_id: null,
    status: 'queued',
    amount_cents: 1,
  }],
  receipts: [],
  processPosts: 0,
  getGets: 0,
  oauthPosts: 0,
  getPaths: [],
  writeMethods: [],
  role,
  memberships: memberships || [{ tenant_id: tenantId, role, tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  mapping: tenantId === C1C_TENANT ? c1cMapping : mapping,
});

const identityClient = (store) => ({
  connect: async () => {},
  end: async () => {},
  query: async (sql, params = []) => {
    const text = String(sql);
    if (text === 'BEGIN' || text === 'ROLLBACK' || text === 'COMMIT' || text === 'SET TRANSACTION READ WRITE'
      || text.startsWith('SELECT set_config')) {
      return { rows: [] };
    }
    if (text === LOOKUP_MAPPING_SQL) {
      if (params[0] === mapping.cognito_sub) return { rows: [store.mapping || mapping] };
      if (params[0] === c1cMapping.cognito_sub) return { rows: [c1cMapping] };
      return { rows: [] };
    }
    if (text === TENANT_MEMBERSHIP_SQL || text.includes('FROM public.tenant_users tu')) {
      return { rows: store.memberships };
    }
    if (text.includes('FROM public.user_roles')) {
      return { rows: store.role === 'operator' ? [{ role: 'staff' }] : [{ role: 'admin' }] };
    }
    if (text.includes('FROM public.tenant_users WHERE user_id') && text.includes('AND tenant_id')) {
      const tenantId = params[1];
      const match = store.memberships.find((row) => row.tenant_id === tenantId);
      return { rows: match ? [{ role: match.role }] : [] };
    }
    if (text.includes('FROM public.payment_provider_accounts')) {
      if (params[0] !== FREEDOM_TENANT && params[0] !== 'moov-freedom') return { rows: [] };
      return {
        rows: [{
          id: ACCOUNT_ROW_ID,
          tenant_id: FREEDOM_TENANT,
          provider: 'moov',
          environment: 'production',
          provider_account_id: 'moov-freedom',
          account_type: 'business',
          onboarding_status: 'active',
          verification_status: 'verified',
          can_send_payments: true,
          can_receive_payments: true,
          can_ach_credit: true,
          can_ach_debit: true,
          disabled: false,
          restricted: false,
        }],
      };
    }
    if (text.includes('FROM public.payment_wallets')) {
      return { rows: [{ id: 'wallet-1', tenant_id: FREEDOM_TENANT, environment: 'production', status: 'active', provider_wallet_id: 'wallet-freedom' }] };
    }
    if (text.includes('INSERT INTO public.aws_provider_webhook_receipts')) {
      const existing = store.receipts.find((row) => row.provider === params[0] && row.external_event_id === params[1]);
      if (existing) return { rows: [] };
      const row = { id: crypto.randomUUID(), provider: params[0], external_event_id: params[1] };
      store.receipts.push(row);
      return { rows: [row] };
    }
    if (text.includes('FROM public.payment_transfers')) {
      const found = store.transfers.find((row) => row.id === params[0] || row.provider_transfer_id === params[0]);
      return { rows: found ? [found] : [] };
    }
    return { rows: [] };
  },
});

const fetchImpl = (store) => async (url, options = {}) => {
  const target = String(url);
  const method = String(options.method || 'GET').toUpperCase();
  if (target.includes('/oauth2/token')) {
    store.oauthPosts += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok', expires_in: 300 }) };
  }
  if (method !== 'GET') {
    store.writeMethods.push(method);
    store.processPosts += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ transferID: 'should-not' }) };
  }
  store.getGets += 1;
  store.getPaths.push(target.replace('https://api.moov.io', ''));
  if (target.includes('/wallets/') && !target.endsWith('/wallets')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ walletID: 'wallet-freedom', status: 'active', availableBalance: { value: 0, currency: 'USD' } }) };
  }
  if (target.endsWith('/wallets')) {
    return { ok: true, status: 200, text: async () => JSON.stringify([{ walletID: 'wallet-freedom', status: 'active' }]) };
  }
  if (target.includes('/capabilities')) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { capability: 'send-funds.ach', status: 'enabled' },
        { capability: 'collect-funds.ach', status: 'enabled' },
        { capability: 'wallet.balance', status: 'enabled' },
      ]),
    };
  }
  if (target.includes('/bank-accounts')) {
    return { ok: true, status: 200, text: async () => JSON.stringify([{ status: 'verified', verificationStatus: 'verified' }]) };
  }
  if (target.includes('/payment-methods')) {
    return { ok: true, status: 200, text: async () => JSON.stringify([{ status: 'verified', paymentMethodType: 'ach-credit-standard' }]) };
  }
  return { ok: true, status: 200, text: async () => JSON.stringify({ accountID: 'moov-freedom', status: 'active', verification: { status: 'verified' } }) };
};

const depsFor = (store) => ({
  createClient: () => identityClient(store),
  loadDatabaseCredentials: async () => ({
    host: 'localhost', username: 'checksops', password: 'x', database: 'checksops',
  }),
  fetchImpl: fetchImpl(store),
  loadProductionReadSecrets: async () => readSecrets(),
});

const invoke = (store, name, body = {}, extra = {}) => withEnv(liveReadFlags, () => handleProviderRequest(
  jwtEvent(`/functions/v1/${name}`, 'POST', body, extra),
  `/functions/v1/${name}`,
  'POST',
  depsFor(store),
));

test('money flags remain OFF; live-reads default OFF; SQL 72 unapplied', () => {
  assert.equal(productionMoovExecutionAllowed(), false);
  assert.equal(productionMoovReadsAllowed(), false);
  const sql72 = fs.readFileSync(path.join(ROOT, 'aws/financial/sql/72_moov_production_intent.sql'), 'utf8');
  assert.match(sql72, /DO NOT APPLY/);
  assert.equal(PRODUCTION_MOOV_READ_SECRET_NAMES.includes('MOOV_WEBHOOK_SECRET'), false);
  assert.equal(PRODUCTION_MOOV_SECRET_NAMES.includes('MOOV_WEBHOOK_SECRET'), true);
  assert.equal(PRODUCTION_MOOV_SECRET_NAMES.includes('MOOV_PLATFORM_ACCOUNT_ID'), true);
});

test('live reads flag false → no provider HTTP', async () => {
  const store = createStore();
  const result = await withEnv({
    ...liveReadFlags,
    AWS_PROVIDER_LIVE_READS_ENABLED: undefined,
  }, () => handleProviderRequest(
    jwtEvent('/functions/v1/moov-readiness', 'POST', {}),
    '/functions/v1/moov-readiness',
    'POST',
    depsFor(store),
  ));
  assert.notEqual(result.liveProviderCalled, true);
  assert.equal(store.getGets, 0);
  assert.equal(store.processPosts, 0);
});

test('production-prep money routes blocked before HTTP even when live-reads is false', async () => {
  const store = createStore();
  const blocked = await withEnv({
    CHECKSOPS_ENV: 'production-prep',
    AWS_PROVIDER_LIVE_READS_ENABLED: 'false',
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_MOOV_ENABLED: 'false',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'false',
  }, async () => {
    const create = await handleProviderRequest(
      jwtEvent('/functions/v1/moov-transfer-create', 'POST', { payment_transfer_id: TRANSFER_ID }),
      '/functions/v1/moov-transfer-create',
      'POST',
      depsFor(store),
    );
    const disburse = await handleProviderRequest(
      jwtEvent('/functions/v1/moov-disburse', 'POST', { payment_transfer_id: TRANSFER_ID }),
      '/functions/v1/moov-disburse',
      'POST',
      depsFor(store),
    );
    return { create, disburse };
  });
  assert.equal(blocked.create.error, 'production_execution_blocked');
  assert.equal(blocked.create.liveProviderCalled, false);
  assert.equal(blocked.disburse.error, 'production_execution_blocked');
  assert.equal(blocked.disburse.liveProviderCalled, false);
  assert.equal(store.getGets, 0);
  assert.equal(store.processPosts, 0);
});

test('live reads true + money flags false → GET account/wallet/bank/capabilities allowed', async () => {
  const store = createStore();
  const result = await invoke(store, 'moov-readiness', {});
  assert.equal(result.ok, true);
  assert.equal(result.productionExecution, false);
  assert.equal(result.productionRead, true);
  assert.equal(result.payment_transfer_required, false);
  assert.equal(result.liveProviderCalled, true);
  assert.equal(store.processPosts, 0);
  assert.ok(store.getGets >= 4);
  assert.ok(store.getPaths.includes('/accounts/moov-freedom'));
  assert.ok(store.getPaths.some((p) => p.includes('/wallets')));
  assert.ok(store.getPaths.some((p) => p.includes('/bank-accounts')));
  assert.ok(store.getPaths.some((p) => p.includes('/capabilities')));
  assert.equal(result.capabilities.send_funds.enabled, true);
  assert.equal(result.capabilities.collect_funds.enabled, true);
  assert.equal(result.capabilities.wallet_balance.enabled, true);
  assert.equal(result.sender_readiness.verdict, 'SENDER_READY');
  assert.equal(result.wallet.available_cents, 0);
  assert.equal(result.live_gets.account.ok, true);
});

test('GET account uses server-derived provider_account_id; spoofed account denied', async () => {
  const store = createStore();
  const ok = await invoke(store, 'moov-readiness', {});
  assert.equal(ok.server_derived_provider_account_id_present, true);
  assert.ok(store.getPaths.every((p) => !p.includes('browser-moov')));
  const spoof = await invoke(store, 'moov-readiness', { moov_account_id: 'browser-moov', provider_account_id: 'browser-moov' });
  assert.equal(spoof.error, 'untrusted_provider_config');
  assert.equal(store.processPosts, 0);
});

test('cross-tenant lookup denied; Freedom cannot inspect C1C', async () => {
  const store = createStore();
  const cross = await invoke(store, 'moov-readiness', { tenant_id: C1C_TENANT });
  assert.equal(cross.statusCode, 403);
  assert.equal(cross.error, 'cross_tenant_denied');
  const c1c = createStore({
    tenantId: C1C_TENANT,
    memberships: [{ tenant_id: C1C_TENANT, role: 'admin', tenant_name: 'C1C', tenant_slug: 'c1c' }],
  });
  const c1cOnFreedom = await withEnv(liveReadFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/moov-readiness', 'POST', { tenant_id: FREEDOM_TENANT }, { sub: C1C_SUB }),
    '/functions/v1/moov-readiness',
    'POST',
    depsFor(c1c),
  ));
  assert.equal(c1cOnFreedom.statusCode, 403);
  assert.equal(c1c.getGets, 0);
});

test('POST/PUT/PATCH/DELETE under read authorization denied before HTTP', async () => {
  let called = 0;
  const fetchImplNever = async () => {
    called += 1;
    return { ok: true, status: 200, text: async () => '{}' };
  };
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    called = 0;
    await assert.rejects(
      () => productionMoovFetch({
        mode: 'read',
        method,
        path: '/accounts/moov-freedom/transfers',
        credentials: clientCredentials,
        fetchImpl: fetchImplNever,
      }),
      (error) => error.code === 'read_only_method_denied' && called === 0,
    );
    assert.equal(called, 0, method);
  }
  assert.throws(
    () => assertReadOnlyMoovRequest({ method: 'POST', path: '/accounts/x/transfers' }),
    (error) => error.code === 'read_only_method_denied',
  );
});

test('transfer create, disburse, funding, recipient, capability, ToS, bank mutations denied', async () => {
  const store = createStore();
  const create = await invoke(store, 'moov-transfer-create', { payment_transfer_id: TRANSFER_ID });
  assert.equal(create.error, 'production_execution_blocked');
  const disburse = await invoke(store, 'moov-disburse', { payment_transfer_id: TRANSFER_ID });
  assert.equal(disburse.error, 'production_execution_blocked');
  const fund = await invoke(store, 'moov-wallet-fund', {});
  assert.notEqual(fund.liveProviderCalled, true);
  const recipient = await invoke(store, 'moov-recipient-create', {});
  assert.notEqual(recipient.liveProviderCalled, true);
  const cap = await invoke(store, 'moov-readiness', { request_capability: true });
  assert.equal(cap.error, 'read_only_operation');
  const tos = await invoke(store, 'moov-readiness', { accept_tos: true });
  assert.equal(tos.error, 'read_only_operation');
  const bank = await invoke(store, 'moov-readiness', { add_bank: true });
  assert.equal(bank.error, 'read_only_operation');
  const onboard = await invoke(store, 'moov-tos-accept', {});
  assert.notEqual(onboard.liveProviderCalled, true);
  assert.equal(store.processPosts, 0);
  assert.equal(store.writeMethods.length, 0);
});

test('webhook cannot initiate transfer while live reads are on', async () => {
  const store = createStore();
  process.env.AWS_MOOV_WEBHOOK_SECRET = 'staging-webhook-secret';
  const webhookId = 'evt_m31';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'n31';
  const payload = { eventID: webhookId, type: 'transfer.created', accountID: 'moov-freedom', data: { transferID: 'moov-tr-1' } };
  const signature = hmacHex('staging-webhook-secret', `${timestamp}|${nonce}|${webhookId}`, 'sha512');
  const result = await withEnv(liveReadFlags, () => handleProviderRequest({
    rawPath: '/webhooks/moov',
    headers: { 'x-webhook-id': webhookId, 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-signature': signature },
    body: JSON.stringify(payload),
    requestContext: { stage: 'staging', http: { method: 'POST', path: '/webhooks/moov' } },
  }, '/webhooks/moov', 'POST', depsFor(store)));
  assert.equal(result.applied, false);
  const dark = await applyProductionMoovWebhook(identityClient(store), payload);
  assert.equal(dark.createdTransfer, false);
  assert.equal(dark.applied, false);
  assert.equal(store.processPosts, 0);
  delete process.env.AWS_MOOV_WEBHOOK_SECRET;
});

test('account GET failure continues remaining GETs and does not leak provider account ids', async () => {
  const store = createStore();
  const failingFetch = async (url, options = {}) => {
    const target = String(url);
    const path = target.replace('https://api.moov.io', '');
    if (target.includes('/oauth2/token')) {
      store.oauthPosts += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok', expires_in: 300 }) };
    }
    if (/^\/accounts\/[^/]+$/.test(path)) {
      store.getGets += 1;
      store.getPaths.push(path);
      return { ok: false, status: 403, text: async () => JSON.stringify({ error: 'account read denied' }) };
    }
    return fetchImpl(store)(url, options);
  };
  const result = await withEnv(liveReadFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/moov-readiness', 'POST', {}),
    '/functions/v1/moov-readiness',
    'POST',
    { ...depsFor(store), fetchImpl: failingFetch },
  ));
  assert.equal(result.error, 'moov_account_get_failed');
  assert.equal(result.statusCode, 502);
  assert.equal(result.liveProviderCalled, true);
  assert.equal(result.productionExecution, false);
  assert.equal(result.live_gets.account.status, 403);
  assert.equal(result.live_gets.capabilities.ok, true);
  assert.equal(result.live_gets.banks.ok, true);
  assert.ok(store.getGets >= 4);
  assert.equal(store.processPosts, 0);
  assert.doesNotMatch(String(result.live_gets.account.error || ''), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  assert.equal(result.sender_readiness.verdict, 'BLOCKED');
});

test('Moov HTTP error messages redact account ids', async () => {
  assert.equal(redactMoovText('Moov /accounts/60922058-7eca-4889-81dd-5720d7b9de96 failed'), 'Moov /accounts/{id} failed');
  assert.equal(fingerprintMoovId('60922058-7eca-4889-81dd-5720d7b9de96'), '60922058…de96');
  const jwt = [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify({
      scope: '/accounts/{id}/profile.read'.replace('{id}', '60922058-7eca-4889-81dd-5720d7b9de96'),
      aud: 'https://api.moov.io',
      origin: 'https://checksops.com',
      accountID: '60922058-7eca-4889-81dd-5720d7b9de96',
      exp: Math.floor(Date.now() / 1000) + 300,
    })).toString('base64url'),
    'sig',
  ].join('.');
  const tokenMeta = inspectAccessTokenMetadata(jwt);
  assert.equal(tokenMeta.looks_like_jwt, true);
  assert.equal(tokenMeta.account_fp, '60922058…de96');
  assert.equal(tokenMeta.origin_claim, 'https://checksops.com');
  assert.doesNotMatch(JSON.stringify(tokenMeta), /60922058-7eca/);
  let called = 0;
  await assert.rejects(
    () => productionMoovFetch({
      mode: 'read',
      method: 'GET',
      path: '/accounts/60922058-7eca-4889-81dd-5720d7b9de96',
      credentials: clientCredentials,
      fetchImpl: async (url) => {
        if (String(url).includes('/oauth2/token')) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () => JSON.stringify({
              access_token: jwt,
              token_type: 'Bearer',
              expires_in: 300,
              scope: '/accounts/{id}/profile.read',
            }),
          };
        }
        called += 1;
        return {
          ok: false,
          status: 401,
          headers: {
            get: (name) => ({
              'www-authenticate': 'Bearer',
              'x-request-id': 'req-test',
              'content-type': 'application/json',
            }[String(name).toLowerCase()] || null),
          },
          text: async () => JSON.stringify({ error: 'unauthorized' }),
        };
      },
    }),
    (error) => (
      error.status === 401
      && error.message === 'unauthorized'
      && error.diagnosis?.www_authenticate === 'Bearer'
      && error.diagnosis?.request_id === 'req-test'
      && error.diagnosis?.oauth?.token_type === 'Bearer'
      && error.diagnosis?.authorization_scheme === 'Bearer'
      && error.diagnosis?.origin_sent === 'https://checksops.com'
      && !JSON.stringify(error.diagnosis).includes(jwt)
    ),
  );
  assert.equal(called, 1);
});

test('sender readiness stays blocked without send-funds.ach', () => {
  const blocked = classifySenderReadiness({
    accountGetOk: true,
    verification: { account_status: 'active', kyc: 'verified', tos: { accepted: true } },
    capabilities: { send_funds: { id: 'send-funds.ach', enabled: false } },
    wallet: { status: 'active' },
    banks: [{ status: 'verified', verification_status: 'verified' }],
  });
  assert.equal(blocked.verdict, 'BLOCKED');
  assert.ok(blocked.reasons.includes('send_funds_ach_not_enabled'));
});

test('missing production read credentials fail closed; sandbox cannot satisfy', async () => {
  const snapshot = classifyProductionMoovSecrets({
    MOOV_PUBLIC_KEY: 'same',
    MOOV_SECRET_KEY: 'same-secret',
    MOOV_ENVIRONMENT: 'production',
    MOOV_ALLOWED_ORIGIN: 'https://checksops.com',
    MOOV_SANDBOX_PUBLIC_KEY: 'same',
  });
  assert.equal(snapshot.productionReadKeysComplete, true);
  assert.ok(snapshot.sandboxContamination.includes('MOOV_SANDBOX_PUBLIC_KEY'));
  assert.equal(snapshot.webhookRequiredForRead, false);
  const missing = await withEnv(liveReadFlags, () => loadProductionMoovReadSecrets(async () => ({})));
  assert.equal(missing.error, 'production_secret_missing');
  const store = createStore();
  const denied = await withEnv(liveReadFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/moov-readiness', 'POST', {}),
    '/functions/v1/moov-readiness',
    'POST',
    {
      ...depsFor(store),
      loadProductionReadSecrets: async () => loadProductionMoovReadSecrets(async () => ({})),
    },
  ));
  assert.equal(denied.error, 'production_secret_missing');
  assert.equal(store.getGets, 0);
});

test('sandbox credentials cannot satisfy production execution either', async () => {
  const exec = await withEnv(liveReadFlags, () => loadProductionMoovSecrets(async () => ({
    MOOV_PUBLIC_KEY: 'prod',
    MOOV_SECRET_KEY: 'prod',
    MOOV_ENVIRONMENT: 'production',
    MOOV_ALLOWED_ORIGIN: 'https://checksops.com',
  })));
  assert.equal(exec.error, 'production_secret_missing');
  assert.ok(exec.missingNames.includes('MOOV_WEBHOOK_SECRET'));
  assert.ok(exec.missingNames.includes('MOOV_PLATFORM_ACCOUNT_ID'));
});

test('production execution remains unreachable with live reads on', async () => {
  assert.equal(await withEnv(liveReadFlags, async () => productionMoovExecutionAllowed()), false);
  assert.equal(await withEnv(liveReadFlags, async () => productionMoovReadsAllowed()), true);
  const store = createStore();
  const result = await invoke(store, 'moov-transfer-create', { payment_transfer_id: TRANSFER_ID });
  assert.equal(result.productionExecution, false);
  assert.equal(store.processPosts, 0);
});
