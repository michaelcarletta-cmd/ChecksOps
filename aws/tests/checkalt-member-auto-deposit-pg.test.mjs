/**
 * SQL 80 against PostgreSQL 16: the real RLS helper files, checkalt_tenant_accounts
 * with its real SELECT and write policies, the real SQL 37 Auto-Deposit read
 * view and the real SQL 38 persist RPC, then the real SQL 80 file, driven
 * through the real save_checkalt_tenant_auto_deposit RPC executor as checksops
 * (RLS on).
 *
 * Before SQL 80 a tenant operator (no user_roles row) passes the API gate but
 * the SQL 38 RPC refuses; after SQL 80 an operator or admin of the tenant can
 * change only auto_approve_enabled and auto_approve_max_cents on that tenant's
 * row. Viewers, members of other tenants, platform admins without membership,
 * extra columns, bad ceilings and direct table UPDATEs stay refused.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { executeSafeWriteRpc } from '../functions/api/workflow-rpc.mjs';
import { AWS_ROOT, applyBaseSchema, pgSkipReason, policyBlock, startPg } from './helpers/stakeholder-policies-pg.mjs';

const SQL_37 = path.join(AWS_ROOT, 'rls/sql/37_checkalt_ui_access_reads.sql');
const SQL_38 = path.join(AWS_ROOT, 'rls/sql/38_checkalt_auto_deposit_persist.sql');
const SQL_80 = path.join(AWS_ROOT, 'workflows/sql/80_checkalt_member_auto_deposit.sql');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const A_OPERATOR = 'a1000000-0000-4000-8000-00000000000a';
const A_VIEWER = 'a1000000-0000-4000-8000-00000000000c';
const A_ADMIN = 'a1000000-0000-4000-8000-0000000000ad';
const B_MEMBER = 'a1000000-0000-4000-8000-00000000000b';
const PLATFORM_ADMIN = 'a1000000-0000-4000-8000-0000000000f2';

const SCHEMA = `
CREATE TABLE public.checkalt_tenant_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE UNIQUE,
  sso_user_id text NOT NULL,
  deposit_account_number text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  registered_at timestamptz,
  last_register_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  auto_approve_enabled boolean NOT NULL DEFAULT false,
  auto_approve_max_cents integer);
REVOKE ALL ON TABLE public.checkalt_tenant_accounts FROM checksops, authenticated;
GRANT SELECT ON TABLE public.checkalt_tenant_accounts TO checksops;
ALTER TABLE public.checkalt_tenant_accounts ENABLE ROW LEVEL SECURITY;
`;

const SEED = `
INSERT INTO public.tenants (id, name) VALUES ('${TENANT_A}', 'A'), ('${TENANT_B}', 'B');
INSERT INTO public.identity_accounts (application_user_id, status) VALUES
  ('${A_OPERATOR}', 'active'), ('${A_VIEWER}', 'active'), ('${A_ADMIN}', 'active'),
  ('${B_MEMBER}', 'active'), ('${PLATFORM_ADMIN}', 'active');
INSERT INTO public.user_roles (user_id, role) VALUES ('${PLATFORM_ADMIN}', 'admin');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES
  ('${TENANT_A}', '${A_OPERATOR}', 'operator'), ('${TENANT_A}', '${A_VIEWER}', 'viewer'),
  ('${TENANT_A}', '${A_ADMIN}', 'admin'), ('${TENANT_B}', '${B_MEMBER}', 'operator');
INSERT INTO public.checkalt_tenant_accounts
  (tenant_id, sso_user_id, deposit_account_number, first_name, last_name, email, registered_at,
   auto_approve_enabled, auto_approve_max_cents)
VALUES
  ('${TENANT_A}', 'sso-a', '1111', 'A', 'A', 'a@example.com', now(), true, 200000),
  ('${TENANT_B}', 'sso-b', '2222', 'B', 'B', 'b@example.com', now(), true, 50000);
`;

/** The Auto-Deposit view from SQL 37 (its checkalt_config view is not part of this fixture). */
const autoDepositViewSql = () => {
  const text = fs.readFileSync(SQL_37, 'utf8');
  return text.slice(text.indexOf('DROP VIEW IF EXISTS public.checkalt_tenant_auto_deposit_public'));
};

test('PostgreSQL 16: SQL 80 lets tenant operators and admins, not viewers, change only its Auto-Deposit settings', {
  timeout: 180000, skip: pgSkipReason() || false,
}, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql80-checkalt-', 55500);
  const client = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await client.connect();
  try {
    await applyBaseSchema(client);
    await client.query(SCHEMA);
    await client.query(policyBlock('12_final_select_policies.sql', 'aws_select_checkalt_tenant_accounts'));
    await client.query(policyBlock('24_complete_write_policies.sql', 'aws_write_checkalt_tenant_accounts'));
    await client.query(autoDepositViewSql());
    await client.query(fs.readFileSync(SQL_38, 'utf8'));
    await client.query(SEED);

    /** One API request: a transaction as checksops (RLS on) for this user. */
    const as = async (user, fn) => {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE checksops');
        await client.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
        const out = await fn();
        await client.query('COMMIT');
        return out;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    };
    const save = (user, args) => as(user, () => executeSafeWriteRpc({
      client,
      mapping: { application_user_id: user },
      name: 'save_checkalt_tenant_auto_deposit',
      args,
    }));
    const stored = async (tenantId) => (await client.query(
      'SELECT auto_approve_enabled, auto_approve_max_cents, sso_user_id, deposit_account_number, enabled FROM public.checkalt_tenant_accounts WHERE tenant_id = $1',
      [tenantId],
    )).rows[0];
    const viewRows = (user) => as(user, async () => (await client.query(
      'SELECT tenant_id, auto_approve_enabled, auto_approve_max_cents, registered FROM public.checkalt_tenant_auto_deposit_public ORDER BY tenant_id',
    )).rows);

    // Any member can read its own tenant's Auto-Deposit row through the SQL 37 view, and only that one.
    for (const user of [A_OPERATOR, A_VIEWER, A_ADMIN]) {
      const rows = await viewRows(user);
      assert.deepEqual(rows.map((r) => r.tenant_id), [TENANT_A], user);
      assert.equal(rows[0].registered, true);
    }
    assert.deepEqual((await viewRows(B_MEMBER)).map((r) => r.tenant_id), [TENANT_B]);

    // SQL 38: an operator passes the API's role gate but the RPC refuses.
    assert.equal((await save(A_OPERATOR, { tenant_id: TENANT_A, auto_approve_enabled: false })).error, 'not_authorized');
    assert.equal((await stored(TENANT_A)).auto_approve_enabled, true);

    await client.query(fs.readFileSync(SQL_80, 'utf8'));

    // SQL 80: operator turns it off, keeps the ceiling.
    let result = await save(A_OPERATOR, { tenant_id: TENANT_A, auto_approve_enabled: false, auto_approve_max_cents: 200000 });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.deepEqual(result.data, { tenant_id: TENANT_A, auto_approve_enabled: false, auto_approve_max_cents: 200000 });
    assert.equal((await stored(TENANT_A)).auto_approve_enabled, false);
    // A viewer cannot change it (the setting controls automatic approval), not even directly.
    assert.equal((await save(A_VIEWER, { tenant_id: TENANT_A, auto_approve_enabled: true })).error, 'not_authorized');
    assert.equal((await stored(TENANT_A)).auto_approve_enabled, false);
    // Operator turns it on and clears the ceiling (blank = no automatic approval).
    result = await save(A_OPERATOR, { tenant_id: TENANT_A, auto_approve_enabled: true, auto_approve_max_cents: null });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.deepEqual(await stored(TENANT_A), {
      auto_approve_enabled: true, auto_approve_max_cents: null, sso_user_id: 'sso-a', deposit_account_number: '1111', enabled: true,
    });
    // Admin sets a new ceiling.
    result = await save(A_ADMIN, { tenant_id: TENANT_A, auto_approve_max_cents: 150000 });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal((await stored(TENANT_A)).auto_approve_max_cents, 150000);

    // A viewer, another tenant's member, and a platform admin with no membership cannot change tenant A.
    for (const user of [A_VIEWER, B_MEMBER, PLATFORM_ADMIN]) {
      assert.equal((await save(user, { tenant_id: TENANT_A, auto_approve_enabled: false })).error, 'not_authorized', user);
    }
    // A's member cannot change tenant B either.
    assert.equal((await save(A_OPERATOR, { tenant_id: TENANT_B, auto_approve_enabled: false })).error, 'not_authorized');
    assert.equal((await stored(TENANT_B)).auto_approve_enabled, true);
    assert.equal((await stored(TENANT_A)).auto_approve_enabled, true);

    // Only the two columns: other keys and bad ceilings are refused, and nothing changes.
    assert.equal((await save(A_OPERATOR, { tenant_id: TENANT_A, sso_user_id: 'stolen' })).error, 'invalid_field');
    for (const bad of [-1, 1.5, 'abc', 2147483648]) {
      assert.equal((await save(A_OPERATOR, { tenant_id: TENANT_A, auto_approve_max_cents: bad })).error, 'invalid_field', String(bad));
    }
    assert.equal((await stored(TENANT_A)).auto_approve_max_cents, 150000);

    // The DEFINER function itself refuses extra keys, non-boolean toggles and fractions even without the Node gate.
    const direct = (user, settings) => as(user, () => client.query(
      'SELECT public.aws_save_checkalt_tenant_auto_deposit($1::uuid, $2::jsonb) AS result', [TENANT_A, settings],
    ));
    await assert.rejects(direct(A_OPERATOR, { enabled: false }), /invalid_field/);
    await assert.rejects(direct(A_OPERATOR, { auto_approve_enabled: 'false' }), (e) => e.code === '22023' && /invalid_field/.test(e.message) && e.detail === 'auto_approve_enabled');
    await assert.rejects(direct(A_OPERATOR, { auto_approve_max_cents: 12.5 }), (e) => e.code === '22023' && /invalid_field/.test(e.message) && e.detail === 'auto_approve_max_cents');
    await assert.rejects(direct(A_OPERATOR, { auto_approve_max_cents: '100' }), /invalid_field/);
    await assert.rejects(direct(B_MEMBER, { auto_approve_enabled: false }), /not_authorized/);
    await assert.rejects(direct(A_VIEWER, { auto_approve_enabled: false }), /not_authorized/);

    // A tenant with no Check Alt account: not_found, never a silent success.
    await client.query('DELETE FROM public.checkalt_tenant_accounts WHERE tenant_id = $1', [TENANT_B]);
    assert.equal((await save(B_MEMBER, { tenant_id: TENANT_B, auto_approve_enabled: false })).error, 'rls_denied');

    // Still no table UPDATE for members.
    await assert.rejects(
      as(A_OPERATOR, () => client.query('UPDATE public.checkalt_tenant_accounts SET auto_approve_enabled = false WHERE tenant_id = $1', [TENANT_A])),
      /permission denied/,
    );
  } finally {
    await client.end();
    server.stop();
  }
});
