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
  BANK_VERIFY_STATES,
  canTransitionBankVerifyState,
  createDynamoBankVerifyStore,
  createMemoryBankVerifyStore,
  createUnavailableBankVerifyStore,
  tokenFingerprint,
} from '../functions/api/providers/recipient-bank-verify-state.mjs';
import { productionMoovFetch } from '../functions/api/providers/production/moov-client.mjs';
import { executionAllowed, flagSnapshot } from '../functions/api/provider-flags.mjs';

const RECIPIENT_ID = '62a858ff-ee6a-49d7-9898-1c8e4a44227b';
const ACCOUNT_ID = 'ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f';
const BANK_ID = '72eb66c1-d9a9-4f85-ab50-8871db9ceeea';
const OTHER_ACCOUNT = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_BANK = 'bbbbbbbb-0000-4000-8000-000000000002';
const OTHER_RECIPIENT = 'cccccccc-0000-4000-8000-000000000003';
const TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const SESSION_TOKEN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const CFN = readFileSync(new URL('../production/api-cfn.yaml', import.meta.url), 'utf8');
const TABLE = readFileSync(new URL('../production/bank-verify-state-table.yaml', import.meta.url), 'utf8');
const HANDLER = readFileSync(new URL('../functions/api/public-moov-recipient-bank-verify.mjs', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../functions/api/index.mjs', import.meta.url), 'utf8');
const STATE = readFileSync(new URL('../functions/api/providers/recipient-bank-verify-state.mjs', import.meta.url), 'utf8');
const UI = readFileSync(new URL('../../src/pages/RecipientPaymentSetup.tsx', import.meta.url), 'utf8');

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

const eventOf = (path, body = {}) => ({
  headers: {},
  body: JSON.stringify(body),
  requestContext: {
    stage: 'prep',
    http: { method: 'POST', path, sourceIp: '127.0.0.1' },
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
      if (moovState.postError === 'lost') {
        moovState.verifyStatus = 'sent-credit';
        moovState.bankStatus = 'pending';
        const error = new Error('fetch failed');
        error.cause = { code: 'ETIMEDOUT' };
        throw error;
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
  if (path.includes('/transfers') || path.includes('/disbursements')) {
    return jsonResponse(404, { error: 'not_found' });
  }
  return jsonResponse(404, { error: 'not_found' });
};
fetchImpl.calls = [];

const resolveOk = async ({ token } = {}) => {
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
  nowMs: extra.nowMs || Date.now(),
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
    'AWS_RECIPIENT_BANK_VERIFY_STATE_TABLE',
  ];
  const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.AWS_PROVIDER_LIVE_READS_ENABLED = extra.liveReads ?? 'true';
  process.env.AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED = extra.bankVerify ?? 'true';
  process.env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED = extra.sandbox ?? 'false';
  process.env.AWS_PROVIDER_EXECUTION_ENABLED = extra.execution ?? 'false';
  process.env.AWS_MOOV_ENABLED = extra.moov ?? 'false';
  process.env.AWS_FINANCIAL_PERMISSIONS_ACTIVATED = extra.financial ?? 'false';
  process.env.AWS_CHECKALT_ENABLED = extra.checkalt ?? 'false';
  if (extra.table === false) delete process.env.AWS_RECIPIENT_BANK_VERIFY_STATE_TABLE;
  else if (extra.table) process.env.AWS_RECIPIENT_BANK_VERIFY_STATE_TABLE = extra.table;
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

const initiate = (extra = {}) => handlePublicMoovRecipientBankVerifyInitiate(
  eventOf('/public/moov-recipient-bank-verify-initiate', { token: SESSION_TOKEN, ...extra.body }),
  deps(extra),
);

const confirm = (code, extra = {}) => handlePublicMoovRecipientBankVerifyConfirm(
  eventOf('/public/moov-recipient-bank-verify-confirm', { token: SESSION_TOKEN, code, ...extra.body }),
  deps(extra),
);

test('state machine forbids regression from verified', () => {
  assert.match(TABLE, /TableName: checksops-recipient-bank-verify-state/);
  assert.match(CFN, /AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED: "false"/);
  assert.match(CFN, /AWS_RECIPIENT_BANK_VERIFY_STATE_TABLE: "checksops-recipient-bank-verify-state"/);
  assert.equal(canTransitionBankVerifyState('verified', 'not_started'), false);
  assert.equal(canTransitionBankVerifyState('verified', 'initiation_claimed'), false);
  assert.equal(canTransitionBankVerifyState('verified', 'verification_pending'), false);
  assert.equal(canTransitionBankVerifyState('verified', 'uncertain'), false);
  assert.equal(canTransitionBankVerifyState('verified', 'verified'), true);
  assert.equal(canTransitionBankVerifyState('not_started', 'initiation_claimed'), true);
  assert.equal(canTransitionBankVerifyState('initiation_claimed', 'verification_pending'), true);
  assert.equal(canTransitionBankVerifyState('uncertain', 'verified'), true);
});

test('memory CAS allows only one initiation claimant', async () => {
  const backing = new Map();
  const left = createMemoryBankVerifyStore(backing);
  const right = createMemoryBankVerifyStore(backing);
  const ids = { recipientId: RECIPIENT_ID, accountId: ACCOUNT_ID, bankId: BANK_ID, tokenFp: 'abc', nowMs: 1 };
  const [a, b] = await Promise.all([
    left.claimInitiation({ ...ids, claimantId: 'L', idempotencyKey: 'k' }),
    right.claimInitiation({ ...ids, claimantId: 'R', idempotencyKey: 'k' }),
  ]);
  assert.equal([a.claimed, b.claimed].filter(Boolean).length, 1);
  const verified = await left.transitionClaim({ ...ids, to: BANK_VERIFY_STATES.VERIFIED, nowMs: 2 });
  assert.equal(verified.ok, true);
  const back = await right.transitionClaim({ ...ids, to: BANK_VERIFY_STATES.UNCERTAIN, nowMs: 3 });
  assert.equal(back.ok, false);
  assert.equal(back.error, 'verified_no_regression');
});

test('two simultaneous initiation Lambdas share one POST', async () => {
  await withFlags(async () => {
    const backing = new Map();
    moovState.delayPost = true;
    const [left, right] = await Promise.all([
      initiate({ bankVerifyStore: createMemoryBankVerifyStore(backing) }),
      initiate({ bankVerifyStore: createMemoryBankVerifyStore(backing) }),
    ]);
    assert.equal(moovState.postCount, 1);
    const posts = fetchImpl.calls.filter((call) => call.method === 'POST' && String(call.path).includes('/verify'));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, `/accounts/${ACCOUNT_ID}/bank-accounts/${BANK_ID}/verify`);
    assert.equal([left.ok, right.ok].filter(Boolean).length >= 1, true);
    assert.equal([left, right].some((result) => result.mutated === true || result.error === 'initiate_uncertain'), true);
  });
});

test('Lambda retry after provider acceptance never POSTs again', async () => {
  await withFlags(async () => {
    const first = await initiate({ crashAfterPost: true });
    assert.equal(first.error, 'initiate_uncertain');
    assert.equal(moovState.postCount, 1);
    assert.equal((await testStore.getClaim({
      recipientId: RECIPIENT_ID, accountId: ACCOUNT_ID, bankId: BANK_ID,
    })).state, BANK_VERIFY_STATES.INITIATION_CLAIMED);
    const retry = await initiate();
    assert.equal(retry.already_initiated, true);
    assert.equal(retry.mutated, false);
    assert.equal(moovState.postCount, 1);
    assert.equal(retry.state, BANK_VERIFY_STATES.VERIFICATION_PENDING);
  });
});

test('provider timeout reconciles and never blind-retries', async () => {
  await withFlags(async () => {
    const first = await initiate();
    assert.equal(first.error, 'initiate_uncertain');
    assert.equal(first.state, BANK_VERIFY_STATES.UNCERTAIN);
    assert.equal(moovState.postCount, 1);
    const second = await initiate();
    assert.equal(second.error, 'initiate_uncertain');
    assert.equal(moovState.postCount, 1);
  }, { postError: 'timeout' });
});

test('DB claim success with lost provider response does not POST again', async () => {
  await withFlags(async () => {
    const first = await initiate();
    assert.equal(first.ok, true);
    assert.equal(first.already_initiated, true);
    assert.equal(first.mutated, false);
    assert.equal(first.state, BANK_VERIFY_STATES.VERIFICATION_PENDING);
    assert.equal(moovState.postCount, 1);
    assert.equal(moovState.bankStatus, 'pending');
    const second = await initiate();
    assert.equal(second.already_initiated, true);
    assert.equal(second.mutated, false);
    assert.equal(moovState.postCount, 1);
    assert.equal(second.state, BANK_VERIFY_STATES.VERIFICATION_PENDING);
  }, { postError: 'lost' });
});

test('already initiated and verified banks never POST', async () => {
  await withFlags(async () => {
    const result = await initiate();
    assert.equal(result.already_initiated, true);
    assert.equal(result.mutated, false);
    assert.equal(moovState.postCount, 0);
    assert.equal(result.state, BANK_VERIFY_STATES.VERIFICATION_PENDING);
  }, { bankStatus: 'pending', verifyStatus: 'sent-credit' });
  await withFlags(async () => {
    const result = await initiate();
    assert.equal(result.already_verified, true);
    assert.equal(result.mutated, false);
    assert.equal(moovState.postCount, 0);
    assert.equal(result.state, BANK_VERIFY_STATES.VERIFIED);
    const regress = await testStore.transitionClaim({
      recipientId: RECIPIENT_ID, accountId: ACCOUNT_ID, bankId: BANK_ID,
      to: BANK_VERIFY_STATES.NOT_STARTED, nowMs: Date.now(),
    });
    assert.equal(regress.ok, false);
  }, { bankStatus: 'verified', verifyStatus: 'successful' });
});

test('three wrong MV attempts then fourth blocked; limiter survives new Lambda', async () => {
  await withFlags(async () => {
    const backing = new Map();
    const firstStore = createMemoryBankVerifyStore(backing);
    moovState.bankStatus = 'pending';
    moovState.verifyStatus = 'sent-credit';
    const first = await confirm('0001', { bankVerifyStore: firstStore });
    assert.equal(first.error, 'verification_failed');
    assert.equal(first.attempts_remaining, 2);
    const secondStore = createMemoryBankVerifyStore(backing);
    const second = await confirm('0002', { bankVerifyStore: secondStore });
    assert.equal(second.attempts_remaining, 1);
    const thirdStore = createMemoryBankVerifyStore(backing);
    const third = await confirm('0003', { bankVerifyStore: thirdStore });
    assert.equal(third.error, 'max_attempts_exceeded');
    const fourthStore = createMemoryBankVerifyStore(backing);
    const fourth = await confirm('0004', { bankVerifyStore: fourthStore });
    assert.equal(fourth.error, 'max_attempts_exceeded');
    assert.equal(moovState.putCount, 3);
    assert.equal(JSON.stringify(deps.logs).includes('0001'), false);
    assert.equal(JSON.stringify(first).includes('0001'), false);
  }, { bankStatus: 'pending', verifyStatus: 'sent-credit', putFail: 'wrong' });
});

test('provider timeout still consumes an MV attempt and limiter fails closed', async () => {
  await withFlags(async () => {
    moovState.bankStatus = 'pending';
    moovState.verifyStatus = 'sent-credit';
    const first = await confirm('0001');
    assert.equal(first.error, 'verification_failed');
    assert.equal(first.attempts_remaining, 2);
    assert.equal(moovState.putCount, 1);
    await confirm('0002');
    const third = await confirm('0003');
    assert.equal(third.error, 'max_attempts_exceeded');
    const fourth = await confirm('0004');
    assert.equal(fourth.error, 'max_attempts_exceeded');
    assert.equal(moovState.putCount, 3);
  }, { bankStatus: 'pending', verifyStatus: 'sent-credit', putFail: 'timeout' });

  await withFlags(async () => {
    moovState.bankStatus = 'pending';
    moovState.verifyStatus = 'sent-credit';
    const blocked = await confirm('0001', { bankVerifyStore: createUnavailableBankVerifyStore() });
    assert.equal(blocked.error, 'bank_verify_limiter_unavailable');
    assert.equal(blocked.statusCode, 503);
    assert.equal(moovState.putCount, 0);
    const missing = await handlePublicMoovRecipientBankVerifyConfirm(
      eventOf('/public/moov-recipient-bank-verify-confirm', { token: SESSION_TOKEN, code: '0001' }),
      { ...deps(), bankVerifyStore: undefined },
    );
    assert.equal(missing.error, 'bank_verify_state_unconfigured');
    assert.equal(moovState.putCount, 0);
  }, { bankStatus: 'pending', verifyStatus: 'sent-credit', putFail: 'wrong', table: false });
});

test('cross-bank account recipient substitution cannot move verify writes', async () => {
  await withFlags(async () => {
    const forgedBank = await initiate({ body: { bank_account_id: OTHER_BANK } });
    assert.equal(forgedBank.error, 'bank_account_mismatch');
    const forgedAccount = await initiate({ body: { account_id: OTHER_ACCOUNT } });
    assert.equal(forgedAccount.error, 'bank_account_mismatch');
    const forgedRecipient = await initiate({ body: { recipient_id: OTHER_RECIPIENT } });
    assert.equal(forgedRecipient.error, 'recipient_mismatch');
    const transfer = await initiate({ body: { create_transfer: true } });
    assert.equal(transfer.error, 'provider_execution_blocked');
    assert.equal(moovState.postCount, 0);
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
    const confirmOther = await confirm('1506', { body: { bank_account_id: OTHER_BANK } });
    assert.equal(confirmOther.error, 'bank_account_mismatch');
    assert.equal(INDEX.includes('/public/moov-transfers'), false);
    assert.equal(executionAllowed('moov'), false);
    const flags = flagSnapshot();
    assert.equal(flags.AWS_MOOV_ENABLED, false);
    assert.equal(flags.AWS_PROVIDER_EXECUTION_ENABLED, false);
    assert.equal(flags.AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED, true);
  });
});

test('token fingerprint is not the raw token and MV code is never stored', async () => {
  const fp = tokenFingerprint(SESSION_TOKEN);
  assert.equal(fp.length, 16);
  assert.equal(fp.includes(SESSION_TOKEN), false);
  assert.match(STATE, /token_fp/);
  assert.doesNotMatch(HANDLER, /mvAttempts/);
  assert.match(HANDLER, /consumeMvAttempt/);
  assert.match(UI, /bank_verify_available === true/);
  assert.match(UI, /Send verification deposit/);
});

test('DynamoDB CAS PutItem and MV increment fail closed on limiter errors', async () => {
  const items = new Map();
  const dynamoRequest = async ({ target, body }) => {
    const keyOf = (key) => `${key.pk.S}#${key.sk.S}`;
    if (target.endsWith('PutItem')) {
      const key = keyOf(body.Item);
      if (items.has(key)) {
        const error = new Error('conditional');
        error.code = 'ConditionalCheckFailedException';
        throw error;
      }
      items.set(key, body.Item);
      return {};
    }
    if (target.endsWith('GetItem')) {
      return { Item: items.get(keyOf(body.Key)) };
    }
    if (target.endsWith('UpdateItem')) {
      const key = keyOf(body.Key);
      if (String(body.UpdateExpression).includes('attempts')) {
        const current = items.get(key) || { attempts: { N: '0' } };
        const attempts = Number(current.attempts?.N || 0);
        if (attempts >= 3) {
          const error = new Error('conditional');
          error.code = 'ConditionalCheckFailedException';
          throw error;
        }
        const next = { ...body.Key, attempts: { N: String(attempts + 1) } };
        items.set(key, next);
        return { Attributes: next };
      }
      const current = items.get(key) || { state: { S: 'not_started' } };
      if (current.state?.S === 'verified' && body.ExpressionAttributeValues?.[':to']) {
        const error = new Error('conditional');
        error.code = 'ConditionalCheckFailedException';
        throw error;
      }
      const next = {
        ...current,
        ...body.Key,
        state: body.ExpressionAttributeValues[':verified'] || body.ExpressionAttributeValues[':to'],
      };
      items.set(key, next);
      return { Attributes: next };
    }
    throw new Error('unexpected');
  };
  const store = createDynamoBankVerifyStore({ tableName: 't', dynamoRequest, nowMsFn: () => 1 });
  const ids = { recipientId: RECIPIENT_ID, accountId: ACCOUNT_ID, bankId: BANK_ID, tokenFp: 'fp', nowMs: 1 };
  const first = await store.claimInitiation({ ...ids, claimantId: 'A', idempotencyKey: 'k' });
  const second = await store.claimInitiation({ ...ids, claimantId: 'B', idempotencyKey: 'k' });
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  const one = await store.consumeMvAttempt(ids);
  const two = await store.consumeMvAttempt(ids);
  const three = await store.consumeMvAttempt(ids);
  const four = await store.consumeMvAttempt(ids);
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  assert.equal(three.ok, true);
  assert.equal(four.ok, false);
  assert.equal(four.error, 'max_attempts_exceeded');
  await store.transitionClaim({ ...ids, to: BANK_VERIFY_STATES.VERIFIED, nowMs: 2 });
  const regress = await store.transitionClaim({ ...ids, to: BANK_VERIFY_STATES.UNCERTAIN, nowMs: 3 });
  assert.equal(regress.ok, false);
});
