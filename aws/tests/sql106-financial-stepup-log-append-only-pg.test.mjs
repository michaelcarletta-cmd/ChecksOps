/**
 * SQL 106 (aws/workflows/sql/106_financial_stepup_log_append_only.sql) on PostgreSQL 16, through
 * its production tool, the owner the non-superuser checksops_admin login, checksops (the API
 * login) a member of authenticated:
 *
 *   - production-like (what SQL 97's production inspect of 2026-10-21, SSM 16bcba87, showed:
 *     checksops SELECT, INSERT, UPDATE, DELETE; authenticated SELECT; anon and PUBLIC nothing;
 *     SQL 97 not applied): before, SQL 97's inspect lists other_write_grants ["checksops DELETE",
 *     "checksops UPDATE"] and checksops can rewrite a step-up row's metadata and delete it. One
 *     apply of SQL 106 reaches the intended fingerprint and removes exactly those two lines;
 *     checksops can still INSERT and SELECT but not UPDATE, DELETE or TRUNCATE; SQL 97's live
 *     fingerprint is unchanged and its inspect then lists other_write_grants []; SQL 97 then
 *     applies through its production tool (to its intended fingerprint) and SQL 106 stays
 *     applied; the file run again is a no-op and the tool refuses a re-apply;
 *   - every named role (staging order, SQL 97 first): PUBLIC, anon and authenticated write grants
 *     too (checksops could TRUNCATE through authenticated): all revoked, service_role's ALL and
 *     every SELECT / INSERT kept.
 *
 * Run: node --test aws/tests/sql106-financial-stepup-log-append-only-pg.test.mjs (as root the PG
 * helpers run the server as the ubuntu account).
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
import { MEMBER_A, TENANT_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TABLE = 'public.financial_stepup_log';
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin('sql106', ROOT);
const PIN97 = loadReleaseProductionPin('sql97', ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const SQL97_TEXT = fs.readFileSync(path.join(ROOT, PIN97.filename), 'utf8');
const GRANTEES = Object.freeze(['PUBLIC', 'anon', 'authenticated', 'checksops']);
const WRITES = Object.freeze(['UPDATE', 'DELETE', 'TRUNCATE']);
const revoked = (line) => GRANTEES.includes(line.split(' ')[0]) && WRITES.includes(line.split(' ')[1]);
// Production as SQL 97's inspect of 2026-10-21 showed it (run as the superuser, before ownership):
// checksops holds INSERT (lines ["checksops INSERT"]) plus DELETE and UPDATE, authenticated no INSERT.
const PRODUCTION_LIKE = `
REVOKE INSERT ON TABLE ${TABLE} FROM authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE ${TABLE} TO checksops;`;
// Every role SQL 106 names holds a write grant, and service_role ALL (which SQL 106 leaves).
const EVERY_ROLE = `
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT INSERT, UPDATE, DELETE ON TABLE ${TABLE} TO checksops;
GRANT UPDATE, DELETE, TRUNCATE ON TABLE ${TABLE} TO authenticated;
GRANT SELECT, UPDATE ON TABLE ${TABLE} TO anon;
GRANT DELETE, TRUNCATE ON TABLE ${TABLE} TO PUBLIC;
GRANT ALL ON TABLE ${TABLE} TO service_role;`;

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
    build_timestamp: '2026-10-21T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql106-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

async function withPg(t, prefix, port, grants, fn) {
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [grants] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/** The table's ACL lines (grantee privilege[ with grant option]), the owner excluded. */
const tableAcl = async (admin) => (await admin.query(`SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END
    || ' ' || a.privilege_type || CASE WHEN a.is_grantable THEN ' with grant option' ELSE '' END AS line
  FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
  WHERE c.oid = $1::regclass AND a.grantee <> c.relowner ORDER BY 1`, [TABLE])).rows.map((r) => r.line);

/** One statement as the API login (checksops), always rolled back; returns { error, rows }. */
async function asApi(connectAs, sql, params = [], { writer = false } = {}) {
  const c = await connectAs('checksops');
  try {
    await c.query('BEGIN');
    if (writer) await c.query("SELECT set_config('app.stepup_writer', '1', true)");
    const result = await c.query(sql, params);
    return { error: null, rows: result.rows, rowCount: result.rowCount };
  } catch (error) {
    return { error, rows: null };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
}
const SELECT_ROWS = `SELECT count(*)::int AS n FROM ${TABLE}`;
const INSERT_ROW = (source) => [`INSERT INTO ${TABLE} (user_id, tenant_id, action_key, metadata) VALUES ($1::uuid, $2::uuid, 'deposit.submit', jsonb_build_object('source', $3::text))`, [MEMBER_A, TENANT_A, source]];
const REWRITE_ROW = `UPDATE ${TABLE} SET metadata = jsonb_build_object('source', 'app_financial_totp') WHERE action_key = 'deposit.submit'`;
const DELETE_ROWS = `DELETE FROM ${TABLE}`;
const TRUNCATE = `TRUNCATE ${TABLE}`;
const assertDenied = (result, label) => {
  assert.ok(result.error, `${label}: expected a refusal`);
  assert.equal(result.error.code, '42501', `${label}: ${result.error.message}`);
  assert.match(result.error.message, /permission denied for table financial_stepup_log/, label);
};

test('PostgreSQL 16: production-like, SQL 106 then SQL 97 through their production tools: append-only for checksops, SQL 97\'s other_write_grants becomes [], SQL 97 unchanged and applicable', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql106-prod-', 60720, PRODUCTION_LIKE, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const before = await tableAcl(admin);
  assert.deepEqual(before.filter((line) => line.startsWith('checksops ')), ['checksops DELETE', 'checksops INSERT', 'checksops SELECT', 'checksops UPDATE']);
  assert.deepEqual(before.filter((line) => line.startsWith('authenticated ')), ['authenticated SELECT']);
  // anon exists (aws/rls/sql/01_role_shim.sql) and, as in production, holds nothing on the table.
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'anon'")).rows[0].n, 1);
  assert.deepEqual(before.filter((line) => /^(anon|PUBLIC) /.test(line)), []);

  // SQL 97's inspect as production reported it: its INSERT line, and the two write grants that stopped it.
  const s97 = (await inspectReleaseProduction('sql97', { connect, pin: PIN97, root: ROOT })).details;
  assert.deepEqual(s97.release_sql_inspect.table_privileges, [{ name: 'financial_stepup_log', lines: ['checksops INSERT'], other_write_grants: ['checksops DELETE', 'checksops UPDATE'] }]);
  assert.deepEqual(s97.precondition_failures, [], JSON.stringify(s97.release_sql_inspect));
  // What the review note was about: checksops can rewrite a row's metadata, and delete rows.
  assert.equal((await asApi(connectAs, REWRITE_ROW)).error, null);
  assert.equal((await asApi(connectAs, DELETE_ROWS)).error, null);

  const s = (await inspectReleaseProduction('sql106', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, {});
  assert.deepEqual(s.release_sql_inspect.table_privileges[0].lines, ['checksops DELETE', 'checksops UPDATE']);
  const pin = authorized(PIN, s.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql106', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, s.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  // Exactly checksops's UPDATE and DELETE went; its SELECT and INSERT and authenticated's SELECT stay.
  const after = await tableAcl(admin);
  assert.deepEqual(after, before.filter((line) => !revoked(line)));
  assert.deepEqual(after.filter((line) => line.startsWith('checksops ')), ['checksops INSERT', 'checksops SELECT']);

  // checksops: INSERT and SELECT still work; UPDATE, DELETE and TRUNCATE are refused at the grant layer.
  const [insertSql, insertParams] = INSERT_ROW('test');
  const inserted = await asApi(connectAs, insertSql, insertParams);
  assert.equal(inserted.error, null, inserted.error?.message);
  assert.equal(inserted.rowCount, 1);
  const selected = await asApi(connectAs, SELECT_ROWS);
  assert.equal(selected.error, null);
  assert.ok(selected.rows[0].n >= 1);
  assertDenied(await asApi(connectAs, REWRITE_ROW), 'UPDATE');
  assertDenied(await asApi(connectAs, DELETE_ROWS), 'DELETE');
  assertDenied(await asApi(connectAs, TRUNCATE), 'TRUNCATE');

  // SQL 97: its live fingerprint is unchanged (still the pre-state its inputs give), and its
  // inspect now reports other_write_grants [].
  const s97After = (await inspectReleaseProduction('sql97', { connect, pin: PIN97, root: ROOT })).details;
  assert.equal(s97After.live_definition_sha256, s97.live_definition_sha256);
  assert.deepEqual(s97After.release_sql_inspect.table_privileges[0].other_write_grants, []);
  assert.deepEqual(s97After.precondition_failures, []);
  assert.equal(s97After.already_applied, false);
  // Then SQL 97 applies through its production tool to its intended fingerprint.
  const pin97 = authorized(PIN97, s97After.live_definition_sha256);
  const applied97 = await executeReleaseProductionApply('sql97', manifest(pin97), { root: ROOT, pin: pin97, connect, consumedPath: consumedPath() });
  assert.equal(applied97.ok, true, JSON.stringify(applied97));
  assert.equal(applied97.details.receipt.after_hash, PIN97.intended_replacement_sha256);
  // With both: the server writer inserts a step-up, a client-shaped one is refused, nobody but the owner rewrites.
  const [serverSql, serverParams] = INSERT_ROW('app_financial_totp');
  assert.equal((await asApi(connectAs, serverSql, serverParams, { writer: true })).error, null);
  const forged = await asApi(connectAs, serverSql, serverParams);
  assert.equal(forged.error?.code, '42501');
  assert.match(forged.error.message, /stepup_writer_required/);
  assertDenied(await asApi(connectAs, REWRITE_ROW, [], { writer: true }), 'UPDATE after SQL 97');
  const again97 = (await inspectReleaseProduction('sql97', { connect, pin: pin97, root: ROOT })).details;
  assert.equal(again97.already_applied, true);
  assert.deepEqual(again97.release_sql_inspect.table_privileges[0].other_write_grants, []);

  // SQL 106 stays applied after SQL 97; the file again is a no-op; the tool refuses a re-apply.
  const owner = await connectAs('checksops_admin');
  const aclAfterBoth = await tableAcl(admin);
  try {
    await owner.query(TEXT);
  } finally {
    await owner.end();
  }
  assert.deepEqual(await tableAcl(admin), aclAfterBoth);
  const again = (await inspectReleaseProduction('sql106', { connect, pin, root: ROOT })).details;
  assert.equal(again.already_applied, true);
  assert.equal(again.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply('sql106', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: every named role (staging order, SQL 97 first): PUBLIC, anon, authenticated and checksops lose UPDATE / DELETE / TRUNCATE; service_role and every SELECT / INSERT are kept; run twice is a no-op', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql106-all-', 60820, EVERY_ROLE, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(SQL97_TEXT);
  } finally {
    await owner.end();
  }
  const s97 = (await inspectReleaseProduction('sql97', { connect, pin: PIN97, root: ROOT })).details;
  assert.equal(s97.live_definition_sha256, PIN97.intended_replacement_sha256);
  const before = await tableAcl(admin);
  // checksops can TRUNCATE through its membership in authenticated (and DELETE through PUBLIC).
  assert.equal((await asApi(connectAs, TRUNCATE)).error, null);

  const s = (await inspectReleaseProduction('sql106', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.release_sql_inspect.table_privileges[0].lines, ['PUBLIC DELETE', 'PUBLIC TRUNCATE', 'anon UPDATE', 'authenticated DELETE', 'authenticated TRUNCATE', 'authenticated UPDATE', 'checksops DELETE', 'checksops UPDATE']);
  const pin = authorized(PIN, s.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql106', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  const after = await tableAcl(admin);
  assert.deepEqual(after, before.filter((line) => !revoked(line)));
  for (const line of ['service_role DELETE', 'service_role INSERT', 'service_role SELECT', 'service_role TRUNCATE', 'service_role UPDATE', 'anon SELECT', 'authenticated SELECT', 'checksops INSERT', 'checksops SELECT']) {
    assert.ok(after.includes(line), line);
  }
  assert.deepEqual(after.filter(revoked), []);
  assertDenied(await asApi(connectAs, REWRITE_ROW, [], { writer: true }), 'UPDATE');
  assertDenied(await asApi(connectAs, DELETE_ROWS), 'DELETE');
  assertDenied(await asApi(connectAs, TRUNCATE), 'TRUNCATE');
  const [serverSql, serverParams] = INSERT_ROW('app_financial_totp');
  assert.equal((await asApi(connectAs, serverSql, serverParams, { writer: true })).error, null);
  // SQL 97 is still at its intended fingerprint; its inspect lists only service_role's writes.
  const s97After = (await inspectReleaseProduction('sql97', { connect, pin: PIN97, root: ROOT })).details;
  assert.equal(s97After.live_definition_sha256, PIN97.intended_replacement_sha256);
  assert.deepEqual(s97After.release_sql_inspect.table_privileges[0].other_write_grants, ['service_role DELETE', 'service_role TRUNCATE', 'service_role UPDATE']);
  // Run twice: no change.
  const second = await connectAs('checksops_admin');
  try {
    await second.query(TEXT);
  } finally {
    await second.end();
  }
  assert.deepEqual(await tableAcl(admin), after);
  assert.equal((await inspectReleaseProduction('sql106', { connect, pin, root: ROOT })).details.already_applied, true);
}));
