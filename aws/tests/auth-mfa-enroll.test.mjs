import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  evaluateCognitoTotpEnrollment,
  handleMfaAssociate,
  handleMfaSetPreference,
  handleMfaStatus,
  handleMfaStepUp,
  handleMfaVerify,
  MFA_AUTH_ROUTES,
} from '../functions/api/auth-mfa.mjs';
import { AUTH_ROUTES } from '../functions/api/auth-cognito.mjs';
import { timestepOf, totpAt, wrapKeyFromHex } from '../functions/api/financial-totp.mjs';
import { CHECKALT_TOTP_ACTION } from '../functions/api/providers/production/checkalt-authz.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TESTER_EMAIL = 'checksops-tester@freedomadj.com';
const TESTER_APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const TESTER_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const OTHER_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const CHECK = 'a3a4a153-46e1-4c28-a273-79a9bd04f3a6';
const OTHER_CHECK = '55555555-5555-4555-8555-555555555555';
const NOW = Date.UTC(2026, 8, 11, 1, 0, 0);
const WRAP_HEX = 'ab'.repeat(32);

const eventOf = (body) => ({
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    authorizer: { jwt: { claims: { sub: TESTER_SUB, email: TESTER_EMAIL, token_use: 'id' } } },
  },
});

const createStore = ({
  userId = TESTER_APP,
  email = TESTER_EMAIL,
  memberships = [{ tenant_id: TENANT, role: 'admin' }],
  checks = [{ id: CHECK, tenant_id: TENANT, amount: 12.34, status: 'ready' }],
} = {}) => {
  const enrollments = new Map();
  const rates = new Map();
  const stepups = [];
  const cognitoCalls = [];
  const client = {
    query: async (sql, params = []) => {
      const text = String(sql);
      if (text.includes('consume_financial_totp_rate_limit')) {
        const [uid, action, limit] = params;
        if (String(uid) !== String(userId)) {
          const error = new Error('rate_limit_caller_mismatch');
          error.code = '42501';
          throw error;
        }
        const key = `${uid}:${action}`;
        const count = (rates.get(key) || 0) + 1;
        rates.set(key, count);
        return { rows: [{ allowed: count <= Number(limit), count, retry_after_seconds: 60 }] };
      }
      if (text.includes('financial_totp_upsert_enrollment')) {
        const [uid, ciphertext, nonce, keyId] = params;
        if (String(uid) !== String(userId)) {
          const error = new Error('enrollment_caller_mismatch');
          error.code = '42501';
          throw error;
        }
        const existing = enrollments.get(String(uid));
        if (existing?.verified_at) {
          const error = new Error('verified_enrollment_exists');
          error.code = 'P0001';
          throw error;
        }
        enrollments.set(String(uid), {
          ciphertext,
          nonce,
          key_id: keyId,
          last_used_timestep: null,
          verified_at: null,
          enrolled_at: new Date(NOW).toISOString(),
          failed_attempts: 0,
          locked_until: null,
        });
        return { rows: [] };
      }
      if (text.includes('financial_totp_get_enrollment')) {
        if (String(params[0]) !== String(userId)) {
          const error = new Error('enrollment_caller_mismatch');
          error.code = '42501';
          throw error;
        }
        const row = enrollments.get(String(params[0]));
        return { rows: row ? [row] : [] };
      }
      if (text.includes('financial_totp_status')) {
        const row = enrollments.get(String(params[0]));
        return { rows: row ? [{ enrolled_at: row.enrolled_at, verified_at: row.verified_at }] : [] };
      }
      if (text.includes('financial_totp_mark_verified')) {
        const row = enrollments.get(String(params[0]));
        const timestep = params[1];
        if (!row) return { rows: [{ claimed: false }] };
        if (timestep !== null && timestep !== undefined
          && row.last_used_timestep !== null
          && Number(row.last_used_timestep) === Number(timestep)) {
          return { rows: [{ claimed: false }] };
        }
        row.verified_at = row.verified_at || new Date(NOW).toISOString();
        if (timestep !== null && timestep !== undefined) {
          row.last_used_timestep = timestep;
        }
        return { rows: [{ claimed: true }] };
      }
      if (text.includes('FROM public.check_intake_items')) {
        const check = checks.find((row) => row.id === params[0]);
        return { rows: check ? [check] : [] };
      }
      if (text.includes('FROM public.tenant_users')) {
        return { rows: memberships };
      }
      if (text.includes('INSERT INTO public.financial_stepup_log')) {
        const row = {
          id: `stepup-${stepups.length + 1}`,
          created_at: new Date(NOW).toISOString(),
          user_id: params[0],
          tenant_id: params[1],
          action_key: params[2],
          metadata: JSON.parse(params[3]),
        };
        stepups.push(row);
        return { rows: [row] };
      }
      return { rows: [] };
    },
  };
  return {
    client,
    enrollments,
    rates,
    stepups,
    cognitoCalls,
    mapping: {
      application_user_id: userId,
      email,
      cognito_sub: TESTER_SUB,
      status: 'isolated_test',
    },
  };
};

const depsOf = (store, extra = {}) => ({
  withIdentityWrite: async (event, fn) => {
    const body = event?.body ? JSON.parse(event.body) : {};
    return fn({
      client: store.client,
      mapping: store.mapping,
      claims: { sub: TESTER_SUB, email: TESTER_EMAIL },
      body,
      spoof: { ignored: true, bodyUserId: body.user_id || null, bodyTenantId: body.tenant_id || null },
    });
  },
  loadWrapKey: async () => ({ key: wrapKeyFromHex(WRAP_HEX), keyId: 'test' }),
  listPasskeys: async () => 0,
  nowMs: NOW,
  ...extra,
});

const enrollTester = async (store) => {
  const started = await handleMfaAssociate(eventOf({ email: TESTER_EMAIL }), depsOf(store));
  assert.equal(started.ok, true, JSON.stringify(started));
  const secret = started.totp.secret;
  const code = totpAt(secret, timestepOf(NOW));
  const verified = await handleMfaVerify(eventOf({ code }), depsOf(store));
  assert.equal(verified.ok, true, JSON.stringify(verified));
  return { secret, code, started, verified };
};

test('MFA enroll and verify routes are wired for POST /auth/mfa/*', () => {
  assert.equal(AUTH_ROUTES['/auth/mfa/associate'], MFA_AUTH_ROUTES['/auth/mfa/associate']);
  assert.equal(AUTH_ROUTES['/auth/mfa/verify'], MFA_AUTH_ROUTES['/auth/mfa/verify']);
  assert.equal(AUTH_ROUTES['/auth/mfa/step-up'], MFA_AUTH_ROUTES['/auth/mfa/step-up']);
  assert.equal(AUTH_ROUTES['/auth/mfa/set-preference'], MFA_AUTH_ROUTES['/auth/mfa/set-preference']);
});

test('tester can enroll app-level financial TOTP without Cognito MFA APIs', async () => {
  const store = createStore();
  const prev = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('cognito_should_not_be_called');
  };
  try {
    const { secret, started, verified } = await enrollTester(store);
    assert.match(started.totp.otpauth_uri, /otpauth:\/\/totp\/ChecksOps-Financial:/);
    assert.match(started.totp.otpauth_uri, /issuer=ChecksOps-Financial/);
    assert.doesNotMatch(started.totp.otpauth_uri, /ChecksOps%20Financial/);
    assert.equal(started.totp.qr_code, null);
    assert.equal(verified.enrollment, true);
    assert.equal(verified.recorded, false);
    assert.equal(store.stepups.length, 0);
    const status = await handleMfaStatus(eventOf({}), depsOf(store));
    assert.equal(status.totpEnrolled, true);
    assert.equal(status.source, 'financial_totp_enrollments');
    assert.equal(JSON.stringify(status).includes(secret), false);
    assert.equal(JSON.stringify(verified).includes(secret), false);
  } finally {
    globalThis.fetch = prev;
  }
});

test('correct TOTP step-up writes financial_stepup_log bound to server check amount', async () => {
  const store = createStore();
  const { code } = await enrollTester(store);
  const stepped = await handleMfaStepUp(eventOf({
    code,
    action_key: CHECKALT_TOTP_ACTION,
    tenant_id: OTHER_TENANT,
    user_id: '00000000-0000-4000-8000-000000000000',
    check_intake_item_id: CHECK,
  }), depsOf(store));
  assert.equal(stepped.ok, true, JSON.stringify(stepped));
  assert.equal(stepped.recorded, true);
  assert.equal(stepped.amount_cents, 1234);
  assert.equal(stepped.tenant_id, TENANT);
  assert.equal(stepped.check_id, CHECK);
  assert.equal(store.stepups.length, 1);
  assert.equal(store.stepups[0].metadata.amount_cents, 1234);
  assert.equal(store.stepups[0].metadata.source, 'app_financial_totp');
  assert.equal(store.stepups[0].user_id, TESTER_APP);
});

test('wrong TOTP fails closed and does not write financial_stepup_log', async () => {
  const store = createStore();
  await enrollTester(store);
  const failed = await handleMfaStepUp(eventOf({
    code: '000000',
    check_intake_item_id: CHECK,
  }), depsOf(store));
  assert.equal(failed.ok, false);
  assert.equal(store.stepups.length, 0);
  assert.match(String(failed.message || ''), /Wait for a new code/i);
});

test('expired timestep fails closed', async () => {
  const store = createStore();
  const { secret } = await enrollTester(store);
  const stale = totpAt(secret, timestepOf(NOW) + 5);
  const failed = await handleMfaStepUp(eventOf({
    code: stale,
    check_intake_item_id: CHECK,
  }), depsOf(store));
  assert.equal(failed.ok, false);
  assert.equal(store.stepups.length, 0);
});

test('replayed timestep is rejected', async () => {
  const store = createStore();
  const { code } = await enrollTester(store);
  const first = await handleMfaStepUp(eventOf({ code, check_intake_item_id: CHECK }), depsOf(store));
  assert.equal(first.ok, true);
  const replay = await handleMfaStepUp(eventOf({ code, check_intake_item_id: CHECK }), depsOf(store));
  assert.equal(replay.ok, false);
  assert.equal(store.stepups.length, 1);
});

test('step-up is rate limited', async () => {
  const store = createStore();
  await enrollTester(store);
  store.rates.set(`${TESTER_APP}:step_up`, 5);
  const denied = await handleMfaStepUp(eventOf({
    code: '123456',
    check_intake_item_id: CHECK,
  }), depsOf(store));
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'rate_limited');
  assert.equal(store.stepups.length, 0);
});

test('cross-user, cross-tenant, and cross-resource step-ups are rejected', async () => {
  const foreign = createStore({
    userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    memberships: [{ tenant_id: TENANT, role: 'admin' }],
  });
  const missing = await handleMfaStepUp(eventOf({
    code: '123456',
    check_intake_item_id: CHECK,
  }), depsOf(foreign));
  assert.equal(missing.error, 'totp_not_enrolled');

  const store = createStore();
  const { code } = await enrollTester(store);
  const otherTenantCheck = createStore({
    checks: [{ id: CHECK, tenant_id: OTHER_TENANT, amount: 12.34, status: 'ready' }],
    memberships: [{ tenant_id: TENANT, role: 'admin' }],
  });
  otherTenantCheck.enrollments.set(TESTER_APP, store.enrollments.get(TESTER_APP));
  const tenantDenied = await handleMfaStepUp(eventOf({
    code,
    check_intake_item_id: CHECK,
    tenant_id: OTHER_TENANT,
  }), depsOf(otherTenantCheck));
  assert.equal(tenantDenied.error, 'cross_tenant_denied');

  const missingCheck = await handleMfaStepUp(eventOf({
    code,
    check_intake_item_id: OTHER_CHECK,
  }), depsOf(store));
  assert.equal(missingCheck.error, 'Check not found');
});

test('amount change and action mismatch are rejected', async () => {
  const store = createStore();
  const { code } = await enrollTester(store);
  const amount = await handleMfaStepUp(eventOf({
    code,
    check_intake_item_id: CHECK,
    amount_cents: 1,
  }), depsOf(store));
  assert.equal(amount.error, 'amount_mismatch');
  const action = await handleMfaStepUp(eventOf({
    code,
    check_intake_item_id: CHECK,
    action_key: 'wallet.fund',
  }), depsOf(store));
  assert.equal(action.error, 'action_mismatch');
  assert.equal(store.stepups.length, 0);
});

test('Cognito MFA state is ignored for financial enrollment', async () => {
  const store = createStore();
  const status = await handleMfaStatus(eventOf({}), depsOf(store));
  assert.equal(status.totpEnrolled, false);
  assert.equal(evaluateCognitoTotpEnrollment({
    UserMFASettingList: ['SOFTWARE_TOKEN_MFA'],
    PreferredMfaSetting: 'SOFTWARE_TOKEN_MFA',
  }).totpEnrolled, true);
  assert.equal(status.source, 'financial_totp_enrollments');
});

test('numeric TOTP is rejected and preference remains disabled', async () => {
  const numeric = await handleMfaStepUp(eventOf({ code: 123456, check_intake_item_id: CHECK }));
  assert.equal(numeric.error, 'totp_must_be_string');
  const preference = await handleMfaSetPreference();
  assert.equal(preference.statusCode, 403);
  assert.equal(preference.error, 'cognito_preferred_mfa_disabled');
});

test('enroll and step-up handlers never call Cognito software-token APIs', async () => {
  const files = [
    'aws/functions/api/auth-mfa.mjs',
    'aws/functions/api/auth-financial-totp.mjs',
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(text, /SetUserMFAPreference|AdminSetUserMFAPreference|AssociateSoftwareToken|VerifySoftwareToken/);
    assert.doesNotMatch(text, /console\.(log|info|debug|warn|error)\([^)]*(secret|otpauth)/i);
  }
});

test('enroll-start encrypts the secret at rest and never returns ciphertext', async () => {
  const store = createStore();
  const started = await handleMfaAssociate(eventOf({ email: TESTER_EMAIL }), depsOf(store));
  assert.equal(started.ok, true);
  const secret = started.totp.secret;
  const row = store.enrollments.get(TESTER_APP);
  assert.ok(Buffer.isBuffer(row.ciphertext));
  assert.equal(row.ciphertext.includes(secret), false);
  assert.equal(row.verified_at, null);
  const status = await handleMfaStatus(eventOf({}), depsOf(store));
  assert.equal(status.totpEnrolled, false);
  const blob = JSON.stringify(status);
  assert.equal(blob.includes(secret), false);
  assert.doesNotMatch(blob, /ciphertext|nonce|wrapKey|otpauth/);
  const { decryptSecret, wrapKeyFromHex } = await import('../functions/api/financial-totp.mjs');
  assert.equal(decryptSecret({ ciphertext: row.ciphertext, nonce: row.nonce, key: wrapKeyFromHex(WRAP_HEX) }), secret);
});

test('status, verify, and failed step-up never leak secret or ciphertext', async () => {
  const store = createStore();
  const { secret, verified } = await enrollTester(store);
  const status = await handleMfaStatus(eventOf({}), depsOf(store));
  const failed = await handleMfaStepUp(eventOf({
    code: '000000',
    check_intake_item_id: CHECK,
  }), depsOf(store));
  for (const payload of [status, verified, failed]) {
    const blob = JSON.stringify(payload);
    assert.equal(blob.includes(secret), false);
    assert.doesNotMatch(blob, /ciphertext|secretCiphertext/);
  }
});

test('wrap key env hex is refused in production and missing wrap key fails closed', async () => {
  const store = createStore();
  const missing = await handleMfaAssociate(eventOf({ email: TESTER_EMAIL }), depsOf(store, {
    loadWrapKey: async () => {
      const error = new Error('wrap_key_unconfigured');
      error.statusCode = 503;
      throw error;
    },
  }));
  assert.equal(missing.error, 'wrap_key_unconfigured');
  assert.equal(store.enrollments.size, 0);

  const { loadFinancialTotpWrapKey } = await import('../functions/api/auth-financial-totp.mjs');
  const prevEnv = process.env.CHECKSOPS_ENV;
  const prevKey = process.env.FINANCIAL_TOTP_WRAP_KEY;
  const prevArn = process.env.FINANCIAL_TOTP_WRAP_KEY_ARN;
  try {
    process.env.CHECKSOPS_ENV = 'production-prep';
    process.env.FINANCIAL_TOTP_WRAP_KEY = WRAP_HEX;
    delete process.env.FINANCIAL_TOTP_WRAP_KEY_ARN;
    await assert.rejects(loadFinancialTotpWrapKey(), /wrap_key_unconfigured/);
  } finally {
    if (prevEnv === undefined) delete process.env.CHECKSOPS_ENV;
    else process.env.CHECKSOPS_ENV = prevEnv;
    if (prevKey === undefined) delete process.env.FINANCIAL_TOTP_WRAP_KEY;
    else process.env.FINANCIAL_TOTP_WRAP_KEY = prevKey;
    if (prevArn === undefined) delete process.env.FINANCIAL_TOTP_WRAP_KEY_ARN;
    else process.env.FINANCIAL_TOTP_WRAP_KEY_ARN = prevArn;
  }
});

test('missing financial TOTP schema fails closed without writing step-up', async () => {
  const store = createStore();
  const original = store.client.query;
  store.client.query = async (sql, params) => {
    if (String(sql).includes('consume_financial_totp_rate_limit')) {
      const error = new Error('function consume_financial_totp_rate_limit does not exist');
      error.code = '42883';
      throw error;
    }
    return original(sql, params);
  };
  const failed = await handleMfaStepUp(eventOf({
    code: '123456',
    check_intake_item_id: CHECK,
  }), depsOf(store));
  assert.equal(failed.error, 'financial_totp_schema_unapplied');
  assert.equal(store.stepups.length, 0);
});

test('financial_stepup_log is written only after successful app-TOTP step-up', async () => {
  const store = createStore();
  const { code, verified } = await enrollTester(store);
  assert.equal(verified.recorded, false);
  assert.equal(store.stepups.length, 0);
  const stepped = await handleMfaStepUp(eventOf({ code, check_intake_item_id: CHECK }), depsOf(store));
  assert.equal(stepped.ok, true);
  assert.equal(store.stepups.length, 1);
  assert.equal(store.stepups[0].user_id, TESTER_APP);
  assert.equal(store.stepups[0].tenant_id, TENANT);
  assert.equal(store.stepups[0].action_key, CHECKALT_TOTP_ACTION);
  assert.equal(store.stepups[0].metadata.check_id, CHECK);
  assert.equal(store.stepups[0].metadata.amount_cents, 1234);
});

test('verified enrollment cannot be overwritten without an explicit reset', async () => {
  const store = createStore();
  const { secret } = await enrollTester(store);
  const again = await handleMfaAssociate(eventOf({ email: TESTER_EMAIL }), depsOf(store));
  assert.equal(again.ok, false);
  assert.equal(again.error, 'enrollment_reset_required');
  assert.equal(JSON.stringify(again).includes(secret), false);
  const row = store.enrollments.get(TESTER_APP);
  const { decryptSecret, wrapKeyFromHex } = await import('../functions/api/financial-totp.mjs');
  assert.equal(decryptSecret({ ciphertext: row.ciphertext, nonce: row.nonce, key: wrapKeyFromHex(WRAP_HEX) }), secret);
  assert.ok(row.verified_at);
});

test('unverified enroll-start may retry and replace the pending secret', async () => {
  const store = createStore();
  const first = await handleMfaAssociate(eventOf({ email: TESTER_EMAIL }), depsOf(store));
  const second = await handleMfaAssociate(eventOf({ email: TESTER_EMAIL }), depsOf(store));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(second.totp.secret, first.totp.secret);
});

test('concurrent step-up cannot reuse the same timestep', async () => {
  const store = createStore();
  const { code } = await enrollTester(store);
  const [first, second] = await Promise.all([
    handleMfaStepUp(eventOf({ code, check_intake_item_id: CHECK }), depsOf(store)),
    handleMfaStepUp(eventOf({ code, check_intake_item_id: CHECK }), depsOf(store)),
  ]);
  const outcomes = [first, second];
  assert.equal(outcomes.filter((row) => row.ok === true).length, 1);
  assert.equal(outcomes.filter((row) => row.ok === false).length, 1);
  assert.equal(store.stepups.length, 1);
});

test('rate-limit storage returning no row fails closed', async () => {
  const store = createStore();
  await enrollTester(store);
  const original = store.client.query;
  store.client.query = async (sql, params) => {
    if (String(sql).includes('consume_financial_totp_rate_limit')) {
      return { rows: [] };
    }
    return original(sql, params);
  };
  const failed = await handleMfaStepUp(eventOf({
    code: '123456',
    check_intake_item_id: CHECK,
  }), depsOf(store));
  assert.equal(failed.error, 'rate_limit_unavailable');
  assert.equal(failed.statusCode, 503);
  assert.equal(store.stepups.length, 0);
});

test('enroll-confirm does not write financial_stepup_log or burn last_used_timestep', async () => {
  const store = createStore();
  const started = await handleMfaAssociate(eventOf({ email: TESTER_EMAIL }), depsOf(store));
  const secret = started.totp.secret;
  const code = totpAt(secret, timestepOf(NOW));
  const verified = await handleMfaVerify(eventOf({ code }), depsOf(store));
  assert.equal(verified.ok, true);
  assert.equal(verified.recorded, false);
  assert.equal(store.stepups.length, 0);
  assert.equal(store.enrollments.get(TESTER_APP).last_used_timestep, null);
  const stepped = await handleMfaStepUp(eventOf({ code, check_intake_item_id: CHECK }), depsOf(store));
  assert.equal(stepped.ok, true, JSON.stringify(stepped));
  assert.equal(store.stepups.length, 1);
});
