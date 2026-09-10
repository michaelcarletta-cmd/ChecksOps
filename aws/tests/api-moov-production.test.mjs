import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL } from '../functions/api/identity.mjs';
import { handleFinancialRequest } from '../functions/api/financial.mjs';
import { evaluateFinancialAuthorization } from '../functions/api/financial-authz.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import { hmacHex } from '../functions/api/providers/hmac.mjs';
import { productionMoovExecutionAllowed, productionMoovAmbiguousMode } from '../functions/api/providers/production/moov-holds.mjs';
import {
  classifyProductionMoovSecrets,
  loadProductionMoovSecrets,
  PRODUCTION_MOOV_SECRET_NAMES,
} from '../functions/api/providers/production/moov-secrets.mjs';
import {
  evaluateMoovProductionAuthorization,
  stepUpMatchesTransfer,
} from '../functions/api/providers/production/moov-authz.mjs';
import {
  providerIdempotencyKeyFromIntent,
  moovTransferIdempotencyKey,
  shouldReconcileInsteadOfPost,
} from '../functions/api/providers/production/moov-idempotency.mjs';
import { applyProductionMoovWebhook } from '../functions/api/providers/production/moov-webhook-apply.mjs';
import { resetProviderSecretsCache } from '../functions/api/provider-secrets.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const C1C_APP = 'fd857564-0000-4000-8000-000000000001';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const C1C_SUB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TRANSFER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TRANSFER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C1C_TRANSFER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SOURCE_METHOD_ID = '11111111-1111-4111-8111-111111111111';
const DEST_METHOD_ID = '22222222-2222-4222-8222-222222222222';
const RECIPIENT_ID = '33333333-3333-4333-8333-333333333333';
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

const productionFlags = {
  AWS_PROVIDER_EXECUTION_ENABLED: 'true',
  AWS_MOOV_ENABLED: 'true',
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
  AWS_LOVABLE_MONEY_NEUTRALIZED: 'true',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  AWS_CHECKALT_ENABLED: 'false',
  PROVIDER_SECRETS_ARN: 'arn:aws:secretsmanager:us-east-1:806168576068:secret:checksops/production/providers',
};

const productionSecrets = () => ({
  ok: true,
  credentials: {
    environment: 'production',
    host: 'https://api.moov.io',
    publicKey: 'prod-public',
    secretKey: 'prod-secret',
    platformAccountId: 'platform-prod',
    origin: 'https://checksops.com',
    webhookSecretConfigured: true,
    apiVersion: 'v2024.01.00',
  },
});

const queuedTransfer = (extra = {}) => ({
  id: TRANSFER_ID,
  tenant_id: FREEDOM_TENANT,
  provider: 'moov',
  environment: 'production',
  provider_transfer_id: null,
  provider_status: null,
  status: 'queued',
  idempotency_key: moovTransferIdempotencyKey({
    tenantId: FREEDOM_TENANT,
    resourceId: TRANSFER_ID,
    amountCents: 1,
    destinationMethodId: 'pm-dest',
  }),
  amount_cents: 1,
  currency: 'USD',
  description: 'M3 fixture',
  source_tenant_account_id: 'moov-freedom',
  source_payment_method_id: SOURCE_METHOD_ID,
  destination_recipient_id: RECIPIENT_ID,
  destination_payment_method_id: DEST_METHOD_ID,
  provider_metadata: { provider_http_attempted: false },
  provider_http_attempted_at: null,
  failure_class: null,
  last_error: null,
  created_at: new Date().toISOString(),
  ...extra,
});

const createStore = ({
  role = 'admin',
  tenantId = FREEDOM_TENANT,
  transferOverrides = {},
  memberships = null,
} = {}) => {
  const transfer = queuedTransfer({ tenant_id: tenantId, ...transferOverrides });
  return {
    transfers: [transfer],
    stepups: [],
    receipts: [],
    processPosts: 0,
    getGets: 0,
    oauthPosts: 0,
    persistOutcomeFails: 0,
    role,
    rolesByUser: {},
    memberships: memberships || [{ tenant_id: tenantId, role, tenant_name: 'Freedom', tenant_slug: 'freedom' }],
    mapping,
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
    if (text === LOOKUP_MAPPING_SQL) {
      if (params[0] === mapping.cognito_sub) return { rows: [store.mapping || mapping] };
      if (params[0] === c1cMapping.cognito_sub) return { rows: [c1cMapping] };
      return { rows: [] };
    }
    if (text === TENANT_MEMBERSHIP_SQL || text.includes('FROM public.tenant_users tu')) {
      return { rows: store.memberships };
    }
    if (text.includes('FROM public.user_roles')) {
      const userId = params[0];
      const role = store.rolesByUser?.[userId] || store.role;
      return { rows: role === 'operator' ? [{ role: 'staff' }] : [{ role: 'admin' }] };
    }
    if (text.includes('FROM public.tenant_users WHERE user_id') && text.includes('AND tenant_id')) {
      const userId = params[0];
      const tenantId = params[1];
      if (store.rolesByUser?.[userId]) return { rows: [{ role: store.rolesByUser[userId] }] };
      const match = store.memberships.find((row) => row.tenant_id === tenantId);
      return { rows: match ? [{ role: match.role }] : [] };
    }
    if (text.includes('FROM public.financial_stepup_log')) {
      const dual = text.includes('action_key = $2') && params[1] === 'moov.dual_control';
      if (dual) {
        const [tenantId, , since, transferId, amountCents] = params;
        return {
          rows: store.stepups.filter((row) => (
            row.action_key === 'moov.dual_control'
            && row.tenant_id === tenantId
            && row.succeeded === true
            && (row.metadata?.payment_transfer_id === transferId || row.metadata?.resource_id === transferId)
            && Number(row.metadata?.amount_cents) === Number(amountCents)
            && new Date(row.created_at) >= new Date(since)
          )),
        };
      }
      const [userId, tenantId, actionKey, since, transferId, amountCents] = params;
      return {
        rows: store.stepups.filter((row) => (
          row.user_id === userId
          && row.tenant_id === tenantId
          && row.action_key === actionKey
          && row.succeeded === true
          && (row.metadata?.payment_transfer_id === transferId || row.metadata?.resource_id === transferId)
          && Number(row.metadata?.amount_cents) === Number(amountCents)
          && new Date(row.created_at) >= new Date(since)
        )),
      };
    }
    if (text.includes('INSERT INTO public.financial_stepup_log')) {
      const row = {
        id: crypto.randomUUID(),
        user_id: params[0],
        tenant_id: params[1],
        action_key: params[2],
        factor_type: 'dual_control',
        succeeded: true,
        metadata: typeof params[3] === 'string' ? JSON.parse(params[3]) : params[3],
        created_at: new Date().toISOString(),
      };
      store.stepups.push(row);
      return { rows: [row] };
    }
    if (text.includes('FROM public.payment_provider_accounts')) {
      if (text.includes("environment = 'production'")) {
        const want = params[0];
        if (want && want !== FREEDOM_TENANT && want !== 'moov-freedom') return { rows: [] };
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
      return { rows: [] };
    }
    if (text.includes('FROM public.payment_provider_methods')) {
      const row = params[0] === SOURCE_METHOD_ID
        ? {
          id: SOURCE_METHOD_ID,
          tenant_id: FREEDOM_TENANT,
          external_recipient_id: null,
          provider: 'moov',
          environment: 'production',
          provider_account_id: 'moov-freedom',
          provider_bank_account_id: 'bank-src',
          provider_payment_method_id: 'pm-src',
          verification_status: 'verified',
          can_send: true,
          can_receive: false,
        }
        : params[0] === DEST_METHOD_ID
          ? {
            id: DEST_METHOD_ID,
            tenant_id: FREEDOM_TENANT,
            external_recipient_id: RECIPIENT_ID,
            provider: 'moov',
            environment: 'production',
            provider_account_id: 'moov-recipient',
            provider_bank_account_id: 'bank-dst',
            provider_payment_method_id: 'pm-dest',
            verification_status: 'verified',
            can_send: false,
            can_receive: true,
          }
          : null;
      return { rows: row ? [row] : [] };
    }
    if (text.includes('FROM public.external_payment_recipients')) {
      return {
        rows: params[0] === RECIPIENT_ID
          ? [{
            id: RECIPIENT_ID,
            tenant_id: FREEDOM_TENANT,
            provider: 'moov',
            environment: 'production',
            provider_account_id: 'moov-recipient',
            onboarding_status: 'ready',
          }]
          : [],
      };
    }
    if (text.includes('FROM public.payment_wallets')) {
      return { rows: [{ id: 'wallet-1', tenant_id: FREEDOM_TENANT, environment: 'production', status: 'active', available_cents: 0, pending_cents: 0 }] };
    }
    if (text.includes('INSERT INTO public.payment_transfers')) {
      const error = new Error('duplicate key');
      error.code = '23505';
      throw error;
    }
    if (text.includes('INSERT INTO public.aws_provider_webhook_receipts')) {
      const existing = store.receipts.find((row) => row.provider === params[0] && row.external_event_id === params[1]);
      if (existing) return { rows: [] };
      const row = { id: crypto.randomUUID(), provider: params[0], external_event_id: params[1], dry_run: params[6], received_at: new Date().toISOString() };
      store.receipts.push(row);
      return { rows: [row] };
    }
    if (text.includes('FROM public.aws_provider_webhook_receipts')) {
      const found = store.receipts.find((row) => row.provider === params[0] && row.external_event_id === params[1]);
      return { rows: found ? [found] : [] };
    }
    if (text.includes('UPDATE public.payment_transfers') && text.includes('provider_http_attempted_at = now()')) {
      const row = store.transfers.find((item) => item.id === params[0]);
      if (!row || row.provider_http_attempted_at || row.provider_transfer_id) return { rows: [] };
      row.status = 'submitting';
      row.provider_http_attempted_at = new Date().toISOString();
      row.provider_metadata = { provider_http_attempted: true };
      return { rows: [row] };
    }
    if (text.includes('UPDATE public.payment_transfers') && text.includes('failure_class')) {
      if (store.persistOutcomeFails > 0) {
        store.persistOutcomeFails -= 1;
        throw new Error('simulated_rds_failure');
      }
      const row = store.transfers.find((item) => item.id === params[0]);
      if (!row) return { rows: [] };
      row.status = params[1];
      if (params[3]) row.provider_transfer_id = params[3];
      row.failure_class = params[4];
      row.last_error = params[5];
      return { rows: [row] };
    }
    if (text.includes('UPDATE public.payment_transfers')) {
      const row = store.transfers.find((item) => item.id === params[0]);
      if (!row) return { rows: [] };
      if (params[1]) row.status = params[1];
      if (params[3]) row.provider_transfer_id = params[3];
      return { rows: [row] };
    }
    if (text.includes('FROM public.payment_transfers') && text.includes('provider_transfer_id = $1')) {
      const found = store.transfers.find((row) => row.provider_transfer_id === params[0]);
      return { rows: found ? [found] : [] };
    }
    if (text.includes('FROM public.payment_transfers') && text.includes('idempotency_key = $2')) {
      const found = store.transfers.find((row) => row.tenant_id === params[0] && row.idempotency_key === params[1]);
      return { rows: found ? [found] : [] };
    }
    if (text.includes('FROM public.payment_transfers')) {
      const found = store.transfers.find((row) => row.id === params[0]);
      return { rows: found ? [found] : [] };
    }
    return { rows: [] };
  },
});

const fetchImpl = (store) => async (url, options = {}) => {
  const target = String(url);
  if (target.includes('/oauth2/token')) {
    store.oauthPosts += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok', expires_in: 300 }) };
  }
  if (target.includes('/transfers') && (options.method || 'GET') === 'POST') {
    store.processPosts += 1;
    store.lastIdempotency = options.headers?.['X-Idempotency-Key'];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ transferID: 'moov-tr-1', status: 'pending' }),
    };
  }
  if (target.includes('/transfers/')) {
    store.getGets += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ transferID: 'moov-tr-1', status: 'pending' }),
    };
  }
  if (target.includes('/accounts/')) {
    store.getGets += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ accountID: 'moov-freedom' }) };
  }
  return { ok: false, status: 404, text: async () => 'not found' };
};

const submitDeps = (store, extra = {}) => ({
  createClient: () => identityClient(store),
  loadDatabaseCredentials: async () => ({
    host: 'localhost', username: 'checksops', password: 'x', database: 'checksops',
  }),
  fetchImpl: extra.fetchImpl || fetchImpl(store),
  loadProductionSecrets: extra.loadProductionSecrets || (async () => productionSecrets()),
});

const grantStepUp = (store, {
  userId = FREEDOM_APP,
  action = 'disbursement.send',
  transferId = TRANSFER_ID,
  tenantId = FREEDOM_TENANT,
  amountCents = 1,
  createdAt = new Date().toISOString(),
} = {}) => {
  store.stepups.push({
    id: crypto.randomUUID(),
    user_id: userId,
    tenant_id: tenantId,
    action_key: action,
    factor_type: action === 'moov.dual_control' ? 'dual_control' : 'totp',
    succeeded: true,
    metadata: { payment_transfer_id: transferId, resource_id: transferId, amount_cents: amountCents },
    created_at: createdAt,
  });
};

const submitOnce = (store, body = {}, extra = {}) => withEnv(productionFlags, () => handleProviderRequest(
  jwtEvent('/functions/v1/moov-transfer-create', 'POST', {
    payment_transfer_id: TRANSFER_ID,
    ...body,
  }, extra),
  '/functions/v1/moov-transfer-create',
  'POST',
  submitDeps(store, extra),
));

test('money/provider flags remain OFF and canExecuteProduction stays false', () => {
  assert.equal(productionMoovExecutionAllowed(), false);
  assert.equal(productionMoovAmbiguousMode(), false);
  const gate = evaluateFinancialAuthorization({
    operation: 'disbursement',
    identityOk: true,
    membershipOk: true,
    roles: ['admin'],
    permissionsActivated: true,
  });
  assert.equal(gate.canExecuteProduction, false);
  const moov = evaluateMoovProductionAuthorization({
    identityOk: true,
    membershipOk: true,
    roles: ['admin'],
    totpOk: true,
  });
  assert.equal(moov.canExecuteProduction, false);
  assert.equal(moov.canExecuteProductionMoov, false);
  assert.equal(moov.flagsOk, false);
});

test('SQL 72 and secret contract stay dark; inventory names are corrected', () => {
  const sql72 = fs.readFileSync(path.join(ROOT, 'aws/financial/sql/72_moov_production_intent.sql'), 'utf8');
  assert.match(sql72, /DO NOT APPLY/);
  assert.match(sql72, /NOT_APPLIED/);
  assert.match(sql72, /provider_http_attempted_at/);
  assert.match(sql72, /does not GRANT financial activation/);
  assert.doesNotMatch(sql72, /GRANT SELECT, INSERT, UPDATE ON TABLE public.payment_transfers/);
  const secretsSrc = fs.readFileSync(path.join(ROOT, 'aws/functions/api/provider-secrets.mjs'), 'utf8');
  for (const name of PRODUCTION_MOOV_SECRET_NAMES) {
    assert.match(secretsSrc, new RegExp(`'${name}'`));
  }
  assert.doesNotMatch(secretsSrc, /'MOOV_ACCOUNT_ID'/);
  const adapterFiles = fs.readdirSync(path.join(ROOT, 'aws/functions/api/providers/production'))
    .filter((name) => name.startsWith('moov-'));
  for (const file of adapterFiles) {
    const src = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production', file), 'utf8');
    assert.doesNotMatch(src, /parity\/moov-/);
    assert.doesNotMatch(src, /loadSandboxCredentials/);
  }
});

test('A. unauthenticated is denied', async () => {
  const store = createStore();
  const result = await submitOnce(store, {}, { auth: null });
  assert.equal(result.statusCode, 401);
  assert.equal(result.error, 'missing_cognito_token');
  assert.equal(store.processPosts, 0);
});

test('A. unmapped Cognito user is denied', async () => {
  const store = createStore();
  const result = await submitOnce(store, {}, { sub: '00000000-0000-4000-8000-000000000099' });
  assert.equal(result.statusCode, 401);
  assert.equal(result.error, 'identity_not_linked');
  assert.equal(store.processPosts, 0);
});

test('A. unresolved transfer UUID is denied', async () => {
  const store = createStore();
  grantStepUp(store);
  const result = await submitOnce(store, { payment_transfer_id: OTHER_TRANSFER_ID });
  assert.equal(result.statusCode, 404);
  assert.equal(store.processPosts, 0);
});

test('A. cross-tenant resource is denied', async () => {
  const store = createStore({
    memberships: [{ tenant_id: C1C_TENANT, role: 'admin', tenant_name: 'C1C', tenant_slug: 'c1c' }],
  });
  store.mapping = c1cMapping;
  grantStepUp(store, { userId: C1C_APP, tenantId: C1C_TENANT });
  const result = await withEnv(productionFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/moov-transfer-create', 'POST', { payment_transfer_id: TRANSFER_ID }, { sub: C1C_SUB }),
    '/functions/v1/moov-transfer-create',
    'POST',
    submitDeps(store),
  ));
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'cross_tenant_denied');
  assert.equal(store.processPosts, 0);
});

test('A. unauthorized role is denied', async () => {
  const store = createStore({ role: 'operator' });
  grantStepUp(store);
  const result = await submitOnce(store);
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'financial_unauthorized');
  assert.equal(store.processPosts, 0);
});

test('A. browser spoofed tenant/amount/recipient/Moov account are ignored or denied', async () => {
  const store = createStore();
  grantStepUp(store);
  const amount = await submitOnce(store, { amount_cents: 999999 });
  assert.equal(amount.statusCode, 400);
  assert.equal(amount.error, 'untrusted_amount');
  const tenant = await submitOnce(store, { tenant_id: C1C_TENANT });
  assert.equal(tenant.statusCode, 403);
  assert.equal(tenant.error, 'cross_tenant_denied');
  const recipient = await submitOnce(store, { destination_recipient_id: OTHER_TRANSFER_ID });
  assert.equal(recipient.statusCode, 403);
  assert.equal(recipient.error, 'spoofed_recipient');
  const moov = await submitOnce(store, { moov_account_id: 'browser-moov', platform_account_id: 'browser-platform' });
  assert.equal(moov.statusCode, 400);
  assert.equal(moov.error, 'untrusted_provider_config');
  assert.equal(store.processPosts, 0);
});

test('A. stale or missing TOTP is denied; TOTP for another transfer or amount is denied', async () => {
  const store = createStore();
  const missing = await submitOnce(store);
  assert.equal(missing.statusCode, 403);
  assert.equal(missing.error, 'step_up_required');
  grantStepUp(store, { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() });
  const stale = await submitOnce(store);
  assert.equal(stale.statusCode, 403);
  store.stepups = [];
  grantStepUp(store, { transferId: OTHER_TRANSFER_ID });
  const other = await submitOnce(store);
  assert.equal(other.statusCode, 403);
  store.stepups = [];
  grantStepUp(store, { amountCents: 100 });
  const amount = await submitOnce(store);
  assert.equal(amount.statusCode, 403);
  assert.equal(store.processPosts, 0);
});

test('B. every production flag false → no HTTP', async () => {
  const store = createStore();
  grantStepUp(store);
  const result = await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: 'false',
    AWS_MOOV_ENABLED: 'false',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'false',
  }, () => handleProviderRequest(
    jwtEvent('/functions/v1/moov-transfer-create', 'POST', { payment_transfer_id: TRANSFER_ID }),
    '/functions/v1/moov-transfer-create',
    'POST',
    submitDeps(store),
  ));
  assert.notEqual(result.liveProviderCalled, true);
  assert.equal(store.processPosts, 0);
});

test('B. incomplete flag combinations → no HTTP', async () => {
  const store = createStore();
  grantStepUp(store);
  const combos = [
    { AWS_PROVIDER_EXECUTION_ENABLED: 'true', AWS_MOOV_ENABLED: 'false', AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true', AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined },
    { AWS_PROVIDER_EXECUTION_ENABLED: 'false', AWS_MOOV_ENABLED: 'true', AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true', AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined },
    { AWS_PROVIDER_EXECUTION_ENABLED: 'true', AWS_MOOV_ENABLED: 'true', AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false', AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined },
  ];
  for (const flags of combos) {
    store.processPosts = 0;
    const result = await withEnv({ ...productionFlags, ...flags }, () => handleProviderRequest(
      jwtEvent('/functions/v1/moov-transfer-create', 'POST', { payment_transfer_id: TRANSFER_ID }),
      '/functions/v1/moov-transfer-create',
      'POST',
      submitDeps(store),
    ));
    assert.equal(store.processPosts, 0, JSON.stringify(flags));
    assert.notEqual(result.liveProviderCalled, true);
  }
});

test('B. sandbox+production ambiguity → 409', async () => {
  const store = createStore();
  grantStepUp(store);
  const result = await withEnv({
    ...productionFlags,
    AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true',
  }, () => handleProviderRequest(
    jwtEvent('/functions/v1/moov-transfer-create', 'POST', { payment_transfer_id: TRANSFER_ID }),
    '/functions/v1/moov-transfer-create',
    'POST',
    submitDeps(store),
  ));
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'ambiguous_execution_mode');
  assert.equal(store.processPosts, 0);
});

test('B. missing production secret → no HTTP', async () => {
  const store = createStore();
  grantStepUp(store);
  const result = await submitOnce(store, {}, {
    loadProductionSecrets: async () => loadProductionMoovSecrets(async () => ({})),
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.error, 'production_secret_missing');
  assert.equal(store.processPosts, 0);
});

test('B. sandbox credential contamination → no HTTP', async () => {
  resetProviderSecretsCache();
  const snapshot = classifyProductionMoovSecrets({
    MOOV_PUBLIC_KEY: 'same',
    MOOV_SECRET_KEY: 'same-secret',
    MOOV_PLATFORM_ACCOUNT_ID: 'plat',
    MOOV_WEBHOOK_SECRET: 'wh',
    MOOV_ENVIRONMENT: 'production',
    MOOV_ALLOWED_ORIGIN: 'https://checksops.com',
    MOOV_SANDBOX_PUBLIC_KEY: 'same',
  });
  assert.ok(snapshot.sandboxContamination.includes('MOOV_SANDBOX_PUBLIC_KEY'));
  const store = createStore();
  grantStepUp(store);
  const result = await submitOnce(store, {}, {
    loadProductionSecrets: async () => ({
      ok: false,
      statusCode: 503,
      error: 'sandbox_credential_contamination',
      liveProviderCalled: false,
    }),
  });
  assert.equal(result.error, 'sandbox_credential_contamination');
  assert.equal(store.processPosts, 0);
});

test('C. happy path fixture POST is one claimant and stable provider idempotency key', async () => {
  const store = createStore();
  grantStepUp(store);
  const first = await submitOnce(store);
  assert.equal(first.ok, true);
  assert.equal(store.processPosts, 1);
  assert.equal(first.provider_idempotency_key, TRANSFER_ID);
  assert.equal(store.lastIdempotency, TRANSFER_ID);
  const second = await submitOnce(store);
  assert.equal(second.duplicate, true);
  assert.equal(store.processPosts, 1);
  assert.equal(providerIdempotencyKeyFromIntent(store.transfers[0]), TRANSFER_ID);
});

test('C. simultaneous claim → second does not POST', async () => {
  const store = createStore();
  store.transfers[0].provider_http_attempted_at = new Date().toISOString();
  store.transfers[0].status = 'submitting';
  grantStepUp(store);
  const result = await submitOnce(store);
  assert.equal(store.processPosts, 0);
  assert.equal(result.duplicate, true);
  assert.ok(shouldReconcileInsteadOfPost(store.transfers[0]));
});

test('C. timeout after possible POST → reconcile, no second POST', async () => {
  const store = createStore();
  grantStepUp(store);
  const timeoutFetch = async (url, options = {}) => {
    if (String(url).includes('/oauth2/token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok', expires_in: 300 }) };
    }
    if (String(url).includes('/transfers') && (options.method || 'GET') === 'POST') {
      store.processPosts += 1;
      const error = new Error('fetch failed');
      error.code = 'ETIMEDOUT';
      throw error;
    }
    store.getGets += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ transferID: 'moov-tr-1', status: 'pending' }) };
  };
  const first = await submitOnce(store, {}, { fetchImpl: timeoutFetch });
  assert.equal(first.error, 'provider_timeout');
  assert.equal(store.processPosts, 1);
  const second = await submitOnce(store, {}, { fetchImpl: timeoutFetch });
  assert.equal(store.processPosts, 1);
  assert.equal(second.duplicate, true);
});

test('C. provider accepted / RDS update failed → reconcile, no second POST', async () => {
  const store = createStore();
  store.persistOutcomeFails = 1;
  grantStepUp(store);
  const first = await submitOnce(store);
  assert.equal(first.failure_class, 'db_after_provider');
  assert.equal(store.processPosts, 1);
  store.transfers[0].provider_http_attempted_at = store.transfers[0].provider_http_attempted_at || new Date().toISOString();
  const second = await submitOnce(store);
  assert.equal(store.processPosts, 1);
  assert.equal(second.duplicate, true);
});

test('C. poll before provider id is persisted is safe', async () => {
  const store = createStore();
  const result = await withEnv(productionFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/moov-transfer-status', 'POST', { payment_transfer_id: TRANSFER_ID }),
    '/functions/v1/moov-transfer-status',
    'POST',
    submitDeps(store),
  ));
  assert.equal(result.ok, true);
  assert.equal(result.provider_transfer_id, null);
  assert.equal(store.processPosts, 0);
});

test('C. same intent always produces the same provider idempotency key', () => {
  const row = queuedTransfer();
  assert.equal(providerIdempotencyKeyFromIntent(row), providerIdempotencyKeyFromIntent({ ...row }));
  assert.equal(moovTransferIdempotencyKey({
    tenantId: FREEDOM_TENANT, resourceId: TRANSFER_ID, amountCents: 1, destinationMethodId: 'pm-dest',
  }), moovTransferIdempotencyKey({
    tenantId: FREEDOM_TENANT, resourceId: TRANSFER_ID, amountCents: 1, destinationMethodId: 'pm-dest',
  }));
});

test('D. Freedom cannot operate on C1C transfer and C1C cannot operate on Freedom transfer', async () => {
  const store = createStore();
  store.transfers.push(queuedTransfer({ id: C1C_TRANSFER_ID, tenant_id: C1C_TENANT }));
  grantStepUp(store);
  const freedomOnC1c = await submitOnce(store, { payment_transfer_id: C1C_TRANSFER_ID });
  assert.equal(freedomOnC1c.statusCode, 403);
  const c1cStore = createStore({
    memberships: [{ tenant_id: C1C_TENANT, role: 'admin', tenant_name: 'C1C', tenant_slug: 'c1c' }],
  });
  c1cStore.mapping = c1cMapping;
  grantStepUp(c1cStore, { userId: C1C_APP, tenantId: C1C_TENANT });
  const c1cOnFreedom = await withEnv(productionFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/moov-transfer-create', 'POST', { payment_transfer_id: TRANSFER_ID }, { sub: C1C_SUB }),
    '/functions/v1/moov-transfer-create',
    'POST',
    submitDeps(c1cStore),
  ));
  assert.equal(c1cOnFreedom.statusCode, 403);
  assert.equal(store.processPosts, 0);
  assert.equal(c1cStore.processPosts, 0);
});

test('E. invalid signature denied; duplicate event does not apply; out-of-order is safe; webhook cannot create transfer', async () => {
  const store = createStore();
  store.transfers[0].provider_transfer_id = 'moov-tr-1';
  store.transfers[0].status = 'completed';
  process.env.AWS_MOOV_WEBHOOK_SECRET = 'staging-webhook-secret';
  const webhookId = 'evt_m3';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'n1';
  const payload = {
    eventID: webhookId,
    type: 'transfer.updated',
    accountID: 'moov-freedom',
    data: { transferID: 'moov-tr-1', status: 'pending' },
  };
  const rawBody = JSON.stringify(payload);
  const bad = await handleProviderRequest({
    rawPath: '/webhooks/moov',
    headers: { 'x-webhook-id': webhookId, 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-signature': 'nope' },
    body: rawBody,
    requestContext: { stage: 'staging', http: { method: 'POST', path: '/webhooks/moov' } },
  }, '/webhooks/moov', 'POST', submitDeps(store));
  assert.equal(bad.statusCode, 401);

  const signature = hmacHex('staging-webhook-secret', `${timestamp}|${nonce}|${webhookId}`, 'sha512');
  const event = {
    rawPath: '/webhooks/moov',
    headers: {
      'x-webhook-id': webhookId,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signature,
    },
    body: rawBody,
    requestContext: { stage: 'staging', http: { method: 'POST', path: '/webhooks/moov' } },
  };
  const first = await handleProviderRequest(event, '/webhooks/moov', 'POST', submitDeps(store));
  assert.equal(first.ok, true);
  assert.equal(first.applied, false);
  const second = await handleProviderRequest(event, '/webhooks/moov', 'POST', submitDeps(store));
  assert.equal(second.duplicate, true);
  assert.equal(second.applied, false);
  const dark = await applyProductionMoovWebhook(identityClient(store), payload, { incomingStatus: 'pending' });
  assert.equal(dark.applied, false);
  assert.equal(dark.createdTransfer, false);
  assert.equal(dark.reconciliationCandidate.out_of_order, true);
  assert.equal(store.transfers[0].status, 'completed');
  assert.equal(store.processPosts, 0);
  delete process.env.AWS_MOOV_WEBHOOK_SECRET;
});

test('E. M3 webhook authoritative apply remains false even when a production row exists', async () => {
  const store = createStore();
  store.transfers[0].provider_transfer_id = 'moov-tr-1';
  const result = await applyProductionMoovWebhook(identityClient(store), {
    type: 'transfer.completed',
    accountID: 'moov-freedom',
    data: { transferID: 'moov-tr-1', status: 'completed' },
  });
  assert.equal(result.applied, false);
  assert.equal(result.applyEnabled, false);
  assert.equal(result.financialTablesMutated, false);
});

test('readiness cannot create accounts or accept ToS', async () => {
  const store = createStore();
  const result = await withEnv(productionFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/moov-readiness', 'POST', { create_account: true, accept_tos: true }),
    '/functions/v1/moov-readiness',
    'POST',
    submitDeps(store),
  ));
  assert.equal(result.error, 'read_only_operation');
  assert.equal(store.processPosts, 0);
});

test('step-up matcher rejects a different transfer or amount', () => {
  const row = {
    tenant_id: FREEDOM_TENANT,
    action_key: 'disbursement.send',
    succeeded: true,
    metadata: { payment_transfer_id: TRANSFER_ID, amount_cents: 1 },
  };
  assert.equal(stepUpMatchesTransfer(row, {
    tenantId: FREEDOM_TENANT, transferId: TRANSFER_ID, amountCents: 1, actionKey: 'disbursement.send',
  }), true);
  assert.equal(stepUpMatchesTransfer(row, {
    tenantId: FREEDOM_TENANT, transferId: OTHER_TRANSFER_ID, amountCents: 1, actionKey: 'disbursement.send',
  }), false);
  assert.equal(stepUpMatchesTransfer(row, {
    tenantId: FREEDOM_TENANT, transferId: TRANSFER_ID, amountCents: 100, actionKey: 'disbursement.send',
  }), false);
});

test('dual-control records approval and does not move money', async () => {
  const store = createStore();
  const result = await handleFinancialRequest(
    jwtEvent('/financial/moov-dual-control', 'POST', { payment_transfer_id: TRANSFER_ID }),
    '/financial/moov-dual-control',
    'POST',
    submitDeps(store),
  );
  assert.equal(result.ok, true);
  assert.equal(result.liveProviderCalled, false);
  assert.equal(result.productionExecution, false);
  assert.equal(store.processPosts, 0);
  assert.equal(store.stepups[0].action_key, 'moov.dual_control');
});
