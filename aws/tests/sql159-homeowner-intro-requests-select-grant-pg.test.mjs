/**
 * SQL 159 (aws/workflows/sql/159_homeowner_intro_requests_select_grant.sql) on PostgreSQL 16, through its production
 * tool, the owner the non-superuser checksops_admin login, with the read the contractor's Leads list
 * (src/components/networking/ContractorLeadsCard.tsx) sends through /prep/data/query, run as checksops:
 *
 *   - production's grants (neither checksops nor authenticated holds SELECT on the table): the Leads read is
 *     refused at the grant layer ("permission denied for table homeowner_intro_requests", the production log of
 *     2026-11-10); the inspect reads the no-grant pre-state; one apply reaches the intended fingerprint and adds
 *     exactly checksops SELECT; service_role's grant is unchanged; then the contractor reads their lead and another
 *     user reads none (aws_select_homeowner_intro_requests decides); writes are still refused at the grant layer; the
 *     file run again is a no-op and the tool refuses a re-apply as already in place;
 *   - the table missing: the inspect names it and the file fails closed (sql159_table_missing) with nothing changed.
 *
 * Run: node --test aws/tests/sql159-homeowner-intro-requests-select-grant-pg.test.mjs (as root the PG helpers run the
 * server as the ubuntu account).
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
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { CONTRACTOR, LEADS_READ, LEAD_ID, OTHER_USER, TABLE, homeownerIntroSchema } from './helpers/sql159-homeowner-intro-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql159';
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin(KEY, ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
/** The production pre-state (also derived without a database by release-sql159-executor.test.mjs). */
const NO_GRANT = releaseStateHash(KEY, { privileges: { [TABLE]: { exists: true, lines: [] } } });

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
  const workstream = 'prod-sql159-pg-test';
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
    one_use_id: `sql159-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-11-12T00:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql159-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

async function withPg(t, prefix, port, fn) {
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [homeownerIntroSchema()] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/** The table's ACL, owner excluded; null when the table is missing. */
async function tableAcl(admin) {
  const { rows } = await admin.query(`SELECT pg_catalog.pg_get_userbyid(a.grantee) || ' ' || a.privilege_type AS line
    FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE c.oid = pg_catalog.to_regclass($1) AND a.grantee <> c.relowner ORDER BY 1`, [TABLE]);
  return rows.map((r) => r.line);
}
/** Column ACLs (a column grant would show here). */
async function columnAcls(admin) {
  const { rows } = await admin.query(`SELECT a.attname AS name, a.attacl::text AS acl FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [TABLE]);
  return Object.fromEntries(rows.map((r) => [r.name, r.acl]));
}

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
const deniedOnTable = (result) => {
  assert.equal(result.error?.code, '42501', JSON.stringify(result));
  assert.match(result.error.message, /permission denied for table homeowner_intro_requests/);
};
const STATUS_UPDATE = `UPDATE ${TABLE} SET status = 'contacted', contacted_at = now() WHERE id = $1::uuid`;
const INTRO_INSERT = `INSERT INTO ${TABLE} (contractor_user_id, homeowner_name, homeowner_email) VALUES ($1::uuid, 'X', 'x@example.invalid')`;

test('PostgreSQL 16: production\'s grants: the Leads read is refused at the grant layer; SQL 159 through its production tool adds checksops SELECT only; then RLS decides the rows and writes stay refused', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql159-prd-', 59258, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  assert.deepEqual(await tableAcl(admin), ['service_role SELECT']);
  const columnsBefore = await columnAcls(admin);

  // Before SQL 159: the production log's error, for the contractor whose lead it is.
  deniedOnTable(await asApi(connectAs, CONTRACTOR, LEADS_READ));

  const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.deepEqual(s.missing_dependencies ?? [], []);
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, {});
  assert.equal(s.live_definition_sha256, NO_GRANT);
  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, NO_GRANT);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);

  // Exactly checksops SELECT added; service_role's grant and every column ACL unchanged.
  const after = await tableAcl(admin);
  assert.deepEqual(after, ['checksops SELECT', 'service_role SELECT']);
  assert.deepEqual(await columnAcls(admin), columnsBefore);

  // After SQL 159: the contractor reads their lead; another user reads none (aws_select_homeowner_intro_requests).
  const mine = await asApi(connectAs, CONTRACTOR, LEADS_READ);
  assert.equal(mine.error, undefined, String(mine.error));
  assert.deepEqual(mine.rows.map((r) => r.id), [LEAD_ID]);
  const other = await asApi(connectAs, OTHER_USER, LEADS_READ);
  assert.equal(other.error, undefined, String(other.error));
  assert.deepEqual(other.rows, []);
  // No write grant: the status update and an intro insert are still refused at the grant layer.
  deniedOnTable(await asApi(connectAs, CONTRACTOR, STATUS_UPDATE, [LEAD_ID]));
  deniedOnTable(await asApi(connectAs, CONTRACTOR, INTRO_INSERT, [CONTRACTOR]));

  // Idempotent: the file again is a no-op; the tool refuses a re-apply as already in place.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(TEXT);
  } finally {
    await owner.end();
  }
  assert.deepEqual(await tableAcl(admin), after);
  const again = (await inspectReleaseProduction(KEY, { connect, pin, root: ROOT })).details;
  assert.equal(again.already_applied, true);
  assert.equal(again.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: the table missing: the inspect names it, reads the absent state, and the file fails closed (sql159_table_missing)', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql159-missing-', 59358, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  await admin.query(`DROP TABLE ${TABLE}`);
  const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.missing_dependencies, [TABLE]);
  assert.equal(s.already_applied, false);
  assert.equal(s.live_definition_sha256, releaseStateHash(KEY, {}));
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query('BEGIN');
    await assert.rejects(owner.query(TEXT), (error) => error.code === '42P01' && /sql159_table_missing/.test(error.message));
    await owner.query('ROLLBACK');
  } finally {
    await owner.end();
  }
  assert.equal((await admin.query('SELECT pg_catalog.to_regclass($1) AS r', [TABLE])).rows[0].r, null);
  const blocked = authorized(s.live_definition_sha256);
  const noApply = await executeReleaseProductionApply(KEY, manifest(blocked), { root: ROOT, pin: blocked, connect, consumedPath: consumedPath() });
  assert.equal(noApply.ok, false);
}));
