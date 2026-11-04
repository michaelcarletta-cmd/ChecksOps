/**
 * SQL 142 (aws/workflows/sql/142_mortgage_companies_tenant_admin_write.sql) on PostgreSQL 16, through its production
 * tool (lib/release-sql-production-apply.mjs, the owner the non-superuser checksops_admin login), with the writes made
 * as checksops (the API login) for an application user, as /data/write makes them:
 *
 *   - before the apply only the platform owner may add or edit (the owner report: rls_denied for a tenant admin);
 *   - the read-only inspect reads the derived pre-state (both policies absent); the committed (pending) pin refuses;
 *     one apply reaches the intended fingerprint;
 *   - after it a tenant admin (tenant_users owner) adds an active company and edits an active one; deactivating,
 *     reactivating, adding an inactive company and deleting stay refused; a plain member is still refused; the
 *     platform owner still deactivates and reactivates; the file run again is a no-op and the tool refuses a
 *     re-apply as already in place;
 *   - a drifted owner policy refuses the pre-conditions, and the file's own rule agrees, before any change.
 *
 * Run: node --test aws/tests/sql142-mortgage-companies-tenant-admin-tool-pg.test.mjs (needs PostgreSQL 16; as root
 * the PG helpers run the server as the ubuntu account).
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
import { MEMBER_A, MEMBER_B, PLATFORM_OWNER, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { ACTIVE_COMPANY, INACTIVE_COMPANY, mortgageCompaniesSchema } from './helpers/sql142-mortgage-companies-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql142';
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin(KEY, ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
/** Expected pre-state (both policies absent; also derived without a database by release-sql142-executor.test.mjs). */
const PRE_ABSENT = 'ae3be52e6cdd57b9ba779e573a0e1cdab53c793a63893044fb124efbe81238f3';
// MEMBER_B is tenant B's owner (a tenant admin under aws_is_tenant_manager_admin); MEMBER_A is a tenant A viewer.
const TENANT_ADMIN = MEMBER_B;
const PLAIN_MEMBER = MEMBER_A;

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
  const workstream = 'prod-sql142-pg-test';
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
    one_use_id: `sql142-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-11-04T22:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql142-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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

/** One statement as the API login (checksops) for an application user; rolled back unless `commit`. */
async function asApi(connectAs, user, sql, params = [], { commit = false } = {}) {
  const c = await connectAs('checksops');
  try {
    await c.query('BEGIN');
    if (user) await c.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
    const rows = (await c.query(sql, params)).rows;
    await c.query(commit ? 'COMMIT' : 'ROLLBACK');
    return { rows, error: null };
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    return { rows: null, error };
  } finally {
    await c.end();
  }
}
const insert = (connectAs, user, { active = true } = {}) => asApi(connectAs, user,
  'INSERT INTO public.mortgage_companies (name, is_active, contact_name) VALUES ($1, $2, $3) RETURNING name', ['New Mortgage Co', active, 'Pat']);
const update = (connectAs, user, id, set) => asApi(connectAs, user,
  `UPDATE public.mortgage_companies SET ${set} WHERE id = $1 RETURNING id`, [id]);
const remove = (connectAs, user, id) => asApi(connectAs, user, 'DELETE FROM public.mortgage_companies WHERE id = $1 RETURNING id', [id]);
const RLS = (r) => r.error?.code === '42501' && /row-level security/.test(r.error.message);
const policies = async (admin) => (await admin.query(`SELECT pol.polname FROM pg_catalog.pg_policy pol
  WHERE pol.polrelid = 'public.mortgage_companies'::regclass ORDER BY 1`)).rows.map((r) => r.polname);

test('PostgreSQL 16: SQL 142 through its production tool: the derived pre-state, one apply on the intended fingerprint; tenant admins add and edit active companies; deactivate, reactivate and delete stay platform-owner only; then refused as in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql142-tool-', 61426, [mortgageCompaniesSchema()], async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  // Before: only the platform owner may write (the owner report: rls_denied for a tenant admin).
  assert.ok(RLS(await insert(connectAs, TENANT_ADMIN)), 'tenant admin add refused before the apply');
  assert.deepEqual((await update(connectAs, TENANT_ADMIN, ACTIVE_COMPANY, "contact_name = 'X'")).rows, [], 'tenant admin edit matches no row before the apply');
  assert.equal((await insert(connectAs, PLATFORM_OWNER)).rows.length, 1);

  const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, {});
  assert.equal(s.live_definition_sha256, PRE_ABSENT);
  // The committed (pending) pin refuses before any change.
  const pendingApply = await executeReleaseProductionApply(KEY, manifest({ ...PIN, expected_live_definition_sha256: PRE_ABSENT }), { root: ROOT, connect, consumedPath: consumedPath() });
  assert.equal(pendingApply.ok, false);
  assert.deepEqual(await policies(admin), ['aws_select_mortgage_companies', 'aws_write_mortgage_companies']);

  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, PRE_ABSENT);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  assert.deepEqual(await policies(admin), ['aws_insert_mortgage_companies_tenant_admin', 'aws_select_mortgage_companies',
    'aws_update_mortgage_companies_tenant_admin', 'aws_write_mortgage_companies']);

  // A tenant admin adds an active company and edits an active one.
  assert.deepEqual((await insert(connectAs, TENANT_ADMIN)).rows, [{ name: 'New Mortgage Co' }]);
  assert.deepEqual((await update(connectAs, TENANT_ADMIN, ACTIVE_COMPANY, "contact_name = 'Pat', address_line_1 = 'PO Box 1'")).rows, [{ id: ACTIVE_COMPANY }]);
  // Deactivating, reactivating, an inactive add and deleting stay refused for them.
  assert.ok(RLS(await update(connectAs, TENANT_ADMIN, ACTIVE_COMPANY, 'is_active = false')), 'deactivate refused');
  assert.deepEqual((await update(connectAs, TENANT_ADMIN, INACTIVE_COMPANY, 'is_active = true')).rows, [], 'reactivate matches no row');
  assert.ok(RLS(await insert(connectAs, TENANT_ADMIN, { active: false })), 'inactive add refused');
  assert.deepEqual((await remove(connectAs, TENANT_ADMIN, ACTIVE_COMPANY)).rows, [], 'delete matches no row');
  // A plain member is still refused.
  assert.ok(RLS(await insert(connectAs, PLAIN_MEMBER)), 'member add refused');
  assert.deepEqual((await update(connectAs, PLAIN_MEMBER, ACTIVE_COMPANY, "contact_name = 'X'")).rows, [], 'member edit matches no row');
  // The platform owner still deactivates and reactivates.
  assert.deepEqual((await update(connectAs, PLATFORM_OWNER, ACTIVE_COMPANY, 'is_active = false')).rows, [{ id: ACTIVE_COMPANY }]);
  assert.deepEqual((await update(connectAs, PLATFORM_OWNER, INACTIVE_COMPANY, 'is_active = true')).rows, [{ id: INACTIVE_COMPANY }]);

  // Idempotent: the file again is a no-op; the tool refuses a re-apply as already in place.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(TEXT);
  } finally {
    await owner.end();
  }
  const replayInspect = (await inspectReleaseProduction(KEY, { connect, pin, root: ROOT })).details;
  assert.equal(replayInspect.already_applied, true);
  assert.equal(replayInspect.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: a drifted owner policy refuses the pre-conditions; the file\'s own rule agrees; nothing changes', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql142-drift-', 61427, [mortgageCompaniesSchema(), 'ALTER POLICY aws_write_mortgage_companies ON public.mortgage_companies USING (true);'], async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const refused = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.equal(refused.already_applied, false);
  assert.deepEqual(refused.precondition_failures, ['mortgage_companies_owner_policy_intact'], JSON.stringify(refused.release_sql_inspect));
  assert.equal(refused.live_definition_sha256, PRE_ABSENT);
  const blocked = authorized(refused.live_definition_sha256);
  const noApply = await executeReleaseProductionApply(KEY, manifest(blocked), { root: ROOT, pin: blocked, connect, consumedPath: consumedPath() });
  assert.equal(noApply.ok, false);
  assert.deepEqual(await policies(admin), ['aws_select_mortgage_companies', 'aws_write_mortgage_companies']);
  const owner = await connectAs('checksops_admin');
  try {
    await assert.rejects(owner.query(TEXT), (e) => e.code === '55000' && /sql142_owner_policy_collision/.test(e.message));
  } finally {
    await owner.end();
  }
  assert.deepEqual(await policies(admin), ['aws_select_mortgage_companies', 'aws_write_mortgage_companies']);
}));
