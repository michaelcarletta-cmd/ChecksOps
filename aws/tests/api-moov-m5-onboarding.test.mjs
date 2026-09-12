import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL } from '../functions/api/identity.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import { hmacHex } from '../functions/api/providers/hmac.mjs';
import {
  lovableMoneyNeutralized,
  moovOnboardingWritesEnabled,
  moovWebhookApplyEnabled,
  productionMoovExecutionAllowed,
  productionMoovOnboardingWritesAllowed,
} from '../functions/api/providers/production/moov-holds.mjs';
import {
  evaluateRecipientReady,
  explainAwaitingBank,
} from '../functions/api/providers/production/moov-recipient-readiness.mjs';
import {
  classifyRecipientInvite,
  hashRecipientInviteToken,
  mintRecipientInviteToken,
  noteRecipientTokenFailure,
  recipientTokenRateLimited,
  RECIPIENT_TOKEN_MAX_FAILURES,
  resetRecipientTokenRateLimit,
} from '../functions/api/providers/production/moov-recipient-token.mjs';
import {
  applyProductionMoovWebhook,
  eventCreatesTransfer,
  intendedWebhookMutations,
  transferStatusRank,
} from '../functions/api/providers/production/moov-webhook-apply.mjs';
import { assertOnboardMoovRequest, assertReadOnlyMoovRequest } from '../functions/api/providers/production/moov-client.mjs';
import { rejectBrowserTosForge, rejectUntrustedMoovAccountFields } from '../functions/api/providers/production/moov-untrusted.mjs';
import { classifyWalletOperation, WALLET_OP } from '../functions/api/providers/production/moov-wallet-foundation.mjs';

const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const C1C_SUB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const C1C_APP = 'fd857564-0000-4000-8000-000000000001';
const RECIPIENT_ID = '33333333-3333-4333-8333-333333333333';
const INVITE_PLAIN = 'a'.repeat(64);

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
  AWS_MOOV_ONBOARDING_WRITES_ENABLED: undefined,
  AWS_MOOV_WEBHOOK_APPLY_ENABLED: undefined,
  AWS_LOVABLE_MONEY_NEUTRALIZED: undefined,
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
};

const createStore = () => ({
  memberships: [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
  mapping,
  recipients: [{
    id: RECIPIENT_ID,
    tenant_id: FREEDOM_TENANT,
    provider: 'moov',
    environment: 'production',
    onboarding_status: 'awaiting_bank',
    provider_account_id: 'moov-recipient-1',
    bank_linked_at: '2026-09-01T00:00:00Z',
    provider_last_four: '1506',
    secure_token: INVITE_PLAIN,
    display_name: 'Payee',
    token_expires_at: new Date(Date.now() + 86400000).toISOString(),
    disconnected_at: null,
  }],
  transfers: [],
  receipts: [],
  processPosts: 0,
  getGets: 0,
  getPaths: [],
  writeMethods: [],
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
      if (params[0] === mapping.cognito_sub) return { rows: [mapping] };
      return { rows: [] };
    }
    if (text === TENANT_MEMBERSHIP_SQL || text.includes('FROM public.tenant_users tu')) {
      return { rows: store.memberships };
    }
    if (text.includes('FROM public.user_roles')) return { rows: [{ role: 'admin' }] };
    if (text.includes('FROM public.tenant_users WHERE user_id') && text.includes('AND tenant_id')) {
      const match = store.memberships.find((row) => row.tenant_id === params[1]);
      return { rows: match ? [{ role: match.role }] : [] };
    }
    if (text.includes('FROM public.payment_provider_accounts')) {
      if (params[0] !== FREEDOM_TENANT) return { rows: [] };
      return {
        rows: [{
          id: '60922058-7eca-4889-81dd-5720d7b9de96',
          tenant_id: FREEDOM_TENANT,
          provider: 'moov',
          environment: 'production',
          provider_account_id: 'moov-freedom',
          disabled: false,
          restricted: false,
        }],
      };
    }
    if (text.includes('FROM public.external_payment_recipients')) {
      if (params[0] === FREEDOM_TENANT) return { rows: store.recipients };
      const token = params[0];
      const found = store.recipients.find((row) => row.secure_token === token
        || row.secure_token === params[1]
        || row.secure_token === params[2]);
      return { rows: found ? [found] : [] };
    }
    if (text.includes('INSERT INTO public.aws_provider_webhook_receipts')) {
      store.receipts = store.receipts || [];
      const existing = store.receipts.find((row) => row.provider === params[0] && row.external_event_id === params[1]);
      if (existing) return { rows: [] };
      const row = { id: crypto.randomUUID(), provider: params[0], external_event_id: params[1] };
      store.receipts.push(row);
      return { rows: [row] };
    }
    if (text.includes('FROM public.aws_provider_webhook_receipts')) {
      const found = (store.receipts || []).find((row) => row.provider === params[0] && row.external_event_id === params[1]);
      return { rows: found ? [found] : [] };
    }
    if (text.includes('FROM public.payment_transfers')) return { rows: store.transfers };
    if (text.includes('UPDATE public.payment_transfers') || text.includes('UPDATE public.external_payment_recipients')) {
      store.writes = (store.writes || 0) + 1;
      return { rows: [] };
    }
    return { rows: [] };
  },
});

const fetchImpl = (store) => async (url, options = {}) => {
  const target = String(url);
  const method = String(options.method || 'GET').toUpperCase();
  if (target.includes('/oauth2/token')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok', expires_in: 300 }) };
  }
  if (method !== 'GET') {
    store.writeMethods.push(method);
    store.processPosts += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ accountID: 'should-not' }) };
  }
  store.getGets += 1;
  store.getPaths.push(target);
  if (target.includes('/bank-accounts')) {
    return { ok: true, status: 200, text: async () => JSON.stringify([{ status: 'pending', verificationStatus: 'pending', lastFourAccountNumber: '1506' }]) };
  }
  if (target.includes('/payment-methods')) {
    return { ok: true, status: 200, text: async () => JSON.stringify([]) };
  }
  if (target.includes('/capabilities')) {
    return { ok: true, status: 200, text: async () => JSON.stringify([{ capability: 'transfers', status: 'enabled' }]) };
  }
  if (target.includes('/files')) {
    return { ok: true, status: 200, text: async () => JSON.stringify([{ fileID: 'f1', filePurpose: 'business_verification', status: 'pending' }]) };
  }
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      accountID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      mode: 'production',
      disabled: false,
      restricted: false,
      verification: { status: 'unverified' },
      termsOfService: {},
    }),
  };
};

const depsFor = (store) => ({
  createClient: () => identityClient(store),
  loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
  fetchImpl: fetchImpl(store),
  loadProductionReadSecrets: async () => ({
    ok: true,
    credentials: {
      environment: 'production',
      host: 'https://api.moov.io',
      publicKey: 'prod-public',
      secretKey: 'prod-secret',
      origin: 'https://checksops.com',
      apiVersion: 'v2024.01.00',
    },
  }),
});

const invoke = (store, name, body = {}, extra = {}) => withEnv(liveReadFlags, () => handleProviderRequest(
  jwtEvent(`/functions/v1/${name}`, 'POST', body, extra),
  `/functions/v1/${name}`,
  'POST',
  depsFor(store),
));

test('M5 holds default false; money still blocked without Lovable neutralization', () => {
  assert.equal(moovOnboardingWritesEnabled(), false);
  assert.equal(moovWebhookApplyEnabled(), false);
  assert.equal(lovableMoneyNeutralized(), false);
  assert.equal(productionMoovOnboardingWritesAllowed(), false);
  assert.equal(productionMoovExecutionAllowed(), false);
});

test('money flags without AWS_LOVABLE_MONEY_NEUTRALIZED stay blocked', async () => {
  const allowed = await withEnv({
    AWS_PROVIDER_EXECUTION_ENABLED: 'true',
    AWS_MOOV_ENABLED: 'true',
    AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
    AWS_LOVABLE_MONEY_NEUTRALIZED: undefined,
  }, () => productionMoovExecutionAllowed());
  assert.equal(allowed, false);
});

test('cross-tenant onboarding write denied; browser Moov ids rejected', async () => {
  const store = createStore();
  const cross = await invoke(store, 'moov-account-create', { tenant_id: C1C_TENANT });
  assert.equal(cross.error, 'cross_tenant_denied');
  assert.equal(store.processPosts, 0);
  const spoof = await invoke(store, 'moov-account-onboard', {
    tenant_id: FREEDOM_TENANT,
    moov_account_id: 'browser',
    platform_account_id: 'browser-platform',
  });
  assert.equal(spoof.error, 'untrusted_provider_config');
  assert.equal(store.processPosts, 0);
});

test('unauthorized onboarding writes fail closed behind dedicated hold', async () => {
  const store = createStore();
  for (const name of [
    'moov-account-create', 'moov-account-onboard', 'moov-tos-token', 'moov-tos-accept',
    'moov-bank-link-token', 'moov-bank-account-add', 'moov-micro-deposit-initiate',
    'moov-micro-deposit-confirm', 'moov-recipient-create', 'moov-account-file-upload',
  ]) {
    const result = await invoke(store, name, { tenant_id: FREEDOM_TENANT, terms_of_service_token: 'token-from-drop-xx' });
    assert.equal(result.error, 'production_onboarding_blocked', name);
    assert.equal(result.liveProviderCalled, false, name);
  }
  assert.equal(store.processPosts, 0);
});

test('ToS cannot be forged with accepted=true', () => {
  const forged = rejectBrowserTosForge({ accepted: true });
  assert.equal(forged.error, 'tos_acceptance_forged');
  assert.equal(rejectBrowserTosForge({ terms_of_service_token: 'long-enough-token' }), null);
});

test('public recipient session does not require Cognito; mutations stay held', async () => {
  const store = createStore();
  const session = await withEnv(liveReadFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/moov-recipient-session', 'POST', { token: INVITE_PLAIN }, { auth: null }),
    '/functions/v1/moov-recipient-session',
    'POST',
    depsFor(store),
  ));
  assert.equal(session.cognito_required, false);
  assert.equal(session.public_recipient, true);
  assert.equal(session.financial_execution, false);
  assert.equal(session.readiness.ready, false);
  const kyc = await withEnv(liveReadFlags, () => handleProviderRequest(
    jwtEvent('/functions/v1/moov-recipient-kyc-update', 'POST', { token: INVITE_PLAIN, first_name: 'A' }, { auth: null }),
    '/functions/v1/moov-recipient-kyc-update',
    'POST',
    depsFor(store),
  ));
  assert.equal(kyc.error, 'production_onboarding_blocked');
  assert.equal(store.processPosts, 0);
});

test('expired, revoked, and unknown recipient tokens are rejected without tenant enumeration', () => {
  resetRecipientTokenRateLimit();
  const minted = mintRecipientInviteToken({ nowMs: 1_000 });
  assert.equal(minted.entropy_bits, 256);
  assert.equal(hashRecipientInviteToken(minted.plaintext).length, 64);
  const expired = classifyRecipientInvite({
    recipient: { id: 'r', tenant_id: FREEDOM_TENANT, secure_token: minted.plaintext, token_expires_at: new Date(0).toISOString() },
    presentedToken: minted.plaintext,
    nowMs: Date.now(),
  });
  assert.equal(expired.error, 'invite_expired');
  const revoked = classifyRecipientInvite({
    recipient: { id: 'r', onboarding_status: 'disconnected', secure_token: minted.plaintext },
    presentedToken: minted.plaintext,
  });
  assert.equal(revoked.error, 'invite_revoked');
  const missing = classifyRecipientInvite({ recipient: null, presentedToken: 'nope' });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.error, 'invite_not_found');
});

test('recipient token failures are rate limited', () => {
  resetRecipientTokenRateLimit();
  for (let i = 0; i < RECIPIENT_TOKEN_MAX_FAILURES; i += 1) noteRecipientTokenFailure({ ip: '1.1.1.1', nowMs: 1000 + i });
  assert.equal(recipientTokenRateLimited({ ip: '1.1.1.1', nowMs: 2000 }), true);
  assert.equal(recipientTokenRateLimited({ ip: '8.8.8.8', nowMs: 2000 }), false);
});

test('READY predicate ignores last4 and bank_linked_at', () => {
  const local = { onboarding_status: 'awaiting_bank', provider_last_four: '1506', bank_linked_at: '2026-09-01' };
  const liveIncomplete = {
    account: { mode: 'production', verification: { status: 'unverified' }, termsOfService: {} },
    banks: [{ status: 'pending' }],
    paymentMethods: [],
  };
  const explanation = explainAwaitingBank({ local, live: liveIncomplete });
  assert.equal(explanation.local_last4_present, true);
  assert.equal(explanation.local_insufficient_for_ready, true);
  assert.equal(explanation.live.ready, false);
  const ready = evaluateRecipientReady({
    account: {
      mode: 'production', disabled: false, restricted: false,
      verification: { status: 'verified' },
      termsOfService: { acceptedDate: '2026-08-28T00:00:00Z' },
    },
    banks: [{ status: 'verified', verificationStatus: 'verified' }],
    paymentMethods: [{ paymentMethodType: 'ach-credit-standard', status: 'enabled' }],
    capabilities: [{ capability: 'transfers', status: 'enabled' }],
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.verdict, 'RECIPIENT_READY');
});

test('GET-only recipient readiness uses live Moov and does not mutate', async () => {
  const store = createStore();
  const result = await invoke(store, 'moov-recipient-readiness', { tenant_id: FREEDOM_TENANT });
  assert.equal(result.ok, true);
  assert.equal(result.mutated, false);
  assert.equal(result.recipients[0].readiness.ready, false);
  assert.equal(result.recipients[0].explanation.local_insufficient_for_ready, true);
  assert.equal(store.processPosts, 0);
  const spoof = await invoke(store, 'moov-recipient-readiness', { tenant_id: FREEDOM_TENANT, moov_account_id: 'x' });
  assert.equal(spoof.error, 'untrusted_provider_config');
});

test('wallet foundation distinguishes BALANCE_READ from funding/transfer/disburse/sweep', async () => {
  assert.equal(classifyWalletOperation('moov-wallet-activity'), WALLET_OP.BALANCE_READ);
  assert.equal(classifyWalletOperation('initiate-wallet-funding'), WALLET_OP.FUNDING);
  assert.equal(classifyWalletOperation('moov-transfer-create'), WALLET_OP.TRANSFER);
  assert.equal(classifyWalletOperation('moov-disburse'), WALLET_OP.DISBURSEMENT);
  assert.equal(classifyWalletOperation('moov-sweep-config'), WALLET_OP.SWEEP);
  const store = createStore();
  const activity = await invoke(store, 'moov-wallet-activity', { tenant_id: FREEDOM_TENANT });
  assert.equal(activity.operation, 'BALANCE_READ');
  assert.equal(activity.funding_held, true);
  assert.equal(activity.sweep_held, true);
  const fund = await invoke(store, 'initiate-wallet-funding', { tenant_id: FREEDOM_TENANT });
  assert.equal(fund.error, 'production_execution_blocked');
  const sweep = await invoke(store, 'moov-sweep-config', { tenant_id: FREEDOM_TENANT });
  assert.equal(sweep.error, 'production_execution_blocked');
});

test('onboard mode cannot hit transfer paths; GET files allowed', () => {
  assert.throws(
    () => assertOnboardMoovRequest({ method: 'POST', path: '/accounts/x/transfers' }),
    (error) => error.code === 'onboard_path_denied' || error.code === 'onboard_transfer_denied',
  );
  assert.doesNotThrow(() => assertReadOnlyMoovRequest({ method: 'GET', path: '/accounts/x/files' }));
  assert.doesNotThrow(() => assertOnboardMoovRequest({ method: 'POST', path: '/accounts' }));
});

test('webhook duplicate/out-of-order/create-transfer protections; apply stays false', async () => {
  assert.equal(eventCreatesTransfer({ type: 'transfer.create' }), true);
  assert.ok(transferStatusRank('completed') > transferStatusRank('pending'));
  const planned = intendedWebhookMutations(
    { type: 'bankAccount.updated', data: { status: 'verified' } },
    { recipient: { id: 'r', onboarding_status: 'awaiting_bank' }, liveReadiness: { account: {} } },
  );
  assert.equal(planned.mutations[0].to, 'awaiting_bank');
  assert.equal(planned.mutations[0].requires_full_predicate, true);

  const store = createStore();
  store.transfers = [{
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    tenant_id: FREEDOM_TENANT,
    status: 'completed',
    environment: 'production',
    provider_transfer_id: 'moov-tr-1',
  }];
  const apply = await applyProductionMoovWebhook(identityClient(store), {
    type: 'transfer.updated',
    data: { transferID: 'moov-tr-1', status: 'pending' },
  });
  assert.equal(apply.applied, false);
  assert.equal(apply.createdTransfer, false);
  assert.equal(apply.reconciliationCandidate.out_of_order, true);
  assert.equal(store.writes || 0, 0);

  process.env.AWS_MOOV_WEBHOOK_SECRET = 'staging-webhook-secret';
  const webhookId = 'evt_m5';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'n5';
  const payload = { eventID: webhookId, type: 'transfer.created', data: { transferID: 'moov-tr-1' } };
  const signature = hmacHex('staging-webhook-secret', `${timestamp}|${nonce}|${webhookId}`, 'sha512');
  const first = await withEnv(liveReadFlags, () => handleProviderRequest({
    rawPath: '/webhooks/moov',
    headers: { 'x-webhook-id': webhookId, 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-signature': signature },
    body: JSON.stringify(payload),
    requestContext: { stage: 'staging', http: { method: 'POST', path: '/webhooks/moov' } },
  }, '/webhooks/moov', 'POST', depsFor(store)));
  const second = await withEnv(liveReadFlags, () => handleProviderRequest({
    rawPath: '/webhooks/moov',
    headers: { 'x-webhook-id': webhookId, 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-signature': signature },
    body: JSON.stringify(payload),
    requestContext: { stage: 'staging', http: { method: 'POST', path: '/webhooks/moov' } },
  }, '/webhooks/moov', 'POST', depsFor(store)));
  assert.equal(first.applied, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.applied, false);
  delete process.env.AWS_MOOV_WEBHOOK_SECRET;
});

test('capability request and KYC/KYB writes remain dark', async () => {
  const store = createStore();
  const under = await invoke(store, 'moov-underwriting', { tenant_id: FREEDOM_TENANT, action: 'save' });
  assert.equal(under.error, 'production_onboarding_blocked');
  const ids = rejectUntrustedMoovAccountFields({ accountId: 'x' });
  assert.equal(ids.error, 'untrusted_provider_config');
  assert.equal(store.processPosts, 0);
});
