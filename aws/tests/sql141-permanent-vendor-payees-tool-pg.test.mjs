/**
 * SQL 141 (aws/workflows/sql/141_permanent_vendor_payees.sql) on PostgreSQL 16, through its production tool
 * (lib/release-sql-production-apply.mjs, the owner the non-superuser checksops_admin login), with the functions
 * called as checksops (the API login) for an application user. The file applied directly, and every function
 * outcome, are aws/tests/sql141-permanent-vendor-payees-pg.test.mjs; this file covers the tool's path:
 *
 *   - with default privileges that grant every new table to checksops and authenticated (as on the restored
 *     databases): the read-only inspect reads the derived pre-state (every object absent), one apply reaches
 *     the intended fingerprint, both tables keep only the owner plus SELECT for checksops and authenticated,
 *     public.tenants (columns, grants, rows) is unchanged; then the platform owner marks a vendor and a member
 *     adds it by its Partner Code, with no partnership or shared check, and row-level security decides who
 *     reads the link; the file run again is a no-op and the tool refuses a re-apply as already in place;
 *   - a login that cannot read tenant_partner_code_aliases past row security (FORCE ROW LEVEL SECURITY) refuses
 *     the pre-conditions (definer_can_write_relations, the file's sql141_definer_cannot_read rule) and the
 *     apply changes nothing;
 *   - without tenant_partner_code_aliases the inspect reports the missing prerequisite and the apply refuses.
 *
 * Run: node --test aws/tests/sql141-permanent-vendor-payees-tool-pg.test.mjs (needs PostgreSQL 16; as root the
 * PG helpers run the server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  executeReleaseProductionApply,
  inspectReleaseProduction,
  loadReleaseProductionPin,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { MEMBER_A, MEMBER_B, PLATFORM_OWNER, TENANT_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql141';
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin(KEY, ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
/** Expected pre-state (every object absent; also derived without a database by release-sql141-executor.test.mjs). */
const PRE_ABSENT = '16522f0a99f22410a73e4a80e10e48a10a08162171345d72e0f72bc47338982f';
const TABLES = Object.freeze(['public.vendor_tenants', 'public.tenant_vendor_payees']);
const VENDOR = '14100000-0000-4000-8000-000000000011';

const ALIASES = `
CREATE TABLE IF NOT EXISTS public.tenant_partner_code_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.tenant_partner_code_aliases ENABLE ROW LEVEL SECURITY;
ALTER DEFAULT PRIVILEGES FOR ROLE checksops_admin IN SCHEMA public GRANT ALL ON TABLES TO checksops, authenticated;`;
const SEED = `
INSERT INTO public.tenants (id, name, partner_code, subscription_status) VALUES ('${VENDOR}', 'Tool Supply', 'TOOLVEND141', 'active');`;

const authorized = (live) => Object.freeze({
  ...PIN,
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: live,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
});
function manifest(pin) {
  const live = pin.expected_live_definition_sha256;
  const fingerprint = { sql: live };
  const workstream = 'prod-sql141-pg-test';
  return {
    workstream_id: workstream,
    branch: 'main',
    commit: 'a'.repeat(40),
    operator: 'owner',
    target_environment: 'production',
    target_component: 'production-sql',
    deployment_type: 'sql-apply',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    expected_live_definition_sha256: live,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    live_definition_sha256: live,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: pin.staging_acceptance,
    approval: { approved: true, workstream_id: workstream },
    authorization_phrase: pin.authorization_phrase,
    one_use_id: `sql141-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-11-04T13:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql141-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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

/** Each new table's ACL (owner excluded, sorted), or null when absent. */
const tableAcls = async (admin) => Object.fromEntries(await Promise.all(TABLES.map(async (t) => {
  const row = (await admin.query(`SELECT to_regclass($1) IS NOT NULL AS present,
    ARRAY(SELECT pg_catalog.pg_get_userbyid(a.grantee) || ' ' || a.privilege_type FROM pg_catalog.pg_class c
      CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a WHERE c.oid = to_regclass($1) AND a.grantee <> c.relowner)::text[] AS acl`, [t])).rows[0];
  return [t, row.present ? [...row.acl].sort() : null];
})));
const tenantsState = async (admin) => (await admin.query(
  `SELECT (SELECT relacl::text FROM pg_class WHERE oid = 'public.tenants'::regclass) AS acl,
          (SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'tenants') AS cols,
          (SELECT md5(string_agg(t::text, '|' ORDER BY t.id)) FROM public.tenants t) AS rows`)).rows[0];

test('PostgreSQL 16: SQL 141 through its production tool: the derived pre-state, one apply on the intended fingerprint with the default-privilege grants revoked, the functions work, then refused as in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql141-tool-', 61241, [ALIASES, SEED], async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const tenantsBefore = await tenantsState(admin);
  assert.deepEqual(await tableAcls(admin), Object.fromEntries(TABLES.map((tbl) => [tbl, null])));

  const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, {});
  assert.equal(s.live_definition_sha256, PRE_ABSENT);
  // A pending copy of the pin refuses before any change (the committed pin is execute-authorized since the 2026-11-13 pin change).
  const PENDING_COPY = Object.freeze({ ...PIN, authorization: 'pending', execute: false, expected_live_definition_sha256: null, staging_acceptance: { ok: false, reference: null, basis: 'test' } });
  const pendingApply = await executeReleaseProductionApply(KEY, manifest({ ...PENDING_COPY, expected_live_definition_sha256: PRE_ABSENT }), { root: ROOT, pin: PENDING_COPY, connect, consumedPath: consumedPath() });
  assert.equal(pendingApply.ok, false);
  assert.deepEqual(await tableAcls(admin), Object.fromEntries(TABLES.map((tbl) => [tbl, null])));

  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, s.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  const after = await tableAcls(admin);
  assert.deepEqual(after, Object.fromEntries(TABLES.map((tbl) => [tbl, ['authenticated SELECT', 'checksops SELECT']])));
  assert.deepEqual(await tenantsState(admin), tenantsBefore, 'public.tenants is not changed');
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.vendor_tenants')).rows[0].n, 0);

  // The functions as the API calls them: the platform owner marks the vendor; a member adds it by its code.
  assert.equal((await asApi(connectAs, MEMBER_A, fn('SELECT public.aws_platform_owner_set_tenant_vendor($1::uuid, true) AS r', [VENDOR]))).value.error, 'forbidden');
  assert.equal((await asApi(connectAs, PLATFORM_OWNER, fn('SELECT public.aws_platform_owner_set_tenant_vendor($1::uuid, true) AS r', [VENDOR]))).value.ok, true);
  const link = (await asApi(connectAs, MEMBER_A, fn('SELECT public.aws_vendor_payee_add($1::uuid, $2) AS r', [TENANT_A, 'toolvend141']))).value;
  assert.deepEqual([link.ok, link.replayed, link.vendor_tenant_id], [true, false, VENDOR]);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.tenant_partnerships')).rows[0].n, 0);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.shared_checks')).rows[0].n, 0);
  const visible = async (user) => (await asApi(connectAs, user, async (c) => (await c.query('SELECT tenant_id FROM public.tenant_vendor_payees')).rows, { commit: false })).value;
  assert.deepEqual(await visible(MEMBER_A), [{ tenant_id: TENANT_A }]);
  assert.deepEqual(await visible(MEMBER_B), []);
  // checksops cannot write either table directly.
  const direct = await asApi(connectAs, MEMBER_A, (c) => c.query('DELETE FROM public.tenant_vendor_payees'));
  assert.equal(direct.error?.code, '42501');

  // Idempotent: the file again is a no-op; the tool refuses a re-apply as already in place.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(TEXT);
  } finally {
    await owner.end();
  }
  assert.deepEqual(await tableAcls(admin), after);
  const replayInspect = (await inspectReleaseProduction(KEY, { connect, pin, root: ROOT })).details;
  assert.equal(replayInspect.already_applied, true);
  assert.equal(replayInspect.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: a login that cannot read tenant_partner_code_aliases past row security refuses the pre-conditions; nothing changes', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql141-force-', 61242, [ALIASES, 'ALTER TABLE public.tenant_partner_code_aliases FORCE ROW LEVEL SECURITY;'], async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const refused = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.equal(refused.already_applied, false);
  assert.deepEqual(refused.precondition_failures, ['definer_can_write_relations'], JSON.stringify(refused.release_sql_inspect));
  assert.equal(refused.live_definition_sha256, PRE_ABSENT);
  const blocked = authorized(refused.live_definition_sha256);
  const noApply = await executeReleaseProductionApply(KEY, manifest(blocked), { root: ROOT, pin: blocked, connect, consumedPath: consumedPath() });
  assert.equal(noApply.ok, false);
  assert.deepEqual(await tableAcls(admin), Object.fromEntries(TABLES.map((tbl) => [tbl, null])));
  // The file's own rule agrees: sql141_definer_cannot_read before any change.
  const owner = await connectAs('checksops_admin');
  try {
    await assert.rejects(owner.query(TEXT), (e) => e.code === '55000' && /sql141_definer_cannot_read/.test(e.message));
  } finally {
    await owner.end();
  }
  assert.deepEqual(await tableAcls(admin), Object.fromEntries(TABLES.map((tbl) => [tbl, null])));
}));

test('PostgreSQL 16: without tenant_partner_code_aliases the inspect reports the missing prerequisite and the apply refuses', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql141-missing-', 61243, [], async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const missing = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.equal(missing.already_applied, false);
  assert.ok(missing.precondition_failures.includes('prerequisites_present'), JSON.stringify(missing.precondition_failures));
  assert.ok(missing.missing_dependencies.includes('public.tenant_partner_code_aliases'), JSON.stringify(missing.missing_dependencies));
  const blocked = authorized(missing.live_definition_sha256);
  const noApply = await executeReleaseProductionApply(KEY, manifest(blocked), { root: ROOT, pin: blocked, connect, consumedPath: consumedPath() });
  assert.equal(noApply.ok, false);
  assert.deepEqual(await tableAcls(admin), Object.fromEntries(TABLES.map((tbl) => [tbl, null])));
}));
