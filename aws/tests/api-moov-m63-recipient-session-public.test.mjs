import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { handlePublicMoovRecipientSession } from '../functions/api/public-moov-recipient-session.mjs';
import { requestPath } from '../functions/api/index.mjs';

const RECIPIENT_ID = '62a858ff-ee6a-49d7-9898-1c8e4a44227b';
const ACCOUNT_ID = 'ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f';
const TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const INDEX = readFileSync(new URL('../functions/api/index.mjs', import.meta.url), 'utf8');
const UI = readFileSync(new URL('../../src/pages/RecipientPaymentSetup.tsx', import.meta.url), 'utf8');
const API = readFileSync(new URL('../../src/lib/recipientSessionApi.ts', import.meta.url), 'utf8');
const HANDLER = readFileSync(new URL('../functions/api/public-moov-recipient-session.mjs', import.meta.url), 'utf8');

const eventOf = (body = {}, extra = {}) => ({
  headers: extra.headers || {},
  body: JSON.stringify(body),
  requestContext: {
    stage: 'prep',
    http: { method: 'POST', path: '/public/moov-recipient-session' },
  },
});

const mockClient = (recipientRow, tenantRow = { name: 'Freedom Adjustment', logo_url: null, primary_color: null, secondary_color: null }) => ({
  query: async (sql) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    if (/^BEGIN|ROLLBACK|COMMIT/i.test(compact.trim())) return { rows: [] };
    if (compact.includes('FROM public.external_payment_recipients')) {
      return { rows: recipientRow ? [recipientRow] : [] };
    }
    if (compact.includes('FROM public.tenants')) {
      return { rows: tenantRow ? [tenantRow] : [] };
    }
    return { rows: [] };
  },
  connect: async () => {},
  end: async () => {},
});

const productionRecipient = {
  id: RECIPIENT_ID,
  tenant_id: TENANT_ID,
  display_name: 'Recipient',
  provider_account_id: ACCOUNT_ID,
  token_expires_at: new Date(Date.now() + 86400000).toISOString(),
  token_used_at: null,
  onboarding_status: 'awaiting_bank',
  environment: 'production',
  bank_linked_at: '2026-09-02T15:05:35.512Z',
  provider_bank_name: 'Chase',
  provider_last_four: '1506',
};

const secrets = {
  ok: true,
  credentials: {
    environment: 'production',
    host: 'https://api.moov.io',
    publicKey: 'pk_test_read',
    secretKey: 'sk_test_read',
    origin: 'https://checksops.com',
    platformAccountId: null,
    apiVersion: 'v2024.01.00',
  },
};

const fetchImpl = async (url, init = {}) => {
  const method = String(init.method || 'GET').toUpperCase();
  const path = String(url).replace('https://api.moov.io', '');
  fetchImpl.calls.push({ method, path });
  if (path === '/oauth2/token') {
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ access_token: 'token', token_type: 'Bearer', expires_in: 300 }),
    };
  }
  const jsonFor = () => {
    if (path === `/accounts/${ACCOUNT_ID}`) {
      return {
        accountID: ACCOUNT_ID,
        accountType: 'individual',
        mode: 'production',
        verification: { status: 'unverified' },
        termsOfService: {},
      };
    }
    if (path === `/accounts/${ACCOUNT_ID}/capabilities`) {
      return [{
        capability: 'send-funds',
        status: 'pending',
        requirements: ['account.tos-acceptance', 'individual.address', 'individual.birthdate', 'individual.ssn'],
      }, { capability: 'transfers', status: 'enabled', requirements: [] }];
    }
    if (path === `/accounts/${ACCOUNT_ID}/bank-accounts`) {
      return [{ bankAccountID: 'bank-1', status: 'new', lastFourAccountNumber: '1506', bankName: 'Chase' }];
    }
    if (path === `/accounts/${ACCOUNT_ID}/payment-methods`) {
      return [{ paymentMethodType: 'ach-credit-standard' }];
    }
    return {};
  };
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(jsonFor()),
  };
};
fetchImpl.calls = [];

const withLiveReads = async (fn) => {
  const prev = process.env.AWS_PROVIDER_LIVE_READS_ENABLED;
  const sandbox = process.env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED;
  process.env.AWS_PROVIDER_LIVE_READS_ENABLED = 'true';
  process.env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED = 'false';
  try {
    return await fn();
  } finally {
    process.env.AWS_PROVIDER_LIVE_READS_ENABLED = prev;
    process.env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED = sandbox;
  }
};

test('public route is registered without Cognito and page-load uses it', () => {
  assert.match(INDEX, /path === '\/public\/moov-recipient-session'/);
  assert.match(INDEX, /handlePublicMoovRecipientSession/);
  assert.equal(requestPath({
    rawPath: '/public/moov-recipient-session',
    requestContext: { stage: 'prep', http: { path: '/public/moov-recipient-session' } },
  }), '/public/moov-recipient-session');
  assert.match(UI, /loadRecipientSession\(token/);
  assert.doesNotMatch(UI.slice(UI.indexOf('async function load()'), UI.indexOf('useEffect(() => { void load(); }')), /invoke\("moov-recipient/);
  assert.match(API, /\/public\/moov-recipient-session/);
  assert.match(UI, /invoke\("moov-recipient-kyc-update"/);
  assert.match(UI, /invoke\("moov-recipient-tos-accept"/);
  assert.match(UI, /invoke\("moov-recipient-bank-add"/);
  assert.match(UI, /invoke\("moov-recipient-bank-verify"/);
});

test('dummy token fails closed without JWT and without Moov HTTP', async () => {
  await withLiveReads(async () => {
    const result = await handlePublicMoovRecipientSession(eventOf({ token: 'x' }), {
      client: mockClient(null),
      loadProductionReadSecrets: async () => secrets,
      fetchImpl,
    });
    assert.equal(result.statusCode, 404);
    assert.equal(result.error, 'This link is not valid.');
    assert.equal(result.cognito_required, false);
    assert.equal(result.mutated, false);
    assert.equal(result.token_consumed, false);
    assert.equal(result.liveProviderCalled, false);
  });
});

test('missing token is 400; browser Moov ids are rejected; mutations refused', async () => {
  await withLiveReads(async () => {
    const missing = await handlePublicMoovRecipientSession(eventOf({}), { client: mockClient(null) });
    assert.equal(missing.statusCode, 400);
    const spoof = await handlePublicMoovRecipientSession(eventOf({
      token: 'abc',
      provider_account_id: ACCOUNT_ID,
    }), { client: mockClient(productionRecipient) });
    assert.equal(spoof.statusCode, 400);
    assert.equal(spoof.error, 'untrusted_provider_config');
    assert.equal(spoof.liveProviderCalled, false);
    const mutate = await handlePublicMoovRecipientSession(eventOf({
      token: 'abc',
      verify_bank: true,
    }), { client: mockClient(productionRecipient) });
    assert.equal(mutate.statusCode, 400);
    assert.equal(mutate.error, 'read_only_operation');
  });
});

test('used and expired tokens fail closed without consuming or calling Moov', async () => {
  await withLiveReads(async () => {
    fetchImpl.calls = [];
    const used = await handlePublicMoovRecipientSession(eventOf({ token: 'used-token' }), {
      client: mockClient({ ...productionRecipient, token_used_at: '2026-09-10T00:00:00Z' }),
      loadProductionReadSecrets: async () => secrets,
      fetchImpl,
    });
    assert.equal(used.statusCode, 410);
    assert.equal(used.liveProviderCalled, false);
    const expired = await handlePublicMoovRecipientSession(eventOf({ token: 'expired-token' }), {
      client: mockClient({ ...productionRecipient, token_expires_at: '2020-01-01T00:00:00Z' }),
      loadProductionReadSecrets: async () => secrets,
      fetchImpl,
      nowMs: Date.now(),
    });
    assert.equal(expired.statusCode, 410);
    assert.equal(fetchImpl.calls.length, 0);
  });
});

test('valid production token GETs account/capabilities/banks/methods and matches frontend contract', async () => {
  await withLiveReads(async () => {
    fetchImpl.calls = [];
    const result = await handlePublicMoovRecipientSession(eventOf({ token: 'live-token' }), {
      client: mockClient(productionRecipient),
      loadProductionReadSecrets: async () => secrets,
      fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 200);
    assert.equal(result.success, true);
    assert.equal(result.recipient.id, RECIPIENT_ID);
    assert.equal(result.account_id, ACCOUNT_ID);
    assert.equal(result.environment, 'production');
    assert.equal(result.onboarding.verification_status, 'unverified');
    assert.equal(result.onboarding.terms_accepted, false);
    assert.equal(result.onboarding.bank_status, 'new');
    assert.equal(result.recipient.last_four, '1506');
    assert.equal(result.token_consumed, false);
    assert.equal(result.mutated, false);
    assert.equal(result.productionExecution, false);
    assert.equal(result.cognito_required, false);
    assert.equal(result.token, null);
    assert.ok(result.onboarding.identity_requirements_outstanding.includes('individual.ssn'));
    const methods = fetchImpl.calls.map((row) => row.method);
    assert.ok(methods.includes('POST'));
    assert.ok(fetchImpl.calls.some((row) => row.path === '/oauth2/token' && row.method === 'POST'));
    assert.ok(fetchImpl.calls.some((row) => row.path === `/accounts/${ACCOUNT_ID}` && row.method === 'GET'));
    assert.ok(fetchImpl.calls.some((row) => row.path.endsWith('/capabilities') && row.method === 'GET'));
    assert.ok(fetchImpl.calls.some((row) => row.path.endsWith('/bank-accounts') && row.method === 'GET'));
    assert.ok(fetchImpl.calls.some((row) => row.path.endsWith('/payment-methods') && row.method === 'GET'));
    assert.equal(methods.filter((row) => row !== 'GET' && row !== 'POST').length, 0);
    assert.equal(fetchImpl.calls.filter((row) => row.method === 'POST' && row.path !== '/oauth2/token').length, 0);
  });
});

test('handler source stays GET-only and never writes token_used_at', () => {
  assert.doesNotMatch(HANDLER, /method:\s*'PATCH'/);
  assert.doesNotMatch(HANDLER, /method:\s*'PUT'/);
  assert.doesNotMatch(HANDLER, /method:\s*'DELETE'/);
  assert.doesNotMatch(HANDLER, /token_used_at =/);
  assert.doesNotMatch(HANDLER, /UPDATE public.external_payment_recipients/);
  assert.match(HANDLER, /mode: 'read'/);
  assert.match(HANDLER, /ROLLBACK/);
  assert.match(HANDLER, /resolveProductionRecipientByToken/);
});

test('production token resolve is used when RDS is not passed', async () => {
  await withLiveReads(async () => {
    fetchImpl.calls = [];
    const result = await handlePublicMoovRecipientSession(eventOf({ token: 'live-token' }), {
      resolveRecipientByToken: async () => ({
        ok: true,
        recipient: productionRecipient,
        tenant: { name: 'Freedom Adjustment', logo_url: null, primary_color: null, secondary_color: null },
      }),
      loadProductionReadSecrets: async () => secrets,
      fetchImpl,
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.success, true);
    assert.equal(result.recipient.id, RECIPIENT_ID);
    assert.equal(result.account_id, ACCOUNT_ID);
    assert.equal(result.environment, 'production');
    assert.equal(result.onboarding.verification_status, 'unverified');
    assert.equal(result.token_consumed, false);
    assert.equal(result.mutated, false);
  });
});

test('invalid production token fails closed without Moov HTTP', async () => {
  await withLiveReads(async () => {
    fetchImpl.calls = [];
    const result = await handlePublicMoovRecipientSession(eventOf({ token: 'x' }), {
      resolveRecipientByToken: async () => ({
        ok: false,
        error: 'This link is not valid.',
        statusCode: 404,
      }),
      fetchImpl,
    });
    assert.equal(result.statusCode, 404);
    assert.equal(result.liveProviderCalled, false);
    assert.equal(result.mutated, false);
    assert.equal(fetchImpl.calls.length, 0);
  });
});
