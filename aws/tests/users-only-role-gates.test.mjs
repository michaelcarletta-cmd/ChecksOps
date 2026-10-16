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
import { runDeleteUser, runTenantInviteUser } from '../functions/api/tenant-admin.mjs';
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

const teamClient = ({ memberships = [], platformOwner = false, failMembershipInsert = false } = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
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

const invite = (client, body = {}, { mailer } = {}) => runTenantInviteUser({
  client,
  mapping,
  spoof: {},
  body: { tenant_id: TENANT, email: 'new@example.com', full_name: 'New Person', ...body },
  send: mailer || (async () => {}),
  cognitoJson: async (target) => {
    if (target === 'AdminCreateUser') return { User: { Username: 'cog', Attributes: [{ Name: 'sub', Value: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }] } };
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
  const onboarding = await invite(teamClient({ platformOwner: true }));
  assert.equal(onboarding.ok, true);
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
  const platform = await runDeleteUser({
    client: teamClient({ platformOwner: true }), mapping, spoof: {}, body: { user_id: TEAMMATE, email: 'mate@example.com' },
    cognitoJson: async (target, payload) => { disables.push([target, payload.Username]); return {}; },
  });
  assert.equal(platform.disabled, true);
  assert.deepEqual(disables, [['AdminDisableUser', 'mate@example.com']]);
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
