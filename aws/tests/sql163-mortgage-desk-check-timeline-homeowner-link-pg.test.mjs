/**
 * SQL 163 (aws/workflows/sql/163_mortgage_desk_check_timeline_homeowner_link.sql) on PostgreSQL 16, through its
 * production tool (lib/release-sql-production-apply.mjs, the owner the non-superuser checksops_admin login), with the
 * calls made as checksops (the API login) for an application user, as mortgage-desk-esign.mjs makes them. SQL 124's
 * real aws_mortgage_desk_readable_request is the gate:
 *
 *   - before the apply the assigned agent reads no check_intake_items row (no agent clause) and the functions are
 *     absent; the read-only inspect reads the derived pre-state; a pending pin refuses; one apply reaches the intended
 *     fingerprint (EXECUTE for checksops and the owner only);
 *   - after it the assigned agent and the platform owner read the request's check (display fields only, never routing
 *     or account numbers) and the claim's homeowner timeline written by the request's tenant (newest first, the note
 *     only, from_desk for the Desk's own posts); another agent, a tenant member, no user and a queued request are
 *     refused with SQL 124's codes;
 *   - the homeowner link: the homeowner on file (the request's email, else the claim's), a new token once, then the same
 *     token reused; a malformed token, a request without a claim or without a homeowner email refused;
 *   - authenticated and a plain login cannot execute them; the file run again is a no-op; the tool refuses a re-apply;
 *   - FORCE ROW LEVEL SECURITY on a relation they reach, or a missing column, refuses the pre-conditions and the file.
 *
 * Run: node --test aws/tests/sql163-mortgage-desk-check-timeline-homeowner-link-pg.test.mjs (needs PostgreSQL 16; as
 * root the PG helpers run the server as the ubuntu account).
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
import { CHECK_A, CLAIM_A, MEMBER_A, PLATFORM_OWNER, TENANT_A, TENANT_B, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { AGENT, OTHER_AGENT, REQ, REQ_NO_CLAIM, REQ_QUEUED, TOKEN_1, TOKEN_2, deskSchema } from './helpers/sql163-desk-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql163';
const IDENTITIES = Object.freeze([
  'public.aws_mortgage_desk_request_check(uuid)',
  'public.aws_mortgage_desk_homeowner_timeline(uuid)',
  'public.aws_mortgage_desk_homeowner_link(uuid, text)',
]);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin(KEY, ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
/** Expected pre-state (the three functions absent; also derived by release-sql163-executor.test.mjs). */
const ABSENT_PRE = releaseStateHash(KEY, {});
const CHECK_COLUMNS = ['check_id', 'claim_id', 'amount', 'check_number', 'carrier_name', 'payee_line', 'payee_address', 'property_address',
  'issue_date', 'detected_claim_number', 'front_image_path', 'back_image_path', 'status', 'check_stage', 'funds_type'];
const TIMELINE_COLUMNS = ['event_id', 'event_type', 'occurred_at', 'actor_label', 'note', 'amount', 'from_desk'];

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
  const workstream = 'prod-sql163-pg-test';
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
    one_use_id: `sql163-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-11-13T12:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql163-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
  const fx = await releaseFixture(pg, prefix, port, { extra: deskSchema() });
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
    return { rows: result.rows, fields: result.fields.map((f) => f.name), error: null };
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    return { rows: null, fields: null, error };
  } finally {
    await c.end();
  }
}
const check = (cx, user, req, login = 'checksops') => asLogin(cx, login, user, 'SELECT * FROM public.aws_mortgage_desk_request_check($1::uuid)', [req]);
const timeline = (cx, user, req) => asLogin(cx, 'checksops', user, 'SELECT * FROM public.aws_mortgage_desk_homeowner_timeline($1::uuid)', [req]);
const link = (cx, user, req, token) => asLogin(cx, 'checksops', user, 'SELECT * FROM public.aws_mortgage_desk_homeowner_link($1::uuid, $2::text)', [req, token], { commit: true });
const refused = (r, code, message) => r.error?.code === code && r.error.message === message;
async function asOwner(connectAs, sql) {
  const owner = await connectAs('checksops_admin');
  try {
    return await owner.query(sql);
  } finally {
    await owner.end();
  }
}
const present = async (admin) => (await admin.query(
  'SELECT bool_or(pg_catalog.to_regprocedure(f) IS NOT NULL) AS present FROM unnest($1::text[]) f', [IDENTITIES])).rows[0].present;

test('PostgreSQL 16: SQL 163 through its production tool: the derived pre-state, one apply on the intended fingerprint; the assigned agent reads the check and the homeowner timeline and gets the homeowner link for the homeowner on file; everyone else refused; then refused as in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql163-tool-', 61563, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');

  // Before: the agent reads no check row (the policy has no agent clause), and the functions are absent.
  const direct = await asLogin(connectAs, 'checksops', AGENT, 'SELECT id FROM public.check_intake_items WHERE id = $1::uuid', [CHECK_A]);
  assert.equal(direct.error, null, direct.error?.message);
  assert.deepEqual(direct.rows, []);
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
  for (const identity of IDENTITIES) {
    const acl = (await admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
        (SELECT pg_catalog.array_agg(g.name ORDER BY g.name)::text[] FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END AS name
           FROM pg_catalog.aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') g) AS execute
      FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [identity])).rows[0];
    assert.deepEqual(acl, { owner: 'checksops_admin', prosecdef: true, proconfig: ['search_path=public, pg_temp'], execute: ['checksops', 'checksops_admin'] }, identity);
  }

  // The check: the assigned agent and the platform owner; display fields only.
  for (const user of [AGENT, PLATFORM_OWNER]) {
    const r = await check(connectAs, user, REQ);
    assert.equal(r.error, null, r.error?.message);
    assert.deepEqual(r.fields, CHECK_COLUMNS, 'never routing_number or account_number');
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].check_id, CHECK_A);
    assert.equal(r.rows[0].claim_id, CLAIM_A);
    assert.equal(Number(r.rows[0].amount), 1234.56);
    assert.equal(r.rows[0].check_number, '4182');
    assert.equal(r.rows[0].issue_date, '2026-11-01');
    assert.equal(r.rows[0].front_image_path, 'checks/front.jpg');
  }
  // SQL 124's refusals: another agent, a tenant member, no user, a queued request.
  assert.ok(refused(await check(connectAs, OTHER_AGENT, REQ), '42501', 'not_assigned_to_you'));
  assert.ok(refused(await check(connectAs, MEMBER_A, REQ), '42501', 'not_assigned_to_you'));
  assert.ok(refused(await check(connectAs, null, REQ), '42501', 'not_authorized'));
  assert.ok(refused(await check(connectAs, AGENT, REQ_QUEUED), '42501', 'request_not_in_status'));

  // The timeline: the request's tenant's events on the claim, newest first, the note only; from_desk for the Desk's post.
  const tl = await timeline(connectAs, AGENT, REQ);
  assert.equal(tl.error, null, tl.error?.message);
  assert.deepEqual(tl.fields, TIMELINE_COLUMNS);
  assert.deepEqual(tl.rows.map((r) => [r.event_type, r.note, r.from_desk]), [
    ['mortgage_followup', 'spoke with Sarah', true],
    ['check_received', 'received', false],
  ], 'the other tenant\'s event on the same claim is not shown');
  assert.doesNotMatch(JSON.stringify(tl.rows), /secret/);
  assert.deepEqual((await timeline(connectAs, AGENT, REQ_NO_CLAIM)).rows, [], 'no claim, no timeline');
  assert.ok(refused(await timeline(connectAs, OTHER_AGENT, REQ), '42501', 'not_assigned_to_you'));

  // The homeowner link: the claim's policyholder (no request email), one new token, then reused.
  assert.ok(refused(await link(connectAs, AGENT, REQ, 'not-hex'), '22023', 'invalid_token'));
  const first = await link(connectAs, AGENT, REQ, TOKEN_1);
  assert.equal(first.error, null, first.error?.message);
  assert.deepEqual(first.rows, [{ token: TOKEN_1, homeowner_email: 'owner@example.invalid', homeowner_name: 'Home Owner', tenant_id: TENANT_A, reused: false }]);
  const stored = (await admin.query('SELECT tenant_id, claim_id, homeowner_email, created_by FROM public.homeowner_ledger_tokens WHERE token = $1', [TOKEN_1])).rows;
  assert.deepEqual(stored, [{ tenant_id: TENANT_A, claim_id: CLAIM_A, homeowner_email: 'owner@example.invalid', created_by: AGENT }]);
  const again = await link(connectAs, AGENT, REQ, TOKEN_2);
  assert.deepEqual(again.rows, [{ token: TOKEN_1, homeowner_email: 'owner@example.invalid', homeowner_name: 'Home Owner', tenant_id: TENANT_A, reused: true }]);
  // The request's own email wins over the claim's: a new recipient, a new token.
  await admin.query('UPDATE public.mortgage_handling_requests SET homeowner_email = $2, homeowner_name = $3 WHERE id = $1', [REQ, 'Desk@Example.Invalid', 'Desk Name']);
  const own = await link(connectAs, AGENT, REQ, TOKEN_2);
  assert.deepEqual(own.rows, [{ token: TOKEN_2, homeowner_email: 'desk@example.invalid', homeowner_name: 'Desk Name', tenant_id: TENANT_A, reused: false }]);
  assert.ok(refused(await link(connectAs, AGENT, REQ_NO_CLAIM, TOKEN_1), '22023', 'request_has_no_claim'));
  assert.ok(refused(await link(connectAs, OTHER_AGENT, REQ, 'c'.repeat(48)), '42501', 'not_assigned_to_you'));
  await admin.query("UPDATE public.mortgage_handling_requests SET homeowner_email = '' WHERE id = $1", [REQ]);
  await admin.query("UPDATE public.claims SET policyholder_email = 'not an address' WHERE id = $1", [CLAIM_A]);
  assert.ok(refused(await link(connectAs, AGENT, REQ, 'c'.repeat(48)), '22023', 'no_homeowner_email'));
  // A claim that is not the request's tenant's.
  await admin.query("UPDATE public.claims SET policyholder_email = 'owner@example.invalid', org_id = $2 WHERE id = $1", [CLAIM_A, TENANT_B]);
  assert.ok(refused(await link(connectAs, AGENT, REQ, 'c'.repeat(48)), '42501', 'claim_not_in_tenant'));
  await admin.query('UPDATE public.claims SET org_id = $2 WHERE id = $1', [CLAIM_A, TENANT_A]);

  // authenticated and a plain login hold no EXECUTE.
  const plain = await check(connectAs, AGENT, REQ, 'sql163_plain');
  assert.ok(plain.error?.code === '42501' && /permission denied for function aws_mortgage_desk_request_check/.test(plain.error.message), plain.error?.message);
  const c = await connectAs('checksops');
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE authenticated');
    await c.query("SELECT set_config('request.app_user_id', $1, true)", [AGENT]);
    await assert.rejects(c.query('SELECT * FROM public.aws_mortgage_desk_homeowner_timeline($1::uuid)', [REQ]),
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

test('PostgreSQL 16: SQL 163 with a relation it reaches under FORCE ROW LEVEL SECURITY or a missing column refuses the pre-conditions; the file\'s own rules agree; nothing changes', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql163-drift-', 61564, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const inspect = async () => (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;

  for (const table of ['check_intake_items', 'homeowner_ledger_tokens']) {
    await admin.query(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
    const forced = await inspect();
    assert.deepEqual(forced.precondition_failures, ['definer_can_write_relations'], `${table}: ${JSON.stringify(forced.release_sql_inspect)}`);
    assert.equal(forced.live_definition_sha256, ABSENT_PRE);
    const blocked = authorized(forced.live_definition_sha256);
    const noApply = await executeReleaseProductionApply(KEY, manifest(blocked), { root: ROOT, pin: blocked, connect, consumedPath: consumedPath() });
    assert.equal(noApply.ok, false, table);
    await assert.rejects(asOwner(connectAs, TEXT), (e) => e.code === '55000' && new RegExp(`sql163_definer_cannot_reach: .*${table}`).test(e.message), table);
    assert.equal(await present(admin), false, table);
    await admin.query(`ALTER TABLE public.${table} NO FORCE ROW LEVEL SECURITY`);
  }

  await admin.query('ALTER TABLE public.homeowner_ledger_events RENAME COLUMN payload_json TO payload_moved');
  const missing = await inspect();
  assert.ok(missing.release_sql_inspect.prerequisites_missing.includes('column public.homeowner_ledger_events.payload_json'),
    JSON.stringify(missing.release_sql_inspect.prerequisites_missing));
  assert.ok(missing.precondition_failures.includes('prerequisites_present'));
  await assert.rejects(asOwner(connectAs, TEXT), (e) => e.code === '55000' && /sql163_prerequisite_missing: .*payload_json/.test(e.message));
  assert.equal(await present(admin), false);
  await admin.query('ALTER TABLE public.homeowner_ledger_events RENAME COLUMN payload_moved TO payload_json');
  assert.deepEqual((await inspect()).precondition_failures, []);
}));
