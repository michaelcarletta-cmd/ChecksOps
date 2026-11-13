/**
 * SQL 165 (aws/workflows/sql/165_vendor_payee_lookup_and_payroll_vendor.sql) on PostgreSQL 16, applied as the
 * non-superuser checksops_admin owner (the release fixture, helpers/release-sql-pg.mjs) after the real SQL 141, with the
 * lookup called as checksops (the API login) for an application user, as the API calls DEFINER functions:
 *
 *   - before SQL 141 the file fails closed (55000 sql165_prerequisite_missing) and changes nothing; run as checksops it
 *     fails closed too (55000);
 *   - applied twice by the owner: aws_vendor_payees_for_tenant is STABLE SECURITY DEFINER, owned by the login, EXECUTE
 *     checksops only (not PUBLIC or authenticated); payroll_runs gains vendor_tenant_id (FK to tenants, partial index,
 *     column INSERT for checksops only), stakeholder_account_id is nullable, and exactly one payee is required; the
 *     existing run, the policies and the table grants are unchanged; no SQL 141 object or tenants row changes;
 *   - why the lookup is needed: through the API login a paying member reads no vendor_tenants row;
 *   - the lookup: a non-member, no sign-in and no tenant are forbidden; a member reads its live links with the vendor's
 *     name, is_vendor, subscription_status and payable; unmarking a vendor or an organization that is no longer active
 *     makes it not payable at once; a removed link is not listed; another organization's links are not listed;
 *   - payroll_runs as the API writes it: a run to a vendor alone is accepted; no payee, both payees and an unknown
 *     organization are refused (23514, 23514, 23503).
 *
 * Run: node --test aws/tests/sql165-vendor-payee-lookup-and-payroll-vendor-pg.test.mjs (needs PostgreSQL 16; as root
 * the PG helpers run the server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { RELEASE_SQL_SPECS } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { MEMBER_A, MEMBER_B, PLATFORM_OWNER, TENANT_A, TENANT_B, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { policyBlock } from './helpers/stakeholder-policies-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEXT = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/165_vendor_payee_lookup_and_payroll_vendor.sql'), 'utf8');
const SQL141 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/141_permanent_vendor_payees.sql'), 'utf8');

const VENDOR = '16500000-0000-4000-8000-000000000001';
const VENDOR_UNMARKED = '16500000-0000-4000-8000-000000000002';
const VENDOR_LAPSED = '16500000-0000-4000-8000-000000000003';
const VENDOR_REMOVED = '16500000-0000-4000-8000-000000000004';
const STAKEHOLDER_A = '16500000-0000-4000-8000-0000000000a1';
const RUN_BEFORE = '16500000-0000-4000-8000-0000000000b1';

const ALIASES = `
CREATE TABLE IF NOT EXISTS public.tenant_partner_code_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.tenant_partner_code_aliases ENABLE ROW LEVEL SECURITY;`;
/** public.payroll_runs as the repository leaves it: the Supabase table, SQL 12's and SQL 24's policies, the API's grants. */
const PAYROLL = `
CREATE TABLE public.payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  stakeholder_account_id uuid NOT NULL REFERENCES public.stakeholder_accounts(id),
  disbursement_batch_id uuid,
  amount numeric NOT NULL CHECK (amount > 0),
  speed text NOT NULL DEFAULT 'next_day',
  memo text,
  initiated_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX payroll_runs_stakeholder_idx ON public.payroll_runs (stakeholder_account_id);
ALTER TABLE public.payroll_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON TABLE public.payroll_runs TO checksops;
${policyBlock('12_final_select_policies.sql', 'aws_select_payroll_runs')}
${policyBlock('24_complete_write_policies.sql', 'aws_write_payroll_runs')}`;
const SEED = `
UPDATE public.tenants SET partner_code = 'ALPHA165' WHERE id = '${TENANT_A}';
UPDATE public.tenants SET partner_code = 'BRAVO165' WHERE id = '${TENANT_B}';
INSERT INTO public.tenants (id, name, partner_code, subscription_status) VALUES
  ('${VENDOR}', 'Acme Supply', 'VEND165', 'active'),
  ('${VENDOR_UNMARKED}', 'Bolt Hardware', 'BOLT165', 'active'),
  ('${VENDOR_LAPSED}', 'Crest Roofing', 'CREST165', 'active'),
  ('${VENDOR_REMOVED}', 'Delta Lumber', 'DELTA165', 'active');
INSERT INTO public.user_roles (user_id, role) VALUES ('${MEMBER_A}', 'staff');
INSERT INTO public.stakeholder_accounts (id, tenant_id, name) VALUES ('${STAKEHOLDER_A}', '${TENANT_A}', 'Pat');
INSERT INTO public.payroll_runs (id, tenant_id, stakeholder_account_id, amount, initiated_by, status)
  VALUES ('${RUN_BEFORE}', '${TENANT_A}', '${STAKEHOLDER_A}', 125.00, '${MEMBER_A}', 'submitted');`;

async function withPg(t, prefix, port, extra, fn) {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const fx = await releaseFixture(pg, prefix, port, { extra });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/** One statement as the API login (checksops) for an application user. */
async function asApi(connectAs, user, run, { commit = true, financial = false } = {}) {
  const c = await connectAs('checksops');
  try {
    await c.query('BEGIN');
    if (user) await c.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
    if (financial) await c.query("SELECT set_config('request.financial_execution', '1', true)");
    const value = await run(c);
    await c.query(commit ? 'COMMIT' : 'ROLLBACK');
    return { value, error: null };
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    return { value: null, error };
  } finally {
    await c.end();
  }
}
const fn = (sql, params) => async (c) => (await c.query(sql, params)).rows[0].r;
const lookup = (cx, user, tenant) => asApi(cx, user, fn('SELECT public.aws_vendor_payees_for_tenant($1::uuid) AS r', [tenant]), { commit: false });
const add = (cx, user, tenant, code) => asApi(cx, user, fn('SELECT public.aws_vendor_payee_add($1::uuid, $2) AS r', [tenant, code]));
const remove = (cx, user, tenant, vendor) => asApi(cx, user, fn('SELECT public.aws_vendor_payee_remove($1::uuid, $2::uuid) AS r', [tenant, vendor]));
const setVendor = (cx, user, tenant, on) => asApi(cx, user, fn('SELECT public.aws_platform_owner_set_tenant_vendor($1::uuid, $2) AS r', [tenant, on]));
const insertRun = (cx, values) => asApi(cx, MEMBER_A, (c) => c.query(
  `INSERT INTO public.payroll_runs (tenant_id, stakeholder_account_id, vendor_tenant_id, amount, speed, initiated_by, status)
   VALUES ($1::uuid, $2::uuid, $3::uuid, 50.00, 'next_day', $4::uuid, 'pending') RETURNING id`,
  [TENANT_A, values.stakeholder ?? null, values.vendor ?? null, MEMBER_A]));

test('PostgreSQL 16: SQL 165 vendor payee lookup and payroll runs to a vendor', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql165-', 62165, [ALIASES, PAYROLL, SEED], async ({ admin, connectAs }) => {
  const catalog = async () => (await admin.query(
    `SELECT (SELECT relacl::text FROM pg_class WHERE oid = 'public.payroll_runs'::regclass) AS acl,
            (SELECT string_agg(polname, ',' ORDER BY polname) FROM pg_policy WHERE polrelid = 'public.payroll_runs'::regclass) AS policies,
            (SELECT md5(string_agg(t::text, '|' ORDER BY t.id)) FROM public.tenants t) AS tenants,
            (SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'payroll_runs') AS cols`)).rows[0];

  // Before SQL 141: fails closed, nothing changes.
  const owner0 = await connectAs('checksops_admin');
  await assert.rejects(owner0.query(TEXT), (e) => e.code === '55000' && /sql165_prerequisite_missing/.test(e.message) && /vendor_tenants/.test(e.message));
  await owner0.query(SQL141);
  await owner0.end();
  // As the API login: fails closed.
  const api = await connectAs('checksops');
  await assert.rejects(api.query(TEXT), (e) => e.code === '55000' && /sql165_(definer_cannot_read|prerequisite_missing|not_payroll_owner)/.test(e.message));
  await api.end();
  const before = await catalog();
  assert.doesNotMatch(before.cols, /vendor_tenant_id/);
  assert.equal((await admin.query("SELECT to_regprocedure('public.aws_vendor_payees_for_tenant(uuid)') AS r")).rows[0].r, null);

  // Applied twice by the owner.
  const owner = await connectAs('checksops_admin');
  await owner.query(TEXT);
  await owner.query(TEXT);
  await owner.end();
  const after = await catalog();
  assert.equal(after.acl, before.acl, 'payroll_runs table grants unchanged');
  assert.equal(after.policies, before.policies, 'payroll_runs policies unchanged');
  assert.equal(after.tenants, before.tenants, 'no tenants row changed');
  assert.equal(after.cols, `${before.cols},vendor_tenant_id`);

  // The function.
  const props = (await admin.query(
    `SELECT p.prosecdef, p.provolatile::text AS vol, pg_get_userbyid(p.proowner) AS owner,
            has_function_privilege('checksops', p.oid, 'EXECUTE') AS api,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
            EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_exec,
            p.proconfig
       FROM pg_proc p WHERE p.oid = 'public.aws_vendor_payees_for_tenant(uuid)'::regprocedure`)).rows[0];
  assert.deepEqual(props, { prosecdef: true, vol: 's', owner: 'checksops_admin', api: true, auth: false, public_exec: false, proconfig: ['search_path=public', 'row_security=off'] });

  // payroll_runs: the renderings the spec pins (search_path pg_catalog, as the engine reads them).
  await admin.query("SELECT set_config('search_path', 'pg_catalog', false)");
  const spec = RELEASE_SQL_SPECS.sql165;
  const constraints = Object.fromEntries((await admin.query(
    `SELECT conname, pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
      WHERE conrelid = 'public.payroll_runs'::regclass AND conname = ANY ($1::text[])`, [spec.constraints.map((c) => c.name)])).rows
    .map((r) => [r.conname, [r.def, r.convalidated]]));
  assert.deepEqual(constraints, Object.fromEntries(spec.constraints.map((c) => [c.name, [c.def, true]])));
  const index = (await admin.query(
    "SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'payroll_runs_vendor_tenant_idx'")).rows[0].def;
  assert.equal(index, spec.indexes[0].def);
  const columns = Object.fromEntries((await admin.query(
    `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull, a.attacl::text AS acl
       FROM pg_attribute a WHERE a.attrelid = 'public.payroll_runs'::regclass AND a.attname IN ('stakeholder_account_id', 'vendor_tenant_id')`)).rows
    .map((r) => [r.attname, [r.type, r.attnotnull, r.acl]]));
  assert.deepEqual(columns, {
    stakeholder_account_id: ['uuid', false, null],
    vendor_tenant_id: ['uuid', false, '{checksops=a/checksops_admin}'],
  });
  await admin.query("SELECT set_config('search_path', 'public', false)");
  assert.equal((await admin.query('SELECT stakeholder_account_id, vendor_tenant_id FROM public.payroll_runs WHERE id = $1', [RUN_BEFORE])).rows[0].stakeholder_account_id, STAKEHOLDER_A);

  // Vendors and links (SQL 141's own functions).
  for (const v of [VENDOR, VENDOR_UNMARKED, VENDOR_LAPSED, VENDOR_REMOVED]) assert.equal((await setVendor(connectAs, PLATFORM_OWNER, v, true)).value.ok, true);
  for (const code of ['VEND165', 'BOLT165', 'CREST165', 'DELTA165']) assert.equal((await add(connectAs, MEMBER_A, TENANT_A, code)).value.ok, true, code);
  assert.equal((await add(connectAs, MEMBER_B, TENANT_B, 'VEND165')).value.ok, true);

  // Why the lookup is needed: a paying member reads no vendor_tenants row through the API login.
  const direct = await asApi(connectAs, MEMBER_A, async (c) => (await c.query('SELECT tenant_id FROM public.vendor_tenants')).rows, { commit: false });
  assert.deepEqual(direct.value, []);

  // Refusals.
  assert.deepEqual((await lookup(connectAs, MEMBER_B, TENANT_A)).value, { ok: false, error: 'forbidden' });
  assert.deepEqual((await lookup(connectAs, null, TENANT_A)).value, { ok: false, error: 'forbidden' });
  assert.deepEqual((await lookup(connectAs, MEMBER_A, null)).value, { ok: false, error: 'forbidden' });
  assert.deepEqual((await lookup(connectAs, PLATFORM_OWNER, TENANT_A)).value, { ok: false, error: 'forbidden' }, 'members only');

  const payees = async () => {
    const r = (await lookup(connectAs, MEMBER_A, TENANT_A)).value;
    assert.equal(r.ok, true);
    assert.equal(r.tenant_id, TENANT_A);
    return Object.fromEntries(r.payees.map((p) => [p.vendor_tenant_id, p]));
  };
  let list = await payees();
  assert.deepEqual(Object.keys(list), [VENDOR, VENDOR_UNMARKED, VENDOR_LAPSED, VENDOR_REMOVED], 'by vendor name');
  const acme = list[VENDOR];
  assert.deepEqual(Object.keys(acme).sort(), ['added_at', 'is_vendor', 'link_id', 'partner_code_used', 'payable', 'subscription_status', 'vendor_name', 'vendor_tenant_id']);
  assert.deepEqual([acme.vendor_name, acme.partner_code_used, acme.is_vendor, acme.subscription_status, acme.payable], ['Acme Supply', 'VEND165', true, 'active', true]);
  assert.match(acme.link_id, /^[0-9a-f-]{36}$/);
  assert.equal((await lookup(connectAs, MEMBER_B, TENANT_B)).value.payees.length, 1, 'only the caller\'s own links');

  // Unmarked, lapsed and removed take effect at once.
  assert.equal((await setVendor(connectAs, PLATFORM_OWNER, VENDOR_UNMARKED, false)).value.ok, true);
  await admin.query("UPDATE public.tenants SET subscription_status = 'past_due' WHERE id = $1", [VENDOR_LAPSED]);
  assert.equal((await remove(connectAs, MEMBER_A, TENANT_A, VENDOR_REMOVED)).value.ok, true);
  list = await payees();
  assert.deepEqual(Object.keys(list), [VENDOR, VENDOR_UNMARKED, VENDOR_LAPSED]);
  assert.deepEqual([list[VENDOR_UNMARKED].is_vendor, list[VENDOR_UNMARKED].payable], [false, false]);
  assert.deepEqual([list[VENDOR_LAPSED].is_vendor, list[VENDOR_LAPSED].subscription_status, list[VENDOR_LAPSED].payable], [true, 'past_due', false]);
  assert.equal(list[VENDOR].payable, true);
  // A tenant with no links.
  await admin.query(`INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ('${TENANT_B}', '${MEMBER_A}', 'viewer')`);
  assert.equal((await remove(connectAs, MEMBER_B, TENANT_B, VENDOR)).value.ok, true);
  assert.deepEqual((await lookup(connectAs, MEMBER_A, TENANT_B)).value, { ok: true, tenant_id: TENANT_B, payees: [] });

  // payroll_runs as the API writes it (exactly one payee).
  const vendorRun = await insertRun(connectAs, { vendor: VENDOR });
  assert.equal(vendorRun.error, null, String(vendorRun.error));
  assert.equal((await admin.query('SELECT vendor_tenant_id, stakeholder_account_id FROM public.payroll_runs WHERE id = $1', [vendorRun.value.rows[0].id])).rows[0].vendor_tenant_id, VENDOR);
  assert.equal((await insertRun(connectAs, { stakeholder: STAKEHOLDER_A })).error, null);
  assert.equal((await insertRun(connectAs, {})).error?.code, '23514');
  assert.equal((await insertRun(connectAs, { stakeholder: STAKEHOLDER_A, vendor: VENDOR })).error?.code, '23514');
  assert.equal((await insertRun(connectAs, { vendor: '16500000-0000-4000-8000-0000000000ff' })).error?.code, '23503');
  // Another organization's member still cannot write tenant A's runs (the policies are unchanged).
  const other = await asApi(connectAs, MEMBER_B, (c) => c.query(
    `INSERT INTO public.payroll_runs (tenant_id, vendor_tenant_id, amount, initiated_by) VALUES ($1::uuid, $2::uuid, 1, $3::uuid)`,
    [TENANT_A, VENDOR, MEMBER_B]));
  assert.equal(other.error?.code, '42501');
}));
