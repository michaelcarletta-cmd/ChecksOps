/**
 * SQL 134 (aws/workflows/sql/134_loss_draft_escrow_write_grants.sql) on PostgreSQL 16, through its
 * production tool, the owner the non-superuser checksops_admin login, with the statements the Loss
 * Draft API change (#1464, aws/functions/api/workflow-rpc.mjs executeLossDraftAction) runs as checksops:
 *
 *   - from the grants the restored database and SQL 50 leave: mark_sent (SQL 50's columns) passes;
 *     mark_escrowed, request_draw, record_release, record_holdback and the Draws row fail at the
 *     grant layer ("permission denied for table ..."); one apply reaches the intended fingerprint,
 *     the fourteen columns gain exactly the pinned lines, the table ACLs and every other column are
 *     unchanged; then every escrow action passes and the policies decide: the Draws row is written
 *     for a draft on the member's claim, refused by aws_write_loss_draft_releases (row-level
 *     security) for a draft without a claim, and another tenant's member matches no row; a column
 *     outside the grant is still refused; the file run again is a no-op and the tool refuses a
 *     re-apply as already in place;
 *   - every pinned line already held: the inspect reports already_applied true, nothing applied;
 *   - another role's grant on one of the columns refuses the pre-conditions
 *     (column_acl_replaceable); a partial grant applies to the intended fingerprint.
 *
 * Run: node --test aws/tests/sql134-loss-draft-escrow-write-grants-pg.test.mjs (as root the PG
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
import { DRAFT_B, DRAFT_NULL, INSERT_COLUMNS, LOSS_DRAFT_SCHEMA, RELEASES, TRACKING, UPDATE_COLUMNS } from './helpers/sql134-loss-draft-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin('sql134', ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const UPD = Object.freeze(['authenticated UPDATE', 'checksops UPDATE']);
const INS = Object.freeze(['authenticated INSERT', 'checksops INSERT']);
const PINNED = Object.freeze([[TRACKING, UPDATE_COLUMNS, UPD], [RELEASES, INSERT_COLUMNS, INS]]);

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
  const workstream = 'prod-sql134-pg-test';
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
    one_use_id: `sql134-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-30T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql134-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
  const fx = await releaseFixture(pg, prefix, port, { extra: [LOSS_DRAFT_SCHEMA] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/** Each table's ACL (owner excluded) and every column's ACL. */
const acls = async (admin) => Object.fromEntries(await Promise.all([TRACKING, RELEASES].map(async (table) => [table, {
  table: (await admin.query(`SELECT pg_catalog.pg_get_userbyid(a.grantee) || ' ' || a.privilege_type AS line
    FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE c.oid = $1::regclass AND a.grantee <> c.relowner ORDER BY 1`, [table])).rows.map((r) => r.line),
  columns: Object.fromEntries((await admin.query(`SELECT a.attname AS name,
    ARRAY(SELECT pg_catalog.pg_get_userbyid(x.grantee) || ' ' || x.privilege_type FROM pg_catalog.aclexplode(a.attacl) x ORDER BY 1)::text[] AS acl
    FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [table])).rows.map((r) => [r.name, r.acl])),
}])));

/** One statement as the API login (checksops, a member of authenticated) for `user`; returns { rowCount } or { error }. */
async function asApi(connectAs, user, sql, params) {
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
// The Loss Draft API's statements (workflow-rpc.mjs executeLossDraftAction and recordLossDraftReleaseRow, #1464).
const MARK_SENT = `UPDATE ${TRACKING}
       SET escrow_status = 'sent_to_lender',
           check_sent_date = COALESCE(check_sent_date, CURRENT_DATE),
           tracking_number_sent = COALESCE($2::text, tracking_number_sent),
           last_contact_at = now(),
           updated_at = now()
       WHERE id = $1::uuid`;
const MARK_ESCROWED = `UPDATE ${TRACKING}
       SET escrow_status = 'escrowed',
           total_escrowed = $2::numeric,
           check_received_date = COALESCE(check_received_date, CURRENT_DATE),
           updated_at = now()
       WHERE id = $1::uuid`;
const REQUEST_DRAW = `UPDATE ${TRACKING}
       SET escrow_status = 'first_draw_requested',
           draw_amount_requested = COALESCE(draw_amount_requested, 0) + $2::numeric,
           draw_stage = draw_stage + 1,
           updated_at = now()
       WHERE id = $1::uuid`;
const RECORD_RELEASE = `UPDATE ${TRACKING}
       SET escrow_status = CASE
             WHEN COALESCE(draw_amount_released, 0) + $2::numeric >= COALESCE(total_escrowed, 0)
               AND COALESCE(total_escrowed, 0) > 0
             THEN 'final_release_complete'
             ELSE 'partial_release'
           END,
           draw_amount_released = COALESCE(draw_amount_released, 0) + $2::numeric,
           updated_at = now()
       WHERE id = $1::uuid`;
const RELEASE_ROW = `INSERT INTO ${RELEASES} (
           loss_draft_id, draw_number, amount_requested, amount_released,
           release_date, released_at, status, notes, created_by
         ) VALUES (
           $1::uuid,
           (SELECT COALESCE(MAX(r.draw_number), 0) + 1 FROM ${RELEASES} r WHERE r.loss_draft_id = $1::uuid),
           $2::numeric, $2::numeric,
           CURRENT_DATE, now(), 'released', $3::text, $4::uuid
         )`;
const RECORD_HOLDBACK = `UPDATE ${TRACKING}
       SET holdback_amount = $2::numeric,
           updated_at = now()
       WHERE id = $1::uuid`;
const MARK_FINAL_RELEASE = `UPDATE ${TRACKING}
       SET escrow_status = 'final_release_complete',
           draw_amount_released = COALESCE(total_escrowed, draw_amount_released),
           updated_at = now()
       WHERE id = $1::uuid`;
const LOCK = `SELECT * FROM ${TRACKING} WHERE id = $1::uuid FOR UPDATE`;
const deniedOn = (result, table) => {
  assert.equal(result.error?.code, '42501', JSON.stringify(result));
  assert.match(result.error.message, new RegExp(`permission denied for table ${table.split('.')[1]}`));
};

test('PostgreSQL 16: from the restored and SQL 50 grants, SQL 134 through its production tool: the fourteen columns gain their grant, every escrow action passes the grant layer, RLS decides, nothing else changes', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql134-prod-', 59734, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const before = await acls(admin);
  assert.deepEqual(before[RELEASES].table, ['authenticated SELECT', 'checksops SELECT']);
  for (const [table, pinned] of PINNED) for (const c of pinned) assert.deepEqual(before[table].columns[c], [], `${table}.${c}`);

  // Before SQL 134: SQL 50's columns pass (mark_sent); the escrow amounts and the Draws row are
  // refused at the grant layer, before any policy.
  assert.deepEqual(await asApi(connectAs, MEMBER_B, MARK_SENT, [DRAFT_B, 'TRK-1']), { rowCount: 1 });
  assert.deepEqual(await asApi(connectAs, MEMBER_B, LOCK, [DRAFT_B]), { rowCount: 1 });
  for (const [sql, params] of [[MARK_ESCROWED, [DRAFT_B, '1000.00']], [REQUEST_DRAW, [DRAFT_B, '250.00']], [RECORD_RELEASE, [DRAFT_B, '250.00']], [RECORD_HOLDBACK, [DRAFT_B, '100.00']], [MARK_FINAL_RELEASE, [DRAFT_B]]]) {
    deniedOn(await asApi(connectAs, MEMBER_B, sql, params), TRACKING);
  }
  deniedOn(await asApi(connectAs, MEMBER_B, RELEASE_ROW, [DRAFT_B, '250.00', 'draw 1', MEMBER_B]), RELEASES);

  const s = (await inspectReleaseProduction('sql134', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, {});
  assert.equal(s.live_definition_sha256, '7827f4c87e5bc9e7bd0def01d5f201a0a1fc26365480921896aa452e1403466d');
  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql134', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, s.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  const after = await acls(admin);
  for (const [table, pinned, lines] of PINNED) {
    assert.deepEqual(after[table].table, before[table].table, table);
    for (const [name, acl] of Object.entries(after[table].columns)) {
      assert.deepEqual(acl, pinned.includes(name) ? [...lines] : before[table].columns[name], `${table}.${name}`);
    }
  }

  // After SQL 134: every escrow action passes the grant layer and aws_write_loss_draft_tracking
  // decides (MEMBER_B, staff of TENANT_B, writes TENANT_B's check's drafts; MEMBER_A matches no row).
  assert.deepEqual(await asApi(connectAs, MEMBER_B, MARK_ESCROWED, [DRAFT_B, '1000.00']), { rowCount: 1 });
  assert.deepEqual(await asApi(connectAs, MEMBER_B, REQUEST_DRAW, [DRAFT_B, '250.00']), { rowCount: 1 });
  assert.deepEqual(await asApi(connectAs, MEMBER_B, RECORD_RELEASE, [DRAFT_B, '250.00']), { rowCount: 1 });
  assert.deepEqual(await asApi(connectAs, MEMBER_B, RELEASE_ROW, [DRAFT_B, '250.00', 'draw 1', MEMBER_B]), { rowCount: 1 });
  assert.deepEqual(await asApi(connectAs, MEMBER_B, RELEASE_ROW, [DRAFT_B, '100.00', 'draw 2', MEMBER_B]), { rowCount: 1 });
  assert.deepEqual(await asApi(connectAs, MEMBER_B, RECORD_HOLDBACK, [DRAFT_B, '100.00']), { rowCount: 1 });
  assert.deepEqual(await asApi(connectAs, MEMBER_A, MARK_ESCROWED, [DRAFT_B, '1.00']), { rowCount: 0 });
  const tracked = (await admin.query(`SELECT escrow_status, total_escrowed::text, draw_amount_requested::text, draw_stage, draw_amount_released::text, holdback_amount::text, check_received_date IS NOT NULL AS received FROM ${TRACKING} WHERE id = $1`, [DRAFT_B])).rows[0];
  assert.deepEqual(tracked, { escrow_status: 'partial_release', total_escrowed: '1000.00', draw_amount_requested: '250.00', draw_stage: 1, draw_amount_released: '250.00', holdback_amount: '100.00', received: true });
  assert.deepEqual(await asApi(connectAs, MEMBER_B, MARK_FINAL_RELEASE, [DRAFT_B]), { rowCount: 1 });
  assert.equal((await admin.query(`SELECT draw_amount_released::text FROM ${TRACKING} WHERE id = $1`, [DRAFT_B])).rows[0].draw_amount_released, '1000.00');
  const draws = (await admin.query(`SELECT draw_number, amount_requested::text, amount_released::text, holdback_amount::text, status, notes, created_by, release_date IS NOT NULL AS dated FROM ${RELEASES} WHERE loss_draft_id = $1 ORDER BY draw_number`, [DRAFT_B])).rows;
  assert.deepEqual(draws, [
    { draw_number: 1, amount_requested: '250.00', amount_released: '250.00', holdback_amount: '0.00', status: 'released', notes: 'draw 1', created_by: MEMBER_B, dated: true },
    { draw_number: 2, amount_requested: '100.00', amount_released: '100.00', holdback_amount: '0.00', status: 'released', notes: 'draw 2', created_by: MEMBER_B, dated: true },
  ]);
  // A draft without a claim: the amounts are recorded on loss_draft_tracking, but
  // aws_write_loss_draft_releases (aws_can_write_claim(NULL) is false) refuses its Draws row.
  assert.deepEqual(await asApi(connectAs, MEMBER_B, RECORD_RELEASE, [DRAFT_NULL, '50.00']), { rowCount: 1 });
  const nullClaim = await asApi(connectAs, MEMBER_B, RELEASE_ROW, [DRAFT_NULL, '50.00', 'no claim', MEMBER_B]);
  assert.equal(nullClaim.error?.code, '42501');
  assert.match(nullClaim.error.message, /new row violates row-level security policy for table "loss_draft_releases"/);
  assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${RELEASES} WHERE loss_draft_id = $1`, [DRAFT_NULL])).rows[0].n, 0);
  // Columns outside the grant are still refused at the grant layer.
  deniedOn(await asApi(connectAs, MEMBER_B, `UPDATE ${TRACKING} SET claim_id = NULL WHERE id = $1::uuid`, [DRAFT_B]), TRACKING);
  deniedOn(await asApi(connectAs, MEMBER_B, `INSERT INTO ${RELEASES} (loss_draft_id, draw_number, holdback_amount) VALUES ($1::uuid, 9, 1)`, [DRAFT_B]), RELEASES);
  deniedOn(await asApi(connectAs, MEMBER_B, `UPDATE ${RELEASES} SET notes = 'x' WHERE loss_draft_id = $1::uuid`, [DRAFT_B]), RELEASES);
  deniedOn(await asApi(connectAs, MEMBER_B, `DELETE FROM ${RELEASES} WHERE loss_draft_id = $1::uuid`, [DRAFT_B]), RELEASES);

  // Idempotent: the file again is a no-op; the tool refuses a re-apply as already in place.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(TEXT);
  } finally {
    await owner.end();
  }
  assert.deepEqual(await acls(admin), after);
  const again = (await inspectReleaseProduction('sql134', { connect, pin, root: ROOT })).details;
  assert.equal(again.already_applied, true);
  assert.equal(again.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply('sql134', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: every pinned line already held: the inspect reports already_applied true on the committed pin, nothing to apply', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql134-held-', 59834, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  await admin.query(`GRANT UPDATE (${UPDATE_COLUMNS.join(', ')}) ON TABLE ${TRACKING} TO checksops, authenticated`);
  await admin.query(`GRANT INSERT (${INSERT_COLUMNS.join(', ')}) ON TABLE ${RELEASES} TO checksops, authenticated`);
  const before = await acls(admin);
  const s = (await inspectReleaseProduction('sql134', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, true);
  assert.equal(s.live_definition_sha256, PIN.intended_replacement_sha256);
  assert.equal(s.read_only, true);
  assert.deepEqual(await acls(admin), before);
  const pin = authorized(s.live_definition_sha256);
  const replay = await executeReleaseProductionApply('sql134', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
  assert.deepEqual(await acls(admin), before);
}));

test('PostgreSQL 16: another role\'s grant on a pinned column refuses the pre-conditions; a partial grant applies to the intended fingerprint', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql134-other-', 59934, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  await admin.query('DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$');
  await admin.query(`GRANT INSERT (status) ON TABLE ${RELEASES} TO service_role`);
  const refused = (await inspectReleaseProduction('sql134', { connect, pin: PIN, root: ROOT })).details;
  assert.equal(refused.already_applied, false);
  assert.deepEqual(refused.precondition_failures, ['column_acl_replaceable'], JSON.stringify(refused.release_sql_inspect));
  const blocked = authorized(refused.live_definition_sha256);
  const noApply = await executeReleaseProductionApply('sql134', manifest(blocked), { root: ROOT, pin: blocked, connect, consumedPath: consumedPath() });
  assert.equal(noApply.ok, false);
  assert.deepEqual((await acls(admin))[RELEASES].columns.status, ['service_role INSERT']);

  // Partial: only checksops UPDATE on total_escrowed; the file adds the rest.
  await admin.query(`REVOKE INSERT (status) ON TABLE ${RELEASES} FROM service_role`);
  await admin.query(`GRANT UPDATE (total_escrowed) ON TABLE ${TRACKING} TO checksops`);
  const partial = (await inspectReleaseProduction('sql134', { connect, pin: PIN, root: ROOT })).details;
  assert.equal(partial.already_applied, false);
  assert.deepEqual(partial.precondition_failures, [], JSON.stringify(partial.release_sql_inspect));
  const pin = authorized(partial.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql134', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  const now = await acls(admin);
  for (const [table, pinned, lines] of PINNED) for (const c of pinned) assert.deepEqual(now[table].columns[c], [...lines], `${table}.${c}`);
}));
