/**
 * Owner policy (users only, no tenant role tiers) for the workflow RPCs, tenant
 * team management and the platform treasury bank:
 * - every member of a tenant (any tenant_users row, whatever role value is
 *   stored, 'viewer' included) is a user with the same rights;
 * - partners (members of another tenant), other tenants and platform
 *   admin/staff without that membership are refused;
 * - platform-owner-only actions (disabling a login, the platform treasury
 *   bank) refuse members; the platform owner keeps tenant onboarding;
 * - mortgage agents keep cross-tenant access to mortgage handling requests.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { executeSafeWriteRpc, TENANT_MEMBER_SQL } from '../functions/api/workflow-rpc.mjs';
import {
  IDENTITY_BY_SUB_SQL,
  PLATFORM_OWNER_EMAIL,
  runDeleteUser,
  runHireMortgageAgent,
  runTenantInviteUser,
  TENANT_MEMBER_COUNT_SQL,
  USER_IS_PLATFORM_OWNER_SQL,
} from '../functions/api/tenant-admin.mjs';
import { platformBank } from '../functions/api/providers/parity/moov-onboard.mjs';

const USER = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const TEAMMATE = '11111111-1111-4111-8111-111111111111';
const TENANT = '2eff5f1a-929d-4ce3-9a8b-cd96b98df42a';
const PARTNER_TENANT = '4f172140-f57a-4744-8050-95f4f07b13b4';
const CHECK_ID = '8d2b1c3e-4f5a-4678-9abc-def012345678';
const DRAFT_ID = '9e3c2d4f-5a6b-4789-abcd-ef0123456789';
const REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLAIM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const mapping = { application_user_id: USER };
const ANY_ROLE = ['owner', 'admin', 'manager', 'operator', 'viewer', 'member'];

const memberRows = (memberships, params) => {
  const [userId, tenantId] = params;
  const ok = userId === USER && memberships.some((m) => m.tenant_id === tenantId);
  return { rows: ok ? [{ '?column?': 1 }] : [] };
};

/** Fake for workflow-rpc: user_roles, the membership query and the rows each RPC reads. */
const rpcClient = ({ memberships = [], userRoles = [], handlers = [] } = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql === USER_ROLES_SQL) return { rows: userRoles.map((role) => ({ role })) };
      if (sql === TENANT_MEMBER_SQL) return memberRows(memberships, params);
      for (const [pattern, result] of handlers) {
        if (pattern.test(sql)) return typeof result === 'function' ? result(sql, params) : result;
      }
      return { rows: [] };
    },
  };
};

test('TENANT_MEMBER_SQL is a plain membership check for one tenant; the role is not read', () => {
  assert.match(TENANT_MEMBER_SQL, /user_id = \$1::uuid AND tenant_id = \$2::uuid/);
  assert.doesNotMatch(TENANT_MEMBER_SQL, /role/);
});

// --- Loss draft admin reset ---------------------------------------------------

const lossDraftReset = (opts) => {
  const client = rpcClient({
    ...opts,
    handlers: [
      [/SELECT \* FROM public\.loss_draft_tracking WHERE id = \$1::uuid FOR UPDATE/, { rows: [{ id: DRAFT_ID, check_intake_item_id: CHECK_ID, escrow_status: 'pending_send', monitoring_type: 'monitored' }] }],
      [/COALESCE\(ci\.tenant_id, c\.org_id\) AS tenant_id/, { rows: [{ tenant_id: TENANT }] }],
      [/SELECT escrow_status, monitoring_type FROM public\.loss_draft_tracking/, { rows: [{ escrow_status: 'sent_to_lender', monitoring_type: 'monitored' }] }],
    ],
  });
  return executeSafeWriteRpc({
    client,
    mapping,
    name: 'loss_draft_action',
    args: { p_loss_draft_id: DRAFT_ID, p_action: 'admin_reset_status', p_extra: { target_status: 'sent_to_lender' } },
  }).then((result) => ({ result, client }));
};

for (const role of ANY_ROLE) {
  test(`loss draft reset: a member of the draft's tenant (stored role ${role}) may reset it`, async () => {
    const { result, client } = await lossDraftReset({ memberships: [{ tenant_id: TENANT, role }] });
    assert.equal(result.error, undefined, role);
    assert.ok(client.queries.some((q) => /UPDATE public\.loss_draft_tracking\s+SET escrow_status = \$2::text/.test(q.sql)));
  });
}

for (const [label, opts] of [
  ['partner (owner of another tenant)', { memberships: [{ tenant_id: PARTNER_TENANT, role: 'owner' }] }],
  ['platform admin without membership', { userRoles: ['admin'] }],
  ['platform staff without membership', { userRoles: ['staff'] }],
]) {
  test(`loss draft reset: ${label} is refused`, async () => {
    const { result, client } = await lossDraftReset(opts);
    assert.equal(result.error, 'not_authorized', label);
    assert.equal(client.queries.some((q) => /UPDATE public\.loss_draft_tracking|DELETE FROM public\.loss_draft/.test(q.sql)), false);
  });
}

// --- admin_set_check_claim ------------------------------------------------------

const setCheckClaim = (opts) => {
  const client = rpcClient({
    ...opts,
    handlers: [
      [/FROM public\.check_intake_items\s+WHERE id = \$1::uuid/, { rows: [{ id: CHECK_ID, tenant_id: TENANT, claim_id: null, deposited_at: null }] }],
      [/FROM public\.claims/, { rows: [{ id: CLAIM_ID, tenant_id: TENANT }] }],
      [/public\.admin_set_check_claim/, { rows: [{ result: { ok: true, check_id: CHECK_ID, claim_id: CLAIM_ID } }] }],
    ],
  });
  return executeSafeWriteRpc({
    client, mapping, name: 'admin_set_check_claim', args: { p_check_id: CHECK_ID, p_claim_id: CLAIM_ID },
  }).then((result) => ({ result, client }));
};

test('admin_set_check_claim: any member of the check tenant links a claim; partner and platform admin are refused', async () => {
  for (const role of ['operator', 'viewer']) {
    const ok = await setCheckClaim({ memberships: [{ tenant_id: TENANT, role }] });
    assert.equal(ok.result.data.ok, true, role);
  }
  for (const opts of [
    { memberships: [{ tenant_id: PARTNER_TENANT, role: 'admin' }] },
    { userRoles: ['admin'] },
  ]) {
    const refused = await setCheckClaim(opts);
    assert.equal(refused.result.error, 'not_authorized', JSON.stringify(opts));
    assert.equal(refused.client.queries.some((q) => /public\.admin_set_check_claim/.test(q.sql)), false);
  }
});

// --- Mortgage handling requests ---------------------------------------------------

test('mortgage agents keep cross-tenant access to accept handling requests; platform admin and tenant members do not', async () => {
  const accept = (opts) => {
    const client = rpcClient({
      ...opts,
      handlers: [[/UPDATE public\.mortgage_handling_requests/, (sql, params) => ({ rows: [{ id: params[0], tenant_id: PARTNER_TENANT, assigned_employee_id: params[1] }] })]],
    });
    return executeSafeWriteRpc({ client, mapping, name: 'accept_mortgage_handling_request', args: { _request_id: REQUEST_ID } })
      .then((result) => ({ result, client }));
  };
  // A mortgage agent with no membership of the request's tenant may accept it.
  const agent = await accept({ userRoles: ['mortgage_agent'] });
  assert.equal(agent.result.data.id, REQUEST_ID);
  const update = agent.client.queries.find((q) => /UPDATE public\.mortgage_handling_requests/.test(q.sql));
  assert.doesNotMatch(update.sql, /tenant_users/);
  for (const opts of [
    { userRoles: ['admin'] },
    { userRoles: ['staff'] },
    { memberships: [{ tenant_id: PARTNER_TENANT, role: 'owner' }] },
  ]) {
    const refused = await accept(opts);
    assert.equal(refused.result.error, 'not_authorized', JSON.stringify(opts));
    assert.equal(refused.client.queries.some((q) => /UPDATE public\.mortgage_handling_requests/.test(q.sql)), false);
  }
});

test('mortgage request status: only the assigned mortgage agent; no platform admin override', async () => {
  const client = rpcClient({
    userRoles: ['mortgage_agent'],
    handlers: [[/UPDATE public\.mortgage_handling_requests/, (sql, params) => ({ rows: [{ id: params[0], status: params[1] }] })]],
  });
  const ok = await executeSafeWriteRpc({
    client, mapping, name: 'update_mortgage_handling_request_status', args: { _request_id: REQUEST_ID, _status: 'completed' },
  });
  assert.equal(ok.data.status, 'completed');
  const update = client.queries.find((q) => /UPDATE public\.mortgage_handling_requests/.test(q.sql));
  assert.match(update.sql, /AND assigned_employee_id = \$4::uuid\n/);
  assert.equal(update.params.length, 4);

  const admin = rpcClient({ userRoles: ['admin'] });
  const refused = await executeSafeWriteRpc({
    client: admin, mapping, name: 'update_mortgage_handling_request_status', args: { _request_id: REQUEST_ID, _status: 'completed' },
  });
  assert.equal(refused.error, 'not_authorized');
});

// --- Tenant team management -----------------------------------------------------

const teamClient = ({
  memberships = [], platformOwner = false, failMembershipInsert = false, failProfileInsert = false,
  tenantMemberCount = 0, linkedUserId = null, ownerUserIds = [], identityEmail = null,
} = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql === TENANT_MEMBER_COUNT_SQL) return { rows: [{ member_count: tenantMemberCount }] };
      if (sql === IDENTITY_BY_SUB_SQL) return { rows: linkedUserId ? [{ application_user_id: linkedUserId }] : [] };
      if (sql === USER_IS_PLATFORM_OWNER_SQL) {
        assert.equal(params[1], PLATFORM_OWNER_EMAIL);
        return { rows: ownerUserIds.includes(params[0]) ? [{ '?column?': 1 }] : [] };
      }
      if (/SELECT email FROM public\.identity_accounts WHERE application_user_id/.test(sql)) {
        return { rows: identityEmail ? [{ email: identityEmail }] : [] };
      }
      if (/INSERT INTO public\.profiles/.test(sql) && failProfileInsert) {
        throw Object.assign(new Error('new row violates row-level security policy for table "profiles"'), { code: '42501' });
      }
      if (/is_platform_owner\(\)/.test(sql)) return { rows: [{ is_owner: platformOwner, is_master: platformOwner }] };
      if (/FROM public\.user_roles/.test(sql)) return { rows: [{ role: 'admin' }] };
      if (/SELECT 1 FROM public\.tenant_users/.test(sql)) {
        assert.doesNotMatch(sql, /role/);
        const [tenantId, userId] = params;
        const ok = userId === USER && memberships.some((m) => m.tenant_id === tenantId);
        return { rows: ok ? [{ '?column?': 1 }] : [] };
      }
      if (/FROM public\.tenants/.test(sql)) return { rows: [{ id: TENANT, name: 'Acme', custom_domain: null }] };
      if (/INSERT INTO public\.tenant_users/.test(sql)) {
        // No role is chosen or stored by the invite: the column default applies.
        assert.doesNotMatch(sql, /\brole\b/);
        if (failMembershipInsert) {
          const error = new Error('null value in column "role" violates not-null constraint');
          error.code = '23502';
          throw error;
        }
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM public\.tenant_users/.test(sql)) {
        if (params.length === 1) return { rows: [], rowCount: 2 };
        assert.doesNotMatch(sql, /role/);
        const [, callerId, tenantFilter] = params;
        const removable = memberships.filter((m) => tenantFilter == null || m.tenant_id === tenantFilter);
        return { rows: [], rowCount: callerId === USER ? removable.length : 0 };
      }
      return { rows: [] };
    },
  };
};

const COGNITO_SUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const invite = (client, body = {}, { mailer, cognitoCalls = [], existingLogin = false } = {}) => runTenantInviteUser({
  client,
  mapping,
  spoof: {},
  body: { tenant_id: TENANT, email: 'new@example.com', full_name: 'New Person', ...body },
  send: mailer || (async () => {}),
  cognitoJson: async (target, payload) => {
    cognitoCalls.push([target, payload.Username]);
    if (target === 'AdminCreateUser') {
      if (existingLogin) throw Object.assign(new Error('exists'), { name: 'UsernameExistsException' });
      return { User: { Username: 'cog', Attributes: [{ Name: 'sub', Value: COGNITO_SUB }] } };
    }
    if (target === 'AdminGetUser') return { Username: 'cog', UserAttributes: [{ Name: 'sub', Value: COGNITO_SUB }] };
    if (target === 'AdminDeleteUser') return {};
    throw new Error(`unexpected ${target}`);
  },
});

test('invite: any member of the tenant (stored role viewer included) may invite; the platform owner keeps onboarding', async () => {
  for (const role of ANY_ROLE) {
    const result = await invite(teamClient({ memberships: [{ tenant_id: TENANT, role }] }));
    assert.equal(result.ok, true, role);
    assert.equal(result.invite_sent, true);
    assert.equal(result.is_new_user, true);
    assert.equal('role' in result, false);
  }
  const onboarding = await invite(teamClient({ platformOwner: true, tenantMemberCount: 0 }));
  assert.equal(onboarding.ok, true);
});

test('invite: the platform owner makes only the first invite of a tenant with no members', async () => {
  for (const tenantMemberCount of [1, 5, null]) {
    const client = teamClient({ platformOwner: true, tenantMemberCount });
    const cognitoCalls = [];
    const refused = await invite(client, {}, { cognitoCalls });
    assert.equal(refused.statusCode, 403, String(tenantMemberCount));
    assert.equal(refused.error, 'first_invite_only');
    assert.deepEqual(cognitoCalls, []);
    assert.equal(client.queries.some((q) => /INSERT INTO public\.(tenant_users|profiles)/.test(q.sql)), false);
  }
  assert.match(TENANT_MEMBER_COUNT_SQL, /count\(\*\)::int AS member_count/);
  assert.doesNotMatch(TENANT_MEMBER_COUNT_SQL, /role/);
});

test('invite: nobody adds the platform owner to a tenant (by email or by its linked login)', async () => {
  for (const opts of [{ platformOwner: true }, { memberships: [{ tenant_id: TENANT, role: 'viewer' }] }]) {
    const cognitoCalls = [];
    const client = teamClient(opts);
    const byEmail = await invite(client, { email: 'ChecksOpsAdmin@gmail.com' }, { cognitoCalls });
    assert.equal(byEmail.statusCode, 403);
    assert.equal(byEmail.error, 'platform_owner_not_invitable');
    assert.deepEqual(cognitoCalls, []);
  }
  // Another email whose existing Cognito login is linked to the platform owner.
  const OWNER_USER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const client = teamClient({
    memberships: [{ tenant_id: TENANT, role: 'viewer' }], linkedUserId: OWNER_USER, ownerUserIds: [OWNER_USER],
  });
  const cognitoCalls = [];
  const linked = await invite(client, { email: 'alias@example.com' }, { cognitoCalls, existingLogin: true });
  assert.equal(linked.statusCode, 403);
  assert.equal(linked.error, 'platform_owner_not_invitable');
  assert.equal(linked.cognitoCleanup, 'not_created_by_this_request');
  assert.equal(cognitoCalls.some(([target]) => target === 'AdminDeleteUser'), false);
  assert.equal(client.queries.some((q) => /INSERT INTO public\.tenant_users/.test(q.sql)), false);
});

test('invite: an existing Cognito login keeps its linked user; the link is never re-pointed', async () => {
  const LINKED = '77777777-7777-4777-8777-777777777777';
  const client = teamClient({ memberships: [{ tenant_id: TENANT, role: 'viewer' }], linkedUserId: LINKED });
  const result = await invite(client, {}, { existingLogin: true });
  assert.equal(result.ok, true);
  assert.equal(result.applicationUserId, LINKED);
  assert.equal(client.queries.some((q) => /INSERT INTO public\.(profiles|identity_accounts)/.test(q.sql)), false);
  const membership = client.queries.find((q) => /INSERT INTO public\.tenant_users/.test(q.sql));
  assert.equal(membership.params[2], LINKED);
  for (const q of client.queries) {
    assert.doesNotMatch(q.sql, /DO UPDATE/);
  }
  // With no link, a profile is created and linked with ON CONFLICT DO NOTHING.
  const fresh = teamClient({ memberships: [{ tenant_id: TENANT, role: 'viewer' }] });
  const created = await invite(fresh);
  assert.equal(created.ok, true);
  const link = fresh.queries.find((q) => /INSERT INTO public\.identity_accounts/.test(q.sql));
  assert.match(link.sql, /ON CONFLICT \(cognito_sub\) DO NOTHING/);
  assert.doesNotMatch(link.sql, /DO UPDATE|SET application_user_id/);
});

test('invite: a failed step after creating the Cognito user deletes it again and fails the request', async () => {
  for (const opts of [{ failMembershipInsert: true }, { failProfileInsert: true }]) {
    const cognitoCalls = [];
    const result = await invite(teamClient({ memberships: [{ tenant_id: TENANT, role: 'viewer' }], ...opts }), {}, { cognitoCalls });
    assert.equal(result.ok, false, JSON.stringify(opts));
    assert.equal(result.statusCode, 500);
    assert.equal(result.cognitoCleanup, 'deleted');
    assert.deepEqual(cognitoCalls.map(([target]) => target), ['AdminCreateUser', 'AdminDeleteUser']);
  }
  // A login that existed before this request is never deleted.
  const cognitoCalls = [];
  const kept = await invite(teamClient({ memberships: [{ tenant_id: TENANT, role: 'viewer' }], failMembershipInsert: true }), {}, {
    cognitoCalls, existingLogin: true,
  });
  assert.equal(kept.ok, false);
  assert.equal(kept.cognitoCleanup, 'not_created_by_this_request');
  assert.equal(cognitoCalls.some(([target]) => target === 'AdminDeleteUser'), false);
});

test('hire mortgage agent: the platform owner only; a global user_roles admin is refused', async () => {
  const cognitoCalls = [];
  const admin = await runHireMortgageAgent({
    client: teamClient({ platformOwner: false }),
    mapping,
    spoof: {},
    body: { email: 'agent@example.com', full_name: 'Mo Agent' },
    send: async () => {},
    cognitoJson: async (target) => { cognitoCalls.push(target); return {}; },
  });
  assert.equal(admin.statusCode, 403);
  assert.equal(admin.error, 'Platform owner access required');
  assert.deepEqual(cognitoCalls, []);
  const ownerSelf = await runHireMortgageAgent({
    client: teamClient({ platformOwner: true }),
    mapping,
    spoof: {},
    body: { email: PLATFORM_OWNER_EMAIL, full_name: 'Owner' },
    send: async () => {},
    cognitoJson: async (target) => { cognitoCalls.push(target); return {}; },
  });
  assert.equal(ownerSelf.statusCode, 403);
  assert.deepEqual(cognitoCalls, []);
});

test('invite: a client-supplied role is ignored (no role choice)', async () => {
  const client = teamClient({ memberships: [{ tenant_id: TENANT, role: 'viewer' }] });
  const result = await invite(client, { role: 'superadmin' });
  assert.equal(result.ok, true);
  const insert = client.queries.find((q) => /INSERT INTO public\.tenant_users/.test(q.sql));
  assert.equal(insert.params.includes('superadmin'), false);
});

test('invite: a member of another tenant and a platform admin without membership are refused', async () => {
  for (const memberships of [[{ tenant_id: PARTNER_TENANT, role: 'owner' }], []]) {
    const client = teamClient({ memberships });
    const result = await invite(client);
    assert.equal(result.statusCode, 403, JSON.stringify(memberships));
    assert.equal(client.queries.some((q) => /INSERT INTO public\.tenant_users/.test(q.sql)), false);
  }
});

test('invite: a failed membership insert fails loudly; a failed email is reported, not hidden', async () => {
  const member = [{ tenant_id: TENANT, role: 'viewer' }];
  const failed = await invite(teamClient({ memberships: member, failMembershipInsert: true }));
  assert.equal(failed.ok, false);
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.error, 'tenant_membership_failed');
  const unsent = await invite(teamClient({ memberships: member }), {}, {
    mailer: async () => { throw new Error('ses throttled'); },
  });
  assert.equal(unsent.ok, true);
  assert.equal(unsent.invite_sent, false);
  assert.match(unsent.invite_error, /ses throttled/);
});

test('remove member: any member removes only from its own tenants; disabling the login stays platform owner', async () => {
  for (const role of ['viewer', 'operator', 'owner']) {
    const member = teamClient({ memberships: [{ tenant_id: TENANT, role }] });
    const removed = await runDeleteUser({
      client: member, mapping, spoof: {}, body: { user_id: TEAMMATE, tenant_id: TENANT, email: 'mate@example.com' },
      cognitoJson: async () => { throw new Error('must not disable the login'); },
    });
    assert.equal(removed.ok, true, role);
    assert.equal(removed.disabled, false);
    const del = member.queries.find((q) => /DELETE FROM public\.tenant_users/.test(q.sql));
    assert.deepEqual(del.params, [TEAMMATE, USER, TENANT]);
  }

  for (const memberships of [[{ tenant_id: PARTNER_TENANT, role: 'owner' }], []]) {
    const refused = await runDeleteUser({
      client: teamClient({ memberships }), mapping, spoof: {}, body: { user_id: TEAMMATE, tenant_id: TENANT },
      cognitoJson: async () => { throw new Error('must not disable the login'); },
    });
    assert.equal(refused.statusCode, 403, JSON.stringify(memberships));
  }

  const disables = [];
  const platformClient = teamClient({ platformOwner: true });
  const platform = await runDeleteUser({
    client: platformClient, mapping, spoof: {}, body: { user_id: TEAMMATE, email: 'mate@example.com' },
    cognitoJson: async (target, payload) => { disables.push([target, payload.Username]); return {}; },
  });
  assert.equal(platform.disabled, true);
  assert.deepEqual(disables, [['AdminDisableUser', 'mate@example.com']]);
  // The platform owner disables the login; it does not edit tenant memberships.
  assert.equal(platformClient.queries.some((q) => /DELETE FROM public\.tenant_users/.test(q.sql)), false);

  // By user id alone: the login email comes from the identity mapping.
  const byId = [];
  const viaIdentity = await runDeleteUser({
    client: teamClient({ platformOwner: true, identityEmail: 'Mate@Example.com' }), mapping, spoof: {}, body: { user_id: TEAMMATE },
    cognitoJson: async (target, payload) => { byId.push([target, payload.Username]); return {}; },
  });
  assert.equal(viaIdentity.disabled, true);
  assert.deepEqual(byId, [['AdminDisableUser', 'mate@example.com']]);

  // The platform owner's own login is never disabled here.
  const own = await runDeleteUser({
    client: teamClient({ platformOwner: true }), mapping, spoof: {}, body: { email: PLATFORM_OWNER_EMAIL },
    cognitoJson: async () => { throw new Error('must not disable the platform owner'); },
  });
  assert.equal(own.statusCode, 403);
});

// --- Platform treasury bank ---------------------------------------------------------

test('moov-platform-bank: a global user_roles admin (ctx.isAdmin) is not the platform owner; members are refused', async () => {
  const result = await platformBank.run({
    client: { query: async () => ({ rows: [{ is_owner: false }] }) },
    body: { action: 'list' },
    ctx: {
      isAdmin: true,
      tenantId: TENANT,
      memberships: [{ tenant_id: TENANT, role: 'owner' }],
      moovContext: { sandboxPlatformAccountId: 'acct' },
    },
    fetchImpl: async () => { throw new Error('no provider call expected'); },
  });
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'Platform owner access required');
});

// --- Review follow-ups: remaining global admin/staff and platform-owner gates ------

const ownerOrMemberClient = ({ platformOwner = false, member = false, userRoles = ['admin'], handlers = [] } = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql === USER_ROLES_SQL || /FROM public\.user_roles/.test(sql)) return { rows: userRoles.map((role) => ({ role })) };
      if (/is_platform_owner\(\)|is_master_owner\(\)/.test(sql)) {
        return { rows: [{ is_owner: platformOwner, is_master: platformOwner, is_platform: platformOwner }] };
      }
      for (const [pattern, result] of handlers) {
        if (pattern.test(sql)) return typeof result === 'function' ? result(sql, params) : result;
      }
      if (/FROM public\.tenant_users/.test(sql)) return { rows: member ? [{ '?column?': 1 }] : [] };
      return { rows: [] };
    },
  };
};

test('Auto-Deposit threshold is a tenant setting: members only; the platform owner is refused', async () => {
  const saveSql = /aws_save_checkalt_tenant_auto_deposit/;
  const result = (_sql, params) => ({ rows: [{ result: { tenant_id: params[0], auto_approve_enabled: true, auto_approve_max_cents: null } }] });
  const owner = ownerOrMemberClient({ platformOwner: true, member: false, handlers: [[saveSql, result]] });
  const refused = await executeSafeWriteRpc({
    client: owner, mapping, name: 'save_checkalt_tenant_auto_deposit', args: { tenant_id: TENANT, auto_approve_enabled: true },
  });
  assert.equal(refused.error, 'not_authorized');
  assert.equal(owner.queries.some((q) => saveSql.test(q.sql)), false);
  const member = ownerOrMemberClient({ member: true, userRoles: [], handlers: [[saveSql, result]] });
  const saved = await executeSafeWriteRpc({
    client: member, mapping, name: 'save_checkalt_tenant_auto_deposit', args: { tenant_id: TENANT, auto_approve_enabled: true },
  });
  assert.equal(saved.error, undefined, JSON.stringify(saved));
  assert.equal(member.queries.some((q) => /is_platform_owner/.test(q.sql)), false);
});

test('Contractor Pro approval: the platform owner only; a global user_roles admin is refused', async () => {
  const CONTRACTOR = '33333333-3333-4333-8333-333333333333';
  const admin = ownerOrMemberClient({ platformOwner: false, userRoles: ['admin'] });
  const refused = await executeSafeWriteRpc({
    client: admin, mapping, name: 'admin_set_contractor_pro', args: { p_contractor_id: CONTRACTOR, p_approve: true },
  });
  assert.equal(refused.error, 'not_authorized');
  assert.equal(admin.queries.some((q) => /UPDATE public\.contractor_profiles/.test(q.sql)), false);
  const owner = ownerOrMemberClient({ platformOwner: true, userRoles: [] });
  const approved = await executeSafeWriteRpc({
    client: owner, mapping, name: 'admin_set_contractor_pro', args: { p_contractor_id: CONTRACTOR, p_approve: true },
  });
  assert.equal(approved.error, undefined);
  assert.equal(owner.queries.some((q) => /UPDATE public\.contractor_profiles/.test(q.sql)), true);
});

test('tenant billing authorization: any member; the platform owner without membership and global admins are refused', async () => {
  const { canAuthorizeTenantBilling } = await import('../functions/api/tenant-billing-engine.mjs');
  for (const [opts, expected] of [
    [{ member: true, userRoles: [] }, true],
    [{ member: false, platformOwner: true }, false],
    [{ member: false, userRoles: ['admin'] }, false],
  ]) {
    const client = ownerOrMemberClient(opts);
    assert.equal(await canAuthorizeTenantBilling(client, USER, TENANT), expected, JSON.stringify(opts));
    const membership = client.queries.find((q) => /FROM public\.tenant_users/.test(q.sql));
    assert.doesNotMatch(membership.sql, /\brole\b/);
  }
});

test('catalog inspection is platform-level: the platform owner only, not a global user_roles admin', async () => {
  const { assertCatalogAdmin } = await import('../functions/api/tenant-maintenance-payments-catalog-inspect.mjs');
  const admin = await assertCatalogAdmin(ownerOrMemberClient({ platformOwner: false, userRoles: ['admin'] }), mapping);
  assert.equal(admin.statusCode, 403);
  assert.equal(await assertCatalogAdmin(ownerOrMemberClient({ platformOwner: true, userRoles: [] }), mapping), null);
});

test('homeowner intro leads and contractor profiles: the owner or a teammate; a global admin/staff is refused', async () => {
  const { executeCheckWorkflowWrite, SHARES_TENANT_SQL } = await import('../functions/api/write-check-workflow.mjs');
  assert.doesNotMatch(SHARES_TENANT_SQL, /\brole\b/);
  const OTHER_USER = '44444444-4444-4444-8444-444444444444';
  const LEAD = '55555555-5555-4555-8555-555555555555';
  const PROFILE = '66666666-6666-4666-8666-666666666666';
  const writes = [
    ['homeowner_intro_requests', { status: 'contacted' }, [/FROM public\.homeowner_intro_requests WHERE id/, { rows: [{ id: LEAD, contractor_user_id: OTHER_USER }] }], /UPDATE public\.homeowner_intro_requests/, LEAD],
    ['contractor_profiles', { bio: 'Roofing' }, [/FROM public\.contractor_profiles WHERE id/, { rows: [{ id: PROFILE, user_id: OTHER_USER }] }], /UPDATE public\.contractor_profiles/, PROFILE],
  ];
  for (const [table, values, lookup, update, id] of writes) {
    for (const userRoles of [['admin'], ['staff']]) {
      const client = ownerOrMemberClient({ userRoles, handlers: [lookup, [update, { rows: [{ id }] }]] });
      const refused = await executeCheckWorkflowWrite({
        client, mapping, table, op: 'update', values, filters: [{ column: 'id', op: 'eq', value: id }],
      });
      assert.equal(refused.error, 'not_authorized', `${table} ${userRoles}`);
      assert.equal(client.queries.some((q) => update.test(q.sql)), false, table);
      assert.equal(client.queries.some((q) => /FROM public\.user_roles/.test(q.sql)), false, table);
    }
    const teammate = ownerOrMemberClient({
      userRoles: [],
      handlers: [lookup, [update, { rows: [{ id }] }], [/JOIN public\.tenant_users theirs/, (_sql, params) => ({
        rows: params[0] === USER && params[1] === OTHER_USER ? [{ '?column?': 1 }] : [],
      })]],
    });
    const ok = await executeCheckWorkflowWrite({
      client: teammate, mapping, table, op: 'update', values, filters: [{ column: 'id', op: 'eq', value: id }],
    });
    assert.equal(ok.error, undefined, `${table} ${JSON.stringify(ok)}`);
    assert.equal(teammate.queries.some((q) => update.test(q.sql)), true, table);
  }
});
