import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  handlePublicMoovRecipientKycUpdate,
  handlePublicMoovRecipientTosAccept,
  handlePublicMoovRecipientTosToken,
} from '../functions/api/public-moov-recipient-kyc-tos.mjs';
import {
  assertRecipientOnboardingWrite,
  productionMoovFetch,
} from '../functions/api/providers/production/moov-client.mjs';
import {
  redactRecipientKycText,
  recipientKycResponseHasSecrets,
} from '../functions/api/providers/recipient-kyc-redact.mjs';
import { requestPath } from '../functions/api/index.mjs';
import { executionAllowed, flagSnapshot } from '../functions/api/provider-flags.mjs';

const RECIPIENT_ID = '62a858ff-ee6a-49d7-9898-1c8e4a44227b';
const ACCOUNT_ID = 'ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f';
const OTHER_ACCOUNT = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_RECIPIENT = 'bbbbbbbb-0000-4000-8000-000000000002';
const TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const SESSION_TOKEN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SSN = '123456789';
const DOB = '1980-05-15';

const INDEX = readFileSync(new URL('../functions/api/index.mjs', import.meta.url), 'utf8');
const HANDLER = readFileSync(new URL('../functions/api/public-moov-recipient-kyc-tos.mjs', import.meta.url), 'utf8');
const UI = readFileSync(new URL('../../src/pages/RecipientPaymentSetup.tsx', import.meta.url), 'utf8');
const API = readFileSync(new URL('../../src/lib/recipientSessionApi.ts', import.meta.url), 'utf8');
const TEMPLATE = readFileSync(new URL('../template.yaml', import.meta.url), 'utf8');
const PROD_TEMPLATE = readFileSync(new URL('../production/api-template.yaml', import.meta.url), 'utf8');

const kycInput = {
  token: SESSION_TOKEN,
  first_name: 'Ada',
  last_name: 'Lovelace',
  email: 'ada@example.com',
  phone: '5125550100',
  address_line1: '101 Congress Ave',
  city: 'Austin',
  state: 'TX',
  postal_code: '78701',
  birth_date: DOB,
  ssn: SSN,
};

const productionRecipient = {
  id: RECIPIENT_ID,
  tenant_id: TENANT_ID,
  display_name: 'Recipient',
  provider_account_id: ACCOUNT_ID,
  token_expires_at: new Date(Date.now() + 86400000).toISOString(),
  token_used_at: null,
  onboarding_status: 'kyc_pending',
  environment: 'production',
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

const eventOf = (path, body = {}, extra = {}) => ({
  headers: extra.headers || {},
  queryStringParameters: extra.queryStringParameters || undefined,
  body: JSON.stringify(body),
  requestContext: {
    stage: 'prep',
    http: { method: 'POST', path },
  },
});

const resolveOk = async () => ({ ok: true, recipient: { ...productionRecipient } });

const moovState = {
  tosAccepted: false,
  verification: 'unverified',
  identity: ['individual.address', 'individual.birthdate', 'individual.ssn'],
  tosOutstanding: true,
};

const fetchImpl = async (url, init = {}) => {
  const method = String(init.method || 'GET').toUpperCase();
  const path = String(url).replace('https://api.moov.io', '');
  const body = init.body ? (typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body) : null;
  fetchImpl.calls.push({ method, path, body });
  if (path === '/oauth2/token') {
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ access_token: 'drop-oauth-token', token_type: 'Bearer', expires_in: 300, scope: `/accounts/${ACCOUNT_ID}/profile.write` }),
    };
  }
  if (method === 'PATCH' && path === `/accounts/${ACCOUNT_ID}`) {
    if (body?.profile?.individual) {
      moovState.verification = 'verified';
      moovState.identity = [];
    }
    if (body?.termsOfService?.token) {
      moovState.tosAccepted = true;
      moovState.tosOutstanding = false;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ accountID: ACCOUNT_ID }),
    };
  }
  if (path === `/accounts/${ACCOUNT_ID}`) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({
        accountID: ACCOUNT_ID,
        accountType: 'individual',
        verification: { status: moovState.verification },
        termsOfService: moovState.tosAccepted ? { acceptedDate: '2026-09-12T00:00:00Z' } : {},
      }),
    };
  }
  if (path === `/accounts/${ACCOUNT_ID}/capabilities`) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify([{
        capability: 'send-funds',
        status: moovState.tosOutstanding || moovState.identity.length ? 'pending' : 'enabled',
        requirements: [
          ...(moovState.tosOutstanding ? ['account.tos-acceptance'] : []),
          ...moovState.identity,
        ],
      }]),
    };
  }
  return {
    ok: false,
    status: 404,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ error: 'not_found' }),
  };
};
fetchImpl.calls = [];

const deps = () => ({
  resolveRecipientByToken: resolveOk,
  loadProductionReadSecrets: async () => secrets,
  fetchImpl,
  nowMs: Date.now(),
  log: (...args) => { deps.logs.push(args); },
});
deps.logs = [];

const withFlags = async (fn, extra = {}) => {
  const keys = [
    'AWS_PROVIDER_LIVE_READS_ENABLED',
    'AWS_PROVIDER_RECIPIENT_KYC_TOS_WRITES_ENABLED',
    'AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED',
    'AWS_PROVIDER_EXECUTION_ENABLED',
    'AWS_MOOV_ENABLED',
    'AWS_FINANCIAL_PERMISSIONS_ACTIVATED',
    'AWS_CHECKALT_ENABLED',
  ];
  const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.AWS_PROVIDER_LIVE_READS_ENABLED = extra.liveReads ?? 'true';
  process.env.AWS_PROVIDER_RECIPIENT_KYC_TOS_WRITES_ENABLED = extra.kycTos ?? 'true';
  process.env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED = extra.sandbox ?? 'false';
  process.env.AWS_PROVIDER_EXECUTION_ENABLED = extra.execution ?? 'false';
  process.env.AWS_MOOV_ENABLED = extra.moov ?? 'false';
  process.env.AWS_FINANCIAL_PERMISSIONS_ACTIVATED = extra.financial ?? 'false';
  process.env.AWS_CHECKALT_ENABLED = extra.checkalt ?? 'false';
  fetchImpl.calls = [];
  deps.logs = [];
  moovState.tosAccepted = extra.tosAccepted === true;
  moovState.verification = extra.verification || 'unverified';
  moovState.identity = extra.identity || ['individual.address', 'individual.birthdate', 'individual.ssn'];
  moovState.tosOutstanding = extra.tosOutstanding !== false && extra.tosAccepted !== true;
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
};

test('index routes public KYC, ToS token, and ToS accept', () => {
  assert.match(INDEX, /path === '\/public\/moov-recipient-kyc-update'/);
  assert.match(INDEX, /path === '\/public\/moov-recipient-tos-token'/);
  assert.match(INDEX, /path === '\/public\/moov-recipient-tos-accept'/);
  assert.doesNotMatch(INDEX, /moov-recipient-bank-verify/);
  assert.equal(requestPath({
    rawPath: '/prep/public/moov-recipient-kyc-update',
    requestContext: { stage: 'prep' },
  }), '/public/moov-recipient-kyc-update');
});

test('SPA KYC and ToS post to AWS public routes, not Lovable invoke', () => {
  assert.match(API, /\/public\/moov-recipient-kyc-update/);
  assert.match(API, /\/public\/moov-recipient-tos-token/);
  assert.match(API, /\/public\/moov-recipient-tos-accept/);
  assert.match(API, /JSON\.stringify\(body\)/);
  assert.doesNotMatch(API, /functions\.invoke/);
  assert.doesNotMatch(API, /supabase\.co/);
  assert.doesNotMatch(API, /console\.(log|debug|info|warn|error)/);
  assert.match(UI, /submitRecipientKyc\(token/);
  assert.match(UI, /submitRecipientTos\(token/);
  assert.match(UI, /loadRecipientTosDropToken\(token/);
  assert.doesNotMatch(UI, /functions\.invoke/);
  assert.doesNotMatch(UI, /moov-recipient-kyc-update/);
  assert.doesNotMatch(UI, /invoke\("moov-recipient-tos-accept"/);
  assert.doesNotMatch(UI, /Send verification deposit/);
  assert.doesNotMatch(UI, /moov-recipient-bank-verify/);
  assert.doesNotMatch(UI, /moov-recipient-bank-add/);
  assert.match(UI, /Bank verification is not available yet/);
});

test('valid recipient KYC PATCHes the bound account and never returns SSN', async () => {
  await withFlags(async () => {
    const result = await handlePublicMoovRecipientKycUpdate(
      eventOf('/public/moov-recipient-kyc-update', kycInput),
      deps(),
    );
    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 200);
    assert.equal(result.account_id, ACCOUNT_ID);
    assert.equal(result.recipient_id, RECIPIENT_ID);
    assert.equal(result.ssn_returned, false);
    assert.equal(result.ssn_stored, false);
    assert.equal(result.token_consumed, false);
    assert.equal(result.productionExecution, false);
    assert.equal(result.verification_status, 'verified');
    assert.equal(recipientKycResponseHasSecrets(result), false);
    const patch = fetchImpl.calls.find((call) => call.method === 'PATCH');
    assert.equal(patch.path, `/accounts/${ACCOUNT_ID}`);
    assert.equal(patch.body.profile.individual.governmentID.ssn.full, SSN);
    assert.equal(JSON.stringify(result).includes(SSN), false);
    assert.equal(JSON.stringify(result).includes(DOB), false);
    assert.equal(fetchImpl.calls.some((call) => call.path.includes('/verify')), false);
    assert.equal(fetchImpl.calls.some((call) => call.path.includes('/transfers')), false);
  });
});

test('invalid token is 404 and expired token is 410', async () => {
  await withFlags(async () => {
    const invalid = await handlePublicMoovRecipientKycUpdate(
      eventOf('/public/moov-recipient-kyc-update', { ...kycInput, token: 'not-a-token' }),
      deps(),
    );
    assert.equal(invalid.statusCode, 404);
    const expired = await handlePublicMoovRecipientKycUpdate(
      eventOf('/public/moov-recipient-kyc-update', kycInput),
      {
        ...deps(),
        resolveRecipientByToken: async () => ({
          ok: true,
          recipient: { ...productionRecipient, token_expires_at: '2020-01-01T00:00:00.000Z' },
        }),
      },
    );
    assert.equal(expired.statusCode, 410);
    assert.match(String(expired.error), /expired/i);
  });
});

test('wrong recipient or account ids are rejected and the bound account is unchanged', async () => {
  await withFlags(async () => {
    const wrongRecipient = await handlePublicMoovRecipientKycUpdate(
      eventOf('/public/moov-recipient-kyc-update', { ...kycInput, recipient_id: OTHER_RECIPIENT }),
      deps(),
    );
    assert.equal(wrongRecipient.error, 'recipient_mismatch');
    assert.equal(wrongRecipient.statusCode, 400);
    const wrongAccount = await handlePublicMoovRecipientTosAccept(
      eventOf('/public/moov-recipient-tos-accept', {
        token: SESSION_TOKEN,
        terms_of_service_token: 'drop-token-xx',
        account_id: OTHER_ACCOUNT,
      }),
      deps(),
    );
    assert.equal(wrongAccount.error, 'tos_account_mismatch');
    assert.equal(fetchImpl.calls.some((call) => call.method === 'PATCH'), false);
  });
});

test('forged browser provider identifiers are rejected', async () => {
  await withFlags(async () => {
    const forged = await handlePublicMoovRecipientKycUpdate(
      eventOf('/public/moov-recipient-kyc-update', {
        ...kycInput,
        provider_account_id: OTHER_ACCOUNT,
        moov_account_id: OTHER_ACCOUNT,
      }),
      deps(),
    );
    assert.equal(forged.error, 'untrusted_provider_config');
    assert.equal(forged.statusCode, 400);
  });
});

test('KYC validation fails closed on incomplete identity', async () => {
  await withFlags(async () => {
    const result = await handlePublicMoovRecipientKycUpdate(
      eventOf('/public/moov-recipient-kyc-update', { token: SESSION_TOKEN, first_name: 'Ada' }),
      deps(),
    );
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 400);
    assert.equal(result.error, 'kyc_fields_incomplete');
    assert.ok(result.missing.includes('ssn'));
    assert.ok(result.missing.includes('birthdate'));
    assert.equal(fetchImpl.calls.some((call) => call.method === 'PATCH'), false);
    assert.equal(JSON.stringify(result).includes(SSN), false);
  });
});

test('sensitive KYC values are redacted from logs and provider errors', async () => {
  const leaked = `ssn=${SSN} birth_date=${DOB} governmentID.full=111223333`;
  const redacted = redactRecipientKycText(leaked);
  assert.doesNotMatch(redacted, /123456789/);
  assert.doesNotMatch(redacted, /1980-05-15/);
  assert.doesNotMatch(redacted, /111223333/);
  await withFlags(async () => {
    const logs = [];
    const result = await handlePublicMoovRecipientKycUpdate(
      eventOf('/public/moov-recipient-kyc-update', kycInput),
      {
        ...deps(),
        log: (...args) => logs.push(args.join(' ')),
        productionMoovFetch: async () => {
          const error = new Error(`Moov rejected SSN ${SSN} DOB ${DOB}`);
          error.status = 400;
          error.body = { error: `invalid ssn ${SSN}`, birthDate: { year: 1980, month: 5, day: 15 } };
          throw error;
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(SSN), false);
    assert.equal(JSON.stringify(result).includes(DOB), false);
    assert.equal(logs.join(' ').includes(SSN), false);
    assert.equal(logs.join(' ').includes(DOB), false);
    assert.equal(result.ssn_returned, false);
  });
});

test('ToS token is bound to the existing recipient account scopes', async () => {
  await withFlags(async () => {
    const result = await handlePublicMoovRecipientTosToken(
      eventOf('/public/moov-recipient-tos-token', { token: SESSION_TOKEN }),
      deps(),
    );
    assert.equal(result.ok, true);
    assert.equal(result.account_id, ACCOUNT_ID);
    assert.equal(result.drop, 'moov-terms-of-service');
    assert.equal(result.mutated, false);
    const oauth = fetchImpl.calls.find((call) => call.path === '/oauth2/token');
    assert.ok(oauth);
    const scope = String(oauth.body?.get?.('scope') || oauth.body);
    assert.match(scope, new RegExp(`/accounts/${ACCOUNT_ID}/profile.write`));
    assert.doesNotMatch(scope, /transfers/);
    assert.doesNotMatch(scope, /bank-accounts/);
  });
});

test('ToS accept binds the Drop token to the server account and is idempotent', async () => {
  await withFlags(async () => {
    const first = await handlePublicMoovRecipientTosAccept(
      eventOf('/public/moov-recipient-tos-accept', {
        token: SESSION_TOKEN,
        terms_of_service_token: 'drop-token-xx',
      }),
      deps(),
    );
    assert.equal(first.ok, true);
    assert.equal(first.terms_accepted, true);
    assert.equal(first.already_accepted, false);
    assert.equal(first.account_id, ACCOUNT_ID);
    const patches = fetchImpl.calls.filter((call) => call.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0].body, { termsOfService: { token: 'drop-token-xx' } });
  });
  await withFlags(async () => {
    const second = await handlePublicMoovRecipientTosAccept(
      eventOf('/public/moov-recipient-tos-accept', {
        token: SESSION_TOKEN,
        terms_of_service_token: 'drop-token-xx',
      }),
      deps(),
    );
    assert.equal(second.ok, true);
    assert.equal(second.already_accepted, true);
    assert.equal(second.terms_accepted, true);
    assert.equal(fetchImpl.calls.filter((call) => call.method === 'PATCH').length, 0);
  }, { tosAccepted: true, tosOutstanding: false, verification: 'verified', identity: [] });
});

test('browser accepted=true without a Drop token is forged', async () => {
  await withFlags(async () => {
    const forged = await handlePublicMoovRecipientTosAccept(
      eventOf('/public/moov-recipient-tos-accept', { token: SESSION_TOKEN, accepted: true }),
      deps(),
    );
    assert.equal(forged.error, 'tos_acceptance_forged');
    assert.equal(fetchImpl.calls.some((call) => call.method === 'PATCH'), false);
  });
});

test('money and bank-verify provider execution remain blocked', async () => {
  assert.throws(
    () => assertRecipientOnboardingWrite({
      method: 'POST',
      path: `/accounts/${ACCOUNT_ID}/bank-accounts/bank/verify`,
      boundAccountId: ACCOUNT_ID,
    }),
    (error) => error.code === 'recipient_onboarding_method_denied',
  );
  assert.throws(
    () => assertRecipientOnboardingWrite({
      method: 'PATCH',
      path: `/accounts/${OTHER_ACCOUNT}`,
      boundAccountId: ACCOUNT_ID,
    }),
    (error) => error.code === 'recipient_onboarding_path_denied',
  );
  await withFlags(async () => {
    assert.equal(executionAllowed('moov'), false);
    const flags = flagSnapshot();
    assert.equal(flags.AWS_MOOV_ENABLED, false);
    assert.equal(flags.AWS_PROVIDER_EXECUTION_ENABLED, false);
    const blocked = await handlePublicMoovRecipientKycUpdate(
      eventOf('/public/moov-recipient-kyc-update', { ...kycInput, verify_bank: true, create_transfer: true }),
      deps(),
    );
    assert.equal(blocked.error, 'provider_execution_blocked');
    assert.equal(fetchImpl.calls.length, 0);
    await assert.rejects(
      () => productionMoovFetch({
        credentials: secrets.credentials,
        path: `/accounts/${ACCOUNT_ID}/transfers`,
        method: 'POST',
        mode: 'recipient_onboarding',
        boundAccountId: ACCOUNT_ID,
        fetchImpl,
      }),
      (error) => error.code === 'recipient_onboarding_method_denied',
    );
  });
  assert.match(TEMPLATE, /AWS_PROVIDER_EXECUTION_ENABLED: "false"/);
  assert.match(TEMPLATE, /AWS_MOOV_ENABLED: "false"/);
  assert.match(TEMPLATE, /AWS_FINANCIAL_PERMISSIONS_ACTIVATED: "false"/);
  assert.match(TEMPLATE, /AWS_PROVIDER_RECIPIENT_KYC_TOS_WRITES_ENABLED: "false"/);
  assert.match(PROD_TEMPLATE, /AWS_PROVIDER_RECIPIENT_KYC_TOS_WRITES_ENABLED: "false"/);
  assert.doesNotMatch(HANDLER, /token_used_at =/);
  assert.doesNotMatch(HANDLER, /INSERT INTO/);
  assert.doesNotMatch(HANDLER, /ssn_stored: true/);
  assert.match(HANDLER, /mode: 'recipient_onboarding'/);
});

test('KYC writes fail closed when the narrow onboarding flag is off', async () => {
  await withFlags(async () => {
    const result = await handlePublicMoovRecipientKycUpdate(
      eventOf('/public/moov-recipient-kyc-update', kycInput),
      deps(),
    );
    assert.equal(result.error, 'recipient_onboarding_writes_blocked');
    assert.equal(result.statusCode, 403);
    assert.equal(fetchImpl.calls.length, 0);
  }, { kycTos: 'false' });
});

test('SSN is not placed in URLs and plaintext SSN is not persisted', () => {
  assert.doesNotMatch(API, /searchParams/);
  assert.doesNotMatch(API, /\?token=/);
  assert.doesNotMatch(HANDLER, /queryStringParameters.*ssn/);
  assert.doesNotMatch(HANDLER, /client\.query/);
  assert.doesNotMatch(HANDLER, /secure_token = \$1/);
  assert.match(HANDLER, /ssn_stored: false/);
  assert.match(HANDLER, /Never logged/);
});
