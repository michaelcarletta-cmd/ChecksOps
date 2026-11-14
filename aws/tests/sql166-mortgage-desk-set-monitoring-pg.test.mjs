/**
 * SQL 166 (aws/workflows/sql/166_mortgage_desk_set_monitoring.sql) on PostgreSQL 16, through its production tool
 * (lib/release-sql-production-apply.mjs, the owner the non-superuser checksops_admin login), with the calls made as
 * checksops (the API login) for an application user. SQL 122's real aws_mortgage_desk_working_request is the gate; the
 * loss draft, audit and message tables carry their real policies (helpers/sql166-desk-monitoring-schema.mjs):
 *
 *   - before the apply the assigned agent cannot update the loss draft directly (aws_write_loss_draft_tracking is
 *     members only) and the function is absent; the read-only inspect reads the derived pre-state; a pending pin
 *     refuses; one apply reaches the intended fingerprint (EXECUTE for checksops and the owner only);
 *   - after it the assigned agent switches an in-progress request's loss draft to Not Monitored and back: each change
 *     writes the type, one audit row in loss_draft_action's shape and one check message the tenant member reads; the
 *     same type again writes nothing; the platform owner may too;
 *   - another agent, a tenant member, no user, a requested or completed request, a check without a loss draft, a closed
 *     file (endorsing, final_release_complete) and a bad type are refused, writing nothing;
 *   - with escrow or draws recorded the switch still succeeds and returns escrow_or_draws_recorded true;
 *   - authenticated and a plain login cannot execute it; the file run again is a no-op; the tool refuses a re-apply;
 *   - FORCE ROW LEVEL SECURITY on a relation it reaches, or a missing column, refuses the pre-conditions and the file.
 *
 * Run: node --test aws/tests/sql166-mortgage-desk-set-monitoring-pg.test.mjs (needs PostgreSQL 16; as root the PG
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
import { releaseStateHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { CHECK_A, MEMBER_A, PLATFORM_OWNER, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import {
  AGENT, CHECK_CLOSED, CHECK_NO_DRAFT, DRAFT_A, OTHER_AGENT, REQ, REQ_CLOSED, REQ_COMPLETED, REQ_NO_DRAFT, REQ_QUEUED, deskMonitoringSchema,
} from './helpers/sql166-desk-monitoring-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql166';
const IDENTITY = 'public.aws_mortgage_desk_set_monitoring(uuid, text)';
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin(KEY, ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
/** Expected pre-state (the function absent; also derived by release-sql166-executor.test.mjs). */
const ABSENT_PRE = releaseStateHash(KEY, {});
const TO_NOT = 'ChecksOps Mortgage Desk changed this loss draft to Not Monitored.';
const TO_MON = 'ChecksOps Mortgage Desk changed this loss draft to Monitored.';
/** The old_values / new_values keys loss_draft_action writes (workflow-rpc.mjs LOSS_DRAFT_AUDIT_VALUES_SQL). */
const AUDIT_KEYS = ['draw_amount_released', 'escrow_status', 'holdback_amount', 'monitoring_type', 'total_escrowed'];

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
  const workstream = 'prod-sql166-pg-test';
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
    one_use_id: `sql166-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-11-14T12:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql166-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
  const fx = await releaseFixture(pg, prefix, port, { extra: deskMonitoringSchema() });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/** Statements as `login` (checksops: the API login) for an application user, in one transaction; commit or roll back. */
async function asLogin(connectAs, login, user, sql, params = [], { commit = false } = {}) {
  const c = await connectAs(login);
  try {
    await c.query('BEGIN');
    if (user) await c.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
    const result = await c.query(sql, params);
    await c.query(commit ? 'COMMIT' : 'ROLLBACK');
    return { rows: result.rows, rowCount: result.rowCount, error: null };
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    return { rows: null, rowCount: null, error };
  } finally {
    await c.end();
  }
}
const setMonitoring = async (cx, user, req, type, login = 'checksops') => {
  const r = await asLogin(cx, login, user, 'SELECT public.aws_mortgage_desk_set_monitoring($1::uuid, $2::text) AS r', [req, type], { commit: true });
  return { ...r, result: r.rows?.[0]?.r ?? null };
};
const refused = (r, code, message) => r.error?.code === code && r.error.message === message;
async function asOwner(connectAs, sql) {
  const owner = await connectAs('checksops_admin');
  try {
    return await owner.query(sql);
  } finally {
    await owner.end();
  }
}
const present = async (admin) => (await admin.query('SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present', [IDENTITY])).rows[0].present;
const counts = async (admin) => (await admin.query(`SELECT
    (SELECT count(*)::int FROM public.check_messages) AS messages,
    (SELECT count(*)::int FROM public.loss_draft_audit_log) AS audits,
    (SELECT pg_catalog.string_agg(id::text || '=' || monitoring_type || '/' || escrow_status, ',' ORDER BY id) FROM public.loss_draft_tracking) AS drafts`)).rows[0];
const monitoringOf = async (admin, id) => (await admin.query('SELECT monitoring_type FROM public.loss_draft_tracking WHERE id = $1', [id])).rows[0].monitoring_type;

test('PostgreSQL 16: SQL 166 through its production tool: the derived pre-state, one apply on the intended fingerprint; the assigned agent switches an in-progress loss draft both ways, each change one audit row and one check message the tenant reads, no-op when unchanged; everyone and everything else refused; the escrow flag never refuses; then refused as in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql166-tool-', 61566, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');

  // Before: the agent cannot update the loss draft directly (members-only write policy), and the function is absent.
  const direct = await asLogin(connectAs, 'checksops', AGENT, "UPDATE public.loss_draft_tracking SET monitoring_type = 'not_monitored' WHERE id = $1::uuid", [DRAFT_A], { commit: true });
  assert.ok(direct.error || direct.rowCount === 0, 'the agent writes nothing directly');
  assert.equal(await monitoringOf(admin, DRAFT_A), 'monitored');
  assert.equal(await present(admin), false);

  const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.equal(s.live_definition_sha256, ABSENT_PRE);
  const pendingPin = { ...PIN, authorization: 'pending', execute: false, expected_live_definition_sha256: ABSENT_PRE };
  const pendingApply = await executeReleaseProductionApply(KEY, manifest(pendingPin), { root: ROOT, pin: pendingPin, connect, consumedPath: consumedPath() });
  assert.equal(pendingApply.ok, false);
  assert.equal(await present(admin), false);

  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, ABSENT_PRE);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  const acl = (await admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
      (SELECT pg_catalog.array_agg(g.name ORDER BY g.name)::text[] FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
         FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') g) AS execute
    FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [IDENTITY])).rows[0];
  assert.deepEqual(acl, { owner: 'checksops_admin', prosecdef: true, proconfig: ['search_path=public, pg_temp'], execute: ['checksops', 'checksops_admin'] });

  // The assigned agent: Monitored -> Not Monitored.
  const toNot = await setMonitoring(connectAs, AGENT, REQ, 'not_monitored');
  assert.equal(toNot.error, null, toNot.error?.message);
  assert.deepEqual({ ...toNot.result, message_id: typeof toNot.result.message_id }, {
    ok: true, changed: true, monitoring_type: 'not_monitored', previous_monitoring_type: 'monitored', request_id: REQ, loss_draft_id: DRAFT_A,
    message_id: 'string', escrow_or_draws_recorded: false,
  });
  assert.equal(await monitoringOf(admin, DRAFT_A), 'not_monitored');
  const audit1 = (await admin.query('SELECT loss_draft_id, action, actor_id, amount, notes, old_values, new_values FROM public.loss_draft_audit_log ORDER BY created_at')).rows;
  assert.equal(audit1.length, 1);
  assert.deepEqual({ ...audit1[0], old_values: undefined, new_values: undefined }, {
    loss_draft_id: DRAFT_A, action: 'set_monitoring_type', actor_id: AGENT, amount: null, notes: TO_NOT, old_values: undefined, new_values: undefined,
  });
  assert.deepEqual(Object.keys(audit1[0].old_values).sort(), AUDIT_KEYS);
  assert.deepEqual(Object.keys(audit1[0].new_values).sort(), AUDIT_KEYS);
  assert.deepEqual([audit1[0].old_values.monitoring_type, audit1[0].new_values.monitoring_type], ['monitored', 'not_monitored']);
  assert.deepEqual([audit1[0].old_values.total_escrowed, audit1[0].old_values.escrow_status], ['0.00', 'pending_send'], 'amounts as text, as the Lambda writes them');
  const msg1 = (await admin.query('SELECT id, check_id, sender_id, body, is_deleted FROM public.check_messages')).rows;
  assert.deepEqual(msg1, [{ id: toNot.result.message_id, check_id: CHECK_A, sender_id: AGENT, body: TO_NOT, is_deleted: false }]);
  // The tenant member reads the message on the check under RLS.
  const seen = await asLogin(connectAs, 'checksops', MEMBER_A, 'SELECT body FROM public.check_messages WHERE check_id = $1::uuid', [CHECK_A]);
  assert.equal(seen.error, null, seen.error?.message);
  assert.deepEqual(seen.rows, [{ body: TO_NOT }]);

  // The same type again: nothing written.
  const before = await counts(admin);
  const same = await setMonitoring(connectAs, AGENT, REQ, ' Not_Monitored ');
  assert.equal(same.error, null, same.error?.message);
  assert.deepEqual(same.result, { ok: true, changed: false, monitoring_type: 'not_monitored', request_id: REQ, loss_draft_id: DRAFT_A, escrow_or_draws_recorded: false });
  assert.deepEqual(await counts(admin), before);

  // Back to Monitored, by the platform owner this time: one more audit row and message.
  const back = await setMonitoring(connectAs, PLATFORM_OWNER, REQ, 'monitored');
  assert.equal(back.error, null, back.error?.message);
  assert.equal(back.result.changed, true);
  assert.equal(back.result.previous_monitoring_type, 'not_monitored');
  assert.equal(await monitoringOf(admin, DRAFT_A), 'monitored');
  assert.deepEqual((await admin.query('SELECT sender_id, body FROM public.check_messages ORDER BY created_at')).rows,
    [{ sender_id: AGENT, body: TO_NOT }, { sender_id: PLATFORM_OWNER, body: TO_MON }]);
  assert.deepEqual((await admin.query("SELECT actor_id, old_values->>'monitoring_type' AS old, new_values->>'monitoring_type' AS new FROM public.loss_draft_audit_log ORDER BY created_at")).rows,
    [{ actor_id: AGENT, old: 'monitored', new: 'not_monitored' }, { actor_id: PLATFORM_OWNER, old: 'not_monitored', new: 'monitored' }]);

  // Refusals: nothing written by any of them.
  const quiet = await counts(admin);
  assert.ok(refused(await setMonitoring(connectAs, OTHER_AGENT, REQ, 'not_monitored'), '42501', 'not_assigned_to_you'));
  assert.ok(refused(await setMonitoring(connectAs, MEMBER_A, REQ, 'not_monitored'), '42501', 'not_assigned_to_you'));
  assert.ok(refused(await setMonitoring(connectAs, null, REQ, 'not_monitored'), '42501', 'not_authorized'));
  assert.ok(refused(await setMonitoring(connectAs, AGENT, REQ_QUEUED, 'not_monitored'), '42501', 'request_not_in_status'));
  assert.ok(refused(await setMonitoring(connectAs, AGENT, REQ_COMPLETED, 'not_monitored'), '42501', 'request_not_in_status'));
  assert.ok(refused(await setMonitoring(connectAs, AGENT, REQ_NO_DRAFT, 'not_monitored'), '22023', 'request_has_no_loss_draft'));
  assert.ok(refused(await setMonitoring(connectAs, AGENT, REQ_CLOSED, 'monitored'), '42501', 'loss_draft_closed'));
  for (const bad of ['paused', '', null]) assert.ok(refused(await setMonitoring(connectAs, AGENT, REQ, bad), '22023', 'invalid_monitoring_type'), String(bad));
  await admin.query("UPDATE public.loss_draft_tracking SET escrow_status = 'final_release_complete' WHERE id = $1", [DRAFT_A]);
  assert.ok(refused(await setMonitoring(connectAs, AGENT, REQ, 'not_monitored'), '42501', 'loss_draft_closed'));
  await admin.query("UPDATE public.loss_draft_tracking SET escrow_status = 'pending_send' WHERE id = $1", [DRAFT_A]);
  assert.deepEqual(await counts(admin), quiet);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.check_messages WHERE check_id IN ($1, $2)', [CHECK_NO_DRAFT, CHECK_CLOSED])).rows[0].n, 0);

  // Escrow recorded: allowed with the warning flag.
  await admin.query("UPDATE public.loss_draft_tracking SET escrow_status = 'escrowed', total_escrowed = 25000 WHERE id = $1", [DRAFT_A]);
  const escrowed = await setMonitoring(connectAs, AGENT, REQ, 'not_monitored');
  assert.equal(escrowed.error, null, escrowed.error?.message);
  assert.equal(escrowed.result.changed, true);
  assert.equal(escrowed.result.escrow_or_draws_recorded, true);
  assert.equal(await monitoringOf(admin, DRAFT_A), 'not_monitored');
  const last = (await admin.query('SELECT old_values, new_values FROM public.loss_draft_audit_log ORDER BY created_at DESC LIMIT 1')).rows[0];
  assert.deepEqual([last.old_values.total_escrowed, last.new_values.total_escrowed, last.new_values.escrow_status], ['25000.00', '25000.00', 'escrowed']);
  // Draws only (escrow status reset): still flagged, still allowed.
  await admin.query("UPDATE public.loss_draft_tracking SET escrow_status = 'received_by_lender', total_escrowed = 0, draw_amount_released = 1000 WHERE id = $1", [DRAFT_A]);
  const draws = await setMonitoring(connectAs, AGENT, REQ, 'monitored');
  assert.equal(draws.error, null, draws.error?.message);
  assert.deepEqual([draws.result.changed, draws.result.escrow_or_draws_recorded], [true, true]);
  assert.equal((await setMonitoring(connectAs, AGENT, REQ, 'monitored')).result.escrow_or_draws_recorded, true, 'the no-op reports it too');

  // authenticated and a plain login hold no EXECUTE.
  const plain = await setMonitoring(connectAs, AGENT, REQ, 'not_monitored', 'sql166_plain');
  assert.ok(plain.error?.code === '42501' && /permission denied for function aws_mortgage_desk_set_monitoring/.test(plain.error.message), plain.error?.message);
  const c = await connectAs('checksops');
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE authenticated');
    await c.query("SELECT set_config('request.app_user_id', $1, true)", [AGENT]);
    await assert.rejects(c.query('SELECT public.aws_mortgage_desk_set_monitoring($1::uuid, $2::text)', [REQ, 'not_monitored']),
      (e) => e.code === '42501' && /permission denied for function/.test(e.message));
    await c.query('ROLLBACK');
  } finally {
    await c.end();
  }

  // Idempotent: the file again is a no-op; the tool refuses a re-apply.
  const settled = await counts(admin);
  await asOwner(connectAs, TEXT);
  assert.deepEqual(await counts(admin), settled, 'running the file writes no row');
  const replayInspect = (await inspectReleaseProduction(KEY, { connect, pin, root: ROOT })).details;
  assert.equal(replayInspect.already_applied, true);
  assert.equal(replayInspect.live_definition_sha256, PIN.intended_replacement_sha256);
  assert.deepEqual(replayInspect.precondition_failures, [], JSON.stringify(replayInspect.release_sql_inspect));
  const replay = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: SQL 166 with a relation it reaches under FORCE ROW LEVEL SECURITY or a missing column refuses the pre-conditions; the file\'s own rules agree; nothing changes', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql166-drift-', 61567, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const inspect = async () => (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;

  for (const table of ['loss_draft_tracking', 'check_messages']) {
    await admin.query(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
    const forced = await inspect();
    assert.deepEqual(forced.precondition_failures, ['definer_can_write_relations'], `${table}: ${JSON.stringify(forced.release_sql_inspect)}`);
    assert.equal(forced.live_definition_sha256, ABSENT_PRE);
    const blocked = authorized(forced.live_definition_sha256);
    const noApply = await executeReleaseProductionApply(KEY, manifest(blocked), { root: ROOT, pin: blocked, connect, consumedPath: consumedPath() });
    assert.equal(noApply.ok, false, table);
    await assert.rejects(asOwner(connectAs, TEXT), (e) => e.code === '55000' && new RegExp(`sql166_definer_cannot_reach: .*${table}`).test(e.message), table);
    assert.equal(await present(admin), false, table);
    await admin.query(`ALTER TABLE public.${table} NO FORCE ROW LEVEL SECURITY`);
  }

  await admin.query('ALTER TABLE public.loss_draft_audit_log RENAME COLUMN old_values TO old_moved');
  const missing = await inspect();
  assert.ok(missing.release_sql_inspect.prerequisites_missing.includes('column public.loss_draft_audit_log.old_values'),
    JSON.stringify(missing.release_sql_inspect.prerequisites_missing));
  assert.ok(missing.precondition_failures.includes('prerequisites_present'));
  await assert.rejects(asOwner(connectAs, TEXT), (e) => e.code === '55000' && /sql166_prerequisite_missing: .*old_values/.test(e.message));
  assert.equal(await present(admin), false);
  await admin.query('ALTER TABLE public.loss_draft_audit_log RENAME COLUMN old_moved TO old_values');
  assert.deepEqual((await inspect()).precondition_failures, []);
}));
