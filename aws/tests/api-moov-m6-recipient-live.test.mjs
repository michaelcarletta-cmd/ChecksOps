import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import {
  classifyLiveRecipientClass,
  evaluateRecipientReady,
} from '../functions/api/providers/production/moov-recipient-readiness.mjs';
import { LOOKUP_MAPPING_SQL, TENANT_MEMBERSHIP_SQL } from '../functions/api/identity.mjs';

const FREEDOM_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const FREEDOM_TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const C1C_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const PROD_RECIPIENT = '53a2be7e-0000-4000-8000-0000000078c5';
const SANDBOX_RECIPIENT = '3269bd10-0000-4000-8000-000000002562';
const RECIPIENT_ACCOUNT = 'd1adebb2-0000-4000-8000-0000000012db';

const jwtEvent = (pathName, method, body, extra = {}) => ({
  rawPath: pathName,
  headers: { authorization: extra.auth === null ? undefined : 'Bearer test-id-token' },
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

const liveReadFlags = {
  AWS_PROVIDER_LIVE_READS_ENABLED: 'true',
  AWS_PROVIDER_EXECUTION_ENABLED: 'false',
  AWS_MOOV_ENABLED: 'false',
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false',
  AWS_MOOV_ONBOARDING_WRITES_ENABLED: 'false',
  AWS_MOOV_WEBHOOK_APPLY_ENABLED: 'false',
  AWS_LOVABLE_MONEY_NEUTRALIZED: 'false',
};

const createStore = () => ({
  processPosts: 0,
  getGets: 0,
  getPaths: [],
  writeMethods: [],
  recipients: [
    {
      id: PROD_RECIPIENT,
      tenant_id: FREEDOM_TENANT,
      environment: 'production',
      onboarding_status: 'awaiting_bank',
      recipient_type: 'individual',
      display_name: 'Freedom test payee',
      provider_account_id: RECIPIENT_ACCOUNT,
      bank_linked_at: '2026-08-30T19:13:38.421Z',
      provider_last_four: '1506',
    },
    {
      id: SANDBOX_RECIPIENT,
      tenant_id: FREEDOM_TENANT,
      environment: 'sandbox',
      onboarding_status: 'awaiting_bank',
      recipient_type: 'individual',
      display_name: 'sandbox excluded',
      provider_account_id: 'f190ea55-0000-4000-8000-000000006184',
      bank_linked_at: null,
      provider_last_four: null,
    },
  ],
  memberships: [{ tenant_id: FREEDOM_TENANT, role: 'admin', tenant_name: 'Freedom', tenant_slug: 'freedom' }],
});

const identityClient = (store) => ({
  connect: async () => {},
  end: async () => {},
  query: async (sql, params = []) => {
    const text = String(sql);
    if (text === 'BEGIN' || text === 'ROLLBACK' || text === 'COMMIT' || text === 'SET TRANSACTION READ WRITE'
      || text.startsWith('SELECT set_config')) return { rows: [] };
    if (text === LOOKUP_MAPPING_SQL) {
      return params[0] === mapping.cognito_sub ? { rows: [mapping] } : { rows: [] };
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
    if (text.includes('FROM public.payment_wallets')) {
      return { rows: [{ id: 'w1', tenant_id: FREEDOM_TENANT, environment: 'production', status: 'active' }] };
    }
    if (text.includes('FROM public.external_payment_recipients')) {
      return { rows: params[0] === FREEDOM_TENANT ? store.recipients : [] };
    }
    if (text.includes('FROM public.payment_provider_methods')) return { rows: [] };
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
    return { ok: true, status: 200, text: async () => JSON.stringify({ transferID: 'nope' }) };
  }
  store.getGets += 1;
  store.getPaths.push(target.replace('https://api.moov.io', ''));
  if (target.includes(RECIPIENT_ACCOUNT) && target.includes('/bank-accounts')) {
    return { ok: true, status: 200, text: async () => JSON.stringify([{ status: 'pending', lastFourAccountNumber: '1506' }]) };
  }
  if (target.includes(RECIPIENT_ACCOUNT) && target.includes('/payment-methods')) {
    return { ok: true, status: 200, text: async () => JSON.stringify([]) };
  }
  if (target.includes(RECIPIENT_ACCOUNT) && target.includes('/capabilities')) {
    return { ok: true, status: 200, text: async () => JSON.stringify([{ capability: 'transfers', status: 'enabled' }]) };
  }
  if (target.endsWith(`/accounts/${RECIPIENT_ACCOUNT}`)) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        accountID: RECIPIENT_ACCOUNT,
        accountType: 'individual',
        mode: 'production',
        displayName: 'Freedom test payee',
        verification: { status: 'verified' },
        termsOfService: { acceptedDate: '2026-08-30T00:00:00Z' },
      }),
    };
  }
  if (target.includes('/wallets')) {
    return { ok: true, status: 200, text: async () => JSON.stringify([{ walletID: 'wallet-freedom', status: 'active', availableBalance: 0 }]) };
  }
  if (target.includes('/capabilities')) {
    return { ok: true, status: 200, text: async () => JSON.stringify([{ capability: 'send-funds', status: 'enabled' }]) };
  }
  if (target.includes('/bank-accounts')) {
    return { ok: true, status: 200, text: async () => JSON.stringify([{ status: 'verified', lastFourAccountNumber: '4573' }]) };
  }
  if (target.includes('/payment-methods')) {
    return { ok: true, status: 200, text: async () => JSON.stringify([{ paymentMethodType: 'ach-credit-standard' }]) };
  }
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      accountID: '60922058-7eca-4889-81dd-5720d7b9de96',
      accountType: 'business',
      mode: 'production',
      displayName: 'Freedom Adjustment LLC',
      verification: { status: 'verified' },
      termsOfService: { acceptedDate: '2026-08-28T18:36:52.907203Z' },
    }),
  };
};

const invoke = (store, body = {}, extra = {}) => withEnv(liveReadFlags, () => handleProviderRequest(
  jwtEvent('/functions/v1/moov-readiness', 'POST', body, extra),
  '/functions/v1/moov-readiness',
  'POST',
  {
    createClient: () => identityClient(store),
    loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'x', password: 'x', database: 'checksops' }),
    fetchImpl: fetchImpl(store),
    loadProductionReadSecrets: async () => ({
      ok: true,
      contract: 'read',
      credentials: {
        environment: 'production',
        host: 'https://api.moov.io',
        publicKey: 'prod-public',
        secretKey: 'prod-secret',
        origin: 'https://checksops.com',
        apiVersion: 'v2024.01.00',
      },
    }),
  },
));

test('M6 class: local last4 is not READY; pending bank is BANK_UNVERIFIED', () => {
  const evaluation = evaluateRecipientReady({
    account: {
      mode: 'production',
      verification: { status: 'verified' },
      termsOfService: { acceptedDate: '2026-08-30T00:00:00Z' },
    },
    banks: [{ status: 'pending' }],
    paymentMethods: [],
  });
  assert.equal(evaluation.ready, false);
  const klass = classifyLiveRecipientClass({
    local: { provider_last_four: '1506', bank_linked_at: '2026-08-30', onboarding_status: 'awaiting_bank' },
    evaluation,
    banks: [{ status: 'pending' }],
  });
  assert.equal(klass, 'BANK_UNVERIFIED');
});

test('M6 class: local last4 with no live bank is BROKEN_LOCAL_SYNC', () => {
  const evaluation = evaluateRecipientReady({
    account: {
      mode: 'production',
      verification: { status: 'verified' },
      termsOfService: { acceptedDate: '2026-08-30T00:00:00Z' },
    },
    banks: [],
    paymentMethods: [],
  });
  const klass = classifyLiveRecipientClass({
    local: { provider_last_four: '1506', bank_linked_at: '2026-08-30' },
    evaluation,
    banks: [],
  });
  assert.equal(klass, 'BROKEN_LOCAL_SYNC');
});

test('M6 class: unverified identity is AWAITING_KYC', () => {
  const evaluation = evaluateRecipientReady({
    account: { mode: 'production', verification: { status: 'pending' }, termsOfService: { acceptedDate: '2026-08-30T00:00:00Z' } },
    banks: [{ status: 'verified' }],
    paymentMethods: [{ paymentMethodType: 'ach-credit-standard', status: 'enabled' }],
  });
  assert.equal(classifyLiveRecipientClass({ evaluation, banks: [{ status: 'verified' }] }), 'AWAITING_KYC');
});

test('M6 class: ToS missing is AWAITING_TOS', () => {
  const evaluation = evaluateRecipientReady({
    account: { mode: 'production', verification: { status: 'verified' }, termsOfService: {} },
    banks: [{ status: 'verified' }],
    paymentMethods: [{ paymentMethodType: 'ach-credit-standard', status: 'enabled' }],
  });
  assert.equal(classifyLiveRecipientClass({ evaluation, banks: [{ status: 'verified' }] }), 'AWAITING_TOS');
});

test('M6 class: verified bank without ACH credit PM is NO_ELIGIBLE_PAYMENT_METHOD', () => {
  const evaluation = evaluateRecipientReady({
    account: {
      mode: 'production',
      verification: { status: 'verified' },
      termsOfService: { acceptedDate: '2026-08-30T00:00:00Z' },
    },
    banks: [{ status: 'verified' }],
    paymentMethods: [{ paymentMethodType: 'moov-wallet' }],
  });
  assert.equal(classifyLiveRecipientClass({ evaluation, banks: [{ status: 'verified' }] }), 'NO_ELIGIBLE_PAYMENT_METHOD');
});

test('opt-in recipient_live_gets GETs production recipients only; skips sandbox; no mutation', async () => {
  const store = createStore();
  const baselineGets = (await invoke(store, {})).ok;
  assert.equal(baselineGets, true);
  const afterBaseline = store.getGets;
  const live = await invoke(store, { recipient_live_gets: true });
  assert.equal(live.ok, true);
  assert.equal(live.mutated, false);
  assert.equal(live.recipient_live_gets, true);
  assert.equal(live.sandbox_recipient_used, false);
  assert.equal(live.c1c_used, false);
  assert.equal(store.processPosts, 0);
  assert.ok(live.live_recipients.some((row) => row.skipped && row.reason === 'sandbox_recipient_excluded'));
  const prod = live.live_recipients.find((row) => row.recipient_id === PROD_RECIPIENT);
  assert.equal(prod.class, 'BANK_UNVERIFIED');
  assert.equal(prod.ready, false);
  assert.equal(prod.local.last4, '1506');
  assert.equal(prod.live_account.mode, 'production');
  assert.ok(store.getPaths.some((path) => path.includes(`/accounts/${RECIPIENT_ACCOUNT}/bank-accounts`)));
  assert.ok(store.getGets > afterBaseline);
});

test('recipient_id live GET is tenant-scoped and ignores unknown ids', async () => {
  const store = createStore();
  const owned = await invoke(store, { recipient_live_gets: true, recipient_id: PROD_RECIPIENT });
  assert.equal(owned.ok, true);
  assert.equal(owned.mutated, false);
  assert.equal(owned.live_recipients.length, 1);
  assert.equal(owned.live_recipients[0].recipient_id, PROD_RECIPIENT);
  const unknown = await invoke(createStore(), {
    recipient_live_gets: true,
    recipient_id: '00000000-0000-4000-8000-000000000000',
  });
  assert.equal(unknown.live_recipients[0].reason, 'recipient_not_owned');
  assert.equal(unknown.live_recipients[0].liveProviderCalled, false);
});

test('browser Moov ids rejected; C1C denied; default readiness does not live-GET recipients', async () => {
  const store = createStore();
  const spoof = await invoke(store, { recipient_live_gets: true, moov_account_id: 'browser' });
  assert.equal(spoof.error, 'untrusted_provider_config');
  const cross = await invoke(store, { recipient_live_gets: true, tenant_id: C1C_TENANT });
  assert.equal(cross.error, 'cross_tenant_denied');
  const store2 = createStore();
  const def = await invoke(store2, {});
  assert.equal(def.live_recipients, null);
  assert.equal(def.recipient_live_gets, false);
  assert.ok(!store2.getPaths.some((path) => path.includes(RECIPIENT_ACCOUNT)));
});
