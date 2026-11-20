/**
 * App push registration: the route push-register-device (aws/functions/api/push-register-device.mjs), which the
 * iOS/Android app calls after sign-in (PR 2016, src/components/NativePushRegistration.tsx) with { token, platform }.
 * The token is kept by SQL 171's DEFINER functions (proven on PostgreSQL 16 in sql171-device-push-tokens-pg.test.mjs);
 * this file covers the routing, the sign-in the route runs as, the request checks before any database connection, the
 * register and unregister calls, the error answers, and that no full token reaches a log.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CLASS_A_FUNCTIONS, handleAppServiceRequest } from '../functions/api/app-services.mjs';
import {
  PUSH_REGISTER_SQL,
  PUSH_TOKEN_MAX,
  PUSH_UNREGISTER_SQL,
  handlePushRegisterDevice,
  mapPushSqlError,
  parsePushRequest,
  runPushRegisterDevice,
  tokenRef,
} from '../functions/api/push-register-device.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const ROW_ID = 'd1710000-0000-4000-8000-000000000001';
const TOKEN = 'fcm:APA91bExampleTokenAbc123_def-456';

const event = (body, { signedIn = true } = {}) => ({
  rawPath: '/functions/v1/push-register-device',
  headers: signedIn ? { authorization: 'Bearer t', 'x-user-id': '00000000-0000-0000-0000-000000000099' } : {},
  body: JSON.stringify(body),
  requestContext: {
    stage: 'staging',
    requestId: 'req-1',
    http: { method: 'POST', path: '/functions/v1/push-register-device' },
    ...(signedIn ? { authorizer: { jwt: { claims: { sub: SUB, email: 'tester@example.com', token_use: 'id' } } } } : {}),
  },
});

/** A fake connection: the identity lookup answers, the SQL 171 call answers `answer` (or throws it). */
const fakeClient = (answer) => {
  const queries = [];
  return {
    queries,
    connected: false,
    async connect() { this.connected = true; },
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params });
      if (params && params[0] === SUB) return { rows: [{ application_user_id: APP_ID, cognito_sub: SUB, email: 'tester@example.com', status: 'active' }] };
      if (String(sql) === PUSH_REGISTER_SQL || String(sql) === PUSH_UNREGISTER_SQL) {
        if (answer instanceof Error) throw answer;
        return { rows: [answer] };
      }
      return { rows: [] };
    },
  };
};
const deps = (client) => ({
  enforceLoginMfa: async () => null,
  loadDatabaseCredentials: async () => ({ username: 'checksops', password: 'unit-test-only', host: 'db.example.internal', database: 'checksops' }),
  createClient: () => client,
});
const sqlError = (message, code) => Object.assign(new Error(message), { code });

/** Runs fn with console.error / console.log captured. */
const captureLogs = async (fn) => {
  const lines = [];
  const orig = { error: console.error, log: console.log, warn: console.warn };
  console.error = (...a) => lines.push(a.join(' '));
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, orig);
  }
};

test('routing: push-register-device is a Class A name, dispatched to its handler', async () => {
  assert.ok(CLASS_A_FUNCTIONS.has('push-register-device'));
  const appServices = read('aws/functions/api/app-services.mjs');
  assert.match(appServices, /^import \{ handlePushRegisterDevice \} from '\.\/push-register-device\.mjs';$/m);
  assert.match(appServices, /^ {2}'push-register-device',$/m);
  assert.match(appServices, /case 'push-register-device':\n\s+return handlePushRegisterDevice\(event\);/);
  // The app's function name is this route.
  assert.match(read('src/lib/nativePush.ts'), /PUSH_REGISTER_FUNCTION = "push-register-device"/);
  // Unauthenticated through the dispatcher: answered by the route (401), not the provider stub.
  const answer = await handleAppServiceRequest(event({ token: TOKEN, platform: 'ios' }, { signedIn: false }), '/functions/v1/push-register-device', 'POST');
  assert.equal(answer.statusCode, 401, JSON.stringify(answer));
  assert.equal(answer.ok, false);
  // The module reaches the database only through withIdentity; no fetch, no provider, no other table.
  const src = read('aws/functions/api/push-register-device.mjs');
  assert.deepEqual([...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]), ['node:crypto', './data.mjs']);
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /fetch\(|device_push_tokens|apns|firebase|sns/i);
  // No generic route can call the DEFINER functions.
  for (const rel of ['aws/functions/api/data.mjs', 'aws/functions/api/workflow-rpc.mjs']) {
    assert.doesNotMatch(read(rel), /aws_push_(un)?register_device/, rel);
  }
});

test('a sign-in is required: no token answers 401 and no database connection is made', async () => {
  const client = fakeClient({ id: ROW_ID });
  const result = await handlePushRegisterDevice(event({ token: TOKEN, platform: 'ios' }, { signedIn: false }), deps(client));
  assert.equal(result.statusCode, 401);
  assert.equal(result.error, 'missing_cognito_token');
  assert.equal(client.connected, false);
  assert.equal(client.queries.length, 0);
});

test('validation: platform ios or android, token 1 to 4096 characters with no whitespace, checked before the database', async () => {
  assert.deepEqual(parsePushRequest({ token: TOKEN, platform: 'ios' }), { action: 'register', token: TOKEN, platform: 'ios' });
  assert.deepEqual(parsePushRequest({ token: TOKEN, platform: 'android' }), { action: 'register', token: TOKEN, platform: 'android' });
  assert.deepEqual(parsePushRequest({ action: 'unregister', token: TOKEN }), { action: 'unregister', token: TOKEN });
  assert.equal(parsePushRequest({ token: 'x'.repeat(PUSH_TOKEN_MAX), platform: 'ios' }).token.length, 4096);
  const bad = [
    [{ token: TOKEN }, 'invalid_platform'],
    [{ token: TOKEN, platform: 'IOS' }, 'invalid_platform'],
    [{ token: TOKEN, platform: 'windows' }, 'invalid_platform'],
    [{ token: TOKEN, platform: ['ios'] }, 'invalid_platform'],
    [{ platform: 'ios' }, 'invalid_token'],
    [{ token: '', platform: 'ios' }, 'invalid_token'],
    [{ token: 'has a space', platform: 'ios' }, 'invalid_token'],
    [{ token: 'tab\there', platform: 'ios' }, 'invalid_token'],
    [{ token: 'line\nbreak', platform: 'ios' }, 'invalid_token'],
    [{ token: 'x'.repeat(PUSH_TOKEN_MAX + 1), platform: 'ios' }, 'invalid_token'],
    [{ token: 12345, platform: 'ios' }, 'invalid_token'],
    [{ action: 'unregister' }, 'invalid_token'],
    [{ action: 'delete', token: TOKEN }, 'invalid_action'],
  ];
  for (const [body, error] of bad) {
    assert.equal(parsePushRequest(body).error, error, JSON.stringify(body).slice(0, 80));
    const client = fakeClient({ id: ROW_ID });
    const result = await handlePushRegisterDevice(event(body), deps(client));
    assert.equal(result.statusCode, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(result.error, error);
    assert.equal(client.connected, false, 'no database connection on bad input');
  }
  // The inner step refuses too when called without a parsed request.
  const client = fakeClient({ id: ROW_ID });
  const inner = await runPushRegisterDevice({ client, body: { token: '', platform: 'ios' }, spoof: {} });
  assert.equal(inner.statusCode, 400);
  assert.equal(client.queries.length, 0);
});

test('register: one SQL 171 call as the verified sign-in, platform then token, committed; answers { ok, id }', async () => {
  const client = fakeClient({ id: ROW_ID });
  const result = await handlePushRegisterDevice(event({ token: TOKEN, platform: 'android', user_id: '00000000-0000-0000-0000-000000000099' }), deps(client));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.statusCode, 200);
  assert.equal(result.id, ROW_ID);
  // The actor is the mapped application user from the Cognito token, never a body or header id.
  const guc = client.queries.find((q) => /set_config/.test(q.sql) && q.params?.[0] === 'request.app_user_id');
  assert.equal(guc.params[1], APP_ID);
  const calls = client.queries.filter((q) => q.sql === PUSH_REGISTER_SQL || q.sql === PUSH_UNREGISTER_SQL);
  assert.deepEqual(calls.map((q) => [q.sql, q.params]), [[PUSH_REGISTER_SQL, ['android', TOKEN]]]);
  assert.equal(PUSH_REGISTER_SQL, 'SELECT public.aws_push_register_device($1::text, $2::text) AS id');
  const sqls = client.queries.map((q) => q.sql);
  assert.ok(sqls.indexOf('SET TRANSACTION READ WRITE') < sqls.indexOf(PUSH_REGISTER_SQL));
  assert.ok(guc && sqls.indexOf(guc.sql) < sqls.indexOf(PUSH_REGISTER_SQL));
  assert.equal(sqls.at(-1), 'COMMIT');
  // No direct table access: the only statement that writes is the DEFINER call.
  assert.equal(sqls.some((s) => /\b(INSERT|UPDATE|DELETE)\b|device_push_tokens/i.test(s)), false);
});

test('unregister: { action: unregister, token } calls aws_push_unregister_device and answers { ok, removed }', async () => {
  for (const removed of [true, false]) {
    const client = fakeClient({ removed });
    const result = await handlePushRegisterDevice(event({ action: 'unregister', token: TOKEN }), deps(client));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.removed, removed);
    assert.equal(result.id, undefined);
    const calls = client.queries.filter((q) => q.sql === PUSH_REGISTER_SQL || q.sql === PUSH_UNREGISTER_SQL);
    assert.deepEqual(calls.map((q) => [q.sql, q.params]), [[PUSH_UNREGISTER_SQL, [TOKEN]]]);
    assert.equal(client.queries.at(-1).sql, 'COMMIT');
  }
  assert.equal(PUSH_UNREGISTER_SQL, 'SELECT public.aws_push_unregister_device($1::text) AS removed');
});

test('errors: 42501 -> 403, 22023 -> 400, a missing function -> 503, anything else -> 500 without details; each rolls back', async () => {
  const cases = [
    [sqlError('not_authorized', '42501'), 403, 'not_authorized'],
    [sqlError('invalid_platform', '22023'), 400, 'invalid_platform'],
    [sqlError('invalid_token', '22023'), 400, 'invalid_token'],
    [sqlError('function public.aws_push_register_device(text, text) does not exist', '42883'), 503, 'push_registration_unavailable'],
    [sqlError(`duplicate key value violates unique constraint "device_push_tokens_token_key" Key (token)=(${TOKEN})`, '23505'), 500, 'push_registration_failed'],
    [sqlError('connection terminated unexpectedly', undefined), 500, 'push_registration_failed'],
  ];
  for (const [error, status, code] of cases) {
    const client = fakeClient(error);
    const { result } = await captureLogs(() => handlePushRegisterDevice(event({ token: TOKEN, platform: 'ios' }), deps(client)));
    assert.equal(result.statusCode, status, error.message);
    assert.equal(result.error, code);
    assert.equal(result.ok, false);
    // Nothing of the database's own message reaches the caller (beyond SQL 171's own short codes).
    if (error.message !== code) assert.ok(!JSON.stringify(result).includes(error.message), error.message);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.equal(client.queries.at(-1).sql, 'ROLLBACK');
    assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), false);
  }
  // A register that returns no row is a 500, rolled back.
  const empty = fakeClient({ id: null });
  const { result } = await captureLogs(() => handlePushRegisterDevice(event({ token: TOKEN, platform: 'ios' }), deps(empty)));
  assert.equal(result.statusCode, 500);
  assert.equal(empty.queries.at(-1).sql, 'ROLLBACK');
  assert.equal(mapPushSqlError(sqlError('x', 'XX000'), {}).statusCode, 500);
});

test('logs never carry the token: a failure logs a 12-character sha256 reference only', async () => {
  const client = fakeClient(sqlError(`boom ${TOKEN}`, '23505'));
  const { lines } = await captureLogs(() => handlePushRegisterDevice(event({ token: TOKEN, platform: 'ios' }), deps(client)));
  const all = lines.join('\n');
  assert.ok(lines.length >= 1);
  assert.ok(!all.includes(TOKEN), 'the full token is never logged');
  assert.ok(!all.includes(TOKEN.slice(0, 16)), 'not even a long prefix');
  const entry = JSON.parse(lines.find((l) => l.includes('push_register_device_failed')));
  assert.equal(entry.tokenRef, tokenRef(TOKEN));
  assert.match(entry.tokenRef, /^[0-9a-f]{12}$/);
  assert.equal(entry.sqlstate, '23505');
  assert.equal(entry.action, 'register');
  // A success logs nothing with the token either.
  const ok = await captureLogs(() => handlePushRegisterDevice(event({ token: TOKEN, platform: 'ios' }), deps(fakeClient({ id: ROW_ID }))));
  assert.ok(!ok.lines.join('\n').includes(TOKEN));
});
