/**
 * Owner policy (users only, tenant roles decide) for the workflow RPCs, tenant
 * team management and the platform treasury bank:
 * - owner, admin, manager and operator of the row's own tenant act on check
 *   work; viewers, partners (members of another tenant) and platform
 *   admin/staff without that membership do not;
 * - team management (invite, remove a member) is owner and admin only; the
 *   platform owner keeps tenant onboarding and disabling a login;
 * - mortgage agents keep cross-tenant access to mortgage handling requests.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { USER_ROLES_SQL } from '../functions/api/identity.mjs';
import { executeSafeWriteRpc, TENANT_ACTOR_SQL } from '../functions/api/workflow-rpc.mjs';
import { INVITABLE_TENANT_ROLES, runDeleteUser, runTenantInviteUser } from '../functions/api/tenant-admin.mjs';
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
const ACTING = ['owner', 'admin', 'manager', 'operator'];

const actorRows = (memberships, params) => {
  const [userId, tenantId] = params;
  const ok = userId === USER && memberships.some((m) => m.tenant_id === tenantId
    && ACTING.includes(String(m.role).toLowerCase()));
  return { rows: ok ? [{ '?column?': 1 }] : [] };
};

/** Fake for workflow-rpc: user_roles, the acting-role membership query and the rows each RPC reads. */
const rpcClient = ({ memberships = [], userRoles = [], handlers = [] } = {}) => {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql === USER_ROLES_SQL) return { rows: userRoles.map((role) => ({ role })) };
      if (sql === TENANT_ACTOR_SQL) return actorRows(memberships, params);
      for (const [pattern, result] of handlers) {
        if (pattern.test(sql)) return typeof result === 'function' ? result(sql, params) : result;
      }
      return { rows: [] };
    },
  };
};

test('TENANT_ACTOR_SQL is the owner-policy acting-role filter for one tenant', () => {
  assert.match(TENANT_ACTOR_SQL, /user_id = \$1::uuid AND tenant_id = \$2::uuid/);
  assert.match(TENANT_ACTOR_SQL, /lower\(role::text\) IN \('owner', 'admin', 'manager', 'operator'\)/);
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

for (const role of ACTING) {
  test(`loss draft reset: tenant ${role} of the draft's tenant may reset it`, async () => {
    const { result, client } = await lossDraftReset({ memberships: [{ tenant_id: TENANT, role }] });
    assert.equal(result.error, undefined, role);
    assert.ok(client.queries.some((q) => /UPDATE public\.loss_draft_tracking\s+SET escrow_status = \$2::text/.test(q.sql)));
  });
}

for (const [label, opts] of [
  ['viewer', { memberships: [{ tenant_id: TENANT, role: 'viewer' }] }],
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

test('admin_set_check_claim: operator of the check tenant links a claim; viewer, partner and platform admin are refused', async () => {
  const ok = await setCheckClaim({ memberships: [{ tenant_id: TENANT, role: 'operator' }] });
  assert.equal(ok.result.data.ok, true);
  for (const opts of [
    { memberships: [{ tenant_id: TENANT, role: 'viewer' }] },
    { memberships: [{ tenant_id: PARTNER_TENANT, role: 'admin' }] },
    { userRoles: ['admin'] },
  ]) {
    const refused = await setCheckClaim(opts);
    assert.equal(refused.result.error, 'not_authorized', JSON.stringify(opts));
    assert.equal(refused.client.queries.some((q) => /public\.admin_set_check_claim/.test(q.sql)), false);
  }
});

// --- Mortgage handling requests ---------------------------------------------------

test('mortgage agents keep cross-tenant access to accept handling requests; platform admin and tenant owners do not', async () => {
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
      if (/SELECT 1 FROM public\.tenant_users/.test(sql) && /IN \('owner', 'admin'\)/.test(sql)) {
        const [tenantId, userId] = params;
        const ok = userId === USER && memberships.some((m) => m.tenant_id === tenantId && ['owner', 'admin'].includes(m.role));
        return { rows: ok ? [{ '?column?': 1 }] : [] };
      }
      if (/FROM public\.tenants/.test(sql)) return { rows: [{ id: TENANT, name: 'Acme', custom_domain: null }] };
      if (/INSERT INTO public\.tenant_users/.test(sql)) {
        if (failMembershipInsert) {
          const error = new Error('invalid input value for enum tenant_role');
          error.code = '22P02';
          throw error;
        }
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM public\.tenant_users/.test(sql)) {
        if (params.length === 1) return { rows: [], rowCount: 2 };
        const [, callerId, tenantFilter] = params;
        const removable = memberships.filter((m) => ['owner', 'admin'].includes(m.role)
          && (tenantFilter == null || m.tenant_id === tenantFilter));
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
  body: { tenant_id: TENANT, email: 'new@example.com', role: 'operator', full_name: 'New Person', ...body },
  send: mailer || (async () => {}),
  cognitoJson: async (target) => {
    if (target === 'AdminCreateUser') return { User: { Username: 'cog', Attributes: [{ Name: 'sub', Value: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }] } };
    throw new Error(`unexpected ${target}`);
  },
});

test('invite: owner and admin of the tenant may invite; the platform owner keeps onboarding', async () => {
  for (const role of ['owner', 'admin']) {
    const result = await invite(teamClient({ memberships: [{ tenant_id: TENANT, role }] }));
    assert.equal(result.ok, true, role);
    assert.equal(result.invite_sent, true);
    assert.equal(result.is_new_user, true);
  }
  const onboarding = await invite(teamClient({ platformOwner: true }));
  assert.equal(onboarding.ok, true);
});

test('invite: manager, operator, viewer, owner of another tenant and platform admin without membership are refused', async () => {
  for (const memberships of [
    [{ tenant_id: TENANT, role: 'manager' }],
    [{ tenant_id: TENANT, role: 'operator' }],
    [{ tenant_id: TENANT, role: 'viewer' }],
    [{ tenant_id: PARTNER_TENANT, role: 'owner' }],
    [],
  ]) {
    const client = teamClient({ memberships });
    const result = await invite(client);
    assert.equal(result.statusCode, 403, JSON.stringify(memberships));
    assert.equal(client.queries.some((q) => /INSERT INTO public\.tenant_users/.test(q.sql)), false);
  }
});

test('invite: role must be a tenant_role value, and a failed membership insert fails loudly', async () => {
  assert.deepEqual([...INVITABLE_TENANT_ROLES], ['admin', 'operator', 'viewer']);
  const owner = [{ tenant_id: TENANT, role: 'owner' }];
  for (const role of ['member', 'superadmin', 'owner']) {
    const bad = await invite(teamClient({ memberships: owner }), { role });
    assert.equal(bad.statusCode, 400, role);
    assert.equal(bad.error, 'invalid_role');
  }
  const failed = await invite(teamClient({ memberships: owner, failMembershipInsert: true }));
  assert.equal(failed.ok, false);
  assert.equal(failed.statusCode, 500);
  assert.equal(failed.error, 'tenant_membership_failed');
  const unsent = await invite(teamClient({ memberships: owner }), {}, {
    mailer: async () => { throw new Error('ses throttled'); },
  });
  assert.equal(unsent.ok, true);
  assert.equal(unsent.invite_sent, false);
  assert.match(unsent.invite_error, /ses throttled/);
});

test('remove member: owner/admin remove only from their own owner/admin tenants; disabling the login stays platform owner', async () => {
  const owner = teamClient({ memberships: [{ tenant_id: TENANT, role: 'owner' }] });
  const removed = await runDeleteUser({
    client: owner, mapping, spoof: {}, body: { user_id: TEAMMATE, tenant_id: TENANT, email: 'mate@example.com' },
    cognitoJson: async () => { throw new Error('must not disable the login'); },
  });
  assert.equal(removed.ok, true);
  assert.equal(removed.disabled, false);
  const del = owner.queries.find((q) => /DELETE FROM public\.tenant_users/.test(q.sql));
  assert.match(del.sql, /lower\(mine\.role::text\) IN \('owner', 'admin'\)/);
  assert.deepEqual(del.params, [TEAMMATE, USER, TENANT]);

  for (const memberships of [[{ tenant_id: TENANT, role: 'operator' }], [{ tenant_id: TENANT, role: 'manager' }], []]) {
    const refused = await runDeleteUser({
      client: teamClient({ memberships }), mapping, spoof: {}, body: { user_id: TEAMMATE },
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

test('moov-platform-bank: a global user_roles admin (ctx.isAdmin) is not the platform owner', async () => {
  const result = await platformBank.run({
    client: { query: async () => ({ rows: [{ is_owner: false }] }) },
    body: { action: 'list' },
    ctx: { isAdmin: true, tenantId: TENANT, moovContext: { sandboxPlatformAccountId: 'acct' } },
    fetchImpl: async () => { throw new Error('no provider call expected'); },
  });
  assert.equal(result.statusCode, 403);
  assert.equal(result.error, 'Platform owner access required');
});
