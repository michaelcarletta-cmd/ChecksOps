import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLASS_A_FUNCTIONS, handleAppServiceRequest } from '../functions/api/app-services.mjs';
import {
  MFA_RESET_PREFERENCE,
  RESET_TOTP_CONSUME_SQL,
  RESET_TOTP_STEPUP_LOCK_SQL,
  RESET_TOTP_STEPUP_SQL,
  TEAM_RESET_TOTP_CONSUMED_ACTION,
  RESET_TOTP_TARGET_IS_PLATFORM_OWNER_SQL,
  RESET_TOTP_TEAMMATE_SQL,
  TEAM_RESET_TOTP_ACTION,
  TEAM_RESET_TOTP_STEPUP_MAX_AGE_MINUTES,
  runAdminResetTotp,
  softwareTokenEnrolled,
} from '../functions/api/admin-reset-totp.mjs';
import { resolveFinancialStepUpBinding } from '../functions/api/auth-financial-totp.mjs';
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
const COGNITO_SUB = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CLAIMS = { sub: COGNITO_SUB, origin_jti: 'login-1' };
const LOGIN = `${COGNITO_SUB}:jti:login-1`;
/** The caller's own team.reset_totp step-up for this login, for TENANT. */
const STEPPED_UP = [{ user_id: CALLER, tenant_id: TENANT, action_key: 'team.reset_totp', login_session: LOGIN }];

/**
 * tenant_users rows; the fake evaluates the shared-tenant join of
 * RESET_TOTP_TEAMMATE_SQL (owner policy: any member, the role is not read). user_roles and is_master_owner are answered too,
 * so a test can prove they are not consulted.
 */
const teamClient = ({
  memberships = [], userRoles = [], master = false, account = null, stepUps = STEPPED_UP, targetIsOwner = false,
  consumed = [], locks = [],
} = {}) => sqlClient([
  {
    match: (sql) => sql === RESET_TOTP_STEPUP_LOCK_SQL.replace(/\s+/g, ' '),
    result: ([caller]) => { locks.push(caller); return { rows: [{}] }; },
  },
  {
    // RESET_TOTP_CONSUME_SQL: single use, an append-only consumption row.
    match: (sql) => sql === RESET_TOTP_CONSUME_SQL.replace(/\s+/g, ' '),
    result: ([caller, tenantId, action, metadata]) => {
      assert.equal(action, TEAM_RESET_TOTP_CONSUMED_ACTION);
      const parsed = JSON.parse(metadata);
      assert.notEqual(parsed.source, 'app_financial_totp');
      consumed.push({ caller, tenantId, ...parsed });
      return { rows: [], rowCount: 1 };
    },
  },
  {
    // RESET_TOTP_STEPUP_SQL: the caller's own unused step-up, this login, a tenant shared with the target.
    match: (sql) => sql.includes('financial_stepup_log'),
    result: ([caller, target, action, login, minutes, consumedAction]) => {
      assert.equal(minutes, TEAM_RESET_TOTP_STEPUP_MAX_AGE_MINUTES);
      assert.equal(consumedAction, TEAM_RESET_TOTP_CONSUMED_ACTION);
      assert.equal(locks.at(-1), caller);
      const shared = (tenantId) => memberships.some((m) => m.user_id === caller && m.tenant_id === tenantId)
        && memberships.some((m) => m.user_id === target && m.tenant_id === tenantId);
      const row = stepUps.find((s, i) => s.user_id === caller && s.action_key === action
        && s.login_session === login && shared(s.tenant_id)
        && !consumed.some((c) => c.caller === caller && c.stepup_id === (s.id || `stepup-${i}`)));
      return { rows: row ? [{ id: row.id || `stepup-${stepUps.indexOf(row)}`, tenant_id: row.tenant_id }] : [] };
    },
  },
  {
    match: (sql) => sql.includes('lower(ia.email) = $2'),
    result: ([, email]) => {
      assert.equal(email, 'checksopsadmin@gmail.com');
      return { rows: targetIsOwner ? [{ '?column?': 1 }] : [] };
    },
  },
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
      assert.doesNotMatch(RESET_TOTP_TEAMMATE_SQL, /role/);
      const shared = memberships.some((mine) => mine.user_id === caller
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
  claims: CLAIMS,
  body: { user_id: USER_ID },
  spoof: { ignored: true },
  client,
  ...extra,
});

for (const role of ['owner', 'admin', 'manager', 'operator', 'viewer']) {
  test(`a member (stored role ${role}) may reset 2FA for a teammate of the same tenant`, async () => {
    const result = await reset(teamClient({
      memberships: [
        { user_id: CALLER, tenant_id: TENANT, role },
        { user_id: USER_ID, tenant_id: TENANT, role: 'operator' },
      ],
    }));
    assert.equal(result.ok, true, role);
    assert.equal(result.removed_count, 0);
    assert.equal(result.importedUser, false);
    assert.equal(result.poolMfaChanged, false);
  });
}

test('a member of another tenant, platform admin/staff and the master owner without a shared tenant are forbidden', async () => {
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

const TEAM = [
  { user_id: CALLER, tenant_id: TENANT, role: 'viewer' },
  { user_id: USER_ID, tenant_id: TENANT, role: 'operator' },
];

test('a member may not reset their own 2FA here', async () => {
  const calls = [];
  const result = await runAdminResetTotp({
    mapping: { application_user_id: CALLER },
    claims: CLAIMS,
    body: { user_id: CALLER },
    spoof: {},
    client: teamClient({ memberships: [{ user_id: CALLER, tenant_id: TENANT, role: 'owner' }] }),
    cognitoClient: { send: async (command) => { calls.push(command.constructor.name); return {}; } },
  });
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'cannot_reset_own_totp');
  assert.deepEqual(calls, []);
});

test('nobody may reset the platform owner\'s 2FA, even from a shared tenant', async () => {
  assert.match(RESET_TOTP_TARGET_IS_PLATFORM_OWNER_SQL, /identity_accounts/);
  assert.match(RESET_TOTP_TARGET_IS_PLATFORM_OWNER_SQL, /profiles/);
  const calls = [];
  const result = await reset(teamClient({ memberships: TEAM, targetIsOwner: true }), {
    cognitoClient: { send: async (command) => { calls.push(command.constructor.name); return {}; } },
  });
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'platform_owner_protected');
  assert.deepEqual(calls, []);
});

test('a teammate reset needs the caller\'s own recent step-up for this login and a shared tenant', async () => {
  assert.equal(TEAM_RESET_TOTP_ACTION, 'team.reset_totp');
  assert.match(RESET_TOTP_STEPUP_SQL, /s\.user_id = \$1::uuid/);
  assert.match(RESET_TOTP_STEPUP_SQL, /login_session'\) = \$4/);
  assert.match(RESET_TOTP_STEPUP_SQL, /created_at > now\(\) - make_interval\(mins => \$5::int\)/);
  assert.match(RESET_TOTP_STEPUP_SQL, /factor_type = 'totp'/);
  const refusals = [
    ['no step-up', { stepUps: [] }, CLAIMS],
    ['another login', {}, { sub: COGNITO_SUB, origin_jti: 'login-2' }],
    ['no login binding', {}, {}],
    ['wallet.fund step-up', { stepUps: [{ ...STEPPED_UP[0], action_key: 'wallet.fund' }] }, CLAIMS],
    ['step-up for a tenant the target is not in', { stepUps: [{ ...STEPPED_UP[0], tenant_id: OTHER_TENANT }] }, CLAIMS],
    ['someone else\'s step-up', { stepUps: [{ ...STEPPED_UP[0], user_id: USER_ID }] }, CLAIMS],
  ];
  for (const [label, opts, claims] of refusals) {
    const calls = [];
    const memberships = [...TEAM, { user_id: CALLER, tenant_id: OTHER_TENANT, role: 'viewer' }];
    const result = await reset(teamClient({ memberships, ...opts }), {
      claims,
      cognitoClient: { send: async (command) => { calls.push(command.constructor.name); return {}; } },
    });
    assert.equal(result.statusCode, 401, label);
    assert.equal(result.error, 'totp_required', label);
    assert.equal(result.actionKey, 'team.reset_totp', label);
    assert.deepEqual(calls, [], label);
  }
  const ok = await reset(teamClient({
    memberships: TEAM,
    account: { email: 'ada@example.com', cognito_sub: 'sub', application_user_id: USER_ID },
  }), {
    poolId: 'us-east-1_test',
    cognitoClient: {
      send: async (command) => (command.constructor.name === 'AdminGetUserCommand'
        ? { Username: 'ada@example.com', UserMFASettingList: [] }
        : {}),
    },
  });
  assert.equal(ok.ok, true);
});

test('step-up endpoint binds team.reset_totp to the caller\'s tenant and this login', async () => {
  const client = {
    query: async (sql, params = []) => {
      if (/tenant_users/.test(sql)) {
        return { rows: params[0] === CALLER ? [{ tenant_id: TENANT, role: 'viewer' }] : [] };
      }
      return { rows: [] };
    },
  };
  const bound = await resolveFinancialStepUpBinding({
    client, mapping: { application_user_id: CALLER }, claims: CLAIMS, body: { action_key: 'team.reset_totp', tenant_id: TENANT }, spoof: {},
  });
  assert.equal(bound.ok, true);
  assert.equal(bound.kind, 'login_session');
  assert.equal(bound.actionKey, 'team.reset_totp');
  assert.equal(bound.tenantId, TENANT);
  assert.equal(bound.loginSession, LOGIN);
  const foreign = await resolveFinancialStepUpBinding({
    client, mapping: { application_user_id: CALLER }, claims: CLAIMS, body: { action_key: 'team.reset_totp', tenant_id: OTHER_TENANT }, spoof: {},
  });
  assert.equal(foreign.statusCode, 403);
  const unbound = await resolveFinancialStepUpBinding({
    client, mapping: { application_user_id: CALLER }, claims: { sub: COGNITO_SUB }, body: { action_key: 'team.reset_totp', tenant_id: TENANT }, spoof: {},
  });
  assert.equal(unbound.error, 'login_session_unbound');
});

test('a team.reset_totp step-up is single use: one code, one reset', async () => {
  assert.match(RESET_TOTP_STEPUP_SQL, /NOT EXISTS \(\s*SELECT 1\s*FROM public\.financial_stepup_log used/);
  assert.match(RESET_TOTP_STEPUP_LOCK_SQL, /pg_advisory_xact_lock\(hashtextextended\('team-reset-totp:' \|\| \$1::uuid::text, 0\)\)/);
  const SECOND = '99999999-9999-4999-8999-999999999999';
  const consumed = [];
  const client = teamClient({
    memberships: [...TEAM, { user_id: SECOND, tenant_id: TENANT, role: 'viewer' }],
    consumed,
  });
  const cognitoClient = { send: async (command) => (command.constructor.name === 'AdminGetUserCommand' ? { Username: 'u' } : {}) };
  const first = await reset(client, { cognitoClient, poolId: 'p' });
  assert.equal(first.ok, true);
  assert.equal(consumed.length, 1);
  assert.equal(consumed[0].target_user_id, USER_ID);
  assert.equal(consumed[0].tenantId, TENANT);
  // The same step-up does not authorize another reset, of the same or another teammate.
  for (const target of [USER_ID, SECOND]) {
    const again = await runAdminResetTotp({
      mapping: { application_user_id: CALLER }, claims: CLAIMS, body: { user_id: target }, spoof: {}, client, cognitoClient, poolId: 'p',
    });
    assert.equal(again.statusCode, 401, target);
    assert.equal(again.error, 'totp_required');
  }
  assert.equal(consumed.length, 1);
});
