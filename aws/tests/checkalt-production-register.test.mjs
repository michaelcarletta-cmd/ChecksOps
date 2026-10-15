/**
 * Production Check Alt depositor onboarding (providers/production/checkalt-register.mjs):
 * platform owner only, live FinCapture register + user lookup (mocked here),
 * writes through public.aws_register_checkalt_tenant_account (SQL 81), and
 * every response carries the deposit account number as the last four only.
 * Verify shows Check Alt's live answer and persists nothing. Submit is unchanged.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import { handleProviderRequest } from '../functions/api/providers.mjs';
import {
  accountLast4,
  maskAccountNumber,
  maskCheckAltPayload,
  normalizeDepositAccountNumber,
} from '../functions/api/providers/checkalt-account-mask.mjs';
import { validateRegisterBody } from '../functions/api/providers/production/checkalt-register.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const APP = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const FULL = '123456789';

const mapping = { application_user_id: APP, cognito_sub: SUB, email: 'owner@example.com', status: 'active' };

const jwtEvent = (fn, body) => ({
  rawPath: `/functions/v1/${fn}`,
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify(body),
  requestContext: {
    stage: 'prod',
    http: { method: 'POST', path: `/functions/v1/${fn}` },
    authorizer: { jwt: { claims: { sub: SUB, email: 'owner@example.com', token_use: 'id' } } },
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
    environment: 'production',
    username: 'prod-api-login',
    password: 'prod-pass',
    fiKey: 'prod-fi-key',
    baseUrl: 'https://api2.checkalt.com',
  },
});

const fakeClient = (state) => ({
  connect: async () => {},
  end: async () => {},
  query: async (sql, params = []) => {
    const text = String(sql);
    state.queries.push({ sql: text, params });
    if (/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION|SAVEPOINT|RELEASE|ROLLBACK TO)/.test(text)) return { rows: [] };
    if (text.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
    if (text === LOOKUP_MAPPING_SQL) return { rows: params[0] === SUB ? [mapping] : [] };
    if (text.includes('is_platform_owner()')) return { rows: [{ is_owner: state.owner }] };
    if (text.includes('aws_checkalt_production_config')) {
      return { rows: [{ merchant: 'prod-merchant', base_url: 'https://api2.checkalt.com', default_enabled: true, depositor_account_id: null, business_unit: null }] };
    }
    if (text.includes('aws_register_checkalt_tenant_account')) {
      if (state.writerError) throw state.writerError;
      const account = JSON.parse(params[1]);
      state.saved = { tenant_id: params[0], ...account };
      state.row = {
        tenant_id: params[0],
        sso_user_id: account.sso_user_id,
        deposit_account_number: account.deposit_account_number,
        first_name: account.first_name,
        last_name: account.last_name,
        email: account.email,
        enabled: true,
        registered_at: '2026-10-15T00:00:00.000Z',
      };
      return {
        rows: [{
          result: {
            tenant_id: params[0],
            sso_user_id: account.sso_user_id,
            first_name: account.first_name,
            last_name: account.last_name,
            email: account.email,
            enabled: true,
            registered_at: '2026-10-15T00:00:00.000Z',
            account_last4: account.deposit_account_number.slice(-4),
          },
        }],
      };
    }
    if (text.includes('FROM public.checkalt_tenant_accounts')) return { rows: state.row ? [state.row] : [] };
    if (/INSERT|UPDATE|DELETE/.test(text)) state.otherWrites.push(text);
    return { rows: [] };
  },
});

const providerFetch = (state, overrides = {}) => async (url, init = {}) => {
  const href = String(url);
  state.calls.push({ url: href, body: init.body ? JSON.parse(init.body) : null });
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  if (href.endsWith('/public/fincapture/authenticate')) return reply(200, 'header.payload.sig');
  if (href.endsWith('/fincapture/useraccount/register')) {
    return overrides.register || reply(200, { success: true, accountDataList: [{ accountNumber: FULL }] });
  }
  if (href.endsWith('/fincapture/useraccount/getUserAccountInformation')) {
    return reply(200, { userId: 'acme-depositor', accountDataList: [{ accountNumber: FULL, ssoKey: 'sso-live' }] });
  }
  if (href.endsWith('/fincapture/useraccount/getDepositAccountInformation')) {
    return overrides.account || reply(200, { accountNumber: FULL, status: 'Active', memo: `acct ${FULL}` });
  }
  return reply(404, 'not found');
};

const newState = (extra = {}) => ({
  owner: true, queries: [], calls: [], otherWrites: [], row: null, saved: null, ...extra,
});

const call = (state, fn, body, { flags = productionFlags, fetchOverrides } = {}) => withEnv(flags, () => handleProviderRequest(
  jwtEvent(fn, body),
  `/functions/v1/${fn}`,
  'POST',
  {
    createClient: () => fakeClient(state),
    loadDatabaseCredentials: async () => ({ host: 'localhost', username: 'checksops', password: 'x', database: 'checksops' }),
    loadProductionSecrets: productionSecrets,
    fetchImpl: providerFetch(state, fetchOverrides),
  },
));

const registerBody = (extra = {}) => ({
  tenant_id: TENANT,
  sso_user_id: 'acme-depositor',
  first_name: 'Acme',
  last_name: 'Owner',
  email: 'ops@acme.example',
  deposit_account_number: FULL,
  ...extra,
});

const providerHosts = (state) => [...new Set(state.calls.map((c) => new URL(c.url).host))];

test('masking helpers: last four only, deep payload masking, digits-only 4-17 validation', () => {
  assert.equal(maskAccountNumber(FULL), '****6789');
  assert.equal(maskAccountNumber(null), null);
  assert.equal(accountLast4(FULL), '6789');
  assert.equal(normalizeDepositAccountNumber(' 123456789 '), FULL);
  for (const bad of ['1234-5678', '12 34 56', 'abc', '123', '1'.repeat(18), 12, null, undefined, {}]) {
    assert.equal(normalizeDepositAccountNumber(bad), null, String(bad));
  }
  const masked = maskCheckAltPayload({
    accountDataList: [{ accountNumber: FULL, ssoKey: 'k' }],
    depositAccountNumber: '5550001234',
    message: `registered ${FULL}`,
    nested: { list: [FULL] },
  }, [FULL]);
  assert.deepEqual(masked, {
    accountDataList: [{ accountNumber: '****6789', ssoKey: 'k' }],
    depositAccountNumber: '****1234',
    message: 'registered ****6789',
    nested: { list: ['****6789'] },
  });
});

test('production register: platform owner registers with live Check Alt and SQL 81 saves the production row; response is masked', async () => {
  const state = newState();
  const result = await call(state, 'checkalt-register-account', registerBody());
  assert.equal(result.statusCode, 200, JSON.stringify(result));
  assert.equal(result.success, true);
  assert.equal(result.status, 'registered');
  assert.equal(result.environment, 'production');
  assert.equal(result.account_last4, '6789');
  assert.equal(result.deposit_account_number_masked, '****6789');
  assert.equal(result.has_sso_key, true);
  assert.equal(result.productionRecordsMutated, true);
  assert.equal(JSON.stringify(result).includes(FULL), false, 'response must not carry the full number');

  // Live production host only, with the server-side FI key, never UAT.
  assert.deepEqual(providerHosts(state), ['api2.checkalt.com']);
  const register = state.calls.find((c) => c.url.endsWith('/fincapture/useraccount/register'));
  assert.equal(register.body.fiKey, 'prod-fi-key');
  assert.equal(register.body.userId, 'acme-depositor');
  assert.deepEqual(register.body.accountDataList, [{ accountNumber: FULL }]);
  assert.ok(state.calls.some((c) => c.url.endsWith('/getUserAccountInformation')));

  // Saved only through the SQL 81 writer; full number in the column, masked payload, ssoKey kept.
  assert.equal(state.saved.tenant_id, TENANT);
  assert.equal(state.saved.deposit_account_number, FULL);
  assert.equal(state.saved.last_register_payload.sso_key, 'sso-live');
  assert.equal(JSON.stringify(state.saved.last_register_payload).includes(FULL), false);
  assert.deepEqual(Object.keys(state.saved).sort(), [
    'deposit_account_number', 'email', 'first_name', 'last_name', 'last_register_payload', 'sso_user_id', 'tenant_id',
  ]);
  assert.deepEqual(state.otherWrites, []);
  assert.equal(state.queries.some((q) => /INSERT INTO public\.checkalt_tenant_accounts|UPDATE public\.checkalt_tenant_accounts/.test(q.sql)), false);
});

test('production register: non-owner is refused before any Check Alt call or write', async () => {
  const state = newState({ owner: false });
  const result = await call(state, 'checkalt-register-account', registerBody());
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'not_authorized');
  assert.equal(state.calls.length, 0);
  assert.equal(state.saved, null);
});

test('production register: invalid input and browser-chosen provider config are refused before Check Alt', async () => {
  for (const [body, error] of [
    [registerBody({ deposit_account_number: '1234-5678' }), 'invalid_deposit_account_number'],
    [registerBody({ deposit_account_number: '12a45678' }), 'invalid_deposit_account_number'],
    [registerBody({ deposit_account_number: '123' }), 'invalid_deposit_account_number'],
    [registerBody({ deposit_account_number: '1'.repeat(18) }), 'invalid_deposit_account_number'],
    [registerBody({ tenant_id: 'not-a-uuid' }), 'invalid_uuid'],
    [registerBody({ email: 'nope' }), 'invalid_field'],
    [registerBody({ sso_user_id: 'has space' }), 'invalid_field'],
    [registerBody({ first_name: '' }), 'invalid_field'],
    [registerBody({ routing_number: '021000021' }), 'untrusted_provider_config'],
    [registerBody({ fi_key: 'mine' }), 'untrusted_provider_config'],
    [registerBody({ base_url: 'https://uatapi.checkalt.com' }), 'untrusted_provider_config'],
    [registerBody({ sso_user_id: 'prod-api-login' }), 'depositor_must_not_be_api_login'],
  ]) {
    const state = newState();
    const result = await call(state, 'checkalt-register-account', body);
    assert.equal(result.statusCode, 400, JSON.stringify(body));
    assert.equal(result.error, error, JSON.stringify(body));
    assert.equal(state.calls.filter((c) => !c.url.endsWith('/authenticate')).length, 0, JSON.stringify(body));
    assert.equal(state.saved, null);
  }
  assert.equal(validateRegisterBody(registerBody()).depositAccountNumber, FULL);
});

test('production register: Check Alt refusal saves nothing and returns masked details', async () => {
  const state = newState();
  const result = await call(state, 'checkalt-register-account', registerBody(), {
    fetchOverrides: {
      register: { ok: false, status: 400, text: async () => JSON.stringify({ message: `account ${FULL} rejected`, accountNumber: FULL }) },
    },
  });
  assert.equal(result.statusCode, 502);
  assert.equal(result.error, 'checkalt_registration_failed');
  assert.equal(state.saved, null);
  assert.equal(JSON.stringify(result).includes(FULL), false);
  assert.equal(result.details.accountNumber, '****6789');
});

test('production register: SQL 81 not applied or writer refusal is reported, never a silent success', async () => {
  for (const [code, status, error] of [['42883', 503, 'register_writer_missing'], ['42501', 403, 'not_authorized'], ['P0002', 404, 'tenant_not_found']]) {
    const state = newState({ writerError: Object.assign(new Error('x'), { code }) });
    const result = await call(state, 'checkalt-register-account', registerBody());
    assert.equal(result.statusCode, status, code);
    assert.equal(result.error, error, code);
    assert.equal(result.registeredWithCheckAlt, true);
    assert.equal(result.productionRecordsMutated, false);
  }
});

test('production verify: status reads the production row masked; user/account show the live answer masked and persist nothing', async () => {
  const state = newState();
  let result = await call(state, 'checkalt-verify-account', { tenant_id: TENANT, action: 'status' });
  assert.equal(result.statusCode, 200, JSON.stringify(result));
  assert.equal(result.status, 'not_registered');
  assert.equal(result.liveProviderCalled, false);
  assert.equal(state.calls.length, 0);

  result = await call(state, 'checkalt-verify-account', { tenant_id: TENANT, action: 'user' });
  assert.equal(result.statusCode, 409);
  assert.equal(result.error, 'account_unregistered');
  assert.equal(state.calls.length, 0);

  state.row = {
    tenant_id: TENANT, sso_user_id: 'acme-depositor', deposit_account_number: FULL, first_name: 'Acme', last_name: 'Owner',
    email: 'ops@acme.example', enabled: true, registered_at: '2025-01-01T00:00:00.000Z',
  };
  result = await call(state, 'checkalt-verify-account', { tenant_id: TENANT, action: 'status' });
  assert.equal(result.status, 'registered');
  assert.equal(result.account_last4, '6789');
  assert.equal(result.sso_user_id, 'acme-depositor');
  assert.equal(JSON.stringify(result).includes(FULL), false);

  for (const action of ['user', 'account']) {
    state.calls = [];
    const writesBefore = state.queries.filter((q) => /aws_register_checkalt_tenant_account|INSERT|UPDATE/.test(q.sql)).length;
    result = await call(state, 'checkalt-verify-account', { tenant_id: TENANT, action });
    assert.equal(result.statusCode, 200, JSON.stringify(result));
    assert.equal(result.success, true, action);
    assert.equal(result.liveProviderCalled, true);
    assert.equal(result.productionRecordsMutated, false);
    assert.equal(JSON.stringify(result).includes(FULL), false, action);
    assert.deepEqual(providerHosts(state), ['api2.checkalt.com']);
    const lookup = state.calls.find((c) => c.url.includes(action === 'user' ? 'getUserAccountInformation' : 'getDepositAccountInformation'));
    assert.equal(lookup.body.userId, 'acme-depositor');
    if (action === 'account') {
      assert.equal(lookup.body.accountNumber, FULL, 'server sends the stored number to Check Alt');
      assert.equal(result.data.accountNumber, '****6789');
      assert.equal(result.data.memo, 'acct ****6789');
    }
    assert.equal(state.queries.filter((q) => /aws_register_checkalt_tenant_account|INSERT|UPDATE/.test(q.sql)).length, writesBefore);
  }

  // A failed live lookup is shown as a failure (still masked).
  state.calls = [];
  result = await call(state, 'checkalt-verify-account', { tenant_id: TENANT, action: 'account' }, {
    fetchOverrides: { account: { ok: false, status: 404, text: async () => JSON.stringify({ message: `no account ${FULL}` }) } },
  });
  assert.equal(result.success, false);
  assert.equal(result.error, 'checkalt_lookup_failed');
  assert.equal(JSON.stringify(result).includes(FULL), false);

  const denied = newState({ owner: false, row: state.row });
  result = await call(denied, 'checkalt-verify-account', { tenant_id: TENANT, action: 'status' });
  assert.equal(result.statusCode, 403);
  assert.equal(denied.calls.length, 0);
});

test('production register/verify stay behind the production holds: flags off never reaches the production handler', async () => {
  for (const fn of ['checkalt-register-account', 'checkalt-verify-account']) {
    const state = newState();
    const result = await call(state, fn, registerBody({ action: 'status' }), {
      flags: { ...productionFlags, AWS_PROVIDER_EXECUTION_ENABLED: 'false', AWS_CHECKALT_ENABLED: 'false', AWS_FINANCIAL_PERMISSIONS_ACTIVATED: 'false' },
    });
    assert.notEqual(result.statusCode, 200, fn);
    assert.equal(state.calls.length, 0, fn);
    assert.equal(state.saved, null, fn);
    assert.equal(state.queries.some((q) => q.sql.includes('aws_register_checkalt_tenant_account')), false, fn);
  }
  // Production + sandbox parity together is refused as ambiguous.
  const state = newState();
  const result = await call(state, 'checkalt-register-account', registerBody(), {
    flags: { ...productionFlags, AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED: 'true' },
  });
  assert.equal(result.error, 'ambiguous_execution_mode');
  assert.equal(state.calls.length, 0);
});

test('submit keeps today\'s rule: it is not changed by this feature', () => {
  const submit = fs.readFileSync(path.join(ROOT, 'aws/functions/api/providers/production/checkalt-submit.mjs'), 'utf8');
  assert.match(submit, /!acct\?\.sso_user_id \|\| !acct\?\.deposit_account_number \|\| acct\.enabled === false/);
  assert.equal(/verified_at|account_unverified/.test(submit), false);
});

test('SQL 81 is a platform-owner-only SECURITY DEFINER writer with digits-only validation and no table grant', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/81_checkalt_production_register.sql'), 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.aws_register_checkalt_tenant_account\(\s*_tenant_id uuid,\s*_account jsonb\s*\)/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /IF NOT public\.is_platform_owner\(\) THEN/);
  assert.match(sql, /'\^\[0-9\]\{4,17\}\$'/);
  assert.match(sql, /unmasked_account_number/);
  assert.equal(/auto_approve_(enabled|max_cents)\s*=/.test(sql), false);
  assert.equal(/GRANT (INSERT|UPDATE|ALL) ON TABLE/i.test(sql), false);
  assert.equal(/ADD COLUMN|verified_at/i.test(sql), false);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.aws_register_checkalt_tenant_account\(uuid, jsonb\) FROM PUBLIC/);
});

test('SPA: tenant card reads masked status from the server, never the table, and validates digits-only', () => {
  const card = fs.readFileSync(path.join(ROOT, 'src/components/settings/CheckAltTenantAccountCard.tsx'), 'utf8');
  assert.match(card, /isPlatformOwner\(user\?\.email\)/);
  assert.match(card, /action: "status"/);
  assert.match(card, /checkalt-register-account/);
  assert.match(card, /verifyMutation\.mutate\("user"\)/);
  assert.match(card, /verifyMutation\.mutate\("account"\)/);
  assert.match(card, /Not registered/);
  assert.match(card, /Registered/);
  assert.match(card, /\/\^\\d\{4,17\}\$\//);
  assert.equal(/from\("checkalt_tenant_accounts"\)/.test(card), false);
  assert.equal(/last_register_payload/.test(card), false);
  assert.equal(/id="[^"]*routing|routing_number/i.test(card), false, 'no routing number field');
  assert.equal(/deposit_account_number: status/.test(card), false, 'the stored number is never prefilled');
  const settings = fs.readFileSync(path.join(ROOT, 'src/components/settings/CheckAltSettings.tsx'), 'utf8');
  assert.equal(/depositor_account_id/.test(settings), false);
  assert.equal(/where deposits are credited/.test(settings), false);
});
