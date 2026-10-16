import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLASS_A_FUNCTIONS, handleAppServiceRequest } from '../functions/api/app-services.mjs';
import {
  MFA_RESET_PREFERENCE,
  RESET_TOTP_TEAM_MANAGER_SQL,
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

const CALLER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TENANT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_TENANT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/**
 * tenant_users rows; the fake evaluates the shared-tenant owner/admin join of
 * RESET_TOTP_TEAM_MANAGER_SQL. user_roles and is_master_owner are answered too,
 * so a test can prove they are not consulted.
 */
const teamClient = ({ memberships = [], userRoles = [], master = false, account = null } = {}) => sqlClient([
  {
    match: (sql) => sql.includes('user_roles'),
    result: () => ({ rows: userRoles.map((role) => ({ role })) }),
  },
  {
    match: (sql) => sql.includes('is_master_owner'),
    result: () => ({ rows: [{ is_master: master }] }),
  },
  {
    match: (sql) => sql.includes('JOIN public.tenant_users theirs'),
    result: ([caller, target]) => {
      assert.match(RESET_TOTP_TEAM_MANAGER_SQL, /lower\(mine\.role::text\) IN \('owner', 'admin'\)/);
      const shared = memberships.some((mine) => mine.user_id === caller
        && ['owner', 'admin'].includes(String(mine.role).toLowerCase())
        && memberships.some((theirs) => theirs.user_id === target && theirs.tenant_id === mine.tenant_id));
      return { rows: shared ? [{ '?column?': 1 }] : [] };
    },
  },
  {
    match: (sql) => sql.includes('identity_accounts'),
    result: () => ({ rows: account ? [account] : [] }),
  },
]);

const reset = (client, extra = {}) => runAdminResetTotp({
  mapping: { application_user_id: CALLER },
  body: { user_id: USER_ID },
  spoof: { ignored: true },
  client,
  ...extra,
});

for (const role of ['owner', 'admin']) {
  test(`tenant ${role} may reset 2FA for a teammate of the same tenant`, async () => {
    const result = await reset(teamClient({
      memberships: [
        { user_id: CALLER, tenant_id: TENANT, role },
        { user_id: USER_ID, tenant_id: TENANT, role: 'operator' },
      ],
    }));
    assert.equal(result.ok, true);
    assert.equal(result.removed_count, 0);
    assert.equal(result.importedUser, false);
    assert.equal(result.poolMfaChanged, false);
  });
}

for (const role of ['manager', 'operator', 'viewer']) {
  test(`tenant ${role} cannot reset a teammate's 2FA`, async () => {
    const result = await reset(teamClient({
      memberships: [
        { user_id: CALLER, tenant_id: TENANT, role },
        { user_id: USER_ID, tenant_id: TENANT, role: 'operator' },
      ],
    }));
    assert.equal(result.statusCode, 403);
  });
}

test('owner of another tenant, platform admin/staff and the master owner without a shared owner/admin tenant are forbidden', async () => {
  const otherTenant = await reset(teamClient({
    memberships: [
      { user_id: CALLER, tenant_id: OTHER_TENANT, role: 'owner' },
      { user_id: USER_ID, tenant_id: TENANT, role: 'operator' },
    ],
  }));
  assert.equal(otherTenant.statusCode, 403);
  for (const userRoles of [['admin'], ['staff']]) {
    const platform = await reset(teamClient({
      userRoles,
      memberships: [{ user_id: USER_ID, tenant_id: TENANT, role: 'operator' }],
    }));
    assert.equal(platform.statusCode, 403);
  }
  const master = await reset(teamClient({
    master: true,
    userRoles: ['admin'],
    memberships: [{ user_id: USER_ID, tenant_id: TENANT, role: 'operator' }],
  }));
  assert.equal(master.statusCode, 403);
});

test('Cognito software token is disabled and never enabled', async () => {
  const calls = [];
  const result = await reset(teamClient({
    memberships: [
      { user_id: CALLER, tenant_id: TENANT, role: 'admin' },
      { user_id: USER_ID, tenant_id: TENANT, role: 'viewer' },
    ],
    account: { email: 'ada@example.com', cognito_sub: 'sub', application_user_id: USER_ID },
  }), {
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
  });
  assert.equal(result.ok, true);
  assert.equal(result.removed_count, 1);
  assert.equal(result.preferredMfaEnabled, false);
  assert.equal(result.importedUser, false);
  assert.ok(calls.includes('AdminSetUserMFAPreferenceCommand'));
  assert.ok(calls.includes('AdminUserGlobalSignOutCommand'));
});
