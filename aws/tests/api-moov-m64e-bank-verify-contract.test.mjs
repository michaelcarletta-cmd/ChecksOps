import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  handlePublicMoovRecipientBankVerifyConfirm,
  handlePublicMoovRecipientBankVerifyInitiate,
  newTestBankVerifyStore,
  noteRecipientBankVerifyFailure,
  recipientBankVerifyRateLimited,
  resetRecipientBankVerifyMemoryForTests,
} from '../functions/api/public-moov-recipient-bank-verify.mjs';
import {
  BANK_VERIFY_CLAIM_TTL_SECONDS,
  BANK_VERIFY_STATES,
  createDynamoBankVerifyStore,
  createMemoryBankVerifyStore,
  isBankVerifyClaimExpired,
  redactBankVerifyAudit,
  ttlEpochSeconds,
} from '../functions/api/providers/recipient-bank-verify-state.mjs';
import { handleBankVerifyStateProbe } from '../functions/api/providers/recipient-bank-verify-state-probe.mjs';
import {
  bankVerifyConfirmEnabled,
  bankVerifyInitiateEnabled,
  bankVerifyView,
  mapRecipientPublicError,
} from '../../src/lib/recipientBankVerifyUi.ts';

const RECIPIENT_ID = '62a858ff-ee6a-49d7-9898-1c8e4a44227b';
const ACCOUNT_ID = 'ee8c608e-dc2d-45d3-95e9-3c992f3dfc5f';
const BANK_ID = '72eb66c1-d9a9-4f85-ab50-8871db9ceeea';
const TENANT_ID = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = 'aaaaaaaa-0000-4000-8000-000000000099';
const SESSION_TOKEN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const HANDLER = readFileSync(new URL('../functions/api/public-moov-recipient-bank-verify.mjs', import.meta.url), 'utf8');
const PROBE = readFileSync(new URL('../functions/api/providers/recipient-bank-verify-state-probe.mjs', import.meta.url), 'utf8');
const UI = readFileSync(new URL('../../src/pages/RecipientPaymentSetup.tsx', import.meta.url), 'utf8');
const IAM = readFileSync(new URL('../production/bank-verify-state-lambda-iam.yaml', import.meta.url), 'utf8');
const TABLE = readFileSync(new URL('../production/bank-verify-state-table.yaml', import.meta.url), 'utf8');
const CFN = readFileSync(new URL('../production/api-cfn.yaml', import.meta.url), 'utf8');

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
  body: JSON.stringify(body),
  requestContext: {
    stage: 'prep',
    http: { method: 'POST', path, sourceIp: extra.ip || '127.0.0.1' },
  },
});

const moovState = { bankStatus: 'new', verifyStatus: null, postCount: 0, putCount: 0, mode: 'ok' };

const jsonResponse = (status, payload, raw) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => raw ? 'text/html' : 'application/json' },
  text: async () => raw != null ? raw : JSON.stringify(payload),
});

const fetchImpl = async (url, init = {}) => {
  const method = String(init.method || 'GET').toUpperCase();
  const path = String(url).replace('https://api.moov.io', '');
  fetchImpl.calls.push({ method, path });
  if (path === '/oauth2/token') {
    return jsonResponse(200, { access_token: 'bank-oauth-token', token_type: 'Bearer', expires_in: 300 });
  }
  if (moovState.mode === 'malformed_account' && path === `/accounts/${ACCOUNT_ID}` && method === 'GET') {
    return jsonResponse(200, null, '<html>nope</html>');
  }
  if (moovState.mode === 'provider_500' && path.includes('/verify') && method === 'POST') {
    return jsonResponse(500, { error: 'upstream' });
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
  if (path.includes('/verify')) {
    if (method === 'POST') {
      moovState.postCount += 1;
      moovState.verifyStatus = 'sent-credit';
      moovState.bankStatus = 'pending';
      return jsonResponse(200, { status: 'sent-credit' });
    }
    if (method === 'PUT') {
      moovState.putCount += 1;
      moovState.bankStatus = 'verified';
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

const resolveOk = async () => ({ ok: true, recipient: { ...productionRecipient } });
let testStore = newTestBankVerifyStore();

const deps = (extra = {}) => ({
  resolveRecipientByToken: extra.resolveRecipientByToken || resolveOk,
  loadProductionReadSecrets: async () => secrets,
  fetchImpl,
  nowMs: extra.nowMs || Date.now(),
  bankVerifyStore: extra.bankVerifyStore || testStore,
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
  process.env.AWS_PROVIDER_LIVE_READS_ENABLED = 'true';
  process.env.AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED = extra.bankVerify ?? 'true';
  process.env.AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED = 'false';
  process.env.AWS_PROVIDER_EXECUTION_ENABLED = 'false';
  process.env.AWS_MOOV_ENABLED = 'false';
  process.env.AWS_FINANCIAL_PERMISSIONS_ACTIVATED = 'false';
  process.env.AWS_CHECKALT_ENABLED = 'false';
  fetchImpl.calls = [];
  deps.logs = [];
  resetRecipientBankVerifyMemoryForTests();
  testStore = extra.store || newTestBankVerifyStore();
  moovState.bankStatus = extra.bankStatus || 'new';
  moovState.verifyStatus = extra.verifyStatus === undefined ? null : extra.verifyStatus;
  moovState.postCount = 0;
  moovState.putCount = 0;
  moovState.mode = extra.mode || 'ok';
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
};

test('expired claims become not_started and can be reclaimed', async () => {
  const store = createMemoryBankVerifyStore();
  const ids = {
    recipientId: RECIPIENT_ID, accountId: ACCOUNT_ID, bankId: BANK_ID,
    tenantId: TENANT_ID, tokenFp: 'fp', nowMs: 1_000,
  };
  const first = await store.claimInitiation({ ...ids, claimantId: 'A' });
  assert.equal(first.claimed, true);
  assert.equal(typeof first.item.ttl, 'number');
  assert.equal(isBankVerifyClaimExpired(first.item, 1_000), false);
  const later = 1_000 + (BANK_VERIFY_CLAIM_TTL_SECONDS + 5) * 1000;
  const existing = await store.getClaim({ ...ids, nowMs: later });
  assert.equal(existing.state, BANK_VERIFY_STATES.NOT_STARTED);
  const retry = await store.claimInitiation({ ...ids, nowMs: later, claimantId: 'B' });
  assert.equal(retry.claimed, true);
  assert.equal(retry.item.claimant_id, 'B');
});

test('verified claims never expire and never regress', async () => {
  const store = createMemoryBankVerifyStore();
  const ids = { recipientId: RECIPIENT_ID, accountId: ACCOUNT_ID, bankId: BANK_ID, tenantId: TENANT_ID, nowMs: 1 };
  await store.claimInitiation({ ...ids, claimantId: 'A' });
  const verified = await store.transitionClaim({ ...ids, to: BANK_VERIFY_STATES.VERIFIED, nowMs: 2 });
  assert.equal(verified.item.ttl, null);
  const later = await store.getClaim({ ...ids, nowMs: 9e12 });
  assert.equal(later.state, BANK_VERIFY_STATES.VERIFIED);
  const regress = await store.transitionClaim({ ...ids, to: BANK_VERIFY_STATES.UNCERTAIN, nowMs: 3 });
  assert.equal(regress.ok, false);
});

test('tenant scope mismatch cannot steal a claim or MV limiter', async () => {
  const store = createMemoryBankVerifyStore();
  const ids = { recipientId: RECIPIENT_ID, accountId: ACCOUNT_ID, bankId: BANK_ID, tenantId: TENANT_ID, tokenFp: 'fp', nowMs: 1 };
  await store.claimInitiation({ ...ids, claimantId: 'A' });
  const stolen = await store.claimInitiation({ ...ids, tenantId: OTHER_TENANT, claimantId: 'B' });
  assert.equal(stolen.error, 'tenant_scope_mismatch');
  assert.equal(stolen.claimed, false);
  await store.consumeMvAttempt(ids);
  const otherMv = await store.consumeMvAttempt({ ...ids, tenantId: OTHER_TENANT });
  assert.equal(otherMv.error, 'tenant_scope_mismatch');
});

test('MV limiter is isolated by token fingerprint', async () => {
  const store = createMemoryBankVerifyStore();
  const base = { recipientId: RECIPIENT_ID, accountId: ACCOUNT_ID, bankId: BANK_ID, tenantId: TENANT_ID, nowMs: 1 };
  assert.equal((await store.consumeMvAttempt({ ...base, tokenFp: 'aaa' })).ok, true);
  assert.equal((await store.consumeMvAttempt({ ...base, tokenFp: 'bbb' })).ok, true);
  assert.equal((await store.consumeMvAttempt({ ...base, tokenFp: 'aaa' })).count, 2);
});

test('audit redaction drops routing, account, token, and codes', () => {
  const redacted = redactBankVerifyAudit({
    routing_number: '021000021',
    account_number: '123456789',
    code: '0001',
    token: SESSION_TOKEN,
    recipient_id: RECIPIENT_ID,
    state: 'initiation_claimed',
  });
  assert.equal(redacted.routing_number, '[redacted]');
  assert.equal(redacted.account_number, '[redacted]');
  assert.equal(redacted.code, '[redacted]');
  assert.equal(redacted.token, '[redacted]');
  assert.equal(redacted.state, 'initiation_claimed');
  assert.equal(ttlEpochSeconds(1000, 10), 11);
});

test('probe refuses table-admin and never DeleteItem/CreateTable', async () => {
  assert.doesNotMatch(PROBE, /DynamoDB_20120810\.CreateTable/);
  assert.doesNotMatch(PROBE, /DynamoDB_20120810\.DeleteItem/);
  assert.doesNotMatch(PROBE, /DynamoDB_20120810\.PutResourcePolicy/);
  const blocked = await handleBankVerifyStateProbe({
    checksops_bank_verify_state_probe: true,
    action: 'provision',
  });
  assert.equal(blocked.error, 'operator_table_create_required');
  assert.equal(blocked.provider_http, false);
});

test('malformed provider account JSON fails closed without POST', async () => {
  await withFlags(async () => {
    const result = await handlePublicMoovRecipientBankVerifyInitiate(
      eventOf('/public/moov-recipient-bank-verify-initiate', { token: SESSION_TOKEN }),
      deps(),
    );
    assert.equal(result.error, 'moov_account_malformed');
    assert.equal(result.statusCode, 502);
    assert.equal(moovState.postCount, 0);
    assert.equal(JSON.stringify(result).includes('021000021'), false);
  }, { mode: 'malformed_account' });
});

test('provider 5xx on initiate does not leak money paths', async () => {
  await withFlags(async () => {
    const result = await handlePublicMoovRecipientBankVerifyInitiate(
      eventOf('/public/moov-recipient-bank-verify-initiate', { token: SESSION_TOKEN }),
      deps(),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'initiate_failed');
    assert.equal(result.productionExecution, false);
    assert.equal(fetchImpl.calls.some((call) => call.path.includes('/transfers')), false);
  }, { mode: 'provider_500' });
});

test('ACH RTP wire and transfer keys stay provider_execution_blocked', async () => {
  await withFlags(async () => {
    for (const key of ['create_transfer', 'ach', 'rtp', 'wire', 'create_ach']) {
      const result = await handlePublicMoovRecipientBankVerifyInitiate(
        eventOf('/public/moov-recipient-bank-verify-initiate', { token: SESSION_TOKEN, [key]: true }),
        deps(),
      );
      assert.equal(result.error, 'provider_execution_blocked');
      assert.equal(moovState.postCount, 0);
    }
  });
});

test('browser tenant spoof and IP rate limit fail closed', async () => {
  await withFlags(async () => {
    const spoof = await handlePublicMoovRecipientBankVerifyInitiate(
      eventOf('/public/moov-recipient-bank-verify-initiate', { token: SESSION_TOKEN, tenant_id: OTHER_TENANT }),
      deps(),
    );
    assert.equal(spoof.error, 'tenant_mismatch');
    assert.equal(moovState.postCount, 0);
  });
  resetRecipientBankVerifyMemoryForTests();
  const ip = '203.0.113.9';
  for (let i = 0; i < 30; i += 1) noteRecipientBankVerifyFailure({ ip, nowMs: 1_000 + i });
  assert.equal(recipientBankVerifyRateLimited({ ip, nowMs: 1_030 }), true);
  const limited = await handlePublicMoovRecipientBankVerifyInitiate(
    eventOf('/public/moov-recipient-bank-verify-initiate', { token: SESSION_TOKEN }, { ip }),
    deps({ nowMs: 1_030 }),
  );
  assert.equal(limited.error, 'recipient_token_rate_limited');
  assert.equal(limited.statusCode, 429);
});

test('public confirm success never echoes routing or MV code', async () => {
  await withFlags(async () => {
    const result = await handlePublicMoovRecipientBankVerifyConfirm(
      eventOf('/public/moov-recipient-bank-verify-confirm', {
        token: SESSION_TOKEN,
        code: '0001',
        routing_number: '021000021',
        account_number: '999999999',
      }),
      deps(),
    );
    assert.equal(result.ok, true);
    assert.equal(result.state, BANK_VERIFY_STATES.VERIFIED);
    assert.equal(result.routing_number, undefined);
    assert.equal(result.account_number, undefined);
    assert.equal(result.code, undefined);
    assert.equal(result.mv_code_returned, false);
    assert.equal(JSON.stringify(result).includes('0001'), false);
    assert.equal(JSON.stringify(result).includes('021000021'), false);
  }, { bankStatus: 'pending', verifyStatus: 'sent-credit' });
});

test('frontend bank-verify views stay dark unless available', () => {
  assert.equal(bankVerifyView(null, { loading: true }), 'loading');
  assert.equal(bankVerifyView({
    onboarding: {
      terms_accepted: true,
      verification_status: 'verified',
      identity_requirements_known: true,
      identity_requirements_outstanding: [],
      bank_verify_available: false,
      bank_should_initiate: true,
    },
  }), 'unavailable');
  assert.equal(bankVerifyInitiateEnabled('unavailable', false), false);
  assert.equal(bankVerifyView({
    onboarding: {
      terms_accepted: true,
      verification_status: 'verified',
      identity_requirements_known: true,
      identity_requirements_outstanding: [],
      bank_verify_available: true,
      bank_should_initiate: true,
    },
  }), 'initiate');
  assert.equal(bankVerifyInitiateEnabled('initiate', true), false);
  assert.equal(bankVerifyView({
    onboarding: {
      terms_accepted: true,
      verification_status: 'verified',
      identity_requirements_known: true,
      identity_requirements_outstanding: [],
      bank_verify_available: true,
      bank_can_confirm: true,
    },
  }), 'pending_confirm');
  assert.equal(bankVerifyConfirmEnabled('pending_confirm', false, 4), true);
  assert.equal(bankVerifyView({
    onboarding: {
      terms_accepted: true,
      verification_status: 'verified',
      identity_requirements_known: true,
      identity_requirements_outstanding: [],
      bank_verified: true,
    },
  }), 'verified');
  assert.equal(mapRecipientPublicError('recipient_bank_verify_writes_blocked'), 'Bank verification is not available yet.');
  assert.equal(mapRecipientPublicError('max_attempts_exceeded').includes('Too many'), true);
  assert.match(UI, /useState<string \| null>\(null\)/);
  assert.match(UI, /tosDropToken/);
  assert.match(UI, /bankVerifyInitiateEnabled/);
  assert.doesNotMatch(UI, /sessionStorage/);
  assert.doesNotMatch(UI, /localStorage/);
  assert.match(HANDLER, /tenantId: recipient.tenant_id/);
});

test('operator IAM package remains least privilege and flags stay false', () => {
  assert.match(IAM, /dynamodb:GetItem/);
  assert.match(IAM, /dynamodb:PutItem/);
  assert.match(IAM, /dynamodb:UpdateItem/);
  assert.match(IAM, /dynamodb:DescribeTable/);
  assert.doesNotMatch(IAM, /dynamodb:Scan/);
  assert.doesNotMatch(IAM, /dynamodb:CreateTable/);
  assert.doesNotMatch(IAM, /dynamodb:DeleteItem/);
  assert.doesNotMatch(IAM, /Resource: '\*'/);
  assert.match(TABLE, /PAY_PER_REQUEST/);
  assert.match(TABLE, /DeletionProtectionEnabled: true/);
  assert.match(CFN, /AWS_PROVIDER_RECIPIENT_BANK_VERIFY_WRITES_ENABLED: "false"/);
  assert.match(CFN, /AWS_MOOV_ENABLED: "false"/);
  assert.match(CFN, /AWS_PROVIDER_EXECUTION_ENABLED: "false"/);
});

test('DynamoDB CAS put stamps ttl and tenant', async () => {
  const items = new Map();
  const dynamoRequest = async ({ target, body }) => {
    const keyOf = (key) => `${key.pk.S}#${key.sk.S}`;
    if (target.endsWith('PutItem')) {
      assert.equal(Boolean(body.Item.ttl), true);
      assert.equal(body.Item.tenant_id.S, TENANT_ID);
      items.set(keyOf(body.Item), body.Item);
      return {};
    }
    if (target.endsWith('GetItem')) return { Item: items.get(keyOf(body.Key)) };
    throw new Error(`unexpected ${target}`);
  };
  const store = createDynamoBankVerifyStore({ tableName: 't', dynamoRequest, nowMsFn: () => 1_700_000_000_000 });
  const claimed = await store.claimInitiation({
    recipientId: RECIPIENT_ID, accountId: ACCOUNT_ID, bankId: BANK_ID,
    tenantId: TENANT_ID, claimantId: 'A', tokenFp: 'fp',
  });
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.item.tenant_id, TENANT_ID);
  assert.equal(typeof claimed.item.ttl, 'number');
});
