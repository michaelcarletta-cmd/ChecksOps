import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  enforceLoginMfa,
  LOGIN_MFA_ACTION,
  LOGIN_MFA_EXEMPT_PATHS,
  LOGIN_MFA_FLAG,
  loginMfaRequestPath,
  loginMfaState,
  resetLoginMfaCache,
} from '../functions/api/login-mfa.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const USER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const CLAIMS = { sub: SUB, origin_jti: 'origin-jti-1' };
const SESSION = `${SUB}:jti:origin-jti-1`;
const mapping = { application_user_id: USER };

const clientWith = (rows) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      if (String(sql).includes('FROM public.financial_stepup_log')) {
        const hit = rows.find((r) => r.user_id === params[0] && r.action_key === params[1] && r.login_session === params[2]);
        return { rows: hit ? [{ id: 'row-1', created_at: '2026-11-06T00:00:00Z' }] : [] };
      }
      return { rows: [] };
    },
  };
};

const eventFor = (rawPath, stage = 'prep') => ({ rawPath, requestContext: { stage } });
const on = { required: () => true };

test('off by default: the flag is AWS_LOGIN_MFA_REQUIRED and nothing is refused or read while it is unset', async () => {
  assert.equal(LOGIN_MFA_FLAG, 'AWS_LOGIN_MFA_REQUIRED');
  const prev = process.env.AWS_LOGIN_MFA_REQUIRED;
  delete process.env.AWS_LOGIN_MFA_REQUIRED;
  try {
    const client = clientWith([]);
    assert.equal(await enforceLoginMfa({ event: eventFor('/prep/data/query'), client, mapping, claims: CLAIMS }), null);
    assert.equal(client.calls.length, 0);
  } finally {
    if (prev === undefined) delete process.env.AWS_LOGIN_MFA_REQUIRED; else process.env.AWS_LOGIN_MFA_REQUIRED = prev;
  }
});

test('on: a login with no login.mfa step-up is refused with login_mfa_required', async () => {
  resetLoginMfaCache();
  const client = clientWith([]);
  const refused = await enforceLoginMfa({ event: eventFor('/prep/data/query'), client, mapping, claims: CLAIMS, spoof: {} }, on);
  assert.equal(refused.ok, false);
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.error, 'login_mfa_required');
});

test('on: this login\'s login.mfa step-up lets the request through', async () => {
  resetLoginMfaCache();
  const client = clientWith([{ user_id: USER, action_key: LOGIN_MFA_ACTION, login_session: SESSION }]);
  assert.equal(await enforceLoginMfa({ event: eventFor('/prep/data/query'), client, mapping, claims: CLAIMS }, on), null);
});

test('on: a step-up for another login, another user or another action does not count', async () => {
  resetLoginMfaCache();
  const client = clientWith([
    { user_id: USER, action_key: LOGIN_MFA_ACTION, login_session: `${SUB}:jti:other-login` },
    { user_id: '00000000-0000-4000-8000-000000000000', action_key: LOGIN_MFA_ACTION, login_session: SESSION },
    { user_id: USER, action_key: 'wallet.fund', login_session: SESSION },
  ]);
  const refused = await enforceLoginMfa({ event: eventFor('/prep/storage/sign'), client, mapping, claims: CLAIMS }, on);
  assert.equal(refused.error, 'login_mfa_required');
});

test('on: a login with no origin_jti or auth_time is refused as unbound', async () => {
  resetLoginMfaCache();
  const refused = await enforceLoginMfa({ event: eventFor('/prep/data/query'), client: clientWith([]), mapping, claims: { sub: SUB } }, on);
  assert.equal(refused.error, 'login_session_unbound');
});

test('on: the enrollment, step-up and identity routes stay open so a user can pass the check', async () => {
  resetLoginMfaCache();
  for (const route of ['/auth/mfa/status', '/auth/mfa/associate', '/auth/mfa/verify', '/auth/mfa/step-up', '/identity/me', '/identity/session']) {
    assert.ok(LOGIN_MFA_EXEMPT_PATHS.has(route), route);
    const client = clientWith([]);
    assert.equal(await enforceLoginMfa({ event: eventFor(`/prep${route}`), client, mapping, claims: CLAIMS }, on), null, route);
    assert.equal(client.calls.length, 0, route);
  }
  assert.equal(LOGIN_MFA_EXEMPT_PATHS.size, 6);
  assert.equal(LOGIN_MFA_EXEMPT_PATHS.has('/auth/mfa/set-preference'), false);
});

test('the stage prefix and a trailing slash are removed before the exempt check', () => {
  assert.equal(loginMfaRequestPath(eventFor('/prep/auth/mfa/step-up/')), '/auth/mfa/step-up');
  assert.equal(loginMfaRequestPath(eventFor('/auth/mfa/status', '$default')), '/auth/mfa/status');
  assert.equal(loginMfaRequestPath({ requestContext: { http: { path: '/prep/data/query' }, stage: 'prep' } }), '/data/query');
  assert.equal(loginMfaRequestPath(eventFor('/prepx/auth/mfa/status')), '/prepx/auth/mfa/status');
});

test('a pass is cached per login for five minutes; a refusal is never cached', async () => {
  resetLoginMfaCache();
  const empty = clientWith([]);
  assert.equal((await loginMfaState({ client: empty, mapping, claims: CLAIMS }, { ...on, nowMs: 0 })).satisfied, false);
  assert.equal((await loginMfaState({ client: empty, mapping, claims: CLAIMS }, { ...on, nowMs: 1 })).satisfied, false);
  assert.equal(empty.calls.length, 2);
  const passed = clientWith([{ user_id: USER, action_key: LOGIN_MFA_ACTION, login_session: SESSION }]);
  assert.equal((await loginMfaState({ client: passed, mapping, claims: CLAIMS }, { ...on, nowMs: 10 })).satisfied, true);
  assert.equal((await loginMfaState({ client: empty, mapping, claims: CLAIMS }, { ...on, nowMs: 10 + 299999 })).satisfied, true);
  assert.equal((await loginMfaState({ client: empty, mapping, claims: CLAIMS }, { ...on, nowMs: 10 + 300001 })).satisfied, false);
});

test('withIdentity runs the login MFA gate after the identity is mapped and before the route handler', () => {
  const src = fs.readFileSync(path.join(ROOT, 'aws/functions/api/data.mjs'), 'utf8');
  const mapped = src.indexOf('set_config($1, $2, true)\', [APP_USER_EMAIL_GUC');
  const gate = src.indexOf('enforceLoginMfa)({');
  const handler = src.indexOf('const result = await fn({ client, mapping, claims: claimsResult.claims, body, spoof });');
  assert.ok(mapped > 0 && gate > mapped && handler > gate, 'gate sits between mapping and handler');
  assert.match(src.slice(gate, handler), /ROLLBACK/);
});
