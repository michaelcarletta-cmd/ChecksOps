import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  handlePublicMoovRecipientBankVerifyConfirm,
  handlePublicMoovRecipientBankVerifyInitiate,
  newTestBankVerifyStore,
  resetRecipientBankVerifyMemoryForTests,
} from '../functions/api/public-moov-recipient-bank-verify.mjs';
import {
  assertRecipientBankVerifyWrite,
  productionMoovFetch,
} from '../functions/api/providers/production/moov-client.mjs';
import {
  bindLiveRecipientBank,
  recipientBankVerifyIdempotencyKey,
} from '../functions/api/providers/moov-recipient-tos-policy.mjs';
import {
  redactRecipientMvText,
  recipientMvResponseHasSecrets,
} from '../functions/api/providers/recipient-mv-redact.mjs';
import { executionAllowed, flagSnapshot } from '../functions/api/provider-flags.mjs';
import { requestPath } from '../functions/api/index.mjs';

const RECIPIENT_ID = '62a858ff-ee6a-49d7-9898-1c8e4a44227b';
const ACCOUNT_ID = 'ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f';
const BANK_ID = '72eb66c1-d9a9-4f85-ab50-8871db9ceeea';
const OTHER_ACCOUNT = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_BANK = 'bbbbbbbb-0000-4000-8000-000000000002';
const OTHER_RECIPIENT = 'cccccccc-0000-4000-8000-000000000003';
const TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const SESSION_TOKEN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const EXPIRED_TOKEN = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const INDEX = readFileSync(new URL('../functions/api/index.mjs', import.meta.url), 'utf8');
const HANDLER = readFileSync(new URL('../functions/api/public-moov-recipient-bank-verify.mjs', import.meta.url), 'utf8');
const UI = readFileSync(new URL('../../src/pages/RecipientPaymentSetup.tsx', import.meta.url), 'utf8');
const API = readFileSync(new URL('../../src/lib/recipientSessionApi.ts', import.meta.url), 'utf8');
const TEMPLATE = readFileSync(new URL('../template.yaml', import.meta.url), 'utf8');
const PROD_TEMPLATE = readFileSync(new URL('../production/api-template.yaml', import.meta.url), 'utf8');

const productionRecipient = {
  id: RECIPIENT_ID,
  tenant_id: TENANT_ID,
  display_name: 'Recipient',
  provider_account_id: ACCOUNT_ID,
  provider_last_four: '1506',
  token_expires_at: new Date(Date.now() + 86400000).toISOString(),
  token_used_at: null,
  onboarding_status: 'awaiting_bank',
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
    http: { method: 'POST', path, sourceIp: extra.ip || '127.0.0.1' },
  },
});

const moovState = {
  bankStatus: 'new',
  verifyStatus: null,
  postCount: 0,
  putCount: 0,
  putFail: null,
  postError: null,
  delayPost: false,
};

const jsonResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  text: async () => JSON.stringify(payload),
});

const fetchImpl = async (url, init = {}) => {
  const method = String(init.method || 'GET').toUpperCase();
  const path = String(url).replace('https://api.moov.io', '');
  const body = init.body ? (typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body) : null;
  fetchImpl.calls.push({ method, path, body, idempotency: init.headers?.['X-Idempotency-Key'] || null });
  if (path === '/oauth2/token') {
    return jsonResponse(200, { access_token: 'bank-oauth-token', token_type: 'Bearer', expires_in: 300 });
  }
  if (path === `/accounts/${ACCOUNT_ID}`) {
    return jsonResponse(200, {
      accountID: ACCOUNT_ID,
      accountType: 'individual',
      verification: { status: 'verified' },
      termsOfService: { acceptedDate: '2026-09-12T17:37:31.697535Z' },
    });
  }
  if (path === `/accounts/${ACCOUNT_ID}/capabilities`) {
    return jsonResponse(200, [
      { capability: 'send-funds', status: 'enabled', requirements: [] },
      { capability: 'transfers', status: 'enabled', requirements: [] },
    ]);
  }
  if (path === `/accounts/${ACCOUNT_ID}/bank-accounts`) {
    return jsonResponse(200, [{
      bankAccountID: BANK_ID,
      bankName: 'JPMORGAN CHASE BANK, NA',
      lastFourAccountNumber: '1506',
      status: moovState.bankStatus,
    }]);
  }
  if (path === `/accounts/${ACCOUNT_ID}/bank-accounts/${BANK_ID}`) {
    return jsonResponse(200, {
      bankAccountID: BANK_ID,
      bankName: 'JPMORGAN CHASE BANK, NA',
      lastFourAccountNumber: '1506',
      status: moovState.bankStatus,
    });
  }
  if (path === `/accounts/${ACCOUNT_ID}/bank-accounts/${BANK_ID}/verify`
    || path === `/accounts/${ACCOUNT_ID}/bank-accounts/${BANK_ID}/verification`) {
    if (method === 'POST') {
      moovState.postCount += 1;
      if (moovState.delayPost) await new Promise((resolve) => setTimeout(resolve, 40));
      if (moovState.postError === 'timeout') {
        const error = new Error('fetch failed');
        error.cause = { code: 'ETIMEDOUT' };
        throw error;
      }
      if (moovState.postError === 'open') {
        return jsonResponse(409, { error: 'verification already in progress' });
      }
      moovState.verifyStatus = 'sent-credit';
      moovState.bankStatus = 'pending';
      return jsonResponse(200, { status: 'sent-credit' });
    }
    if (method === 'PUT') {
      moovState.putCount += 1;
      if (moovState.putFail === 'timeout') {
        const error = new Error('fetch failed');
        error.cause = { code: 'ETIMEDOUT' };
        throw error;
      }
      if (moovState.putFail === 'wrong') return jsonResponse(409, { error: 'incorrect code' });
      moovState.bankStatus = 'verified';
      moovState.verifyStatus = 'successful';
      return jsonResponse(200, { status: 'successful' });
    }
    if (!moovState.verifyStatus) return jsonResponse(404, { error: 'not_found' });
    return jsonResponse(200, { status: moovState.verifyStatus });
  }
  return jsonResponse(404, { error: 'not_found' });
};
fetchImpl.calls = [];

const resolveOk = async ({ token } = {}) => {
  if (token === EXPIRED_TOKEN) {
    return { ok: false, error: 'This link has expired. Ask the sender for a new one.', statusCode: 410 };
  }
  if (token && token !== SESSION_TOKEN) {
    return { ok: false, error: 'This link is not valid.', statusCode: 404 };
  }
  return { ok: true, recipient: { ...productionRecipient } };
};

let testStore = newTestBankVerifyStore();

const deps = (extra = {}) => ({
  resolveRecipientByToken: resolveOk,
  loadProductionReadSecrets: async () => secrets,
  fetchImpl,
  nowMs: Date.now(),
  bankVerifyStore: extra.bankVerifyStore || testStore,
  crashAfterPost: extra.crashAfterPost === true,
  log: (...args) => { deps.logs.push(args); },
});
deps.logs = [];

const withFlags = async (fn, extra = {}) => {
  const keys = [
    'AWS_PROVIDER_LIVE_READS_ENABLED',
    'AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED',
    'AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED',
    'AWS_PROVIDER_EXECUTION_ENABLED',
    'AWS_MOOV_ENABLED',
    'AWS_FINANCIAL_PERMISSIONS_ACTIVATED',
    'AWS_CHECKALT_ENABLED',
  ];
  const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.AWS_PROVIDER_LIVE_READS_ENABLED = extra.liveReads ?? 'true';
  process.env.AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED = extra.bankVerify ?? 'true';
  process.env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED = extra.sandbox ?? 'false';
  process.env.AWS_PROVIDER_EXECUTION_ENABLED = extra.execution ?? 'false';
  process.env.AWS_MOOV_ENABLED = extra.moov ?? 'false';
  process.env.AWS_FINANCIAL_PERMISSIONS_ACTIVATED = extra.financial ?? 'false';
  process.env.AWS_CHECKALT_ENABLED = extra.checkalt ?? 'false';
  fetchImpl.calls = [];
  deps.logs = [];
  resetRecipientBankVerifyMemoryForTests();
  testStore = extra.store || newTestBankVerifyStore();
  moovState.bankStatus = extra.bankStatus || 'new';
  moovState.verifyStatus = extra.verifyStatus === undefined ? null : extra.verifyStatus;
  moovState.postCount = 0;
  moovState.putCount = 0;
  moovState.putFail = extra.putFail || null;
  moovState.postError = extra.postError || null;
  moovState.delayPost = extra.delayPost === true;
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
};

test('index routes AWS initiate and confirm, not Lovable invoke', () => {
  assert.match(INDEX, /path === '\/public\/moov-recipient-bank-verify-initiate'/);
  assert.match(INDEX, /path === '\/public\/moov-recipient-bank-verify-confirm'/);
  assert.equal(requestPath({
    rawPath: '/prep/public/moov-recipient-bank-verify-initiate',
    requestContext: { stage: 'prep' },
  }), '/public/moov-recipient-bank-verify-initiate');
  assert.match(API, /\/public\/moov-recipient-bank-verify-initiate/);
  assert.match(API, /\/public\/moov-recipient-bank-verify-confirm/);
  assert.doesNotMatch(API, /functions\.invoke/);
  assert.doesNotMatch(UI, /functions\.invoke/);
  assert.doesNotMatch(UI, /invoke\("moov-recipient-bank-verify"/);
  assert.match(UI, /initiateRecipientBankVerify\(token/);
  assert.match(UI, /confirmRecipientBankVerify\(token \|\| "", code\)/);
  assert.match(UI, /bank_verify_available === true/);
  assert.match(UI, /Send verification deposit/);
  assert.match(TEMPLATE, /AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED: "false"/);
  assert.match(PROD_TEMPLATE, /AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED: "false"/);
  assert.match(TEMPLATE, /AWS_MOOV_ENABLED: "false"/);
  assert.match(TEMPLATE, /AWS_PROVIDER_EXECUTION_ENABLED: "false"/);
  assert.match(TEMPLATE, /AWS_FINANCIAL_PERMISSIONS_ACTIVATED: "false"/);
  assert.match(TEMPLATE, /AWS_RECIPIENT_BANK_VERIFY_STATE_TABLE: "checksops-recipient-bank-verify-state"/);
  assert.match(PROD_TEMPLATE, /AWS_RECIPIENT_BANK_VERIFY_STATE_TABLE: "checksops-recipient-bank-verify-state"/);
  assert.match(HANDLER, /claimInitiation/);
  assert.match(HANDLER, /consumeMvAttempt/);
  assert.doesNotMatch(HANDLER, /initiateLocks/);
  assert.doesNotMatch(HANDLER, /mvAttempts/);
  assert.doesNotMatch(HANDLER, /mode: 'execute'/);
  assert.doesNotMatch(HANDLER, /INSERT INTO/);
  assert.doesNotMatch(HANDLER, /transfers\.write/);
});

test('binds the existing Chase 1506 bank and rejects forged ids', async () => {
  const bound = bindLiveRecipientBank({
    banks: [{ bankAccountID: BANK_ID, lastFourAccountNumber: '1506', status: 'new' }],
    recipientLastFour: '1506',
  });
  assert.equal(bound.ok, true);
  assert.equal(bound.bankId, BANK_ID);
  await withFlags(async () => {
    const ok = await handlePublicMoovRecipientBankVerifyInitiate(
      eventOf('/public/moov-recipient-bank-verify-initiate', { token: SESSION_TOKEN }),
      deps(),
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.bank_id, BANK_ID);
    assert.equal(ok.account_id, ACCOUNT_ID);
    assert.equal(ok.recipient_id, RECIPIENT_ID);
    assert.equal(ok.productionExecution, false);
    const post = fetchImpl.calls.find((call) => call.method === 'POST' && String(call.path).includes('/verify'));
    assert.equal(post.path, `/accounts/${ACCOUNT_ID}/bank-accounts/${BANK_ID}/verify`);
    assert.equal(post.idempotency, recipientBankVerifyIdempotencyKey({ recipientId: RECIPIENT_ID, bankId: BANK_ID }));

    const forgedBank = await handlePublicMoovRecipientBankVerifyInitiate(
      eventOf('/public/moov-recipient-bank-verify-initiate', {
        token: SESSION_TOKEN,
        bank_account_id: OTHER_BANK,
      }),
      deps(),
    );
    assert.equal(forgedBank.error, 'bank_account_mismatch');
    assert.equal(forgedBank.ok, false);

    const forgedAccount = await handlePublicMoovRecipientBankVerifyInitiate(
      eventOf('/public/moov-recipient-bank-verify-initiate', {
        token: SESSION_TOKEN,
        account_id: OTHER_ACCOUNT,
      }),
      deps(),
    );
    assert.equal(forgedAccount.error, 'bank_account_mismatch');

    const forgedRecipient = await handlePublicMoovRecipientBankVerifyInitiate(
      eventOf('/public/moov-recipient-bank-verify-initiate', {
        token: SESSION_TOKEN,
        recipient_id: OTHER_RECIPIENT,
      }),
      deps(),
    );
    assert.equal(forgedRecipient.error, 'recipient_mismatch');
  });
});

test('expired and invalid tokens never call Moov writes', async () => {
  await withFlags(async () => {
    const invalid = await handlePublicMoovRecipientBankVerifyInitiate(
      eventOf('/public/moov-recipient-bank-verify-initiate', { token: 'not-a-token' }),
      deps(),
    );
    assert.equal(invalid.statusCode, 404);
    const expired = await handlePublicMoovRecipientBankVerifyInitiate(
      eventOf('/public/moov-recipient-bank-verify-initiate', { token: EXPIRED_TOKEN }),
      deps(),
    );
    assert.equal(expired.statusCode, 410);
    assert.equal(fetchImpl.calls.some((call) => call.method === 'POST' && call.path.includes('/verify')), false);
  });
});

test('duplicate and already-open initiation do not POST twice', async () => {
  await withFlags(async () => {
    const first = await handlePublicMoovRecipientBankVerifyInitiate(
      eventOf('/public/moov-recipient-bank-verify-initiate', { token: SESSION_TOKEN }),
      deps(),
    );
    assert.equal(first.initiated, true);
    assert.equal(moovState.postCount, 1);
    const second = await handlePublicMoovRecipientBankVerifyInitiate(
      eventOf('/public/moov-recipient-bank-verify-initiate', { token: SESSION_TOKEN }),
      deps(),
    );
    assert.equal(second.already_initiated, true);
    assert.equal(second.mutated, false);
    assert.equal(moovState.postCount, 1);
  });
  await withFlags(async () => {
    const open = await handlePublicMoovRecipientBankVerifyInitiate(
      eventOf('/public/moov-recipient-bank-verify-initiate', { token: SESSION_TOKEN }),
      deps(),
    );
    assert.equal(open.already_initiated, true);
    assert.equal(fetchImpl.calls.filter((call) => call.method === 'POST' && call.path.includes('/verify')).length, 0);
  }, { bankStatus: 'pending', verifyStatus: 'sent-credit' });
});

test('concurrent initiation shares one provider POST', async () => {
  await withFlags(async () => {
    moovState.delayPost = true;
    const [left, right] = await Promise.all([
      handlePublicMoovRecipientBankVerifyInitiate(
        eventOf('/public/moov-recipient-bank-verify-initiate', { token: SESSION_TOKEN }),
        deps(),
      ),
      handlePublicMoovRecipientBankVerifyInitiate(
        eventOf('/public/moov-recipient-bank-verify-initiate', { token: SESSION_TOKEN }),
        deps(),
      ),
    ]);
    assert.equal(moovState.postCount, 1);
    assert.equal(fetchImpl.calls.filter((call) => call.method === 'POST' && call.path.includes('/verify')).length, 1);
    assert.equal([left, right].filter((result) => result.ok === true).length >= 1, true);
    assert.equal([left, right].some((result) => result.mutated === true || result.error === 'initiate_uncertain'), true);
  });
});

test('uncertain provider timeout reconciles and does not retry POST', async () => {
  await withFlags(async () => {
    const result = await handlePublicMoovRecipientBankVerifyInitiate(
      eventOf('/public/moov-recipient-bank-verify-initiate', { token: SESSION_TOKEN }),
      deps(),
    );
    assert.equal(result.error, 'initiate_uncertain');
    assert.equal(result.mutated, false);
    assert.equal(moovState.postCount, 1);
    assert.equal(fetchImpl.calls.filter((call) => call.method === 'POST' && call.path.includes('/verify')).length, 1);
  }, { postError: 'timeout' });
});

test('already verified bank does not initiate', async () => {
  await withFlags(async () => {
    const result = await handlePublicMoovRecipientBankVerifyInitiate(
      eventOf('/public/moov-recipient-bank-verify-initiate', { token: SESSION_TOKEN }),
      deps(),
    );
    assert.equal(result.already_verified, true);
    assert.equal(result.mutated, false);
    assert.equal(fetchImpl.calls.filter((call) => call.method === 'POST').length, 0);
  }, { bankStatus: 'verified', verifyStatus: 'successful' });
});

test('wrong MV code is rate-limited and never logged or returned', async () => {
  await withFlags(async () => {
    moovState.bankStatus = 'pending';
    moovState.verifyStatus = 'sent-credit';
    const first = await handlePublicMoovRecipientBankVerifyConfirm(
      eventOf('/public/moov-recipient-bank-verify-confirm', { token: SESSION_TOKEN, code: '0001' }),
      deps(),
    );
    assert.equal(first.error, 'verification_failed');
    assert.equal(first.attempts_remaining, 2);
    assert.equal(recipientMvResponseHasSecrets(first), false);
    assert.equal(JSON.stringify(first).includes('0001'), false);
    assert.equal(JSON.stringify(deps.logs).includes('0001'), false);
    assert.equal(JSON.stringify(deps.logs).includes('MV0001'), false);
    await handlePublicMoovRecipientBankVerifyConfirm(
      eventOf('/public/moov-recipient-bank-verify-confirm', { token: SESSION_TOKEN, code: '0002' }),
      deps(),
    );
    const third = await handlePublicMoovRecipientBankVerifyConfirm(
      eventOf('/public/moov-recipient-bank-verify-confirm', { token: SESSION_TOKEN, code: '0003' }),
      deps(),
    );
    assert.equal(third.error, 'max_attempts_exceeded');
    const fourth = await handlePublicMoovRecipientBankVerifyConfirm(
      eventOf('/public/moov-recipient-bank-verify-confirm', { token: SESSION_TOKEN, code: '0004' }),
      deps(),
    );
    assert.equal(fourth.error, 'max_attempts_exceeded');
    assert.equal(moovState.putCount, 3);
    assert.equal(redactRecipientMvText('code=MV0001'), 'code=[redacted]');
  }, { bankStatus: 'pending', verifyStatus: 'sent-credit', putFail: 'wrong' });
});

test('MV confirm succeeds against the bound bank and still cannot transfer', async () => {
  await withFlags(async () => {
    const result = await handlePublicMoovRecipientBankVerifyConfirm(
      eventOf('/public/moov-recipient-bank-verify-confirm', { token: SESSION_TOKEN, code: '1506' }),
      deps(),
    );
    assert.equal(result.ok, true);
    assert.equal(result.bank_status, 'verified');
    assert.equal(result.mv_code_returned, false);
    assert.equal(result.mv_code_stored, false);
    assert.equal(result.productionExecution, false);
    assert.equal(recipientMvResponseHasSecrets(result), false);
    const put = fetchImpl.calls.find((call) => call.method === 'PUT');
    assert.deepEqual(put.body, { code: 'MV1506' });
    assert.equal(executionAllowed('moov'), false);
    const flags = flagSnapshot();
    assert.equal(flags.AWS_MOOV_ENABLED, false);
    assert.equal(flags.AWS_PROVIDER_EXECUTION_ENABLED, false);
    await assert.rejects(
      () => productionMoovFetch({
        credentials: secrets.credentials,
        path: `/accounts/${ACCOUNT_ID}/transfers`,
        method: 'POST',
        mode: 'recipient_bank_verify',
        boundAccountId: ACCOUNT_ID,
        boundBankId: BANK_ID,
        fetchImpl,
      }),
      (error) => error.code === 'recipient_bank_verify_path_denied' || error.code === 'recipient_bank_verify_method_denied',
    );
    assert.throws(
      () => assertRecipientBankVerifyWrite({
        method: 'POST',
        path: `/accounts/${ACCOUNT_ID}/bank-accounts/${OTHER_BANK}/verify`,
        boundAccountId: ACCOUNT_ID,
        boundBankId: BANK_ID,
      }),
      (error) => error.code === 'recipient_bank_verify_path_denied',
    );
  }, { bankStatus: 'pending', verifyStatus: 'sent-credit' });
});

test('narrow bank-verify flag stays independent of money flags and defaults off', async () => {
  await withFlags(async () => {
    const blocked = await handlePublicMoovRecipientBankVerifyInitiate(
      eventOf('/public/moov-recipient-bank-verify-initiate', { token: SESSION_TOKEN }),
      deps(),
    );
    assert.equal(blocked.error, 'recipient_bank_verify_writes_blocked');
    assert.equal(fetchImpl.calls.length, 0);
  }, { bankVerify: 'false' });
  await withFlags(async () => {
    const blocked = await handlePublicMoovRecipientBankVerifyInitiate(
      eventOf('/public/moov-recipient-bank-verify-initiate', { token: SESSION_TOKEN }),
      deps(),
    );
    assert.equal(blocked.error, 'provider_execution_blocked');
  }, { moov: 'true' });
});
