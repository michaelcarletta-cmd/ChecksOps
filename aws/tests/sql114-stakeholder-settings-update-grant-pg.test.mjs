/**
 * SQL 114 (aws/workflows/sql/114_stakeholder_accounts_settings_update_grant.sql) on PostgreSQL 16,
 * through its production tool, the owner the non-superuser checksops_admin login:
 *
 *   - from the grants the restored database left (table-level SELECT for checksops and
 *     authenticated, no UPDATE): the Settings writes as the API login fail at the grant layer
 *     ("permission denied for table stakeholder_accounts"); one apply reaches the intended
 *     fingerprint, the six columns gain exactly UPDATE for checksops and authenticated and the
 *     table ACL and every other column are unchanged; then the writes pass the grant layer and
 *     aws_write_stakeholder_accounts decides (a staff member of the row's tenant deactivates it
 *     and changes its type; another tenant's row and a member without a write role match no
 *     row); a column outside the grant is still refused; the file run again is a no-op and the
 *     tool refuses a re-apply as already in place;
 *   - every pinned line already held: the inspect reports already_applied true, nothing applied;
 *   - another role's grant on one of the columns refuses the pre-conditions
 *     (column_acl_replaceable); a partial grant applies to the intended fingerprint.
 *
 * Run: node --test aws/tests/sql114-stakeholder-settings-update-grant-pg.test.mjs (as root the PG
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
import { MEMBER_A, MEMBER_B, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { SETTINGS_COLUMNS, STAKEHOLDERS, STAKEHOLDER_A, STAKEHOLDER_B, STAKEHOLDER_SETTINGS_SCHEMA } from './helpers/sql114-stakeholder-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin('sql114', ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const BOTH = Object.freeze(['authenticated UPDATE', 'checksops UPDATE']);

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
  const workstream = 'prod-sql114-pg-test';
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
    one_use_id: `sql114-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-25T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql114-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
  const fx = await releaseFixture(pg, prefix, port, { extra: [STAKEHOLDER_SETTINGS_SCHEMA] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/** The table ACL (owner excluded) and every column's ACL. */
const acls = async (admin) => ({
  table: (await admin.query(`SELECT pg_catalog.pg_get_userbyid(a.grantee) || ' ' || a.privilege_type AS line
    FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE c.oid = $1::regclass AND a.grantee <> c.relowner ORDER BY 1`, [STAKEHOLDERS])).rows.map((r) => r.line),
  columns: Object.fromEntries((await admin.query(`SELECT a.attname AS name,
    ARRAY(SELECT pg_catalog.pg_get_userbyid(x.grantee) || ' ' || x.privilege_type FROM pg_catalog.aclexplode(a.attacl) x ORDER BY 1)::text[] AS acl
    FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [STAKEHOLDERS])).rows.map((r) => [r.name, r.acl])),
});

/** One UPDATE as the API login (checksops, a member of authenticated) for `user`; returns { rowCount } or { error }. */
async function updateAsApi(connectAs, user, sql, params) {
  const c = await connectAs('checksops');
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
    const result = await c.query(sql, params);
    await c.query('COMMIT');
    return { rowCount: result.rowCount };
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    return { error };
  } finally {
    await c.end();
  }
}
const DEACTIVATE = `UPDATE ${STAKEHOLDERS} SET is_active = false, is_primary = false, updated_at = now() WHERE id = $1`;
const CHANGE_TYPE = `UPDATE ${STAKEHOLDERS} SET account_type = 'contractor', homeowner_name = NULL, homeowner_email = NULL, updated_at = now() WHERE id = $1`;
const RENAME = `UPDATE ${STAKEHOLDERS} SET name = 'renamed' WHERE id = $1`;

test('PostgreSQL 16: from the restored grants, SQL 114 through its production tool: the six columns gain UPDATE, the grant layer opens, RLS decides, nothing else changes', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql114-prod-', 59714, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const before = await acls(admin);
  assert.deepEqual(before.table, ['authenticated SELECT', 'checksops SELECT']);
  assert.ok(Object.values(before.columns).every((acl) => acl.length === 0));
  for (const c of SETTINGS_COLUMNS) assert.ok(Object.hasOwn(before.columns, c), c);

  // Before SQL 114: refused at the grant layer, before any policy.
  for (const sql of [DEACTIVATE, CHANGE_TYPE]) {
    const denied = await updateAsApi(connectAs, MEMBER_B, sql, [STAKEHOLDER_B]);
    assert.equal(denied.error?.code, '42501');
    assert.match(denied.error.message, /permission denied for table stakeholder_accounts/);
  }

  const s = (await inspectReleaseProduction('sql114', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, {});
  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql114', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, s.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  const after = await acls(admin);
  assert.deepEqual(after.table, before.table);
  for (const [name, acl] of Object.entries(after.columns)) {
    assert.deepEqual(acl, SETTINGS_COLUMNS.includes(name) ? [...BOTH] : before.columns[name], name);
  }

  // After SQL 114: aws_write_stakeholder_accounts decides. MEMBER_B (staff, member of TENANT_B)
  // deactivates and retypes their tenant's row; TENANT_A's row matches no row for them, and
  // MEMBER_A (no write role) matches none either.
  assert.deepEqual(await updateAsApi(connectAs, MEMBER_B, DEACTIVATE, [STAKEHOLDER_B]), { rowCount: 1 });
  assert.deepEqual(await updateAsApi(connectAs, MEMBER_B, CHANGE_TYPE, [STAKEHOLDER_B]), { rowCount: 1 });
  assert.deepEqual(await updateAsApi(connectAs, MEMBER_B, DEACTIVATE, [STAKEHOLDER_A]), { rowCount: 0 });
  assert.deepEqual(await updateAsApi(connectAs, MEMBER_A, DEACTIVATE, [STAKEHOLDER_A]), { rowCount: 0 });
  const rows = (await admin.query(`SELECT id, is_active, is_primary, account_type, homeowner_name, homeowner_email FROM ${STAKEHOLDERS} ORDER BY id`)).rows;
  assert.deepEqual(rows, [
    { id: STAKEHOLDER_A, is_active: true, is_primary: true, account_type: 'homeowner', homeowner_name: 'Home Owner A', homeowner_email: 'owner-a@example.invalid' },
    { id: STAKEHOLDER_B, is_active: false, is_primary: false, account_type: 'contractor', homeowner_name: null, homeowner_email: null },
  ]);
  // A column outside the grant is still refused at the grant layer.
  const rename = await updateAsApi(connectAs, MEMBER_B, RENAME, [STAKEHOLDER_B]);
  assert.equal(rename.error?.code, '42501');
  assert.match(rename.error.message, /permission denied for table stakeholder_accounts/);

  // Idempotent: the file again is a no-op; the tool refuses a re-apply as already in place.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(TEXT);
  } finally {
    await owner.end();
  }
  assert.deepEqual(await acls(admin), after);
  const again = (await inspectReleaseProduction('sql114', { connect, pin, root: ROOT })).details;
  assert.equal(again.already_applied, true);
  assert.equal(again.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply('sql114', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: every pinned line already held: the inspect reports already_applied true on the committed pin, nothing to apply', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql114-held-', 59814, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  await admin.query(`GRANT UPDATE (${SETTINGS_COLUMNS.join(', ')}) ON TABLE ${STAKEHOLDERS} TO checksops, authenticated`);
  const before = await acls(admin);
  const s = (await inspectReleaseProduction('sql114', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, true);
  assert.equal(s.live_definition_sha256, PIN.intended_replacement_sha256);
  assert.equal(s.read_only, true);
  assert.deepEqual(await acls(admin), before);
  const pin = authorized(s.live_definition_sha256);
  const replay = await executeReleaseProductionApply('sql114', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
  assert.deepEqual(await acls(admin), before);
}));

test('PostgreSQL 16: another role\'s grant on a pinned column refuses the pre-conditions; a partial grant applies to the intended fingerprint', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql114-other-', 59914, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  await admin.query('DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$');
  await admin.query(`GRANT UPDATE (account_type) ON TABLE ${STAKEHOLDERS} TO service_role`);
  const refused = (await inspectReleaseProduction('sql114', { connect, pin: PIN, root: ROOT })).details;
  assert.equal(refused.already_applied, false);
  assert.deepEqual(refused.precondition_failures, ['column_acl_replaceable'], JSON.stringify(refused.release_sql_inspect));
  const blocked = authorized(refused.live_definition_sha256);
  const noApply = await executeReleaseProductionApply('sql114', manifest(blocked), { root: ROOT, pin: blocked, connect, consumedPath: consumedPath() });
  assert.equal(noApply.ok, false);
  assert.deepEqual((await acls(admin)).columns.account_type, ['service_role UPDATE']);

  // Partial: only checksops UPDATE on is_active; the file adds the rest.
  await admin.query(`REVOKE UPDATE (account_type) ON TABLE ${STAKEHOLDERS} FROM service_role`);
  await admin.query(`GRANT UPDATE (is_active) ON TABLE ${STAKEHOLDERS} TO checksops`);
  const partial = (await inspectReleaseProduction('sql114', { connect, pin: PIN, root: ROOT })).details;
  assert.equal(partial.already_applied, false);
  assert.deepEqual(partial.precondition_failures, [], JSON.stringify(partial.release_sql_inspect));
  const pin = authorized(partial.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql114', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  const now = await acls(admin);
  for (const c of SETTINGS_COLUMNS) assert.deepEqual(now.columns[c], [...BOTH], c);
}));
