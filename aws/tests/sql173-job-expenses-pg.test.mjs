/**
 * SQL 173 (aws/workflows/sql/173_job_expenses.sql) on PostgreSQL 16, through its production tool, the owner the
 * non-superuser checksops_admin login (production's admin login, which applies the file). Owner 2026-11-23: "Proceed with
 * the per job build. Make sure it is for insurance jobs and cash jobs": job costs paid outside ChecksOps recorded against
 * an insurance job (a claim) or a cash job. The functions are called as checksops, the API login, with
 * request.app_user_id set as the API sets it (auth.uid() is main's own text, aws/identity/sql/02_auth_uid_guc.sql);
 * SQL 90's membership helpers are verbatim (aws_is_tenant_member, aws_can_write_tenant); the SELECT policy runs on the
 * real AWS RLS helpers (aws/rls/sql 02, 10, 11); the applying login has default privileges that grant new tables to
 * checksops and authenticated.
 *
 *   - one apply through the production tool reaches the intended fingerprint from the absent pre-state; the new table has
 *     RLS on, one SELECT policy, no trigger and exactly SELECT for checksops and authenticated; both functions are
 *     SECURITY DEFINER with EXECUTE for checksops (and the owner) only;
 *   - as the API role for a signed-in member: an expense recorded against a claim of the tenant (org_id), a claim with no
 *     org_id carried by one of the tenant's checks (the API's claimBelongsToTenant rule) and a cash job of the tenant;
 *     the same idempotency key returns the same row (duplicate true) and writes nothing; the key with another expense is
 *     refused (23505); another tenant may use the same key;
 *   - refused, with nothing written: a non-member, the platform owner (not a member), a p_user_id other than the
 *     signed-in user, no signed-in user (42501); another tenant's claim or cash job, a claim no check of the tenant
 *     carries, an unknown job (P0002); both or neither job, a bad category, amount, date, paid_by, text length or key
 *     (22023);
 *   - delete soft-deletes the tenant's live expense for a member only (42501 otherwise), false for an unknown id, another
 *     tenant's expense or one already removed;
 *   - the SELECT policy: a member reads their tenant's rows only, no signed-in user reads none; the API role cannot
 *     INSERT, UPDATE or DELETE directly; deleting a cash job or a claim removes its expenses (ON DELETE CASCADE);
 *   - the file run again is a no-op (the rows kept) and the tool refuses a re-apply;
 *   - the file refuses (55000), and changes nothing, with sql173_unexpected_table, sql173_prerequisite_missing and
 *     sql173_definer_cannot_read; once applied a re-run notices sql173_already_current.
 *
 * Run: node --test aws/tests/sql173-job-expenses-pg.test.mjs (needs PostgreSQL 16; as root the PG helpers run the server
 * as the ubuntu account).
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
import { releaseStateHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { CHECK_A, CLAIM_A, MEMBER_A, MEMBER_B, PLATFORM_OWNER, TENANT_A, TENANT_B, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { SQL90_WRITE_HELPERS } from './helpers/sql145-collection-leg-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql173';
const TABLE = 'public.job_expenses';
const ADD = 'public.aws_job_expense_add(uuid, uuid, uuid, text, bigint, date, text, text, text, text, text, uuid)';
const DEL = 'public.aws_job_expense_delete(uuid, uuid, uuid)';
/** The expected pre-state: the table, its policy and both functions absent. */
const ABSENT = releaseStateHash(KEY, {});
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin(KEY, ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');

const CLAIM_VIA_CHECK = 'c1730000-0000-4000-8000-0000000000a2'; // org_id NULL, carried by a tenant A check
const CLAIM_B = 'c1730000-0000-4000-8000-0000000000b1'; // tenant B's
const CLAIM_ORPHAN = 'c1730000-0000-4000-8000-0000000000c1'; // org_id NULL, no check
const CHECK_VIA = 'c1730000-0000-4000-8000-0000000000a3';
const CASH_A = 'c1730000-0000-4000-8000-0000000000a4';
const CASH_A2 = 'c1730000-0000-4000-8000-0000000000a5';
const CASH_B = 'c1730000-0000-4000-8000-0000000000b2';
const UNKNOWN = 'c1730000-0000-4000-8000-0000000000ff';
/** No request.app_user_id at all (as a call with no sign-in). */
const NONE = Symbol('no sign-in');

/** SQL 90's membership helpers, public.cash_jobs as the restored database has it (RLS on, SELECT for the API roles), the jobs. */
const SCHEMA = [
  SQL90_WRITE_HELPERS,
  `CREATE TABLE public.cash_jobs (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, title text,
     contract_amount numeric NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
   ALTER TABLE public.cash_jobs ENABLE ROW LEVEL SECURITY;
   GRANT SELECT ON TABLE public.cash_jobs TO checksops, authenticated;
   INSERT INTO public.cash_jobs (id, tenant_id, title) VALUES
     ('${CASH_A}', '${TENANT_A}', 'Roof'), ('${CASH_A2}', '${TENANT_A}', 'Siding'), ('${CASH_B}', '${TENANT_B}', 'Gutters');
   INSERT INTO public.claims (id, org_id) VALUES ('${CLAIM_VIA_CHECK}', NULL), ('${CLAIM_B}', '${TENANT_B}'), ('${CLAIM_ORPHAN}', NULL);
   INSERT INTO public.check_intake_items (id, tenant_id, claim_id) VALUES ('${CHECK_VIA}', '${TENANT_A}', '${CLAIM_VIA_CHECK}');`,
];
/** Default privileges that grant new tables to the API roles: the file must leave only its own SELECT grants. */
const DEFAULT_PRIVILEGES = 'ALTER DEFAULT PRIVILEGES FOR ROLE checksops_admin IN SCHEMA public GRANT ALL ON TABLES TO checksops, authenticated;';

const authorized = (pin, live) => Object.freeze({
  ...pin,
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: live,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
});
function manifest(pin) {
  const live = pin.expected_live_definition_sha256;
  const fingerprint = { sql: live };
  const workstream = `prod-${pin.migration}-pg-test`;
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
    one_use_id: `${pin.migration}-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-11-23T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql173-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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

/** The file as the owner; returns { error, notices }. */
async function runFile(connectAs) {
  const owner = await connectAs('checksops_admin');
  const notices = [];
  owner.on('notice', (n) => notices.push(n.message));
  try {
    await owner.query(TEXT);
    return { error: null, notices };
  } catch (error) {
    return { error, notices };
  } finally {
    await owner.end();
  }
}

/** Every row as the owner sees it, ordered by created order then id. */
const rows = async (admin) => (await admin.query(`SELECT id::text, tenant_id::text, claim_id::text, cash_job_id::text, category,
  amount_cents::text, expense_date::text, paid_to, paid_by, notes, receipt_path, created_by::text, idempotency_key,
  deleted_at IS NOT NULL AS deleted, deleted_by::text FROM ${TABLE} ORDER BY created_at, id`)).rows;
const catalog = async (admin) => (await admin.query(`SELECT
  (SELECT count(*)::int FROM pg_catalog.pg_proc WHERE proname IN ('aws_job_expense_add', 'aws_job_expense_delete')) AS functions,
  (SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attnum) FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = pg_catalog.to_regclass('${TABLE}') AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
  (SELECT count(*)::int FROM pg_catalog.pg_policy p WHERE p.polrelid = pg_catalog.to_regclass('${TABLE}')) AS policies,
  (SELECT c.relrowsecurity FROM pg_catalog.pg_class c WHERE c.oid = pg_catalog.to_regclass('${TABLE}')) AS rls`)).rows[0];

test('PostgreSQL 16: SQL 173 through its production tool: the table, policy and functions as intended; members record and remove expenses against their claims and cash jobs only through the functions, idempotently; the policy limits reads to the tenant; re-run a no-op', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql173-prod-', 61273, [...SCHEMA, DEFAULT_PRIVILEGES], async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.deepEqual(s.release_sql_inspect.prerequisites_missing, []);
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, {});
  assert.equal(s.live_definition_sha256, ABSENT);
  const pin = authorized(PIN, s.live_definition_sha256);
  const applied = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, ABSENT);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  // The table: owned by the login, RLS on (not forced), one policy, no trigger, SELECT only for checksops and authenticated.
  const table = (await admin.query(`SELECT pg_catalog.pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
    ARRAY(SELECT p.polname::text FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid ORDER BY 1)::text[] AS policies,
    (SELECT count(*)::int FROM pg_catalog.pg_trigger g WHERE g.tgrelid = c.oid AND NOT g.tgisinternal) AS triggers,
    ARRAY(SELECT a.grantee::regrole::text || ' ' || a.privilege_type FROM pg_catalog.aclexplode(c.relacl) a WHERE a.grantee <> c.relowner ORDER BY 1)::text[] AS grants
    FROM pg_catalog.pg_class c WHERE c.oid = '${TABLE}'::regclass`)).rows[0];
  assert.deepEqual(table, { owner: 'checksops_admin', rls: true, forced: false, policies: ['aws_select_job_expenses'], triggers: 0, grants: ['authenticated SELECT', 'checksops SELECT'] });
  for (const fn of [ADD, DEL]) {
    const f = (await admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
      ARRAY(SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END FROM pg_catalog.aclexplode(p.proacl) a ORDER BY 1)::text[] AS grantees,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
      FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [fn])).rows[0];
    assert.deepEqual(f, { owner: 'checksops_admin', definer: true, grantees: ['checksops', 'checksops_admin'], authenticated: false, anon: false }, fn);
  }

  // The API login, one transaction per call (as the API runs them), for an application user (or none).
  const api = await connectAs('checksops');
  const as = async (user, sql, params = []) => {
    await api.query('BEGIN');
    try {
      if (user !== undefined && user !== NONE) await api.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
      const res = await api.query(sql, params);
      await api.query('COMMIT');
      return { rows: res.rows, error: null };
    } catch (error) {
      await api.query('ROLLBACK');
      return { rows: null, error };
    }
  };
  const base = {
    tenant: TENANT_A, claim: null, cash: CASH_A, category: 'materials', amount: 125000, date: '2026-11-20',
    paidTo: 'ABC Supply', paidBy: 'supplier_account', notes: 'Shingles and underlayment', receipt: null, key: null, user: MEMBER_A,
  };
  const add = async (over = {}, signedIn) => {
    const e = { ...base, ...over };
    const r = await as(signedIn === undefined ? e.user : signedIn, `SELECT ${ADD.replace(/\(.*$/, '')}($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) AS result`,
      [e.tenant, e.claim, e.cash, e.category, e.amount, e.date, e.paidTo, e.paidBy, e.notes, e.receipt, e.key, e.user]);
    return r.error ? { error: r.error } : r.rows[0].result;
  };
  const del = async (tenant, id, user, signedIn = user) => {
    const r = await as(signedIn, 'SELECT public.aws_job_expense_delete($1, $2, $3) AS removed', [tenant, id, user]);
    return r.error ? { error: r.error } : { removed: r.rows[0].removed };
  };
  const refused = (r, code, message) => {
    assert.ok(r.error, `expected ${code} ${message}`);
    assert.equal(r.error.code, code, r.error.message);
    assert.equal(r.error.message, message);
  };
  try {
    // A cash job of the tenant.
    const cash = await add({ key: 'expense-key-0001' });
    assert.equal(cash.error, undefined, cash.error?.message);
    assert.equal(cash.duplicate, false);
    assert.deepEqual([cash.expense.tenant_id, cash.expense.claim_id, cash.expense.cash_job_id, cash.expense.category, cash.expense.amount_cents,
      cash.expense.expense_date, cash.expense.paid_to, cash.expense.paid_by, cash.expense.created_by, cash.expense.deleted_at],
    [TENANT_A, null, CASH_A, 'materials', 125000, '2026-11-20', 'ABC Supply', 'supplier_account', MEMBER_A, null]);
    // A claim of the tenant (org_id), with the inputs normalized (trimmed, lower case, blank is NULL).
    const claim = await add({ cash: null, claim: CLAIM_A, category: ' Permit ', paidBy: ' Company_Card ', paidTo: '  ', notes: '', receipt: ` ${TENANT_A}/receipts/permit.pdf `, amount: 35000 });
    assert.equal(claim.error, undefined, claim.error?.message);
    assert.deepEqual([claim.expense.claim_id, claim.expense.cash_job_id, claim.expense.category, claim.expense.paid_by, claim.expense.paid_to, claim.expense.notes,
      claim.expense.receipt_path, claim.expense.idempotency_key], [CLAIM_A, null, 'permit', 'company_card', null, null, `${TENANT_A}/receipts/permit.pdf`, null]);
    // A claim with no org_id that one of the tenant's checks carries (claimBelongsToTenant); no paid_by.
    const via = await add({ cash: null, claim: CLAIM_VIA_CHECK, category: 'labor', paidBy: null, amount: 100000000000 });
    assert.equal(via.error, undefined, via.error?.message);
    assert.equal(via.expense.claim_id, CLAIM_VIA_CHECK);
    assert.equal(via.expense.paid_by, null);
    assert.equal((await rows(admin)).length, 3);

    // The same key and expense: the recorded row, nothing written.
    const again = await add({ key: 'expense-key-0001' });
    assert.deepEqual(again, { ...cash, duplicate: true });
    assert.equal((await rows(admin)).length, 3);
    // The same key with another expense: refused.
    refused(await add({ key: 'expense-key-0001', amount: 125001 }), '23505', 'job_expense_key_reused');
    refused(await add({ key: 'expense-key-0001', cash: CASH_A2 }), '23505', 'job_expense_key_reused');
    refused(await add({ key: 'expense-key-0001', notes: 'other' }), '23505', 'job_expense_key_reused');
    // Another tenant may use the same key.
    const other = await add({ tenant: TENANT_B, cash: CASH_B, user: MEMBER_B, key: 'expense-key-0001', category: 'equipment', paidBy: 'ach' });
    assert.equal(other.error, undefined, other.error?.message);
    assert.equal(other.duplicate, false);
    assert.notEqual(other.expense.id, cash.expense.id);
    assert.equal((await rows(admin)).length, 4);

    // Refusals, nothing written.
    const before = await rows(admin);
    refused(await add({ user: MEMBER_B }), '42501', 'job_expense_forbidden'); // not a member of tenant A
    refused(await add({ user: PLATFORM_OWNER }), '42501', 'job_expense_forbidden'); // the platform owner is not a member
    refused(await add({}, MEMBER_B), '42501', 'job_expense_forbidden'); // p_user_id is not the signed-in user
    refused(await add({}, NONE), '42501', 'job_expense_forbidden'); // no signed-in user
    refused(await add({}, ''), '42501', 'job_expense_forbidden'); // an empty sign-in
    refused(await add({ user: null }, MEMBER_A), '42501', 'job_expense_forbidden'); // no p_user_id
    refused(await add({ tenant: null }), '42501', 'job_expense_forbidden');
    refused(await add({ cash: CASH_B }), 'P0002', 'job_expense_job_not_found');
    refused(await add({ cash: null, claim: CLAIM_B }), 'P0002', 'job_expense_job_not_found');
    refused(await add({ cash: null, claim: CLAIM_ORPHAN }), 'P0002', 'job_expense_job_not_found');
    refused(await add({ cash: UNKNOWN }), 'P0002', 'job_expense_job_not_found');
    refused(await add({ cash: null, claim: UNKNOWN }), 'P0002', 'job_expense_job_not_found');
    refused(await add({ claim: CLAIM_A }), '22023', 'job_expense_invalid: job');
    refused(await add({ cash: null }), '22023', 'job_expense_invalid: job');
    for (const category of ['dumpster', '', null]) refused(await add({ category }), '22023', 'job_expense_invalid: category');
    for (const amount of [0, -1, 100000000001, null]) refused(await add({ amount }), '22023', 'job_expense_invalid: amount_cents');
    refused(await add({ date: null }), '22023', 'job_expense_invalid: expense_date');
    refused(await add({ paidBy: 'venmo' }), '22023', 'job_expense_invalid: paid_by');
    refused(await add({ paidTo: 'x'.repeat(201) }), '22023', 'job_expense_invalid: paid_to');
    refused(await add({ notes: 'x'.repeat(2001) }), '22023', 'job_expense_invalid: notes');
    refused(await add({ receipt: 'x'.repeat(501) }), '22023', 'job_expense_invalid: receipt_path');
    for (const key of ['short', 'has space in it', 'x'.repeat(101)]) refused(await add({ key }), '22023', 'job_expense_invalid: idempotency_key');
    assert.deepEqual(await rows(admin), before);
    // The limits themselves are accepted.
    const max = await add({ paidTo: 'p'.repeat(200), notes: 'n'.repeat(2000), receipt: 'r'.repeat(500), key: 'k'.repeat(100) });
    assert.equal(max.error, undefined, max.error?.message);

    // Delete: members of the tenant only; soft; once.
    refused(await del(TENANT_A, cash.expense.id, MEMBER_B), '42501', 'job_expense_forbidden');
    refused(await del(TENANT_A, cash.expense.id, MEMBER_A, MEMBER_B), '42501', 'job_expense_forbidden');
    refused(await del(TENANT_A, cash.expense.id, MEMBER_A, NONE), '42501', 'job_expense_forbidden');
    assert.deepEqual(await del(TENANT_B, cash.expense.id, MEMBER_B), { removed: false }, 'tenant A\'s expense through tenant B');
    assert.deepEqual(await del(TENANT_A, other.expense.id, MEMBER_A), { removed: false }, 'tenant B\'s expense through tenant A');
    assert.deepEqual(await del(TENANT_A, UNKNOWN, MEMBER_A), { removed: false });
    assert.deepEqual(await del(TENANT_A, cash.expense.id, MEMBER_A), { removed: true });
    const removed = (await rows(admin)).find((r) => r.id === cash.expense.id);
    assert.deepEqual([removed.deleted, removed.deleted_by], [true, MEMBER_A]);
    assert.deepEqual(await del(TENANT_A, cash.expense.id, MEMBER_A), { removed: false }, 'already removed');
    assert.equal((await rows(admin)).filter((r) => r.deleted).length, 1);
    // The key of a removed expense still answers with that row.
    assert.equal((await add({ key: 'expense-key-0001' })).expense.id, cash.expense.id);

    // The SELECT policy: a member reads the tenant's rows only; no signed-in user reads none.
    const visible = async (user) => (await as(user, `SELECT tenant_id::text AS t FROM ${TABLE}`)).rows.map((r) => r.t);
    const all = await rows(admin);
    assert.deepEqual((await visible(MEMBER_A)).sort(), all.filter((r) => r.tenant_id === TENANT_A).map((r) => r.tenant_id));
    assert.deepEqual(await visible(MEMBER_B), [TENANT_B]);
    assert.deepEqual(await visible(NONE), []);
    // The API role never writes the table itself.
    for (const sql of [`INSERT INTO ${TABLE} (tenant_id, cash_job_id, category, amount_cents, expense_date) VALUES ('${TENANT_A}', '${CASH_A}', 'other', 1, '2026-11-20')`,
      `UPDATE ${TABLE} SET amount_cents = 1`, `DELETE FROM ${TABLE}`]) {
      const r = await as(MEMBER_A, sql);
      assert.equal(r.error?.code, '42501', sql);
    }
  } finally {
    await api.end();
  }

  // The file again is a no-op (the rows kept); the tool sees it in place and refuses a re-apply.
  const kept = await rows(admin);
  const rerun = await runFile(connectAs);
  assert.equal(rerun.error, null);
  assert.ok(rerun.notices.includes('sql173_already_current'), JSON.stringify(rerun.notices));
  assert.deepEqual(await rows(admin), kept);
  const inspected = (await inspectReleaseProduction(KEY, { connect, pin, root: ROOT })).details;
  assert.equal(inspected.already_applied, true);
  assert.deepEqual(inspected.precondition_failures, []);
  assert.equal(inspected.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);

  // Deleting a job removes its expenses (ON DELETE CASCADE), as every claim child table.
  const jobs = (r) => [r.claim_id, r.cash_job_id];
  await admin.query(`DELETE FROM public.cash_jobs WHERE id = '${CASH_A}'`);
  await admin.query(`DELETE FROM public.claims WHERE id = '${CLAIM_A}'`);
  assert.ok((await rows(admin)).every((r) => !jobs(r).includes(CASH_A) && !jobs(r).includes(CLAIM_A)));
  assert.equal((await rows(admin)).length, kept.length - kept.filter((r) => jobs(r).includes(CASH_A) || jobs(r).includes(CLAIM_A)).length);
}));

test('PostgreSQL 16: the file refuses, and changes nothing, on a job_expenses table with other columns, a missing prerequisite or a login that cannot read the jobs past row security', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql173-refuse-', 61373, [
  ...SCHEMA,
  `CREATE TABLE ${TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, amount_cents bigint);
   INSERT INTO ${TABLE} (tenant_id, amount_cents) VALUES ('${TENANT_A}', 1);
   CREATE ROLE other_owner NOLOGIN;`,
], async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const before = await catalog(admin);
  assert.deepEqual(before, { functions: 0, columns: ['id', 'tenant_id', 'amount_cents'], policies: 0, rls: false });
  // The engine refuses the pre-state too: the table is not the intended one.
  const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.ok(s.precondition_failures.includes('created_tables_absent_or_intended'), JSON.stringify(s.precondition_failures));
  assert.equal(s.already_applied, false);

  const unexpected = await runFile(connectAs);
  assert.equal(unexpected.error?.code, '55000', unexpected.error?.message);
  assert.equal(unexpected.error.message, 'sql173_unexpected_table: public.job_expenses has columns {amount_cents,id,tenant_id}');
  assert.deepEqual(await catalog(admin), before);
  await admin.query(`DROP TABLE ${TABLE}`);
  const absent = { functions: 0, columns: null, policies: 0, rls: null };

  // A missing prerequisite (a table, a column, SQL 90's helper): refused before anything is created.
  for (const [rename, undo, missing] of [
    ['ALTER TABLE public.cash_jobs RENAME TO cash_jobs_sql173_test', 'ALTER TABLE public.cash_jobs_sql173_test RENAME TO cash_jobs', 'public.cash_jobs'],
    ['ALTER TABLE public.claims RENAME COLUMN org_id TO org_id_sql173_test', 'ALTER TABLE public.claims RENAME COLUMN org_id_sql173_test TO org_id', 'column public.claims.org_id'],
    ['ALTER FUNCTION public.aws_can_write_tenant(uuid) RENAME TO aws_can_write_tenant_sql173_test', 'ALTER FUNCTION public.aws_can_write_tenant_sql173_test(uuid) RENAME TO aws_can_write_tenant', 'public.aws_can_write_tenant(uuid)'],
  ]) {
    await admin.query(rename);
    try {
      const r = await runFile(connectAs);
      assert.equal(r.error?.code, '55000', r.error?.message);
      assert.equal(r.error.message, `sql173_prerequisite_missing: ${missing}`);
      assert.deepEqual(await catalog(admin), absent);
    } finally {
      await admin.query(undo);
    }
  }
  // The applying login does not own claims: a DEFINER filtered by row security could not find the job.
  await admin.query('ALTER TABLE public.claims OWNER TO other_owner');
  try {
    const r = await runFile(connectAs);
    assert.equal(r.error?.code, '55000', r.error?.message);
    assert.match(r.error.message, /^sql173_definer_cannot_read: /);
    assert.deepEqual(await catalog(admin), absent);
  } finally {
    await admin.query('ALTER TABLE public.claims OWNER TO checksops_admin');
  }
  // With everything in place the file applies; run again it notices it is current.
  const first = await runFile(connectAs);
  assert.equal(first.error, null, first.error?.message);
  assert.ok(!first.notices.includes('sql173_already_current'));
  const columns = ['id', 'tenant_id', 'claim_id', 'cash_job_id', 'category', 'amount_cents', 'expense_date', 'paid_to', 'paid_by', 'notes',
    'receipt_path', 'created_by', 'created_at', 'updated_at', 'deleted_at', 'deleted_by', 'idempotency_key'];
  assert.deepEqual(await catalog(admin), { functions: 2, columns, policies: 1, rls: true });
  const second = await runFile(connectAs);
  assert.equal(second.error, null);
  assert.ok(second.notices.includes('sql173_already_current'));
  assert.deepEqual(await catalog(admin), { functions: 2, columns, policies: 1, rls: true });
  const after = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.equal(after.live_definition_sha256, PIN.intended_replacement_sha256);
  assert.equal(after.already_applied, true);
}));
