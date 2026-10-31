/**
 * SQL 135 (aws/workflows/sql/135_check_create_insert_grant.sql) on PostgreSQL 16, through its
 * production tool, the owner the non-superuser checksops_admin login, with the statement the check
 * create (handleCreateCheck, aws/functions/api/workflow.mjs, POST /workflow/checks) runs as checksops:
 *
 *   - staging's grants (SQL 50's column INSERT on twenty columns for checksops and authenticated, then
 *     SQL 89): the create with claim_id is refused at the grant layer ("permission denied for table
 *     check_intake_items", the staging log of 2026-10-31); one apply reaches the intended fingerprint,
 *     the twenty-four columns carry exactly checksops INSERT (and SQL 89's checksops UPDATE where it
 *     grants it), authenticated INSERT is gone from them, the table ACL and every other column are
 *     unchanged; then the ordinary and the cash-job create pass and the policies decide (another
 *     tenant's member is refused by row-level security); a column outside the grant is still refused;
 *     the homeowner inserts pass the grant layer; the file run again is a no-op and the tool refuses a
 *     re-apply as already in place;
 *   - production's grants (checksops table-level INSERT, SQL 89): the create already passes; the apply
 *     adds the column lines, keeps the table ACL;
 *   - no INSERT anywhere (SQL 51 run): the same apply from that pre-state;
 *   - another role's grant on one of the columns refuses the pre-conditions (column_acl_replaceable);
 *   - a missing column fails the file closed (sql135_column_missing) with nothing changed.
 *
 * Run: node --test aws/tests/sql135-check-create-insert-grant-pg.test.mjs (as root the PG helpers run
 * the server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
import { MEMBER_A, MEMBER_B, TENANT_B, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { CASH_JOB_COLUMNS, INSERT_COLUMNS, TABLE, checkIntakeSchema, sql89Columns } from './helpers/sql135-check-intake-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin('sql135', ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const SQL89 = new Set(sql89Columns());
const SQL50 = Object.freeze(INSERT_COLUMNS.slice(0, 20));
/** The pinned lines of each of the twenty-four columns. */
const pinned = (c) => (SQL89.has(c) ? ['checksops INSERT', 'checksops UPDATE'] : ['checksops INSERT']);
/** Expected pre-states (also derived without a database by release-sql135-executor.test.mjs). */
const PRE_PRODUCTION = '5e147e3929d9f3ae9a8edbf9e3a1b1b896993a9b9ff88cb7d093b2e7273305e4';
const PRE_STAGING_SQL50 = '4dac49398757060deee5d636f193059e30cbe1ffdb33890122f79f026d144f33';

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
  const workstream = 'prod-sql135-pg-test';
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
    one_use_id: `sql135-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-31T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql135-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

async function withPg(t, prefix, port, mode, fn) {
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [checkIntakeSchema(mode)] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/** The table's ACL (owner excluded) and every column's ACL. */
const acls = async (admin) => ({
  table: (await admin.query(`SELECT pg_catalog.pg_get_userbyid(a.grantee) || ' ' || a.privilege_type AS line
    FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE c.oid = $1::regclass AND a.grantee <> c.relowner ORDER BY 1`, [TABLE])).rows.map((r) => r.line),
  columns: Object.fromEntries((await admin.query(`SELECT a.attname AS name,
    ARRAY(SELECT pg_catalog.pg_get_userbyid(x.grantee) || ' ' || x.privilege_type FROM pg_catalog.aclexplode(a.attacl) x ORDER BY 1)::text[] AS acl
    FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [TABLE])).rows.map((r) => [r.name, r.acl])),
});

/** One statement as the API login (checksops, a member of authenticated) for `user`; returns { rowCount, rows } or { error }. */
async function asApi(connectAs, user, sql, params) {
  const c = await connectAs('checksops');
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
    const result = await c.query(sql, params);
    await c.query('COMMIT');
    return { rowCount: result.rowCount, rows: result.rows };
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    return { error };
  } finally {
    await c.end();
  }
}

// handleCreateCheck's INSERT (aws/functions/api/workflow.mjs), built as the handler builds it.
function createStatement(cashJob) {
  const linkColumns = ['claim_id'];
  const linkValues = ['$18::uuid'];
  if (cashJob) {
    linkColumns.push('cash_job_id', 'check_source', 'cash_job_payment_class');
    linkValues.push('$19::uuid', "'cash_job'", '$20::text');
  }
  return `INSERT INTO public.check_intake_items (
         id, tenant_id, uploaded_by, status, check_stage, ocr_status,
         front_image_path, back_image_path, ocr_needs_verification,
         carrier_name, check_number, payee_line, property_address,
         funds_type, review_notes, payee_address, expiration_days,
         is_multi_payee, issue_date, amount, ${linkColumns.join(', ')}
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::text, $5::check_stage, 'pending',
         $6::text, NULL, false,
         $7::text, $8::text, $9::text, $10::text,
         $11::text, $12::text, $13::text, $14::int,
         $15::boolean, $16::date, $17::numeric, ${linkValues.join(', ')}
       ) RETURNING *`;
}
function createParams(user, tenant, { claimId = null, cashJob = null } = {}) {
  const id = crypto.randomUUID();
  return [
    id, tenant, user, 'uploaded', 'review', `checks/${id}/pending_front.jpg`,
    'Carrier', '1001', 'Payee', '1 Main St', 'acv', 'note', 'Addr', 90, false, '2026-10-31', '1234.56',
    claimId,
    ...(cashJob ? [cashJob, 'initial_deposit'] : []),
  ];
}
// The homeowner attach paths (aws/functions/api/homeowner.mjs).
const HOMEOWNER_INSERT = `INSERT INTO public.check_intake_items (
         claim_id, tenant_id, uploaded_by, front_image_path, back_image_path,
         amount, status, check_stage, check_source
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, 'uploaded', 'review', 'insurance')
       RETURNING id`;
const deniedOnTable = (result) => {
  assert.equal(result.error?.code, '42501', JSON.stringify(result));
  assert.match(result.error.message, /permission denied for table check_intake_items/);
};

async function applyAndCheck({ admin, connectAs }, expectedPre) {
  const connect = () => connectAs('checksops_admin');
  const before = await acls(admin);
  const s = (await inspectReleaseProduction('sql135', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, {});
  assert.equal(s.live_definition_sha256, expectedPre);
  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql135', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, s.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  const after = await acls(admin);
  assert.deepEqual(after.table, before.table);
  for (const [name, acl] of Object.entries(after.columns)) {
    assert.deepEqual(acl, INSERT_COLUMNS.includes(name) ? pinned(name) : before.columns[name], name);
  }
  return { before, after, pin };
}

test('PostgreSQL 16: staging\'s grants (SQL 50, SQL 89): the create is refused at the grant layer; SQL 135 through its production tool; then the ordinary and cash-job creates pass and RLS decides; nothing else changes', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql135-stg-', 59735, 'staging', async (fx) => {
  const { admin, connectAs } = fx;
  const connect = () => connectAs('checksops_admin');
  const before = await acls(admin);
  assert.deepEqual(before.table, ['authenticated SELECT', 'checksops SELECT']);
  for (const c of INSERT_COLUMNS) {
    const sql50 = SQL50.includes(c) ? ['authenticated INSERT', 'checksops INSERT'] : [];
    assert.deepEqual(before.columns[c], [...sql50, ...(SQL89.has(c) ? ['checksops UPDATE'] : [])].sort(), c);
  }

  // Before SQL 135: the create names claim_id, which no grant covers: the staging log's error.
  deniedOnTable(await asApi(connectAs, MEMBER_B, createStatement(false), createParams(MEMBER_B, TENANT_B)));
  deniedOnTable(await asApi(connectAs, MEMBER_B, HOMEOWNER_INSERT, [null, TENANT_B, MEMBER_B, 'f', 'b', '1.00']));
  // SQL 50's twenty columns alone would still pass (the create before #1317).
  const twenty = createStatement(false).replace(', claim_id\n', '\n').replace(', $18::uuid\n', '\n');
  assert.equal((await asApi(connectAs, MEMBER_B, twenty, createParams(MEMBER_B, TENANT_B).slice(0, 17))).rowCount, 1);

  const { after, pin } = await applyAndCheck(fx, PRE_STAGING_SQL50);
  for (const c of INSERT_COLUMNS) assert.ok(!after.columns[c].includes('authenticated INSERT'), c);

  // After SQL 135: the ordinary and the cash-job create pass the grant layer; RLS decides.
  const ordinary = await asApi(connectAs, MEMBER_B, createStatement(false), createParams(MEMBER_B, TENANT_B));
  assert.equal(ordinary.rowCount, 1, JSON.stringify(ordinary));
  assert.equal(ordinary.rows[0].check_source, 'insurance');
  const cashJob = crypto.randomUUID();
  const cash = await asApi(connectAs, MEMBER_B, createStatement(true), createParams(MEMBER_B, TENANT_B, { cashJob }));
  assert.equal(cash.rowCount, 1, JSON.stringify(cash));
  assert.deepEqual([cash.rows[0].cash_job_id, cash.rows[0].check_source, cash.rows[0].cash_job_payment_class], [cashJob, 'cash_job', 'initial_deposit']);
  // The homeowner attach insert names a subset of the twenty-four.
  const homeowner = await asApi(connectAs, MEMBER_B, HOMEOWNER_INSERT, [null, TENANT_B, MEMBER_B, 'f', 'b', '1.00']);
  assert.equal(homeowner.rowCount, 1, String(homeowner.error));
  // Another tenant's viewer: past the grant layer, refused by aws_write_check_intake_items.
  const other = await asApi(connectAs, MEMBER_A, createStatement(false), createParams(MEMBER_A, TENANT_B));
  assert.equal(other.error?.code, '42501', JSON.stringify(other));
  assert.match(other.error.message, /new row violates row-level security policy for table "check_intake_items"/);
  // A column outside the grant is still refused at the grant layer.
  deniedOnTable(await asApi(connectAs, MEMBER_B, `INSERT INTO ${TABLE} (id, tenant_id, routing_number) VALUES ($1::uuid, $2::uuid, '1')`, [crypto.randomUUID(), TENANT_B]));
  for (const c of CASH_JOB_COLUMNS) assert.deepEqual(after.columns[c], ['checksops INSERT'], c);

  // Idempotent: the file again is a no-op; the tool refuses a re-apply as already in place.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(TEXT);
  } finally {
    await owner.end();
  }
  assert.deepEqual(await acls(admin), after);
  const again = (await inspectReleaseProduction('sql135', { connect, pin, root: ROOT })).details;
  assert.equal(again.already_applied, true);
  assert.equal(again.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply('sql135', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: production\'s grants (checksops table-level INSERT, SQL 89): the create already passes; SQL 135 adds the column lines and keeps the table ACL', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql135-prd-', 59835, 'production', async (fx) => {
  const { admin, connectAs } = fx;
  const before = await acls(admin);
  assert.deepEqual(before.table, ['authenticated SELECT', 'checksops DELETE', 'checksops INSERT', 'checksops SELECT']);
  assert.equal((await asApi(connectAs, MEMBER_B, createStatement(true), createParams(MEMBER_B, TENANT_B, { cashJob: crypto.randomUUID() }))).rowCount, 1);
  const { after } = await applyAndCheck(fx, PRE_PRODUCTION);
  assert.deepEqual(after.table, before.table);
  assert.equal((await asApi(connectAs, MEMBER_B, createStatement(false), createParams(MEMBER_B, TENANT_B))).rowCount, 1);
}));

test('PostgreSQL 16: no INSERT anywhere (SQL 51 run): the same pre-state as production\'s column ACL; SQL 135 makes the create pass', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql135-none-', 59935, 'none', async (fx) => {
  const { connectAs } = fx;
  deniedOnTable(await asApi(connectAs, MEMBER_B, createStatement(false), createParams(MEMBER_B, TENANT_B)));
  await applyAndCheck(fx, PRE_PRODUCTION);
  assert.equal((await asApi(connectAs, MEMBER_B, createStatement(false), createParams(MEMBER_B, TENANT_B))).rowCount, 1);
}));

test('PostgreSQL 16: another role\'s grant on a pinned column refuses the pre-conditions; a missing column fails the file closed', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql135-other-', 60035, 'staging', async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  await admin.query('DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$');
  await admin.query(`GRANT INSERT (claim_id) ON TABLE ${TABLE} TO service_role`);
  const refused = (await inspectReleaseProduction('sql135', { connect, pin: PIN, root: ROOT })).details;
  assert.equal(refused.already_applied, false);
  assert.deepEqual(refused.precondition_failures, ['column_acl_replaceable'], JSON.stringify(refused.release_sql_inspect));
  const blocked = authorized(refused.live_definition_sha256);
  const noApply = await executeReleaseProductionApply('sql135', manifest(blocked), { root: ROOT, pin: blocked, connect, consumedPath: consumedPath() });
  assert.equal(noApply.ok, false);
  assert.deepEqual((await acls(admin)).columns.claim_id, ['service_role INSERT']);
  await admin.query(`REVOKE INSERT (claim_id) ON TABLE ${TABLE} FROM service_role`);

  // The file's own preconditions: a missing column raises sql135_column_missing and changes nothing.
  await admin.query(`ALTER TABLE ${TABLE} DROP COLUMN cash_job_payment_class`);
  const before = await acls(admin);
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query('BEGIN');
    await assert.rejects(owner.query(TEXT), (error) => error.code === '42703' && /sql135_column_missing: public\.check_intake_items\.cash_job_payment_class/.test(error.message));
    await owner.query('ROLLBACK');
  } finally {
    await owner.end();
  }
  assert.deepEqual(await acls(admin), before);
  const missing = (await inspectReleaseProduction('sql135', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(missing.missing_dependencies, [`column ${TABLE}.cash_job_payment_class`]);
}));
