import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLASS_A_FUNCTIONS, handleAppServiceRequest } from '../functions/api/app-services.mjs';
import {
  MFA_RESET_PREFERENCE,
  runAdminResetTotp,
  softwareTokenEnrolled,
} from '../functions/api/admin-reset-totp.mjs';
import { handleMfaSetPreference } from '../functions/api/auth-mfa.mjs';

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const sqlClient = (handlers) => ({
  query: async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    for (const handler of handlers) {
      if (handler.match(compact, params)) return handler.result(params, compact);
    }
    return { rows: [], rowCount: 0 };
  },
});

test('admin-reset-totp is Class A and Cognito reset stays disable-only', async () => {
  assert.ok(CLASS_A_FUNCTIONS.has('admin-reset-totp'));
  assert.equal(MFA_RESET_PREFERENCE.SoftwareTokenMfaSettings.Enabled, false);
  assert.equal(MFA_RESET_PREFERENCE.SoftwareTokenMfaSettings.PreferredMfa, false);
  assert.equal(MFA_RESET_PREFERENCE.SMSMfaSettings.Enabled, false);
  const auth = await handleAppServiceRequest({
    body: '{}',
    requestContext: { http: { method: 'POST', path: '/functions/v1/admin-reset-totp' } },
  }, '/functions/v1/admin-reset-totp', 'POST');
  assert.equal(auth.statusCode, 401);
  assert.notEqual(auth.error, 'provider_disabled');
});

test('preferred MFA enable path stays refused', async () => {
  const result = await handleMfaSetPreference();
  assert.equal(result.statusCode, 403);
  assert.equal(softwareTokenEnrolled({ UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] }), true);
});

test('non-admin is forbidden and missing cognito user is fail-closed without import', async () => {
  const forbidden = await runAdminResetTotp({
    mapping: { application_user_id: USER_ID },
    body: { user_id: USER_ID },
    spoof: { ignored: true },
    client: sqlClient([{
      match: (sql) => sql.includes('user_roles'),
      result: () => ({ rows: [{ role: 'staff' }] }),
    }]),
  });
  assert.equal(forbidden.statusCode, 403);

  const missing = await runAdminResetTotp({
    mapping: { application_user_id: USER_ID },
    body: { user_id: USER_ID },
    spoof: { ignored: true },
    client: sqlClient([
      {
        match: (sql) => sql.includes('user_roles'),
        result: () => ({ rows: [{ role: 'admin' }] }),
      },
      {
        match: (sql) => sql.includes('identity_accounts'),
        result: () => ({ rows: [] }),
      },
    ]),
  });
  assert.equal(missing.ok, true);
  assert.equal(missing.removed_count, 0);
  assert.equal(missing.importedUser, false);
  assert.equal(missing.poolMfaChanged, false);
});

test('Cognito software token is disabled and never enabled', async () => {
  const calls = [];
  const result = await runAdminResetTotp({
    mapping: { application_user_id: USER_ID },
    body: { user_id: USER_ID },
    spoof: { ignored: true },
    poolId: 'us-east-1_test',
    cognitoClient: {
      send: async (command) => {
        calls.push(command.constructor.name);
        if (command.constructor.name === 'AdminGetUserCommand') {
          return { Username: 'ada@example.com', UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] };
        }
        return {};
      },
    },
    client: sqlClient([
      {
        match: (sql) => sql.includes('user_roles'),
        result: () => ({ rows: [{ role: 'admin' }] }),
      },
      {
        match: (sql) => sql.includes('identity_accounts'),
        result: () => ({ rows: [{ email: 'ada@example.com', cognito_sub: 'sub', application_user_id: USER_ID }] }),
      },
    ]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.removed_count, 1);
  assert.equal(result.preferredMfaEnabled, false);
  assert.equal(result.importedUser, false);
  assert.ok(calls.includes('AdminSetUserMFAPreferenceCommand'));
  assert.ok(calls.includes('AdminUserGlobalSignOutCommand'));
});
