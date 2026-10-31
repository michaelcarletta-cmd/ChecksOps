import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { ENROLL_EMAIL_CODE_RATE_ACTION, TOTP_CODE_CHECK_RATE_ACTION } from '../functions/api/auth-financial-totp.mjs';
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
const ORIGIN_JTI = 'origin-jti-login-1';
const LOGIN_SESSION = `${TESTER_SUB}:jti:${ORIGIN_JTI}`;
const WRAP_HEX = 'ab'.repeat(32);
// SQL 132 (aws/workflows/sql/132_financial_totp_code_check_lockout.sql): ten consecutive code checks
// without a success lock the enrollment for 15 minutes. The store below emulates the function.
const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_MINUTES = 15;

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
  lockoutFunction = true,
} = {}) => {
  const enrollments = new Map();
  const rates = new Map();
  // Each upsert gets its own enrolled_at, as now() in a new transaction does.
  let upserts = 0;
  const stepups = [];
  const cognitoCalls = [];
  // Emails the handlers send (finding 8: the enrollment code and the enrolled notice).
  const mail = [];
  // SQL 132 applied (the function exists) unless a test says otherwise.
  const flags = { lockoutFunction };
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
          enrolled_at: new Date(NOW + (upserts += 1) * 1000).toISOString(),
          failed_attempts: 0,
          locked_until: null,
        });
        return { rows: [] };
      }
      if (text.includes('to_regprocedure')) {
        return { rows: [{ present: flags.lockoutFunction && params[0] === 'public.financial_totp_count_code_check(uuid)' }] };
      }
      if (text.includes('financial_totp_count_code_check')) {
        if (String(params[0]) !== String(userId)) {
          const error = new Error('enrollment_caller_mismatch');
          error.code = '42501';
          throw error;
        }
        const row = enrollments.get(String(params[0]));
        if (!row) return { rows: [] };
        const now = Date.now();
        const lockedUntil = row.locked_until ? new Date(row.locked_until).getTime() : 0;
        if (lockedUntil > now) {
          return { rows: [{ allowed: false, failed_attempts: row.failed_attempts, retry_after_seconds: Math.max(1, Math.ceil((lockedUntil - now) / 1000)) }] };
        }
        row.failed_attempts += 1;
        row.locked_until = row.failed_attempts >= LOCKOUT_THRESHOLD ? new Date(now + LOCKOUT_MINUTES * 60000).toISOString() : null;
        return { rows: [{ allowed: true, failed_attempts: row.failed_attempts, retry_after_seconds: 0 }] };
      }
      if (text.includes('financial_totp_get_enrollment')) {
        if (String(params[0]) !== String(userId)) {
          const error = new Error('enrollment_caller_mismatch');
          error.code = '42501';
          throw error;
        }
        // A snapshot, as a row read from PostgreSQL is: a later count in the same request does not change it.
        const row = enrollments.get(String(params[0]));
        return { rows: row ? [{ ...row }] : [] };
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
        row.failed_attempts = 0;
        row.locked_until = null;
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
    flags,
    mail,
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
      claims: extra.claims || { sub: TESTER_SUB, email: TESTER_EMAIL, origin_jti: ORIGIN_JTI },
      body,
      spoof: { ignored: true, bodyUserId: body.user_id || null, bodyTenantId: body.tenant_id || null },
    });
  },
  loadWrapKey: async () => ({ key: wrapKeyFromHex(WRAP_HEX), keyId: 'test' }),
  listPasskeys: async () => 0,
  sendViaSesOrSink: async (message) => {
    store.mail.push(message);
    return { mode: 'ses', results: [{ to: message.to, delivery: 'ses', status: 'sent', messageId: `ses-${store.mail.length}` }] };
  },
  nowMs: NOW,
  ...extra,
});

/** The code in the latest enrollment-code email. */
const emailedCode = (store) => {
  const sent = [...store.mail].reverse().find((m) => /setup code/.test(m.subject));
  assert.ok(sent, 'an enrollment code email was sent');
  return sent.text.match(/setup code is (\d{6})/)[1];
};

/** Finding 8: first associate emails a code (428), the second with the code issues the secret. */
const associateWithEmailCode = async (store) => {
  const challenged = await handleMfaAssociate(eventOf({ email: TESTER_EMAIL }), depsOf(store));
  assert.equal(challenged.statusCode, 428, JSON.stringify(challenged));
  assert.equal(challenged.error, 'email_code_required');
  const started = await handleMfaAssociate(eventOf({
    emailChallenge: challenged.emailChallenge,
    emailCode: emailedCode(store),
  }), depsOf(store));
  assert.equal(started.ok, true, JSON.stringify(started));
  return { challenged, started };
};

const enrollTester = async (store) => {
  const { started } = await associateWithEmailCode(store);
  const secret = started.totp.secret;
  const code = totpAt(secret, timestepOf(NOW));
  const verified = await handleMfaVerify(eventOf({ code, enrollmentTicket: started.enrollmentTicket }), depsOf(store));
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
    assert.match(started.totp.otpauth_uri, /ChecksOps%20Financial/);
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
  store.rates.set(`${TESTER_APP}:${TOTP_CODE_CHECK_RATE_ACTION}`, 5);
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
    action_key: 'wallet.send',
  }), depsOf(store));
  assert.equal(action.error, 'action_mismatch');
  assert.equal(store.stepups.length, 0);
});

test('deposit.approve TOTP is recorded against the login, with the check and amount kept for audit', async () => {
  const store = createStore();
  const { code } = await enrollTester(store);
  const stepped = await handleMfaStepUp(eventOf({
    code,
    action_key: 'deposit.approve',
    tenant_id: OTHER_TENANT,
    check_intake_item_id: CHECK,
  }), depsOf(store));
  assert.equal(stepped.ok, true, JSON.stringify(stepped));
  assert.equal(stepped.recorded, true);
  assert.equal(stepped.amount_cents, 1234);
  assert.equal(stepped.tenant_id, TENANT);
  assert.equal(stepped.check_id, CHECK);
  assert.equal(store.stepups.length, 1);
  assert.equal(store.stepups[0].action_key, 'deposit.approve');
  assert.equal(store.stepups[0].tenant_id, TENANT);
  assert.equal(store.stepups[0].metadata.operation, 'deposit.approve');
  assert.equal(store.stepups[0].metadata.check_id, CHECK);
  assert.equal(store.stepups[0].metadata.amount_cents, 1234);
  assert.equal(store.stepups[0].metadata.source, 'app_financial_totp');
  assert.equal(store.stepups[0].metadata.login_session, LOGIN_SESSION);
});

test('deposit.approve TOTP fails closed without a check, on amount mismatch, and on replay', async () => {
  const store = createStore();
  const { code } = await enrollTester(store);
  // Five step-ups follow; enroll confirm and step-up share one 5-check budget, and this test is
  // about the refusals, not the budget (the shared-budget test covers that).
  store.rates.delete(`${TESTER_APP}:${TOTP_CODE_CHECK_RATE_ACTION}`);
  const noCheck = await handleMfaStepUp(eventOf({ code, action_key: 'deposit.approve' }), depsOf(store));
  assert.equal(noCheck.error, 'check_intake_item_id is required');
  const amount = await handleMfaStepUp(eventOf({
    code,
    action_key: 'deposit.approve',
    check_intake_item_id: CHECK,
    amount_cents: 1,
  }), depsOf(store));
  assert.equal(amount.error, 'amount_mismatch');
  const missing = await handleMfaStepUp(eventOf({
    code,
    action_key: 'deposit.approve',
    check_intake_item_id: OTHER_CHECK,
  }), depsOf(store));
  assert.equal(missing.error, 'Check not found');
  assert.equal(store.stepups.length, 0);
  const first = await handleMfaStepUp(eventOf({
    code,
    action_key: 'deposit.approve',
    check_intake_item_id: CHECK,
  }), depsOf(store));
  assert.equal(first.ok, true, JSON.stringify(first));
  const replay = await handleMfaStepUp(eventOf({
    code,
    action_key: 'deposit.approve',
    check_intake_item_id: CHECK,
  }), depsOf(store));
  assert.equal(replay.ok, false);
  assert.equal(replay.error, 'mfa_step_up_failed');
  const replayAsSubmit = await handleMfaStepUp(eventOf({
    code,
    action_key: CHECKALT_TOTP_ACTION,
    check_intake_item_id: CHECK,
  }), depsOf(store));
  assert.equal(replayAsSubmit.ok, false);
  assert.equal(store.stepups.length, 1);
});

test('Check Alt step-up without a login session is refused and does not use the code', async () => {
  const store = createStore();
  const { code } = await enrollTester(store);
  for (const action_key of [CHECKALT_TOTP_ACTION, 'deposit.approve']) {
    const unbound = await handleMfaStepUp(eventOf({ code, action_key, check_intake_item_id: CHECK }), depsOf(store, {
      claims: { sub: TESTER_SUB, email: TESTER_EMAIL },
    }));
    assert.equal(unbound.ok, false);
    assert.equal(unbound.statusCode, 401);
    assert.equal(unbound.error, 'login_session_unbound');
  }
  assert.equal(store.stepups.length, 0);
  // The code was not consumed, so the same login can still use it.
  const stepped = await handleMfaStepUp(eventOf({ code, check_intake_item_id: CHECK }), depsOf(store));
  assert.equal(stepped.ok, true, JSON.stringify(stepped));
  assert.equal(store.stepups[0].metadata.login_session, LOGIN_SESSION);
});

test('Check Alt step-up falls back to auth_time when origin_jti is absent', async () => {
  const store = createStore();
  const { code } = await enrollTester(store);
  const stepped = await handleMfaStepUp(eventOf({ code, check_intake_item_id: CHECK }), depsOf(store, {
    claims: { sub: TESTER_SUB, email: TESTER_EMAIL, auth_time: 1791000000 },
  }));
  assert.equal(stepped.ok, true, JSON.stringify(stepped));
  assert.equal(store.stepups[0].metadata.login_session, `${TESTER_SUB}:auth:1791000000`);
});

test('deposit.approve TOTP is refused for a check in another tenant', async () => {
  const store = createStore({
    checks: [{ id: CHECK, tenant_id: OTHER_TENANT, amount: 12.34, status: 'ready' }],
    memberships: [{ tenant_id: TENANT, role: 'admin' }],
  });
  const { code } = await enrollTester(store);
  const denied = await handleMfaStepUp(eventOf({
    code,
    action_key: 'deposit.approve',
    check_intake_item_id: CHECK,
    tenant_id: TENANT,
  }), depsOf(store));
  assert.equal(denied.error, 'cross_tenant_denied');
  assert.equal(store.stepups.length, 0);
});

test('deposit.submit step-up log records the login session and keeps check and amount for audit', async () => {
  const store = createStore();
  const { code } = await enrollTester(store);
  const stepped = await handleMfaStepUp(eventOf({ code, check_intake_item_id: CHECK }), depsOf(store));
  assert.equal(stepped.ok, true, JSON.stringify(stepped));
  assert.equal(store.stepups[0].action_key, 'deposit.submit');
  assert.deepEqual(store.stepups[0].metadata, {
    check_id: CHECK,
    amount_cents: 1234,
    login_session: LOGIN_SESSION,
    operation: 'deposit.submit',
    source: 'app_financial_totp',
  });
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
  const { started } = await associateWithEmailCode(store);
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
  // Each pending setup needs its own fresh email code (finding 8).
  const { started: first } = await associateWithEmailCode(store);
  const { started: second } = await associateWithEmailCode(store);
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
  const { started } = await associateWithEmailCode(store);
  const secret = started.totp.secret;
  const code = totpAt(secret, timestepOf(NOW));
  const verified = await handleMfaVerify(eventOf({ code, enrollmentTicket: started.enrollmentTicket }), depsOf(store));
  assert.equal(verified.ok, true);
  assert.equal(verified.recorded, false);
  assert.equal(store.stepups.length, 0);
  assert.equal(store.enrollments.get(TESTER_APP).last_used_timestep, null);
  const stepped = await handleMfaStepUp(eventOf({ code, check_intake_item_id: CHECK }), depsOf(store));
  assert.equal(stepped.ok, true, JSON.stringify(stepped));
  assert.equal(store.stepups.length, 1);
});

test('a wrong step-up code still counts against the rate limit (committed before the check)', async () => {
  const store = createStore();
  const { code } = await enrollTester(store);
  const wrong = code === '000000' ? '111111' : '000000';
  const order = [];
  const base = store.client.query;
  store.client.query = async (sql, params) => {
    const text = String(sql);
    if (text.includes('consume_financial_totp_rate_limit')) order.push('rate');
    if (text === 'COMMIT') order.push('commit');
    if (text.includes('financial_totp_get_enrollment')) order.push('verify');
    if (text.includes('financial_totp_count_code_check')) order.push('count');
    if (text === 'COMMIT' || text === 'BEGIN' || text.startsWith('SET TRANSACTION') || text.startsWith('SELECT set_config')) {
      return { command: text, rows: [] };
    }
    return base(sql, params);
  };
  const result = await handleMfaStepUp(eventOf({ code: wrong, check_intake_item_id: CHECK }), depsOf(store));
  assert.equal(result.ok, false);
  // The rate-limit hit is committed before anything else; the SQL 132 count is committed right after the
  // enrollment is read and before the code is compared.
  assert.deepEqual(order, ['rate', 'commit', 'verify', 'count', 'commit']);
});

test('enroll confirm and step-up share one budget of 5 code checks (audit finding 7)', async () => {
  const store = createStore();
  const { secret } = await enrollTester(store);
  // enrollTester's confirm used 1 check. Three more wrong confirms and one wrong step-up use the rest.
  for (let i = 0; i < 3; i += 1) {
    const wrong = await handleMfaVerify(eventOf({ code: '000000' }), depsOf(store));
    assert.equal(wrong.ok, false);
    assert.notEqual(wrong.error, 'rate_limited', `confirm ${i}`);
  }
  const wrongStep = await handleMfaStepUp(eventOf({ code: '000000', check_intake_item_id: CHECK }), depsOf(store));
  assert.notEqual(wrongStep.error, 'rate_limited');
  // The sixth check is refused on either route, even with the right code.
  const right = totpAt(secret, timestepOf(NOW));
  const viaStepUp = await handleMfaStepUp(eventOf({ code: right, check_intake_item_id: CHECK }), depsOf(store));
  assert.equal(viaStepUp.error, 'rate_limited');
  const viaConfirm = await handleMfaVerify(eventOf({ code: right }), depsOf(store));
  assert.equal(viaConfirm.error, 'rate_limited');
  assert.equal(store.stepups.length, 0);
  assert.equal(store.rates.get(`${TESTER_APP}:${TOTP_CODE_CHECK_RATE_ACTION}`), 7);
  assert.equal(store.rates.has(`${TESTER_APP}:step_up`), false);
  // enroll_confirm counts the emailed setup code only (finding 8: one check in enrollTester), never a TOTP code.
  assert.equal(store.rates.get(`${TESTER_APP}:enroll_confirm`), 1);
});

const wrongCodeFor = (code) => (code === '000000' ? '111111' : '000000');

/** The order of the store's calls, with the transaction statements answered locally. */
const traceOrder = (store) => {
  const order = [];
  const base = store.client.query;
  store.client.query = async (sql, params) => {
    const text = String(sql);
    if (text.includes('financial_totp_get_enrollment')) order.push('read');
    if (text.includes('financial_totp_count_code_check')) order.push('count');
    if (text.includes('financial_totp_mark_verified')) order.push('mark');
    if (text === 'COMMIT') order.push('commit');
    if (text === 'COMMIT' || text === 'BEGIN' || text.startsWith('SET TRANSACTION') || text.startsWith('SELECT set_config')) {
      return { command: text, rows: [] };
    }
    return base(sql, params);
  };
  return order;
};

test('SQL 132: a wrong code counts one check, committed before the compare; the right code clears the count', async () => {
  const store = createStore();
  const { code } = await enrollTester(store);
  const row = store.enrollments.get(TESTER_APP);
  assert.equal(row.failed_attempts, 0, 'the enroll confirm counted one check and its success cleared it');
  const order = traceOrder(store);
  const wrong = await handleMfaStepUp(eventOf({ code: wrongCodeFor(code), check_intake_item_id: CHECK }), depsOf(store));
  assert.equal(wrong.ok, false);
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.error, 'mfa_step_up_failed');
  assert.deepEqual(order, ['commit', 'read', 'count', 'commit'], 'rate hit committed, enrollment read, count committed, then the compare; nothing marked');
  assert.equal(row.failed_attempts, 1);
  assert.equal(row.locked_until, null);
  order.length = 0;
  const right = await handleMfaStepUp(eventOf({ code, check_intake_item_id: CHECK }), depsOf(store));
  assert.equal(right.ok, true, JSON.stringify(right));
  assert.deepEqual(order, ['commit', 'read', 'count', 'commit', 'mark']);
  assert.equal(row.failed_attempts, 0);
  assert.equal(row.locked_until, null);
  assert.equal(store.stepups.length, 1);
});

test('SQL 132: ten wrong codes across enroll confirm and step-up lock the enrollment; while locked the right code gets the wrong-code answer and nothing is compared, marked or recorded', async () => {
  const store = createStore();
  const { code } = await enrollTester(store);
  const wrong = wrongCodeFor(code);
  const row = store.enrollments.get(TESTER_APP);
  let wrongAnswer = null;
  for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
    if (i % 5 === 0) store.rates.clear(); // a new rate-limit window (5 per 300 s)
    const answer = i % 2 === 0
      ? await handleMfaVerify(eventOf({ code: wrong }), depsOf(store))
      : await handleMfaStepUp(eventOf({ code: wrong, check_intake_item_id: CHECK }), depsOf(store));
    assert.equal(answer.statusCode, 401, `check ${i + 1}`);
    assert.equal(answer.error, 'mfa_step_up_failed', `check ${i + 1}`);
    assert.equal(row.failed_attempts, i + 1);
    if (i < LOCKOUT_THRESHOLD - 1) assert.equal(row.locked_until, null, `check ${i + 1}`);
    wrongAnswer = answer;
  }
  assert.ok(row.locked_until && new Date(row.locked_until).getTime() > Date.now(), 'locked after the tenth');
  store.rates.clear();
  const order = traceOrder(store);
  const lockedStepUp = await handleMfaStepUp(eventOf({ code, check_intake_item_id: CHECK }), depsOf(store));
  assert.deepEqual(lockedStepUp, wrongAnswer, 'a locked check answers exactly like a wrong code');
  const lockedConfirm = await handleMfaVerify(eventOf({ code }), depsOf(store));
  assert.deepEqual(lockedConfirm, wrongAnswer);
  const lockedWrong = await handleMfaStepUp(eventOf({ code: wrong, check_intake_item_id: CHECK }), depsOf(store));
  assert.deepEqual(lockedWrong, wrongAnswer);
  assert.deepEqual(order, ['commit', 'read', 'count', 'commit', 'read', 'count', 'commit', 'read', 'count'], 'refused at the count; nothing marked, no second commit');
  assert.equal(store.stepups.length, 0);
  assert.equal(row.failed_attempts, LOCKOUT_THRESHOLD, 'a locked check is not counted again');
});

test('SQL 132: after locked_until passes the right code works and clears the count and the lock', async () => {
  const store = createStore();
  const { code } = await enrollTester(store);
  const row = store.enrollments.get(TESTER_APP);
  row.failed_attempts = LOCKOUT_THRESHOLD;
  row.locked_until = new Date(Date.now() - 1000).toISOString();
  const right = await handleMfaStepUp(eventOf({ code, check_intake_item_id: CHECK }), depsOf(store));
  assert.equal(right.ok, true, JSON.stringify(right));
  assert.equal(row.failed_attempts, 0);
  assert.equal(row.locked_until, null);
  assert.equal(store.stepups.length, 1);
});

test('SQL 132: another user\'s counter is independent', async () => {
  const locked = createStore();
  const other = createStore({ userId: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', email: 'other@freedomadj.com' });
  const { code: lockedCode } = await enrollTester(locked);
  const { code: otherCode } = await enrollTester(other);
  for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
    if (i % 5 === 0) locked.rates.clear();
    await handleMfaStepUp(eventOf({ code: wrongCodeFor(lockedCode), check_intake_item_id: CHECK }), depsOf(locked));
  }
  assert.ok(locked.enrollments.get(TESTER_APP).locked_until);
  const right = await handleMfaStepUp(eventOf({ code: otherCode, check_intake_item_id: CHECK }), depsOf(other));
  assert.equal(right.ok, true, JSON.stringify(right));
  assert.equal(other.enrollments.get('7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d').failed_attempts, 0);
  assert.equal(locked.enrollments.get(TESTER_APP).failed_attempts, LOCKOUT_THRESHOLD);
});

test('SQL 132 not applied (the function absent): checks are not counted, nothing locks, and the API answers as before, never a 500', async () => {
  const store = createStore({ lockoutFunction: false });
  const { code } = await enrollTester(store);
  const row = store.enrollments.get(TESTER_APP);
  const order = traceOrder(store);
  for (let i = 0; i < LOCKOUT_THRESHOLD + 2; i += 1) {
    if (i % 5 === 0) store.rates.clear();
    const answer = await handleMfaStepUp(eventOf({ code: wrongCodeFor(code), check_intake_item_id: CHECK }), depsOf(store));
    assert.equal(answer.statusCode, 401, `check ${i + 1}`);
    assert.equal(answer.error, 'mfa_step_up_failed', `check ${i + 1}`);
  }
  assert.equal(row.failed_attempts, 0);
  assert.equal(row.locked_until, null);
  assert.equal(order.includes('count'), false, 'the count function is never called when absent');
  store.rates.clear();
  const right = await handleMfaStepUp(eventOf({ code, check_intake_item_id: CHECK }), depsOf(store));
  assert.equal(right.ok, true, JSON.stringify(right));
});

test('a locked_until already on the row is refused with the wrong-code answer even when the SQL 132 function is absent', async () => {
  const store = createStore({ lockoutFunction: false });
  const { code } = await enrollTester(store);
  const row = store.enrollments.get(TESTER_APP);
  row.locked_until = new Date(Date.now() + 60000).toISOString();
  const order = traceOrder(store);
  const locked = await handleMfaStepUp(eventOf({ code, check_intake_item_id: CHECK }), depsOf(store));
  assert.equal(locked.statusCode, 401);
  assert.equal(locked.error, 'mfa_step_up_failed');
  assert.equal(order.includes('mark'), false);
  assert.equal(store.stepups.length, 0);
});

// Finding 8 (security audit 2026-10-29): first-time enrollment needs a fresh email code. Owner
// 2026-10-31: "First-time financial authenticator enrollment: whether it should require a fresh email
// code. - yes".
const withClock = async (offsetMs, fn) => {
  const real = Date.now;
  Date.now = () => real() + offsetMs;
  try { return await fn(); } finally { Date.now = real; }
};

test('finding 8: associate without a fresh email code issues no secret, writes no row and emails a code to the verified address only', async () => {
  const store = createStore();
  // A spoofed body address is ignored: the code goes to the identity mapping's email.
  const challenged = await handleMfaAssociate(eventOf({ email: 'attacker@example.com' }), depsOf(store));
  assert.equal(challenged.ok, false);
  assert.equal(challenged.statusCode, 428);
  assert.equal(challenged.error, 'email_code_required');
  assert.equal(challenged.emailCodeRequired, true);
  assert.equal(challenged.totp, undefined);
  assert.equal(challenged.enrollmentTicket, undefined);
  assert.equal(store.enrollments.size, 0);
  assert.equal(store.mail.length, 1);
  assert.equal(store.mail[0].to, TESTER_EMAIL);
  assert.equal(challenged.emailHint, 'c******@freedomadj.com');
  const code = emailedCode(store);
  // Neither the code nor its plain hash is in the answer (the challenge carries an HMAC only).
  const blob = JSON.stringify(challenged);
  assert.equal(blob.includes(code), false);
  assert.equal(blob.includes(createHash('sha256').update(code).digest('hex')), false);
  assert.equal(challenged.stagingDebugCode, undefined);
  assert.ok(Date.parse(challenged.expiresAt) - Date.now() <= 10 * 60 * 1000);
  // The send counts against enroll_start.
  assert.equal(store.rates.get(`${TESTER_APP}:enroll_start`), 1);
  // A code without its challenge, or a challenge without a code, is refused.
  const noChallenge = await handleMfaAssociate(eventOf({ emailCode: code }), depsOf(store));
  assert.equal(noChallenge.error, 'email_code_invalid');
  const noCode = await handleMfaAssociate(eventOf({ emailChallenge: challenged.emailChallenge }), depsOf(store));
  assert.equal(noCode.error, 'email_code_invalid');
  assert.equal(store.enrollments.size, 0);
});

test('finding 8: a valid email code issues the secret and a ticket; verify activates and the user is emailed that an authenticator was added', async () => {
  const store = createStore();
  const { started } = await associateWithEmailCode(store);
  assert.ok(started.totp.secret);
  assert.match(started.enrollmentTicket, /^v1\./);
  assert.equal(store.enrollments.get(TESTER_APP).verified_at, null);
  const code = totpAt(started.totp.secret, timestepOf(NOW));
  const verified = await handleMfaVerify(eventOf({ code, enrollmentTicket: started.enrollmentTicket }), depsOf(store));
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.ok(store.enrollments.get(TESTER_APP).verified_at);
  assert.deepEqual(verified.enrollmentNotice, { sent: true, status: 'sent' });
  const notice = store.mail.at(-1);
  assert.equal(notice.to, TESTER_EMAIL);
  assert.match(notice.subject, /An authenticator was added to your ChecksOps account/);
  assert.match(notice.text, /support@checksops\.com/);
  assert.equal(notice.text.includes(started.totp.secret), false);
});

test('finding 8: a wrong email code, a challenge for another user or a tampered challenge is refused and issues nothing', async () => {
  const store = createStore();
  const challenged = await handleMfaAssociate(eventOf({}), depsOf(store));
  const code = emailedCode(store);
  const wrongCode = code === '000000' ? '111111' : '000000';
  const wrong = await handleMfaAssociate(eventOf({ emailChallenge: challenged.emailChallenge, emailCode: wrongCode }), depsOf(store));
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.error, 'email_code_invalid');
  assert.equal(wrong.totp, undefined);
  for (const bad of ['12345', 'abcdef', 123456]) {
    const malformed = await handleMfaAssociate(eventOf({ emailChallenge: challenged.emailChallenge, emailCode: bad }), depsOf(store));
    assert.equal(malformed.error, 'email_code_invalid', String(bad));
  }
  // Another user's session cannot use this challenge, even with the right code.
  const other = createStore({ userId: '99999999-9999-4999-8999-999999999999', email: 'other@freedomadj.com' });
  const otherTry = await handleMfaAssociate(eventOf({ emailChallenge: challenged.emailChallenge, emailCode: code }), depsOf(other));
  assert.equal(otherTry.error, 'email_code_invalid');
  assert.equal(other.enrollments.size, 0);
  // Changing the payload (for example, pushing the expiry out) breaks the tag.
  const [v, body, tag] = challenged.emailChallenge.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  const forged = `${v}.${Buffer.from(JSON.stringify({ ...payload, x: payload.x + 86400000 })).toString('base64url')}.${tag}`;
  const tampered = await handleMfaAssociate(eventOf({ emailChallenge: forged, emailCode: code }), depsOf(store));
  assert.equal(tampered.error, 'email_code_invalid');
  assert.equal(store.enrollments.size, 0);
});

test('finding 8: an expired email code is refused', async () => {
  const store = createStore();
  const challenged = await handleMfaAssociate(eventOf({}), depsOf(store));
  const code = emailedCode(store);
  const late = await withClock(10 * 60 * 1000 + 1000, () => handleMfaAssociate(
    eventOf({ emailChallenge: challenged.emailChallenge, emailCode: code }),
    depsOf(store),
  ));
  assert.equal(late.statusCode, 410);
  assert.equal(late.error, 'email_code_expired');
  assert.equal(store.enrollments.size, 0);
});

test('finding 8: an email code works once; a pending setup without its ticket, or with an older ticket, cannot be activated', async () => {
  const store = createStore();
  const { challenged, started } = await associateWithEmailCode(store);
  const code = emailedCode(store);
  const reused = await handleMfaAssociate(eventOf({ emailChallenge: challenged.emailChallenge, emailCode: code }), depsOf(store));
  assert.equal(reused.statusCode, 409);
  assert.equal(reused.error, 'email_code_used');
  assert.equal(reused.totp, undefined);
  const totp = totpAt(started.totp.secret, timestepOf(NOW));
  // The old SPA flow (verify with no ticket) is refused without activating the row.
  const noTicket = await handleMfaVerify(eventOf({ code: totp }), depsOf(store));
  assert.equal(noTicket.statusCode, 403);
  assert.equal(noTicket.error, 'enrollment_email_code_required');
  assert.equal(store.enrollments.get(TESTER_APP).verified_at, null);
  // A ticket for a row that was replaced since is refused too.
  const { started: again } = await associateWithEmailCode(store);
  const againCode = totpAt(again.totp.secret, timestepOf(NOW));
  const stale = await handleMfaVerify(eventOf({ code: againCode, enrollmentTicket: started.enrollmentTicket }), depsOf(store));
  assert.equal(stale.error, 'enrollment_email_code_required');
  // An expired ticket is refused.
  const expired = await withClock(30 * 60 * 1000 + 1000, () => handleMfaVerify(
    eventOf({ code: againCode, enrollmentTicket: again.enrollmentTicket }),
    depsOf(store),
  ));
  assert.equal(expired.error, 'enrollment_email_code_required');
  assert.equal(store.enrollments.get(TESTER_APP).verified_at, null);
  const ok = await handleMfaVerify(eventOf({ code: againCode, enrollmentTicket: again.enrollmentTicket }), depsOf(store));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  // Once verified, the challenge is refused as before (no reset).
  const afterVerify = await handleMfaAssociate(eventOf({ emailChallenge: challenged.emailChallenge, emailCode: code }), depsOf(store));
  assert.equal(afterVerify.error, 'enrollment_reset_required');
});

test('finding 8: a pending row set up before this change (no email code) cannot be activated', async () => {
  const store = createStore();
  const { encryptSecret, generateTotpSecret } = await import('../functions/api/financial-totp.mjs');
  const secret = generateTotpSecret();
  const wrapped = encryptSecret(secret, wrapKeyFromHex(WRAP_HEX), 'test');
  store.enrollments.set(TESTER_APP, {
    ciphertext: wrapped.ciphertext, nonce: wrapped.nonce, key_id: 'test', last_used_timestep: null,
    verified_at: null, enrolled_at: new Date(NOW - 3600000).toISOString(), failed_attempts: 0, locked_until: null,
  });
  const refused = await handleMfaVerify(eventOf({ code: totpAt(secret, timestepOf(NOW)) }), depsOf(store));
  assert.equal(refused.error, 'enrollment_email_code_required');
  assert.equal(store.enrollments.get(TESTER_APP).verified_at, null);
  // A new setup emails a code bound to that pending row and replaces it.
  const { started } = await associateWithEmailCode(store);
  assert.notEqual(started.totp.secret, secret);
});

test('finding 8: email code guesses share the enroll_confirm limit (5 per 300 s), counted and committed before the compare', async () => {
  const store = createStore();
  const challenged = await handleMfaAssociate(eventOf({}), depsOf(store));
  const code = emailedCode(store);
  const wrongCode = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i += 1) {
    const wrong = await handleMfaAssociate(eventOf({ emailChallenge: challenged.emailChallenge, emailCode: wrongCode }), depsOf(store));
    assert.equal(wrong.error, 'email_code_invalid', `guess ${i}`);
  }
  const right = await handleMfaAssociate(eventOf({ emailChallenge: challenged.emailChallenge, emailCode: code }), depsOf(store));
  assert.equal(right.error, 'rate_limited');
  assert.equal(right.statusCode, 429);
  assert.equal(store.enrollments.size, 0);
  assert.equal(store.rates.get(`${TESTER_APP}:${ENROLL_EMAIL_CODE_RATE_ACTION}`), 6);
  // The count is committed before the code is compared (a wrong code rolls the request back).
  const fresh = createStore();
  const c2 = await handleMfaAssociate(eventOf({}), depsOf(fresh));
  const order = [];
  const base = fresh.client.query;
  fresh.client.query = async (sql, params) => {
    const text = String(sql);
    if (text.includes('consume_financial_totp_rate_limit')) order.push(`rate:${params[1]}`);
    if (text === 'COMMIT') order.push('commit');
    if (text.includes('financial_totp_upsert_enrollment')) order.push('upsert');
    if (text === 'COMMIT' || text === 'BEGIN' || text.startsWith('SET TRANSACTION') || text.startsWith('SELECT set_config')) {
      return { command: text, rows: [] };
    }
    return base(sql, params);
  };
  await handleMfaAssociate(eventOf({ emailChallenge: c2.emailChallenge, emailCode: wrongCode }), depsOf(fresh));
  assert.deepEqual(order, ['rate:enroll_confirm', 'commit']);
});

test('finding 8: enrolled users are unaffected: verify and step-up need no email code or ticket and send no email', async () => {
  const store = createStore();
  const { secret } = await enrollTester(store);
  const mailed = store.mail.length;
  const step = timestepOf(NOW) + 1;
  const reverify = await handleMfaVerify(eventOf({ code: totpAt(secret, step) }), depsOf(store, { nowMs: NOW + 30000 }));
  assert.equal(reverify.ok, true, JSON.stringify(reverify));
  assert.equal(reverify.enrollmentNotice, undefined);
  const stepped = await handleMfaStepUp(eventOf({ code: totpAt(secret, step + 1), check_intake_item_id: CHECK }), depsOf(store, { nowMs: NOW + 60000 }));
  assert.equal(stepped.ok, true, JSON.stringify(stepped));
  assert.equal(store.mail.length, mailed);
  assert.equal(store.rates.get(`${TESTER_APP}:${ENROLL_EMAIL_CODE_RATE_ACTION}`), 1);
});

test('finding 8: after a teammate reset (SQL 133 deletes the row) re-enrollment needs a fresh email code', async () => {
  const store = createStore();
  const first = await enrollTester(store);
  store.enrollments.delete(TESTER_APP);
  const challenged = await handleMfaAssociate(eventOf({}), depsOf(store));
  assert.equal(challenged.error, 'email_code_required');
  assert.equal(store.enrollments.size, 0);
  // The first setup's ticket is not an email challenge.
  const old = await handleMfaAssociate(eventOf({ emailChallenge: first.started.enrollmentTicket, emailCode: '123456' }), depsOf(store));
  assert.equal(old.error, 'email_code_invalid');
  const again = await enrollTester(store);
  assert.notEqual(again.secret, first.secret);
});

test('finding 8: production never answers without a delivered email; a staging sink shows the code as homeowner-otp.mjs does', async () => {
  const prevEnv = process.env.CHECKSOPS_ENV;
  const prevMode = process.env.AWS_EMAIL_MODE;
  const sunk = async (message) => ({ mode: 'sink', results: [{ to: 'staging-sink@checksops.invalid', originalTo: message.to, delivery: 'sink', status: 'sunk' }] });
  try {
    process.env.CHECKSOPS_ENV = 'production-prep';
    process.env.AWS_EMAIL_MODE = 'sink';
    const prod = createStore();
    const refused = await handleMfaAssociate(eventOf({}), depsOf(prod, { sendViaSesOrSink: sunk }));
    assert.equal(refused.statusCode, 503);
    assert.equal(refused.error, 'email_code_send_failed');
    assert.equal(refused.emailChallenge, undefined);
    assert.equal(refused.stagingDebugCode, undefined);
    const failed = await handleMfaAssociate(eventOf({}), depsOf(prod, { sendViaSesOrSink: async () => { throw new Error('ses down'); } }));
    assert.equal(failed.error, 'email_code_send_failed');
    process.env.CHECKSOPS_ENV = 'staging';
    const staging = createStore();
    const shown = await handleMfaAssociate(eventOf({}), depsOf(staging, { sendViaSesOrSink: sunk }));
    assert.equal(shown.statusCode, 428);
    assert.match(shown.stagingDebugCode, /^\d{6}$/);
    const started = await handleMfaAssociate(eventOf({ emailChallenge: shown.emailChallenge, emailCode: shown.stagingDebugCode }), depsOf(staging, { sendViaSesOrSink: sunk }));
    assert.equal(started.ok, true, JSON.stringify(started));
  } finally {
    if (prevEnv === undefined) delete process.env.CHECKSOPS_ENV;
    else process.env.CHECKSOPS_ENV = prevEnv;
    if (prevMode === undefined) delete process.env.AWS_EMAIL_MODE;
    else process.env.AWS_EMAIL_MODE = prevMode;
  }
});

test('finding 8: no verified email refuses setup; a failed enrolled notice never undoes the activation', async () => {
  const noEmail = createStore({ email: null });
  const refused = await handleMfaAssociate(eventOf({}), depsOf(noEmail, { claims: { sub: TESTER_SUB, origin_jti: ORIGIN_JTI } }));
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.error, 'verified_email_required');
  assert.equal(noEmail.mail.length, 0);
  const store = createStore();
  const { started } = await associateWithEmailCode(store);
  const verified = await handleMfaVerify(
    eventOf({ code: totpAt(started.totp.secret, timestepOf(NOW)), enrollmentTicket: started.enrollmentTicket }),
    depsOf(store, { sendViaSesOrSink: async () => { throw new Error('ses down'); } }),
  );
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.enrollmentNotice, { sent: false, status: 'failed' });
  assert.ok(store.enrollments.get(TESTER_APP).verified_at);
});
