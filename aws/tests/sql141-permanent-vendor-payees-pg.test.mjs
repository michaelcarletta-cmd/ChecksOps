/**
 * SQL 141 (aws/workflows/sql/141_permanent_vendor_payees.sql) on PostgreSQL 16, applied as the
 * non-superuser checksops_admin owner (the release fixture, helpers/release-sql-pg.mjs), with the
 * functions called as checksops (the API login) for an application user, as the API calls DEFINER
 * functions:
 *
 *   - the applying login must own tenants: run as checksops the file fails closed (55000) and
 *     changes nothing; a missing prerequisite (no tenant_partner_code_aliases) fails closed too;
 *   - applied twice: every organization stays a regular one (is_vendor false), the second run is a
 *     no-op; the functions are SECURITY DEFINER with EXECUTE for checksops only (not PUBLIC or
 *     authenticated); checksops cannot write tenant_vendor_payees directly;
 *   - only the platform owner marks an organization as a vendor;
 *   - a member adds a vendor by its Partner Code or a Partner Code alias; a replay returns the same
 *     link; a regular organization's code, an unknown code and a malformed code are all answered
 *     vendor_not_found / invalid_code; the caller's own code is own_code; an inactive vendor is
 *     vendor_inactive; a non-member is forbidden;
 *   - adding a vendor creates no tenant partnership and no shared check;
 *   - row-level security: the paying organization's members and the platform owner read the link,
 *     another organization and the vendor do not;
 *   - remove ends the live link (history kept); the vendor can be added again.
 *
 * Run: node --test aws/tests/sql141-permanent-vendor-payees-pg.test.mjs (needs PostgreSQL 16; as root
 * the PG helpers run the server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MEMBER_A, MEMBER_B, PLATFORM_OWNER, TENANT_A, TENANT_B, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FILE = path.join(ROOT, 'aws/workflows/sql/141_permanent_vendor_payees.sql');
const TEXT = fs.readFileSync(FILE, 'utf8');

const VENDOR = '14100000-0000-4000-8000-000000000001';
const VENDOR_OFF = '14100000-0000-4000-8000-000000000002';
const VENDOR_MEMBER = '14100000-0000-4000-8000-0000000000a1';

const ALIASES = `
CREATE TABLE IF NOT EXISTS public.tenant_partner_code_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.tenant_partner_code_aliases ENABLE ROW LEVEL SECURITY;`;
const SEED = `
UPDATE public.tenants SET partner_code = 'ALPHA141' WHERE id = '${TENANT_A}';
UPDATE public.tenants SET partner_code = 'BRAVO141' WHERE id = '${TENANT_B}';
INSERT INTO public.tenants (id, name, partner_code, subscription_status) VALUES
  ('${VENDOR}', 'Acme Supply', 'VEND141', 'active'),
  ('${VENDOR_OFF}', 'Closed Supply', 'VENDOFF141', 'inactive');
INSERT INTO public.tenant_partner_code_aliases (tenant_id, code) VALUES ('${VENDOR}', 'OLDVEND141');
INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES ('${VENDOR_MEMBER}', 'vendor@example.invalid', 'active');
INSERT INTO public.profiles (id, email) VALUES ('${VENDOR_MEMBER}', 'vendor@example.invalid');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ('${VENDOR}', '${VENDOR_MEMBER}', 'owner');`;

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
async function asApi(connectAs, user, run, { commit = true } = {}) {
  const c = await connectAs('checksops');
  try {
    await c.query('BEGIN');
    if (user) await c.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
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
const add = (cx, user, tenant, code) => asApi(cx, user, fn('SELECT public.aws_vendor_payee_add($1::uuid, $2) AS r', [tenant, code]));
const remove = (cx, user, tenant, vendor) => asApi(cx, user, fn('SELECT public.aws_vendor_payee_remove($1::uuid, $2::uuid) AS r', [tenant, vendor]));
const setVendor = (cx, user, tenant, on) => asApi(cx, user, fn('SELECT public.aws_platform_owner_set_tenant_vendor($1::uuid, $2) AS r', [tenant, on]));
const visible = (cx, user) => asApi(cx, user, async (c) => (await c.query('SELECT tenant_id, vendor_tenant_id FROM public.tenant_vendor_payees ORDER BY created_at')).rows, { commit: false });

test('PostgreSQL 16: SQL 141 permanent vendors and vendor payees by Partner Code', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql141-', 61141, [ALIASES, SEED], async ({ admin, connectAs }) => {
  // Fail closed for a login that does not own tenants: nothing changes. (checksops cannot read
  // tenant_partner_code_aliases, so information_schema hides its columns and the prerequisite
  // check refuses first; either refusal is 55000 before any change.)
  const api = await connectAs('checksops');
  await assert.rejects(api.query(TEXT), (e) => e.code === '55000' && /sql141_(definer_cannot_write|prerequisite_missing)/.test(e.message));
  await api.end();
  assert.equal((await admin.query("SELECT to_regclass('public.tenant_vendor_payees') AS r")).rows[0].r, null);

  // Applied twice by the owner.
  const owner = await connectAs('checksops_admin');
  await owner.query(TEXT);
  await owner.query(TEXT);
  await owner.end();
  assert.deepEqual((await admin.query('SELECT count(*)::int AS n FROM public.tenants WHERE is_vendor')).rows[0].n, 0);

  // Function properties and ACLs.
  for (const sig of ['aws_vendor_payee_add(uuid,text)', 'aws_vendor_payee_remove(uuid,uuid)', 'aws_platform_owner_set_tenant_vendor(uuid,boolean)']) {
    const row = (await admin.query(
      `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner,
              has_function_privilege('checksops', p.oid, 'EXECUTE') AS api,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_exec
         FROM pg_proc p WHERE p.oid = $1::regprocedure`, [`public.${sig}`])).rows[0];
    assert.deepEqual(row, { prosecdef: true, owner: 'checksops_admin', api: true, auth: false, public_exec: false }, sig);
  }
  const direct = await asApi(connectAs, MEMBER_A, (c) => c.query(
    'INSERT INTO public.tenant_vendor_payees (tenant_id, vendor_tenant_id) VALUES ($1, $2)', [TENANT_A, VENDOR]));
  assert.equal(direct.error?.code, '42501');

  // Only the platform owner marks vendors.
  assert.equal((await setVendor(connectAs, MEMBER_A, VENDOR, true)).value.error, 'forbidden');
  assert.equal((await add(connectAs, MEMBER_A, TENANT_A, 'VEND141')).value.error, 'vendor_not_found');
  assert.deepEqual((await setVendor(connectAs, PLATFORM_OWNER, VENDOR, true)).value, { ok: true, tenant_id: VENDOR, is_vendor: true });
  assert.equal((await setVendor(connectAs, PLATFORM_OWNER, VENDOR_OFF, true)).value.ok, true);
  assert.equal((await setVendor(connectAs, PLATFORM_OWNER, '14100000-0000-4000-8000-0000000000ff', true)).value.error, 'tenant_not_found');

  // Refusals.
  assert.equal((await add(connectAs, MEMBER_B, TENANT_A, 'VEND141')).value.error, 'forbidden');
  assert.equal((await add(connectAs, null, TENANT_A, 'VEND141')).value.error, 'forbidden');
  assert.equal((await add(connectAs, MEMBER_A, TENANT_A, 'no spaces!')).value.error, 'invalid_code');
  assert.equal((await add(connectAs, MEMBER_A, TENANT_A, 'NOSUCH141')).value.error, 'vendor_not_found');
  assert.equal((await add(connectAs, MEMBER_A, TENANT_A, 'BRAVO141')).value.error, 'vendor_not_found', 'a regular organization is not a vendor');
  assert.equal((await add(connectAs, MEMBER_A, TENANT_A, 'ALPHA141')).value.error, 'own_code');
  assert.equal((await add(connectAs, MEMBER_A, TENANT_A, 'VENDOFF141')).value.error, 'vendor_inactive');

  // Add, replay, alias.
  const first = (await add(connectAs, MEMBER_A, TENANT_A, ' vend141 ')).value;
  assert.equal(first.ok, true);
  assert.equal(first.replayed, false);
  assert.equal(first.vendor_tenant_id, VENDOR);
  assert.equal(first.vendor_name, 'Acme Supply');
  const again = (await add(connectAs, MEMBER_A, TENANT_A, 'OLDVEND141')).value;
  assert.deepEqual([again.ok, again.replayed, again.link_id], [true, true, first.link_id]);
  assert.equal((await add(connectAs, MEMBER_B, TENANT_B, 'VEND141')).value.ok, true);

  // No partnership and no share.
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.tenant_partnerships')).rows[0].n, 0);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.shared_checks')).rows[0].n, 0);

  // Row-level security.
  assert.deepEqual((await visible(connectAs, MEMBER_A)).value, [{ tenant_id: TENANT_A, vendor_tenant_id: VENDOR }]);
  assert.deepEqual((await visible(connectAs, MEMBER_B)).value, [{ tenant_id: TENANT_B, vendor_tenant_id: VENDOR }]);
  assert.deepEqual((await visible(connectAs, VENDOR_MEMBER)).value, []);
  assert.equal((await visible(connectAs, PLATFORM_OWNER)).value.length, 2);

  // Remove, history kept, add again.
  assert.equal((await remove(connectAs, MEMBER_B, TENANT_A, VENDOR)).value.error, 'forbidden');
  assert.equal((await remove(connectAs, MEMBER_A, TENANT_A, VENDOR)).value.ok, true);
  assert.equal((await remove(connectAs, MEMBER_A, TENANT_A, VENDOR)).value.error, 'not_found');
  const readded = (await add(connectAs, MEMBER_A, TENANT_A, 'VEND141')).value;
  assert.equal(readded.replayed, false);
  assert.notEqual(readded.link_id, first.link_id);
  const rows = (await admin.query(
    'SELECT (removed_at IS NULL) AS live, removed_by FROM public.tenant_vendor_payees WHERE tenant_id = $1 ORDER BY created_at', [TENANT_A])).rows;
  assert.deepEqual(rows, [{ live: false, removed_by: MEMBER_A }, { live: true, removed_by: null }]);

  // Turning the flag off: links stay as history, new adds are refused.
  assert.equal((await setVendor(connectAs, PLATFORM_OWNER, VENDOR, false)).value.ok, true);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.tenant_vendor_payees WHERE vendor_tenant_id = $1', [VENDOR])).rows[0].n, 3);
  assert.equal((await add(connectAs, MEMBER_B, TENANT_B, 'VEND141')).value.error, 'vendor_not_found');
}));

test('PostgreSQL 16: SQL 141 fails closed without tenant_partner_code_aliases', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql141-pre-', 61142, [], async ({ admin, connectAs }) => {
  const owner = await connectAs('checksops_admin');
  await assert.rejects(owner.query(TEXT), (e) => e.code === '55000' && /sql141_prerequisite_missing/.test(e.message) && /tenant_partner_code_aliases/.test(e.message));
  await owner.end();
  assert.equal((await admin.query("SELECT to_regclass('public.tenant_vendor_payees') AS r")).rows[0].r, null);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'is_vendor'")).rows[0].n, 0);
}));
