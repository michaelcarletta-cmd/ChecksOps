/**
 * SQL 162 (aws/workflows/sql/162_shared_check_source_sends.sql) on PostgreSQL 16, through its production tool
 * (lib/release-sql-production-apply.mjs, the owner the non-superuser checksops_admin login), with the reads made as
 * checksops (the API login) for an application user, as /data/rpc makes them:
 *
 *   - before the apply the partner cannot read the sharing organization's legs (aws_select_payment_transfers is
 *     tenant_id only) and the function does not exist;
 *   - the read-only inspect reads the derived pre-state (the function absent); a pending pin refuses; one apply
 *     reaches the intended fingerprint (EXECUTE for checksops and the owner only);
 *   - after it a member of the partner reads one row per check and sharing organization for the checks actively
 *     shared with it that the sharing organization paid from by an accepted send to someone else (another
 *     organization or an outside payee): check_id, source_tenant_id, last_sent_at and nothing else; never for a
 *     returned, failed or canceled send, a wallet funding, a send to the partner itself, an unshared check or a
 *     revoked share; the platform owner reads the same rows;
 *   - a member of another organization, no user and a NULL tenant are refused (42501
 *     shared_check_source_sends_forbidden); authenticated and a plain login cannot execute it at all;
 *   - the file run again is a no-op; the tool refuses a re-apply as already in place;
 *   - FORCE ROW LEVEL SECURITY on a relation it reads refuses the pre-conditions and the file; nothing changes.
 *
 * Run: node --test aws/tests/sql162-shared-check-source-sends-pg.test.mjs (needs PostgreSQL 16; as root the PG
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
import { CHECK_A, MEMBER_A, MEMBER_B, PLATFORM_OWNER, TENANT_A, TENANT_B, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { CHECK_2, CHECK_3, LEGS, MEMBER_C, TENANT_C, incomingSchema } from './helpers/sql144-incoming-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql162';
const IDENTITY = 'public.get_shared_check_source_sends(uuid)';
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin(KEY, ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
/** Expected pre-state (the function absent; also derived by release-sql162-executor.test.mjs). */
const ABSENT_PRE = releaseStateHash(KEY, { functions: { [IDENTITY]: { exists: false } } });
const COLUMNS = ['check_id', 'source_tenant_id', 'last_sent_at'];

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
  const workstream = 'prod-sql162-pg-test';
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
    one_use_id: `sql162-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-11-12T12:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql162-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
  const fx = await releaseFixture(pg, prefix, port, { extra: incomingSchema() });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/** One statement as `login` (checksops: the API login) for an application user, in a transaction rolled back. */
async function asLogin(connectAs, login, user, sql, params = []) {
  const c = await connectAs(login);
  try {
    await c.query('BEGIN');
    if (user) await c.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
    const result = await c.query(sql, params);
    await c.query('ROLLBACK');
    return { rows: result.rows, fields: result.fields.map((f) => f.name), error: null };
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    return { rows: null, fields: null, error };
  } finally {
    await c.end();
  }
}
const sends = (connectAs, user, tenant, login = 'checksops') => asLogin(connectAs, login, user,
  'SELECT * FROM public.get_shared_check_source_sends($1::uuid)', [tenant]);
const FORBIDDEN = (r) => r.error?.code === '42501' && r.error.message === 'shared_check_source_sends_forbidden';
const NO_EXECUTE = (r) => r.error?.code === '42501' && /permission denied for function get_shared_check_source_sends/.test(r.error.message);
async function asOwner(connectAs, sql) {
  const owner = await connectAs('checksops_admin');
  try {
    return await owner.query(sql);
  } finally {
    await owner.end();
  }
}
const present = async (admin) => (await admin.query('SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present', [IDENTITY])).rows[0].present;

test('PostgreSQL 16: SQL 162 through its production tool: the derived pre-state, one apply on the intended fingerprint; the partner reads which shared checks the sharing organization paid from by a send to someone else, three columns only; everyone else refused; then refused as in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql162-tool-', 61462, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  await admin.query('CREATE ROLE sql162_plain LOGIN NOSUPERUSER NOBYPASSRLS');
  const leg = (n) => `16200000-0000-4000-8000-00000000${String(n).padStart(4, '0')}`;
  const insertLeg = (id, tenant, dest, role, status, check, at) => admin.query(
    `INSERT INTO public.payment_transfers (id, tenant_id, destination_tenant_id, environment, leg_role, status, idempotency_key, amount_cents, check_id, created_at)
     VALUES ($1, $2, $3, 'production', $4, $5, $6, 100, $7, $8)`, [id, tenant, dest, role, status, `k-${id}`, check, at]);

  // Before: the partner cannot read the sharing organization's legs (tenant_id policy), and the function is absent.
  const direct = await asLogin(connectAs, 'checksops', MEMBER_B, 'SELECT id FROM public.payment_transfers WHERE tenant_id = $1::uuid', [TENANT_A]);
  assert.equal(direct.error, null, direct.error?.message);
  assert.deepEqual(direct.rows, []);
  assert.equal(await present(admin), false);

  const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.equal(s.live_definition_sha256, ABSENT_PRE);
  // A pending pin (not execute-authorized) refuses before any change.
  const pendingPin = { ...PIN, authorization: 'pending', execute: false, expected_live_definition_sha256: ABSENT_PRE };
  const pendingApply = await executeReleaseProductionApply(KEY, manifest(pendingPin), { root: ROOT, pin: pendingPin, connect, consumedPath: consumedPath() });
  assert.equal(pendingApply.ok, false);
  assert.equal(await present(admin), false);

  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, ABSENT_PRE);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  const acl = (await admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.provolatile, p.proconfig,
      (SELECT pg_catalog.array_agg(g.name ORDER BY g.name)::text[] FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
         FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') g) AS execute
    FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [IDENTITY])).rows[0];
  assert.deepEqual(acl, { owner: 'checksops_admin', prosecdef: true, provolatile: 's', proconfig: ['search_path=public, pg_temp'], execute: ['checksops', 'checksops_admin'] });

  // The fixture (helpers/sql144-incoming-schema.mjs): CHECK_A is shared A -> B. A's legs from it: two delivered to B,
  // four to B that never left (failed, ready, canceled, unknown) and one completed to C (LEGS.toC, 15:00Z). Only the
  // send to C is a send to someone else, so B reads one row: the check, A, and that leg's time.
  const b = await sends(connectAs, MEMBER_B, TENANT_B);
  assert.equal(b.error, null, b.error?.message);
  assert.deepEqual(b.fields, COLUMNS, 'three columns: never an amount, a payee, a status or a transfer id');
  assert.equal(b.rows.length, 1);
  assert.equal(b.rows[0].check_id, CHECK_A);
  assert.equal(b.rows[0].source_tenant_id, TENANT_A);
  assert.equal(b.rows[0].last_sent_at.toISOString(), '2026-11-06T15:00:00.000Z');
  assert.equal(LEGS.toC.length, 36);

  // What does not count: a returned, failed or canceled send to someone else; a wallet funding; a send from a check
  // that is not shared with B (CHECK_2) or whose share is revoked (CHECK_3); a send by another organization.
  await insertLeg(leg(1), TENANT_A, TENANT_C, 'send_bank', 'returned', CHECK_A, '2026-11-07T10:00:00Z');
  await insertLeg(leg(2), TENANT_A, null, 'send_bank', 'failed', CHECK_A, '2026-11-07T11:00:00Z');
  await insertLeg(leg(3), TENANT_A, null, 'send_wallet', 'canceled', CHECK_A, '2026-11-07T12:00:00Z');
  await insertLeg(leg(4), TENANT_A, null, 'wallet_funding', 'completed', CHECK_A, '2026-11-07T13:00:00Z');
  await insertLeg(leg(5), TENANT_A, TENANT_C, 'send_wallet', 'completed', CHECK_2, '2026-11-07T14:00:00Z');
  await insertLeg(leg(6), TENANT_A, null, 'send_bank', 'completed', CHECK_3, '2026-11-07T15:00:00Z');
  await insertLeg(leg(7), TENANT_C, null, 'send_bank', 'completed', CHECK_A, '2026-11-07T16:00:00Z');
  const same = await sends(connectAs, MEMBER_B, TENANT_B);
  assert.equal(same.rows.length, 1);
  assert.equal(same.rows[0].last_sent_at.toISOString(), '2026-11-06T15:00:00.000Z');
  // What counts: a send to an outside payee (no destination organization), in each accepted status; the newest one dates the row.
  await insertLeg(leg(8), TENANT_A, null, 'send_bank', 'submitted', CHECK_A, '2026-11-08T10:00:00Z');
  await insertLeg(leg(9), TENANT_A, null, 'send_wallet', 'pending', CHECK_A, '2026-11-08T11:00:00Z');
  await insertLeg(leg(10), TENANT_A, TENANT_C, 'send_bank', 'processing', CHECK_A, '2026-11-08T12:00:00Z');
  const later = await sends(connectAs, MEMBER_B, TENANT_B);
  assert.equal(later.rows.length, 1, 'one row per check and sharing organization');
  assert.equal(later.rows[0].last_sent_at.toISOString(), '2026-11-08T12:00:00.000Z');
  // A second shared check with a send to someone else: a second row, newest first.
  await admin.query('INSERT INTO public.shared_checks (check_id, source_tenant_id, target_tenant_id, revoked_at) VALUES ($1, $2, $3, NULL)', [CHECK_2, TENANT_A, TENANT_B]);
  const two = await sends(connectAs, MEMBER_B, TENANT_B);
  assert.deepEqual(two.rows.map((r) => r.check_id), [CHECK_A, CHECK_2]);
  assert.equal(two.rows[1].last_sent_at.toISOString(), '2026-11-07T14:00:00.000Z');
  // A share the sharing organization revokes drops its row.
  await admin.query('UPDATE public.shared_checks SET revoked_at = now() WHERE check_id = $1', [CHECK_2]);
  assert.deepEqual((await sends(connectAs, MEMBER_B, TENANT_B)).rows.map((r) => r.check_id), [CHECK_A]);

  // The platform owner reads B's rows; the sharing organization and C (nothing is shared with them) read none.
  const owner = await sends(connectAs, PLATFORM_OWNER, TENANT_B);
  assert.equal(owner.error, null, owner.error?.message);
  assert.deepEqual(owner.rows.map((r) => r.check_id), [CHECK_A]);
  assert.deepEqual((await sends(connectAs, MEMBER_A, TENANT_A)).rows, []);
  assert.deepEqual((await sends(connectAs, MEMBER_C, TENANT_C)).rows, []);
  // A send only to the partner itself is not a send to someone else: with CHECK_A shared A -> C too, C reads the row
  // (A's sends to B and outside), and after a share of a check A paid only C from, C reads nothing for it.
  await admin.query('INSERT INTO public.shared_checks (check_id, source_tenant_id, target_tenant_id, revoked_at) VALUES ($1, $2, $3, NULL)', [CHECK_A, TENANT_A, TENANT_C]);
  await admin.query('UPDATE public.shared_checks SET revoked_at = NULL, target_tenant_id = $3 WHERE check_id = $1 AND source_tenant_id = $2', [CHECK_2, TENANT_A, TENANT_C]);
  assert.deepEqual((await sends(connectAs, MEMBER_C, TENANT_C)).rows.map((r) => r.check_id), [CHECK_A], 'CHECK_2 was paid only to C');
  // Another organization's member, no user and a NULL tenant: refused.
  assert.ok(FORBIDDEN(await sends(connectAs, MEMBER_A, TENANT_B)), 'sharing organization reading the partner');
  assert.ok(FORBIDDEN(await sends(connectAs, MEMBER_C, TENANT_B)), 'other organization');
  assert.ok(FORBIDDEN(await sends(connectAs, null, TENANT_B)), 'no user');
  assert.ok(FORBIDDEN(await sends(connectAs, MEMBER_B, null)), 'NULL tenant');
  // authenticated and a plain login hold no EXECUTE.
  assert.ok(NO_EXECUTE(await sends(connectAs, MEMBER_B, TENANT_B, 'sql162_plain')), 'plain login');
  const c = await connectAs('checksops');
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE authenticated');
    await c.query("SELECT set_config('request.app_user_id', $1, true)", [MEMBER_B]);
    await assert.rejects(c.query('SELECT * FROM public.get_shared_check_source_sends($1::uuid)', [TENANT_B]),
      (e) => e.code === '42501' && /permission denied for function/.test(e.message));
    await c.query('ROLLBACK');
  } finally {
    await c.end();
  }

  // Idempotent: the file again is a no-op; the tool refuses a re-apply.
  await asOwner(connectAs, TEXT);
  const replayInspect = (await inspectReleaseProduction(KEY, { connect, pin, root: ROOT })).details;
  assert.equal(replayInspect.already_applied, true);
  assert.equal(replayInspect.live_definition_sha256, PIN.intended_replacement_sha256);
  assert.deepEqual(replayInspect.precondition_failures, [], JSON.stringify(replayInspect.release_sql_inspect));
  const replay = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: SQL 162 with a relation it reads under FORCE ROW LEVEL SECURITY or a missing column refuses the pre-conditions; the file\'s own rules agree; nothing changes', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql162-drift-', 61463, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const inspect = async () => (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;

  for (const table of ['payment_transfers', 'shared_checks']) {
    await admin.query(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
    const forced = await inspect();
    assert.deepEqual(forced.precondition_failures, ['definer_can_write_relations'], `${table}: ${JSON.stringify(forced.release_sql_inspect)}`);
    assert.equal(forced.live_definition_sha256, ABSENT_PRE);
    const blocked = authorized(forced.live_definition_sha256);
    const noApply = await executeReleaseProductionApply(KEY, manifest(blocked), { root: ROOT, pin: blocked, connect, consumedPath: consumedPath() });
    assert.equal(noApply.ok, false, table);
    await assert.rejects(asOwner(connectAs, TEXT), (e) => e.code === '55000' && new RegExp(`sql162_definer_cannot_reach: .*${table}`).test(e.message), table);
    assert.equal(await present(admin), false, table);
    await admin.query(`ALTER TABLE public.${table} NO FORCE ROW LEVEL SECURITY`);
  }

  // A column the function reads missing: prerequisites missing, and the file refuses.
  await admin.query('ALTER TABLE public.payment_transfers RENAME COLUMN destination_tenant_id TO destination_moved');
  const missing = await inspect();
  assert.ok(missing.release_sql_inspect.prerequisites_missing.includes('column public.payment_transfers.destination_tenant_id'),
    JSON.stringify(missing.release_sql_inspect.prerequisites_missing));
  assert.ok(missing.precondition_failures.includes('prerequisites_present'));
  await assert.rejects(asOwner(connectAs, TEXT), (e) => e.code === '55000' && /sql162_prerequisite_missing: .*destination_tenant_id/.test(e.message));
  assert.equal(await present(admin), false);
  await admin.query('ALTER TABLE public.payment_transfers RENAME COLUMN destination_moved TO destination_tenant_id');
  assert.deepEqual((await inspect()).precondition_failures, []);
  assert.equal(TENANT_A.length, 36);
}));
