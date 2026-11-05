/**
 * SQL 143 (aws/workflows/sql/143_mortgage_companies_member_delete_unused.sql) on PostgreSQL 16, through its production
 * tool (lib/release-sql-production-apply.mjs, the owner the non-superuser checksops_admin login), with the writes made
 * as checksops (the API login) for an application user, as /data/write makes them. SQL 142 (its predecessor) is
 * applied first from its own file:
 *
 *   - before the apply a plain member and a mortgage desk agent may not add;
 *   - the read-only inspect reads the derived pre-state (SQL 142's two policies, nothing of SQL 143); a pending pin
 *     refuses; one apply reaches the intended fingerprint (SQL 142's policies dropped, the three member policies,
 *     both functions and the trigger created);
 *   - after it any tenant member and an active agent add, edit and delete an unused active company; deactivating,
 *     reactivating, an inactive add and deleting an inactive company stay platform-owner only; a non-member, an
 *     inactive agent and no user are refused;
 *   - a company used by a claim, a loss draft or check cases is refused (SQLSTATE MC143, the counts in DETAIL) for a
 *     same-tenant member, a member of another tenant who cannot see those files, an agent, the platform owner and the
 *     admin login, with nothing unlinked; an id change while used is refused;
 *   - the file run again is a no-op; the inspect reads already_applied with SQL 142 counted as applied through SQL 143
 *     (supersedes); the tool refuses a re-apply as already in place;
 *   - without SQL 142 the predecessor is missing; a referencing table with FORCE ROW LEVEL SECURITY fails the
 *     login-reads-past-RLS count; a drifted SQL 142 policy fails its count; the file's own rules agree; nothing changes.
 *
 * Run: node --test aws/tests/sql143-mortgage-companies-member-delete-tool-pg.test.mjs (needs PostgreSQL 16; as root
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
import { CLAIM_A, MEMBER_A, MEMBER_B, PLATFORM_OWNER, TENANT_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { ACTIVE_COMPANY, INACTIVE_COMPANY, mortgageCompaniesSchema } from './helpers/sql142-mortgage-companies-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql143';
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin(KEY, ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const SQL142 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/142_mortgage_companies_tenant_admin_write.sql'), 'utf8');
/** Expected pre-state (SQL 142's two policies, nothing of SQL 143; also derived by release-sql143-executor.test.mjs). */
const PRE_SQL142 = 'c62a1b0b337cca713cd8551f1a1c70f507ef451e40731baa6e8479abae51038d';

// The repository's helpers the file needs (SQL 90's any-membership test, SQL 100's active-agent test).
const SQL90 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/90_users_only_tenant_roles.sql'), 'utf8');
const ANY_MEMBER = SQL90.slice(SQL90.indexOf('CREATE OR REPLACE FUNCTION public.aws_has_any_tenant_membership()'),
  SQL90.indexOf('COMMENT ON FUNCTION public.aws_has_any_tenant_membership()'));
const SQL100 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/100_mortgage_desk_live_access.sql'), 'utf8');
const AGENT_START = SQL100.indexOf('CREATE OR REPLACE FUNCTION public.aws_is_active_mortgage_agent');
const ACTIVE_AGENT = `${SQL100.slice(AGENT_START, SQL100.indexOf('$sql100_active_agent_def$', AGENT_START))};`;

const AGENT = 'a1000000-0000-4000-8000-0000000000a1';
const OLD_AGENT = 'a1000000-0000-4000-8000-0000000000a2';
const OUTSIDER = 'a1000000-0000-4000-8000-0000000000a3';
const USED_CLAIM = '14300000-0000-4000-8000-000000000001';
const USED_DRAFT = '14300000-0000-4000-8000-000000000002';
const USED_CASE = '14300000-0000-4000-8000-000000000003';

/** The table, the helpers, agents, the three referencing tables (RLS on, tenant-scoped SELECT) and three used companies. */
const schema = () => [mortgageCompaniesSchema(), `
${ANY_MEMBER}
GRANT EXECUTE ON FUNCTION public.aws_has_any_tenant_membership() TO checksops, authenticated;
CREATE TABLE public.mortgage_agent_accounts (application_user_id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'active');
${ACTIVE_AGENT}
GRANT EXECUTE ON FUNCTION public.aws_is_active_mortgage_agent(uuid) TO checksops, authenticated;
INSERT INTO public.identity_accounts (application_user_id, email, status) VALUES
  ('${AGENT}', 'agent@example.invalid', 'active'), ('${OLD_AGENT}', 'old@example.invalid', 'active'), ('${OUTSIDER}', 'x@example.invalid', 'active');
INSERT INTO public.user_roles (user_id, role) VALUES ('${AGENT}', 'mortgage_agent'), ('${OLD_AGENT}', 'mortgage_agent');
INSERT INTO public.mortgage_agent_accounts VALUES ('${AGENT}', 'active'), ('${OLD_AGENT}', 'inactive');
ALTER TABLE public.claims ADD COLUMN mortgage_company_id uuid REFERENCES public.mortgage_companies(id);
ALTER TABLE public.loss_draft_tracking ADD COLUMN tenant_id uuid,
  ADD COLUMN mortgage_company_id uuid REFERENCES public.mortgage_companies(id) ON DELETE SET NULL;
CREATE TABLE public.check_cases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, mortgage_company_id uuid);
ALTER TABLE public.claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loss_draft_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_cases ENABLE ROW LEVEL SECURITY;
CREATE POLICY t_claims ON public.claims FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.tenant_id = org_id AND tu.user_id = auth.uid()));
CREATE POLICY t_drafts ON public.loss_draft_tracking FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.tenant_id = tenant_id AND tu.user_id = auth.uid()));
CREATE POLICY t_cases ON public.check_cases FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.tenant_id = tenant_id AND tu.user_id = auth.uid()));
GRANT SELECT ON public.claims, public.loss_draft_tracking, public.check_cases TO checksops, authenticated;
INSERT INTO public.mortgage_companies (id, name) VALUES
  ('${USED_CLAIM}', 'Used by claim'), ('${USED_DRAFT}', 'Used by loss draft'), ('${USED_CASE}', 'Used by check case');
UPDATE public.claims SET mortgage_company_id = '${USED_CLAIM}' WHERE id = '${CLAIM_A}';
INSERT INTO public.loss_draft_tracking (id, claim_id, tenant_id, mortgage_company_id) VALUES (gen_random_uuid(), '${CLAIM_A}', '${TENANT_A}', '${USED_DRAFT}');
INSERT INTO public.check_cases (tenant_id, mortgage_company_id) VALUES ('${TENANT_A}', '${USED_CASE}'), ('${TENANT_A}', '${USED_CASE}');`];

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
  const workstream = 'prod-sql143-pg-test';
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
    one_use_id: `sql143-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-11-05T12:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql143-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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

/** One statement as the API login (checksops) for an application user; committed unless `commit` is false. */
async function asApi(connectAs, user, sql, params = [], { commit = true } = {}) {
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
async function asOwner(connectAs, sql) {
  const owner = await connectAs('checksops_admin');
  try {
    return await owner.query(sql);
  } finally {
    await owner.end();
  }
}
const insert = (connectAs, user, name, { active = true } = {}) => asApi(connectAs, user,
  'INSERT INTO public.mortgage_companies (name, is_active) VALUES ($1, $2) RETURNING id', [name, active]);
const update = (connectAs, user, id, set) => asApi(connectAs, user, `UPDATE public.mortgage_companies SET ${set} WHERE id = $1 RETURNING id`, [id]);
const remove = (connectAs, user, id) => asApi(connectAs, user, 'DELETE FROM public.mortgage_companies WHERE id = $1 RETURNING id', [id]);
const RLS = (r) => r.error?.code === '42501' && /row-level security/.test(r.error.message);
const IN_USE = (r, files) => r.error?.code === 'MC143' && JSON.parse(r.error.detail).files === files
  && r.error.message === `sql143_company_in_use: this company is used by ${files} files`;
const policies = async (admin) => (await admin.query(`SELECT pol.polname FROM pg_catalog.pg_policy pol
  WHERE pol.polrelid = 'public.mortgage_companies'::regclass ORDER BY 1`)).rows.map((r) => r.polname);
const links = async (admin) => (await admin.query(`SELECT
  (SELECT count(*) FROM public.claims WHERE mortgage_company_id = '${USED_CLAIM}')::int AS claims,
  (SELECT count(*) FROM public.loss_draft_tracking WHERE mortgage_company_id = '${USED_DRAFT}')::int AS loss_drafts,
  (SELECT count(*) FROM public.check_cases WHERE mortgage_company_id = '${USED_CASE}')::int AS check_cases,
  (SELECT count(*) FROM public.mortgage_companies WHERE id IN ('${USED_CLAIM}', '${USED_DRAFT}', '${USED_CASE}'))::int AS companies`)).rows[0];
const SQL142_POLICIES = ['aws_insert_mortgage_companies_tenant_admin', 'aws_select_mortgage_companies',
  'aws_update_mortgage_companies_tenant_admin', 'aws_write_mortgage_companies'];

test('PostgreSQL 16: SQL 143 through its production tool: the derived pre-state after SQL 142, one apply on the intended fingerprint; members and active agents add, edit and delete unused companies; a used company is refused for everyone with nothing unlinked; then refused as in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql143-tool-', 61436, schema(), async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  await asOwner(connectAs, SQL142);
  // Before: a plain member (tenant A viewer) and an agent may not add.
  assert.ok(RLS(await insert(connectAs, MEMBER_A, 'X')), 'member add refused before the apply');
  assert.ok(RLS(await insert(connectAs, AGENT, 'X')), 'agent add refused before the apply');

  const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, { sql142: true });
  assert.equal(s.live_definition_sha256, PRE_SQL142);
  // A pending pin (not execute-authorized) refuses before any change.
  const pendingPin = { ...PIN, expected_live_definition_sha256: PRE_SQL142 };
  assert.equal(pendingPin.execute, false);
  const pendingApply = await executeReleaseProductionApply(KEY, manifest(pendingPin), { root: ROOT, pin: pendingPin, connect, consumedPath: consumedPath() });
  assert.equal(pendingApply.ok, false);
  assert.deepEqual(await policies(admin), SQL142_POLICIES);

  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, PRE_SQL142);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  assert.deepEqual(await policies(admin), ['aws_delete_mortgage_companies_member', 'aws_insert_mortgage_companies_member',
    'aws_select_mortgage_companies', 'aws_update_mortgage_companies_member', 'aws_write_mortgage_companies']);

  // Members of either tenant (any role) and an active agent add, edit and delete an unused active company.
  for (const user of [MEMBER_A, MEMBER_B, AGENT]) {
    const added = await insert(connectAs, user, `New ${user}`);
    assert.equal(added.rows?.length, 1, `${user} add: ${added.error?.message}`);
    const { id } = added.rows[0];
    assert.deepEqual((await update(connectAs, user, id, "contact_name = 'Pat'")).rows, [{ id }], `${user} edit`);
    assert.deepEqual((await remove(connectAs, user, id)).rows, [{ id }], `${user} delete`);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.mortgage_companies WHERE id = $1', [id])).rows[0].n, 0);
  }
  // Deactivating, reactivating, an inactive add and deleting an inactive company stay platform-owner only.
  assert.ok(RLS(await update(connectAs, MEMBER_A, ACTIVE_COMPANY, 'is_active = false')), 'deactivate refused');
  assert.deepEqual((await update(connectAs, MEMBER_A, INACTIVE_COMPANY, 'is_active = true')).rows, [], 'reactivate matches no row');
  assert.ok(RLS(await insert(connectAs, AGENT, 'Inactive', { active: false })), 'inactive add refused');
  assert.deepEqual((await remove(connectAs, MEMBER_B, INACTIVE_COMPANY)).rows, [], 'inactive delete matches no row');
  // A non-member, an inactive agent and no user are refused.
  for (const user of [OUTSIDER, OLD_AGENT, null]) {
    assert.ok(RLS(await insert(connectAs, user, 'X')), `add refused for ${user}`);
    assert.deepEqual((await update(connectAs, user, ACTIVE_COMPANY, "contact_name = 'X'")).rows, [], `edit matches no row for ${user}`);
    assert.deepEqual((await remove(connectAs, user, ACTIVE_COMPANY)).rows, [], `delete matches no row for ${user}`);
  }

  // In use: refused for a same-tenant member, a member of another tenant who cannot see the files, an agent and the
  // platform owner; the counts in DETAIL; nothing unlinked.
  const before = await links(admin);
  assert.deepEqual(before, { claims: 1, loss_drafts: 1, check_cases: 2, companies: 3 });
  for (const user of [MEMBER_A, MEMBER_B, AGENT, PLATFORM_OWNER]) {
    assert.ok(IN_USE(await remove(connectAs, user, USED_CLAIM), 1), `claim ${user}`);
    assert.ok(IN_USE(await remove(connectAs, user, USED_DRAFT), 1), `loss draft ${user}`);
    assert.ok(IN_USE(await remove(connectAs, user, USED_CASE), 2), `check cases ${user}`);
  }
  const refused = await remove(connectAs, MEMBER_B, USED_CASE);
  assert.deepEqual(JSON.parse(refused.error.detail), { files: 2, claims: 0, loss_drafts: 0, check_cases: 2 });
  // The admin login (the table owner) is refused too, and so is an id change while used.
  await assert.rejects(asOwner(connectAs, `DELETE FROM public.mortgage_companies WHERE id = '${USED_DRAFT}'`), (e) => e.code === 'MC143');
  await assert.rejects(asOwner(connectAs, `UPDATE public.mortgage_companies SET id = gen_random_uuid() WHERE id = '${USED_CASE}'`), (e) => e.code === 'MC143');
  assert.deepEqual(await links(admin), before, 'nothing unlinked');
  // The platform owner still deactivates, reactivates and deletes an unused company; a company deletes once unused.
  assert.deepEqual((await update(connectAs, PLATFORM_OWNER, ACTIVE_COMPANY, 'is_active = false')).rows, [{ id: ACTIVE_COMPANY }]);
  assert.deepEqual((await update(connectAs, PLATFORM_OWNER, ACTIVE_COMPANY, 'is_active = true')).rows, [{ id: ACTIVE_COMPANY }]);
  assert.deepEqual((await remove(connectAs, PLATFORM_OWNER, INACTIVE_COMPANY)).rows, [{ id: INACTIVE_COMPANY }]);
  await admin.query(`DELETE FROM public.check_cases WHERE mortgage_company_id = '${USED_CASE}'`);
  assert.deepEqual((await remove(connectAs, MEMBER_A, USED_CASE)).rows, [{ id: USED_CASE }]);

  // Idempotent: the file again is a no-op; SQL 142 counts as applied through SQL 143; the tool refuses a re-apply.
  await asOwner(connectAs, TEXT);
  const replayInspect = (await inspectReleaseProduction(KEY, { connect, pin, root: ROOT })).details;
  assert.equal(replayInspect.already_applied, true);
  assert.equal(replayInspect.live_definition_sha256, PIN.intended_replacement_sha256);
  assert.deepEqual(replayInspect.predecessors, { sql142: true });
  assert.deepEqual(replayInspect.precondition_failures, [], JSON.stringify(replayInspect.release_sql_inspect));
  const replay = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: SQL 143 without SQL 142, with a FORCE RLS referencing table, or with a drifted SQL 142 policy refuses the pre-conditions; the file\'s own rules agree; nothing changes', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql143-drift-', 61437, schema(), async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const triggers = async () => (await admin.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_trigger
    WHERE tgname = 'aws_mortgage_company_in_use_guard'`)).rows[0].n;
  const inspect = async () => (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;

  // No SQL 142: the predecessor is missing and so are its policies.
  const noPredecessor = await inspect();
  assert.equal(noPredecessor.already_applied, false);
  assert.deepEqual(noPredecessor.predecessors, { sql142: false });
  assert.deepEqual(noPredecessor.precondition_failures, ['predecessors_applied', 'mortgage_companies_sql142_policies_replaceable'],
    JSON.stringify(noPredecessor.release_sql_inspect));
  await assert.rejects(asOwner(connectAs, TEXT), (e) => e.code === '55000' && /sql143_sql142_policy_missing/.test(e.message));
  assert.deepEqual(await policies(admin), ['aws_select_mortgage_companies', 'aws_write_mortgage_companies']);

  // FORCE ROW LEVEL SECURITY on a referencing table: the guard would not see every row.
  await asOwner(connectAs, SQL142);
  await admin.query('ALTER TABLE public.check_cases FORCE ROW LEVEL SECURITY');
  const forced = await inspect();
  assert.deepEqual(forced.precondition_failures, ['mortgage_company_references_readable_by_login'], JSON.stringify(forced.release_sql_inspect));
  assert.equal(forced.live_definition_sha256, PRE_SQL142);
  const blocked = authorized(forced.live_definition_sha256);
  const noApply = await executeReleaseProductionApply(KEY, manifest(blocked), { root: ROOT, pin: blocked, connect, consumedPath: consumedPath() });
  assert.equal(noApply.ok, false);
  await assert.rejects(asOwner(connectAs, TEXT), (e) => /sql143_guard_cannot_see_all_rows: .*check_cases/.test(e.message));
  assert.deepEqual(await policies(admin), SQL142_POLICIES);
  assert.equal(await triggers(), 0);
  await admin.query('ALTER TABLE public.check_cases NO FORCE ROW LEVEL SECURITY');

  // A drifted SQL 142 policy: its count fails, and the file raises sql143_sql142_policy_collision.
  await admin.query('ALTER POLICY aws_update_mortgage_companies_tenant_admin ON public.mortgage_companies USING (true)');
  const drifted = await inspect();
  assert.deepEqual(drifted.precondition_failures, ['predecessors_applied', 'mortgage_companies_sql142_policies_replaceable'],
    JSON.stringify(drifted.release_sql_inspect));
  assert.notEqual(drifted.live_definition_sha256, PRE_SQL142);
  await assert.rejects(asOwner(connectAs, TEXT), (e) => e.code === '55000' && /sql143_sql142_policy_collision/.test(e.message));
  assert.deepEqual(await policies(admin), SQL142_POLICIES);
  assert.equal(await triggers(), 0);
}));
