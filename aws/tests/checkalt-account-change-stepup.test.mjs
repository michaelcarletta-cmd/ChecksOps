/**
 * Finding 13 (2026-10-30): changing a tenant's registered Check Alt deposit account needs a fresh
 * code from the platform owner's authenticator app in the same request, checked before any Check Alt
 * call or write; first registration and a re-register with the same number need none. The code
 * draws on the shared code_check rate limit, is accepted once (newer time step only), is logged in
 * financial_stepup_log, and the company is emailed the old and new last four digits. An email
 * failure never undoes the change.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import { TOTP_CODE_CHECK_RATE_ACTION } from '../functions/api/auth-financial-totp.mjs';
import {
  encryptSecret,
  generateTotpSecret,
  timestepOf,
  totpAt,
  wrapKeyFromHex,
} from '../functions/api/financial-totp.mjs';
import {
  CHECKALT_ACCOUNT_CHANGE_ACTION,
  DEPOSIT_ACCOUNT_CHANGED_TEMPLATE,
  buildDepositAccountChangedEmail,
  isDepositAccountChange,
} from '../functions/api/providers/production/checkalt-register.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const OLD = '111122223333';
const NEW = '987654321';
const WRAP_HEX = 'ab'.repeat(32);
const NOW = Date.parse('2026-10-30T12:00:00Z');
const SECRET = generateTotpSecret();
const CODE = totpAt(SECRET, timestepOf(NOW));

const mapping = { application_user_id: APP, cognito_sub: SUB, email: 'owner@checksops.com', status: 'active' };

const jwtEvent = (fn, body) => ({
  rawPath: `/functions/v1/${fn}`,
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'prod',
    http: { method: 'POST', path: `/functions/v1/${fn}` },
    authorizer: { jwt: { claims: { sub: SUB, email: 'owner@checksops.com', token_use: 'id', auth_time: '1793300000' } } },
  },
});

const productionFlags = {
  AWS_PROVIDER_EXECUTION_ENABLED: 'true',
  AWS_CHECKALT_ENABLED: 'true',
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'true',
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: undefined,
  AWS_CHECKALT_STATUS_RECONCILE_ENABLED: undefined,
  PROVIDER_SECRETS_ARN: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:checksops/production/providers',
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

const productionSecrets = async () => ({
  ok: true,
  credentials: {
    environment: 'production', username: 'prod-api-login', password: 'prod-pass', fiKey: 'prod-fi-key', baseUrl: 'https://api2.checkalt.com',
  },
});

const enrollment = () => {
  const sealed = encryptSecret(SECRET, wrapKeyFromHex(WRAP_HEX));
  return { ciphertext: sealed.ciphertext, nonce: sealed.nonce, key_id: 'test', last_used_timestep: null, verified_at: '2026-10-01T00:00:00Z', failed_attempts: 0, locked_until: null };
};

const registeredRow = () => ({
  tenant_id: TENANT,
  sso_user_id: 'acme-depositor',
  deposit_account_number: OLD,
  first_name: 'Acme',
  last_name: 'Owner',
  email: 'ops@acme.example',
  enabled: true,
  registered_at: '2026-10-15T00:00:00.000Z',
});

const newState = (extra = {}) => ({
  owner: true,
  queries: [],
  calls: [],
  writes: [],
  committedWrites: [],
  pendingWrites: [],
  commits: 0,
  row: null,
  saved: null,
  rateAllowed: true,
  enrollment: enrollment(),
  companyEmail: 'billing@acme.example',
  members: [{ email: 'member@acme.example' }],
  stepups: [],
  emailLog: [],
  ...extra,
});

const track = (state, label) => { state.pendingWrites.push(label); state.writes.push(label); };

const fakeClient = (state) => ({
  connect: async () => {},
  end: async () => {},
  query: async (sql, params = []) => {
    const text = String(sql);
    state.queries.push({ sql: text, params });
    if (text === 'COMMIT') {
      state.commits += 1;
      state.committedWrites.push(...state.pendingWrites);
      state.pendingWrites = [];
      return { rows: [], command: 'COMMIT' };
    }
    if (text === 'ROLLBACK') { state.pendingWrites = []; return { rows: [] }; }
    if (/^(BEGIN|SET TRANSACTION|SAVEPOINT|RELEASE|ROLLBACK TO)/.test(text)) return { rows: [] };
    if (text.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
    if (text === LOOKUP_MAPPING_SQL) return { rows: params[0] === SUB ? [mapping] : [] };
    if (text.includes('is_platform_owner()')) return { rows: [{ is_owner: state.owner }] };
    if (text.includes('aws_checkalt_production_config')) {
      return { rows: [{ merchant: 'prod-merchant', base_url: 'https://api2.checkalt.com', default_enabled: true, depositor_account_id: null, business_unit: null }] };
    }
    if (text.includes('has_function_privilege')) return { rows: [{ writer_ok: true, tenant_exists: true }] };
    if (text.includes('consume_financial_totp_rate_limit')) {
      track(state, `rate:${params[1]}`);
      return { rows: [{ allowed: state.rateAllowed, count: 1, retry_after_seconds: 60 }] };
    }
    if (text.includes('financial_totp_get_enrollment')) return { rows: state.enrollment ? [state.enrollment] : [] };
    // SQL 132: the API checks for the function, then counts the check; ten without a success lock for 15 minutes.
    if (text.includes('to_regprocedure')) return { rows: [{ present: state.lockoutFunction !== false && params[0] === 'public.financial_totp_count_code_check(uuid)' }] };
    if (text.includes('financial_totp_count_code_check')) {
      if (!state.enrollment) return { rows: [] };
      const now = Date.now();
      const lockedUntil = state.enrollment.locked_until ? new Date(state.enrollment.locked_until).getTime() : 0;
      if (lockedUntil > now) return { rows: [{ allowed: false, failed_attempts: state.enrollment.failed_attempts, retry_after_seconds: Math.max(1, Math.ceil((lockedUntil - now) / 1000)) }] };
      const failed = state.enrollment.failed_attempts + 1;
      state.enrollment = { ...state.enrollment, failed_attempts: failed, locked_until: failed >= 10 ? new Date(now + 15 * 60000).toISOString() : null };
      track(state, `count:${failed}`);
      return { rows: [{ allowed: true, failed_attempts: failed, retry_after_seconds: 0 }] };
    }
    if (text.includes('financial_totp_mark_verified')) {
      const step = Number(params[1]);
      if (state.enrollment.last_used_timestep !== null && Number(state.enrollment.last_used_timestep) === step) return { rows: [{ claimed: false }] };
      state.enrollment = { ...state.enrollment, last_used_timestep: step, failed_attempts: 0, locked_until: null };
      track(state, `mark:${step}`);
      return { rows: [{ claimed: true }] };
    }
    if (text.includes('INSERT INTO public.financial_stepup_log')) {
      state.stepups.push({ user_id: params[0], tenant_id: params[1], action_key: params[2], metadata: JSON.parse(params[3]) });
      track(state, 'stepup');
      return { rows: [{ id: `stepup-${state.stepups.length}`, created_at: new Date(NOW).toISOString() }] };
    }
    if (text.includes('aws_register_checkalt_tenant_account')) {
      const account = JSON.parse(params[1]);
      state.saved = { tenant_id: params[0], ...account };
      track(state, 'register');
      state.row = { ...registeredRow(), ...account, tenant_id: params[0] };
      return { rows: [{ result: { tenant_id: params[0], sso_user_id: account.sso_user_id, enabled: true, registered_at: '2026-10-30T12:00:00.000Z' } }] };
    }
    if (text.includes('FROM public.checkalt_tenant_accounts')) return { rows: state.row ? [state.row] : [] };
    if (text.includes('company_email FROM public.tenants')) return { rows: [{ name: 'Acme Restoration', company_email: state.companyEmail }] };
    if (text.includes('FROM public.tenant_users tu')) return { rows: state.members };
    if (text.includes('INSERT INTO public.email_send_log')) { state.emailLog.push(params); return { rows: [] }; }
    if (/^\s*(INSERT|UPDATE|DELETE)/.test(text)) track(state, text.slice(0, 60));
    return { rows: [] };
  },
});

const providerFetch = (state) => async (url, init = {}) => {
  const href = String(url);
  state.calls.push({ url: href, body: init.body ? JSON.parse(init.body) : null });
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  if (href.endsWith('/public/fincapture/authenticate')) return reply(200, 'header.payload.sig');
  if (href.endsWith('/fincapture/useraccount/register')) return reply(200, { success: true });
  if (href.endsWith('/fincapture/useraccount/getUserAccountInformation')) return reply(200, { userId: 'acme-depositor', accountDataList: [{ accountNumber: NEW, ssoKey: 'sso-live' }] });
  return reply(404, 'not found');
};

const call = (state, body, { mailer } = {}) => withEnv(productionFlags, () => handleProviderRequest(
  jwtEvent('checkalt-register-account', body),
  '/functions/v1/checkalt-register-account',
  'POST',
  {
    createClient: () => fakeClient(state),
    loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
    loadProductionSecrets: productionSecrets,
    fetchImpl: providerFetch(state),
    loadWrapKey: async () => ({ key: wrapKeyFromHex(WRAP_HEX), keyId: 'test' }),
    nowMs: NOW,
    sendViaSesOrSink: mailer || (async (message) => {
      state.sent = [...(state.sent || []), message];
      return { mode: 'sink', results: [{ status: 'sent', delivery: 'ses', messageId: `m-${(state.sent || []).length}` }] };
    }),
  },
));

const body = (extra = {}) => ({
  tenant_id: TENANT,
  sso_user_id: 'acme-depositor',
  first_name: 'Acme',
  last_name: 'Owner',
  email: 'ops@acme.example',
  deposit_account_number: NEW,
  ...extra,
});

const noProviderNoWrite = (state) => {
  assert.equal(state.calls.length, 0, 'no Check Alt call');
  assert.equal(state.saved, null, 'nothing saved');
  assert.equal(state.writes.includes('register'), false);
};

test('a change is a registered account with a different number; first registration and the same number are not', () => {
  assert.equal(isDepositAccountChange(null, NEW), false);
  assert.equal(isDepositAccountChange({ ...registeredRow(), registered_at: null }, NEW), false);
  assert.equal(isDepositAccountChange(registeredRow(), OLD), false);
  assert.equal(isDepositAccountChange(registeredRow(), NEW), true);
});

test('right people: first registration needs no code and sends no change email', async () => {
  const state = newState();
  const result = await call(state, body());
  assert.equal(result.statusCode, 200, JSON.stringify(result));
  assert.equal(state.saved.deposit_account_number, NEW);
  assert.equal(result.account_changed, undefined);
  assert.equal(state.stepups.length, 0);
  assert.equal(state.queries.some((q) => q.sql.includes('consume_financial_totp_rate_limit')), false);
  assert.equal(state.sent, undefined);
});

test('right people: re-registering the same account number needs no code and sends no change email', async () => {
  const state = newState({ row: registeredRow() });
  const result = await call(state, body({ deposit_account_number: OLD }));
  assert.equal(result.statusCode, 200, JSON.stringify(result));
  assert.equal(state.saved.deposit_account_number, OLD);
  assert.equal(state.stepups.length, 0);
  assert.equal(state.sent, undefined);
});

test('wrong path: a change without a code is refused before any Check Alt call or write, and asks for the code', async () => {
  const state = newState({ row: registeredRow() });
  const result = await call(state, body());
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'account_change_code_required');
  assert.equal(result.code_required, true);
  assert.equal(result.account_last4, '3333');
  assert.equal(JSON.stringify(result).includes(OLD), false);
  noProviderNoWrite(state);
  assert.equal(state.queries.some((q) => q.sql.includes('consume_financial_totp_rate_limit')), false);
});

test('wrong path: a wrong code is refused with no Check Alt call or write; the rate-limit hit is kept', async () => {
  const state = newState({ row: registeredRow() });
  const wrong = CODE === '000000' ? '111111' : '000000';
  const result = await call(state, body({ totp_code: wrong }));
  assert.equal(result.statusCode, 401, JSON.stringify(result));
  assert.equal(result.error, 'code_rejected');
  noProviderNoWrite(state);
  assert.deepEqual(state.committedWrites, [`rate:${TOTP_CODE_CHECK_RATE_ACTION}`, 'count:1'], 'only the rate-limit hit and the SQL 132 count are committed');
  assert.equal(state.enrollment.failed_attempts, 1);
  assert.equal(state.stepups.length, 0);
});

test('wrong path: a malformed code, a rate-limited user and an unenrolled user are refused before Check Alt', async () => {
  for (const [extra, setup, error, status] of [
    [{ totp_code: '12ab56' }, {}, 'invalid_code', 400],
    [{ totp_code: CODE }, { rateAllowed: false }, 'rate_limited', 429],
    [{ totp_code: CODE }, { enrollment: null }, 'totp_not_enrolled', 403],
  ]) {
    const state = newState({ row: registeredRow(), ...setup });
    const result = await call(state, body(extra));
    assert.equal(result.statusCode, status, error);
    assert.equal(result.error, error);
    noProviderNoWrite(state);
  }
});

test('right people: a change with a valid code saves, logs the step-up, spends the code and emails the company (last four only)', async () => {
  const state = newState({ row: registeredRow() });
  const result = await call(state, body({ totp_code: CODE }));
  assert.equal(result.statusCode, 200, JSON.stringify(result));
  assert.equal(result.account_changed, true);
  assert.equal(result.previous_account_last4, '3333');
  assert.equal(result.account_last4, '4321');
  assert.equal(state.saved.deposit_account_number, NEW);
  assert.equal(state.calls.some((c) => c.url.endsWith('/fincapture/useraccount/register')), true);
  // The step-up row: this action, this tenant, this login, written by the server.
  assert.equal(state.stepups.length, 1);
  assert.equal(state.stepups[0].action_key, CHECKALT_ACCOUNT_CHANGE_ACTION);
  assert.equal(state.stepups[0].tenant_id, TENANT);
  assert.equal(state.stepups[0].metadata.source, 'app_financial_totp');
  assert.equal(state.stepups[0].metadata.login_session, `${SUB}:auth:1793300000`);
  // The code was spent (time step recorded) and committed before Check Alt was called.
  const registerCall = state.queries.findIndex((q) => q.sql.startsWith('SELECT public.aws_register_checkalt_tenant_account'));
  const markIndex = state.queries.findIndex((q) => q.sql.includes('financial_totp_mark_verified'));
  const commitAfterMark = state.queries.findIndex((q, i) => i > markIndex && q.sql === 'COMMIT');
  assert.ok(markIndex > 0 && commitAfterMark > markIndex && commitAfterMark < registerCall);
  assert.ok(state.committedWrites.includes('stepup'));
  assert.ok(state.committedWrites.includes('register'), 'the change is committed before the email');
  // The company is emailed at its business address, with masked numbers only.
  assert.equal(state.sent.length, 1);
  const [message] = state.sent;
  assert.equal(message.to, 'billing@acme.example');
  assert.equal(message.messageCategory, DEPOSIT_ACCOUNT_CHANGED_TEMPLATE);
  assert.match(message.text, /ending in 4321/);
  assert.match(message.text, /ending in 3333/);
  assert.match(message.text, /owner@checksops\.com/);
  for (const field of [message.text, message.html, message.subject, JSON.stringify(result)]) {
    assert.equal(field.includes(OLD), false);
    assert.equal(field.includes(NEW), false);
  }
  assert.equal(result.change_notice.status, 'sent');
  assert.equal(state.emailLog.length, 1);
  assert.equal(state.emailLog[0][0], DEPOSIT_ACCOUNT_CHANGED_TEMPLATE);
});

test('wrong path: the same code cannot be used twice', async () => {
  const state = newState({ row: registeredRow() });
  const first = await call(state, body({ totp_code: CODE }));
  assert.equal(first.statusCode, 200, JSON.stringify(first));
  state.calls = [];
  state.saved = null;
  state.writes = [];
  const replay = await call(state, body({ totp_code: CODE, deposit_account_number: '55554444333' }));
  assert.equal(replay.statusCode, 401, JSON.stringify(replay));
  assert.equal(replay.error, 'code_rejected');
  noProviderNoWrite(state);
});

test('wrong path: a code from an earlier time step than the last one used is refused', async () => {
  const state = newState({ row: registeredRow() });
  state.enrollment = { ...state.enrollment, last_used_timestep: timestepOf(NOW) };
  const earlier = totpAt(SECRET, timestepOf(NOW) - 1);
  const result = await call(state, body({ totp_code: earlier }));
  assert.equal(result.statusCode, 401, JSON.stringify(result));
  noProviderNoWrite(state);
});

test('wrong people: a non-platform-owner is refused before any code check, Check Alt call or write', async () => {
  const state = newState({ owner: false, row: registeredRow() });
  const result = await call(state, body({ totp_code: CODE }));
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'not_authorized');
  noProviderNoWrite(state);
  assert.equal(state.queries.some((q) => q.sql.includes('consume_financial_totp_rate_limit')), false);
});

test('an email failure does not undo the change; it is reported and logged', async () => {
  const state = newState({ row: registeredRow() });
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(String(line));
  let result;
  try {
    result = await call(state, body({ totp_code: CODE }), { mailer: async () => { throw new Error('ses down'); } });
  } finally {
    console.error = original;
  }
  assert.equal(result.statusCode, 200, JSON.stringify(result));
  assert.equal(result.account_changed, true);
  assert.equal(result.change_notice.status, 'failed');
  assert.ok(state.committedWrites.includes('register'));
  assert.ok(errors.some((line) => line.includes('checkalt_deposit_account_change_email_failed')));
  assert.equal(state.emailLog[0][3], 'failed');
});

test('without a company email the members are emailed', async () => {
  const state = newState({ row: registeredRow(), companyEmail: null, members: [{ email: 'a@acme.example' }, { email: 'b@acme.example' }, { email: 'a@acme.example' }] });
  const result = await call(state, body({ totp_code: CODE }));
  assert.equal(result.statusCode, 200, JSON.stringify(result));
  assert.deepEqual(state.sent.map((m) => m.to), ['a@acme.example', 'b@acme.example']);
});

test('the email names the company, both last fours, who and when, and nothing more', () => {
  const email = buildDepositAccountChangedEmail({
    tenantName: 'Acme Restoration', previousLast4: '3333', newLast4: '4321', changedAt: new Date(NOW), changedBy: 'owner@checksops.com',
  });
  assert.match(email.subject, /Acme Restoration: your Check Alt deposit account was changed/);
  assert.match(email.text, /2026-10-30 12:00 UTC by owner@checksops\.com/);
  assert.match(email.text, /support@checksops\.com/);
});

test('SPA: the card asks for the authenticator code only when changing a registered account and sends it as totp_code', () => {
  const card = fs.readFileSync(path.join(ROOT, 'src/components/settings/CheckAltTenantAccountCard.tsx'), 'utf8');
  assert.match(card, /const changingAccount = registered && accountNumberValid/);
  assert.match(card, /\.\.\.\(codeNeeded \? \{ totp_code: totpCode\.trim\(\) \} : \{\}\)/);
  assert.match(card, /code_required\?: unknown/);
  assert.match(card, /id="reg_totp"/);
  assert.match(card, /&& \(!codeNeeded \|\| codeValid\)/);
});

test('SQL 132: ten wrong codes lock the account change; while locked the right code is refused exactly like a wrong one, with no Check Alt call, write or mark', async () => {
  const state = newState({ row: registeredRow() });
  const wrong = CODE === '000000' ? '111111' : '000000';
  let wrongResult = null;
  for (let i = 0; i < 10; i += 1) {
    wrongResult = await call(state, body({ totp_code: wrong }));
    assert.equal(wrongResult.statusCode, 401, `check ${i + 1}`);
    assert.equal(wrongResult.error, 'code_rejected', `check ${i + 1}`);
    assert.equal(state.enrollment.failed_attempts, i + 1);
  }
  assert.ok(state.enrollment.locked_until && new Date(state.enrollment.locked_until).getTime() > Date.now(), 'locked after the tenth');
  state.queries = [];
  const locked = await call(state, body({ totp_code: CODE }));
  assert.deepEqual(locked, wrongResult, 'a locked check answers exactly like a wrong code');
  noProviderNoWrite(state);
  assert.equal(state.queries.some((q) => q.sql.includes('financial_totp_mark_verified')), false, 'the code is never compared or spent');
  assert.equal(state.stepups.length, 0);
  assert.equal(state.enrollment.failed_attempts, 10, 'a locked check is not counted again');
});

test('SQL 132: the count is committed before the compare, and a right code clears it', async () => {
  const state = newState({ row: registeredRow(), enrollment: { ...enrollment(), failed_attempts: 4 } });
  const result = await call(state, body({ totp_code: CODE }));
  assert.equal(result.statusCode, 200, JSON.stringify(result));
  const countAt = state.committedWrites.indexOf('count:5');
  const markAt = state.committedWrites.findIndex((w) => w.startsWith('mark:'));
  assert.ok(countAt >= 0 && markAt > countAt, JSON.stringify(state.committedWrites));
  assert.equal(state.enrollment.failed_attempts, 0);
  assert.equal(state.enrollment.locked_until, null);
});

test('SQL 132 not applied (the function absent): the check is not counted, nothing locks, and the change answers as before', async () => {
  const state = newState({ row: registeredRow(), lockoutFunction: false });
  const wrong = CODE === '000000' ? '111111' : '000000';
  for (let i = 0; i < 12; i += 1) {
    const result = await call(state, body({ totp_code: wrong }));
    assert.equal(result.statusCode, 401, `check ${i + 1}`);
    assert.equal(result.error, 'code_rejected', `check ${i + 1}`);
  }
  assert.equal(state.enrollment.failed_attempts, 0);
  assert.equal(state.enrollment.locked_until, null);
  assert.equal(state.queries.some((q) => q.sql.includes('financial_totp_count_code_check')), false);
  const right = await call(state, body({ totp_code: CODE }));
  assert.equal(right.statusCode, 200, JSON.stringify(right));
});

test('a locked_until already on the row is refused like a wrong code even when the SQL 132 function is absent', async () => {
  const state = newState({ row: registeredRow(), lockoutFunction: false, enrollment: { ...enrollment(), locked_until: new Date(Date.now() + 60000).toISOString() } });
  const result = await call(state, body({ totp_code: CODE }));
  assert.equal(result.statusCode, 401, JSON.stringify(result));
  assert.equal(result.error, 'code_rejected');
  noProviderNoWrite(state);
  assert.equal(state.queries.some((q) => q.sql.includes('financial_totp_mark_verified')), false);
});
