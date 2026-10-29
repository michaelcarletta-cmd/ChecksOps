/**
 * /data/rpc access gates (data.mjs RPC_ACCESS_GATES / rpcAccessDenial): the Supabase-era
 * SECURITY DEFINER reads that let a global user_roles admin or staff read every tenant now
 * run only for the platform owner (global reads), a member of the named tenant, a caller who
 * can access the named check, or the caller's own user id. Refused calls never run the RPC.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CONTRACTOR_GATE_SQL, RPC_ACCESS_GATES, handleDataRpc, rpcAccessDenial } from '../functions/api/data.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';
import {
  CHECK_A, MEMBER_A, MEMBER_B, PLATFORM_OWNER, TENANT_A, TENANT_B, pgSkipReason, releaseFixture,
} from './helpers/release-sql-pg.mjs';
import { policyBlock } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const OTHER_USER = 'b0000000-0000-4000-8000-000000000002';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const GLOBAL = ['get_all_checks_safety_net', 'get_stuck_checks', 'get_deposit_ops_kpis', 'get_deposit_exception_kpis', 'get_deposit_aging_summary'];

const event = (name, args) => ({
  rawPath: '/data/rpc',
  headers: { authorization: 'Bearer test-id-token' },
  body: JSON.stringify({ name, args }),
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: '/data/rpc' },
    authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'tenant-admin@example.invalid', token_use: 'id' } } },
  },
});

/** A client whose answers to the gate queries are given; records whether the RPC itself ran. */
const mockClient = ({ owner = false, tenantAccess = false, checkAccess = false, contractorAccess = false } = {}) => {
  const queries = [];
  return {
    queries,
    ran: (name) => queries.some((q) => String(q.sql).startsWith(`SELECT * FROM public.${name}(`)),
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql === 'COMMIT') return { rows: [] };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return { rows: [{ application_user_id: APP_ID, cognito_sub: COGNITO_SUB, email: 'tenant-admin@example.invalid', status: 'active' }] };
      }
      if (sql === CONTRACTOR_GATE_SQL) return { rows: [{ ok: contractorAccess }] };
      if (sql.includes('public.is_platform_owner()')) return { rows: [{ is_owner: owner }] };
      if (sql.includes('aws_can_access_tenant')) return { rows: [{ ok: tenantAccess }] };
      if (sql.includes('aws_can_access_check')) return { rows: [{ ok: checkAccess }] };
      if (sql.startsWith('SELECT * FROM public.')) return { rows: [{ result: 'rows' }] };
      return { rows: [] };
    },
    end: async () => {},
  };
};

const call = async (client, name, args = {}) => handleDataRpc(event(name, args), {
  loadDatabaseCredentials: async () => ({ username: 'checksops', password: 'unit-test-only-not-a-real-secret', host: 'db.example.internal', database: 'checksops' }),
  createClient: () => client,
});

test('a tenant admin (not the platform owner) is refused every global read; the RPC never runs', async () => {
  for (const name of GLOBAL) {
    const client = mockClient({ owner: false });
    const result = await call(client, name);
    assert.equal(result.statusCode, 403, name);
    assert.equal(result.error, 'rpc_forbidden', name);
    assert.equal(client.ran(name), false, name);
  }
});

test('the platform owner still runs the global reads', async () => {
  for (const name of GLOBAL) {
    const client = mockClient({ owner: true });
    const result = await call(client, name);
    assert.equal(result.statusCode, 200, name);
    assert.equal(client.ran(name), true, name);
  }
});

test('per-tenant reads run for the caller\'s tenant and are refused for another tenant', async () => {
  for (const [name, gate] of Object.entries(RPC_ACCESS_GATES).filter(([, g]) => g.tenant)) {
    const own = mockClient({ tenantAccess: true });
    assert.equal((await call(own, name, { [gate.tenant]: TENANT_A })).statusCode, 200, name);
    assert.equal(own.ran(name), true, name);
    assert.deepEqual(own.queries.find((q) => String(q.sql).includes('aws_can_access_tenant')).params, [TENANT_A], name);
    const other = mockClient({ tenantAccess: false });
    const refused = await call(other, name, { [gate.tenant]: TENANT_B });
    assert.equal(refused.statusCode, 403, name);
    assert.equal(other.ran(name), false, name);
    const missing = mockClient({ tenantAccess: true });
    assert.equal((await call(missing, name, {})).statusCode, 400, name);
    assert.equal((await call(missing, name, { [gate.tenant]: 'not-a-uuid' })).statusCode, 400, name);
    assert.equal(missing.ran(name), false, name);
  }
});

test('the claim settlement runs only when the caller can access the check', async () => {
  const yes = mockClient({ checkAccess: true });
  assert.equal((await call(yes, 'get_check_claim_settlement', { p_check_id: CHECK_A })).statusCode, 200);
  const no = mockClient({ checkAccess: false });
  assert.equal((await call(no, 'get_check_claim_settlement', { p_check_id: CHECK_A })).statusCode, 403);
  assert.equal(no.ran('get_check_claim_settlement'), false);
});

test('has_permission answers for the caller\'s own user id; another user\'s only for the platform owner', async () => {
  const self = mockClient({ owner: false });
  assert.equal((await call(self, 'has_permission', { _user_id: APP_ID, _permission: 'manage_users' })).statusCode, 200);
  const other = mockClient({ owner: false });
  assert.equal((await call(other, 'has_permission', { _user_id: OTHER_USER, _permission: 'manage_users' })).statusCode, 403);
  assert.equal(other.ran('has_permission'), false);
  const owner = mockClient({ owner: true });
  assert.equal((await call(owner, 'has_permission', { _user_id: OTHER_USER, _permission: 'manage_users' })).statusCode, 200);
});

test('contractor_verification_status runs only for the caller\'s own profile or a cross-tenant reader', async () => {
  const PROFILE = 'c0000000-0000-4000-8000-000000000001';
  const yes = mockClient({ contractorAccess: true });
  assert.equal((await call(yes, 'contractor_verification_status', { p_contractor_id: PROFILE })).statusCode, 200);
  assert.deepEqual(yes.queries.find((q) => q.sql === CONTRACTOR_GATE_SQL).params, [PROFILE]);
  const no = mockClient({ contractorAccess: false });
  const refused = await call(no, 'contractor_verification_status', { p_contractor_id: PROFILE });
  assert.equal(refused.statusCode, 403);
  assert.equal(no.ran('contractor_verification_status'), false);
  const bad = mockClient({ contractorAccess: true });
  assert.equal((await call(bad, 'contractor_verification_status', { p_contractor_id: 'not-a-uuid' })).statusCode, 400);
  assert.equal(bad.ran('contractor_verification_status'), false);
});

test('every gated RPC is a read RPC, and every READ_RPCS entry with a tenant, check or user argument is gated', () => {
  const src = fs.readFileSync(path.join(ROOT, 'aws/functions/api/data.mjs'), 'utf8');
  const block = src.slice(src.indexOf('const READ_RPCS = new Set(['), src.indexOf(']);', src.indexOf('const READ_RPCS = new Set([')));
  const reads = new Set([...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  for (const name of Object.keys(RPC_ACCESS_GATES)) assert.ok(reads.has(name), name);
  // Read RPCs left ungated, each for a stated reason.
  const UNGATED = {
    get_total_unread_check_messages: 'SQL migration (audit finding: unread counts across tenants)',
    get_check_unread_counts: 'SQL migration (audit finding: unread counts across tenants)',
    get_my_tenant_partner_codes: 'scoped to auth.uid() memberships in the function',
    list_partner_payout_options: 'checks the caller\'s membership of the check\'s tenant in the function',
    lookup_tenant_by_partner_code: 'partner code lookup by design',
    is_approval_required: 'platform setting',
    is_master_owner: 'caller identity',
    is_platform_owner: 'caller identity',
    aws_platform_owner_referral_overview: 'refuses anyone but the platform owner in the function (SQL 111)',
  };
  for (const name of reads) assert.ok(RPC_ACCESS_GATES[name] || UNGATED[name], name);
});

const skip = pgSkipReason();

test('PostgreSQL 16: the gate SQL refuses a tenant admin holding user_roles.admin across tenants and lets the platform owner through', { skip: skip || false }, async () => {
  const { default: pg } = await import('pg');
  const db = await releaseFixture(pg, 'pg-rpc-gates-', 63400);
  try {
    await db.admin.query(`INSERT INTO public.user_roles (user_id, role) VALUES ('${MEMBER_A}', 'admin'), ('${MEMBER_A}', 'staff')`);
    const api = await db.connectAs('checksops');
    const as = async (user, fn) => {
      await api.query('BEGIN');
      try {
        await api.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
        return await fn();
      } finally {
        await api.query('ROLLBACK');
      }
    };
    try {
      // Member A of tenant A, with global user_roles admin and staff.
      await as(MEMBER_A, async () => {
        for (const name of GLOBAL) assert.equal((await rpcAccessDenial(api, name, {}, MEMBER_A))?.error, 'rpc_forbidden', name);
        assert.equal(await rpcAccessDenial(api, 'get_tenant_users_with_profiles', { _tenant_id: TENANT_A }, MEMBER_A), null);
        assert.equal((await rpcAccessDenial(api, 'get_tenant_users_with_profiles', { _tenant_id: TENANT_B }, MEMBER_A))?.error, 'rpc_forbidden');
        assert.equal((await rpcAccessDenial(api, 'get_tenant_check_usage', { _tenant_id: TENANT_B }, MEMBER_A))?.error, 'rpc_forbidden');
        assert.equal(await rpcAccessDenial(api, 'get_check_claim_settlement', { p_check_id: CHECK_A }, MEMBER_A), null);
        assert.equal((await rpcAccessDenial(api, 'has_permission', { _user_id: MEMBER_B, _permission: 'x' }, MEMBER_A))?.error, 'rpc_forbidden');
      });
      // Member B (tenant B owner) cannot reach tenant A's check.
      await as(MEMBER_B, async () => {
        assert.equal((await rpcAccessDenial(api, 'get_check_claim_settlement', { p_check_id: CHECK_A }, MEMBER_B))?.error, 'rpc_forbidden');
      });
      // The platform owner keeps the global and cross-tenant reads.
      await as(PLATFORM_OWNER, async () => {
        for (const name of GLOBAL) assert.equal(await rpcAccessDenial(api, name, {}, PLATFORM_OWNER), null, name);
        assert.equal(await rpcAccessDenial(api, 'get_tenant_users_with_profiles', { _tenant_id: TENANT_B }, PLATFORM_OWNER), null);
        assert.equal(await rpcAccessDenial(api, 'has_permission', { _user_id: MEMBER_A, _permission: 'x' }, PLATFORM_OWNER), null);
      });
    } finally {
      await api.end().catch(() => {});
    }
  } finally {
    await db.admin.end().catch(() => {});
    db.server.stop();
  }
});

test('PostgreSQL 16: contractor_verification_status is allowed for the profile\'s own user and the platform owner, refused for anyone else', { skip: skip || false }, async () => {
  const { default: pg } = await import('pg');
  const PROFILE_A = 'c0000000-0000-4000-8000-00000000000a';
  const PROFILE_B = 'c0000000-0000-4000-8000-00000000000b';
  const UNKNOWN = 'c0000000-0000-4000-8000-0000000000ff';
  const db = await releaseFixture(pg, 'pg-rpc-contractor-gate-', 63420, {
    extra: [
      `ALTER TABLE public.contractor_profiles
         ADD COLUMN is_directory_listed boolean NOT NULL DEFAULT false,
         ADD COLUMN directory_opt_in boolean NOT NULL DEFAULT false`,
      policyBlock('12_final_select_policies.sql', 'aws_select_contractor_profiles'),
      // Profile B is listed in the directory: visible to everyone, its status still is not.
      `INSERT INTO public.contractor_profiles (id, user_id, is_directory_listed, directory_opt_in) VALUES
         ('${PROFILE_A}', '${MEMBER_A}', false, false), ('${PROFILE_B}', '${MEMBER_B}', true, true)`,
      // Member A also holds global user_roles admin and staff: not a cross-tenant reader.
      `INSERT INTO public.user_roles (user_id, role) VALUES ('${MEMBER_A}', 'admin'), ('${MEMBER_A}', 'staff')`,
    ],
  });
  try {
    const api = await db.connectAs('checksops');
    const as = async (user, fn) => {
      await api.query('BEGIN');
      try {
        await api.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
        return await fn();
      } finally {
        await api.query('ROLLBACK');
      }
    };
    const denial = async (user, id) => (await rpcAccessDenial(api, 'contractor_verification_status', { p_contractor_id: id }, user))?.error ?? null;
    try {
      await as(MEMBER_A, async () => {
        assert.equal(await denial(MEMBER_A, PROFILE_A), null);
        assert.equal(await denial(MEMBER_A, PROFILE_B), 'rpc_forbidden');
        assert.equal(await denial(MEMBER_A, UNKNOWN), 'rpc_forbidden');
      });
      await as(MEMBER_B, async () => {
        assert.equal(await denial(MEMBER_B, PROFILE_B), null);
        assert.equal(await denial(MEMBER_B, PROFILE_A), 'rpc_forbidden');
      });
      await as(PLATFORM_OWNER, async () => {
        assert.equal(await denial(PLATFORM_OWNER, PROFILE_A), null);
        assert.equal(await denial(PLATFORM_OWNER, PROFILE_B), null);
      });
    } finally {
      await api.end().catch(() => {});
    }
  } finally {
    await db.admin.end().catch(() => {});
    db.server.stop();
  }
});
