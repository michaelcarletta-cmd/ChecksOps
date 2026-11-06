/**
 * SQL 144 (aws/workflows/sql/144_tenant_incoming_transfers.sql) on PostgreSQL 16, through its production tool
 * (lib/release-sql-production-apply.mjs, the owner the non-superuser checksops_admin login), with the reads made as
 * checksops (the API login) for an application user, as /data/rpc makes them:
 *
 *   - before the apply the recipient cannot read the sender's legs (aws_select_payment_transfers is tenant_id only)
 *     and the function does not exist;
 *   - the read-only inspect reads the derived pre-state (the function absent); a pending pin refuses; one apply
 *     reaches the intended fingerprint (EXECUTE for checksops and the owner only);
 *   - after it a member of the recipient reads exactly the send legs other organizations addressed to it in a
 *     delivered or returned status, newest first, with the sender's name; never ready, submitting, unknown, failed or
 *     canceled legs, a wallet funding, its own sends, or legs addressed to another organization; never
 *     provider_metadata or the description; check context only for the check the sender shares with it (an
 *     unshared check and a revoked share read NULL); the platform owner reads the context of every check;
 *   - a member of another organization, no user and a NULL tenant are refused (42501
 *     incoming_transfers_forbidden); authenticated and a plain login cannot execute it at all;
 *   - the file run again is a no-op; the tool refuses a re-apply as already in place;
 *   - FORCE ROW LEVEL SECURITY on a relation it reads refuses the pre-conditions and the file; nothing changes.
 *
 * Run: node --test aws/tests/sql144-tenant-incoming-transfers-pg.test.mjs (needs PostgreSQL 16; as root the PG
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
import { B_READS, CHECK_2, CHECK_3, LEGS, MEMBER_C, TENANT_C, incomingSchema } from './helpers/sql144-incoming-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql144';
const IDENTITY = 'public.get_tenant_incoming_transfers(uuid)';
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin(KEY, ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
/** Expected pre-state (the function absent; also derived by release-sql144-executor.test.mjs). */
const ABSENT_PRE = releaseStateHash(KEY, { functions: { [IDENTITY]: { exists: false } } });
const COLUMNS = ['id', 'amount_cents', 'status', 'speed', 'environment', 'leg_role', 'created_at', 'submitted_at', 'completed_at',
  'check_id', 'sender_tenant_id', 'sender_name', 'check_number', 'carrier_name', 'property_address', 'funds_type', 'check_amount',
  'claim_id', 'detected_claim_number', 'payee_line', 'claim_number', 'policyholder_name'];
const CONTEXT = COLUMNS.slice(COLUMNS.indexOf('check_number'));

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
  const workstream = 'prod-sql144-pg-test';
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
    one_use_id: `sql144-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-11-06T12:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql144-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
const incoming = (connectAs, user, tenant, login = 'checksops') => asLogin(connectAs, login, user,
  'SELECT * FROM public.get_tenant_incoming_transfers($1::uuid)', [tenant]);
const FORBIDDEN = (r) => r.error?.code === '42501' && r.error.message === 'incoming_transfers_forbidden';
const NO_EXECUTE = (r) => r.error?.code === '42501' && /permission denied for function get_tenant_incoming_transfers/.test(r.error.message);
async function asOwner(connectAs, sql) {
  const owner = await connectAs('checksops_admin');
  try {
    return await owner.query(sql);
  } finally {
    await owner.end();
  }
}
const present = async (admin) => (await admin.query('SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present', [IDENTITY])).rows[0].present;

test('PostgreSQL 16: SQL 144 through its production tool: the derived pre-state, one apply on the intended fingerprint; the recipient reads the legs addressed to it with narrow columns and shared-check context only; everyone else refused; then refused as in place', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql144-tool-', 61446, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  await admin.query('CREATE ROLE sql144_plain LOGIN NOSUPERUSER NOBYPASSRLS');

  // Before: the recipient reads none of the legs addressed to it (tenant_id policy), and the function is absent.
  const direct = await asLogin(connectAs, 'checksops', MEMBER_B, 'SELECT id FROM public.payment_transfers WHERE destination_tenant_id = $1::uuid AND tenant_id <> $1::uuid', [TENANT_B]);
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

  // The recipient (a member of B): exactly the delivered or returned send legs other organizations addressed to B.
  const b = await incoming(connectAs, MEMBER_B, TENANT_B);
  assert.equal(b.error, null, b.error?.message);
  assert.deepEqual(b.fields, COLUMNS, 'narrow columns: never provider_metadata or the description');
  assert.deepEqual(b.rows.map((r) => r.id), B_READS, 'newest first');
  for (const id of [LEGS.failed, LEGS.ready, LEGS.canceled, LEGS.unknown, LEGS.funding, LEGS.self, LEGS.toC]) {
    assert.ok(!b.rows.some((r) => r.id === id), id);
  }
  const byId = Object.fromEntries(b.rows.map((r) => [r.id, r]));
  const wallet = byId[LEGS.walletSubmitted];
  assert.deepEqual({ ...wallet, created_at: undefined, submitted_at: undefined }, {
    id: LEGS.walletSubmitted, amount_cents: '640520', status: 'submitted', speed: 'standard', environment: 'production', leg_role: 'send_wallet',
    created_at: undefined, submitted_at: undefined, completed_at: null, check_id: CHECK_A, sender_tenant_id: TENANT_A, sender_name: 'A',
    check_number: '1001', carrier_name: 'State Farm', property_address: '1 Main St', funds_type: 'dwelling', check_amount: '9029.35',
    claim_id: '66666666-6666-4666-8666-666666666666', detected_claim_number: 'D-1', payee_line: 'Deen Bandhu & A',
    claim_number: 'CL-1', policyholder_name: 'Deen Bandhu',
  });
  assert.equal(byId[LEGS.bankCompleted].status, 'completed');
  assert.ok(byId[LEGS.bankCompleted].completed_at instanceof Date);
  assert.equal(byId[LEGS.returned].status, 'returned');
  // Not shared (CHECK_2) and a revoked share (CHECK_3): the check id, no context.
  for (const [id, check] of [[LEGS.returned, CHECK_2], [LEGS.revokedShare, CHECK_3]]) {
    assert.equal(byId[id].check_id, check);
    for (const col of CONTEXT) assert.equal(byId[id][col], null, `${id} ${col}`);
  }
  assert.equal(byId[LEGS.pending].sender_name, 'C');
  assert.equal(byId[LEGS.pending].check_id, null);

  // The platform owner reads B's incoming legs with the context of every check.
  const owner = await incoming(connectAs, PLATFORM_OWNER, TENANT_B);
  assert.equal(owner.error, null, owner.error?.message);
  assert.deepEqual(owner.rows.map((r) => r.id), B_READS);
  assert.equal(owner.rows.find((r) => r.id === LEGS.returned).check_number, '1002');
  assert.equal(owner.rows.find((r) => r.id === LEGS.revokedShare).check_number, '1003');

  // The sender reads nothing addressed to itself here; C reads only the leg addressed to it.
  assert.deepEqual((await incoming(connectAs, MEMBER_A, TENANT_A)).rows, []);
  assert.deepEqual((await incoming(connectAs, MEMBER_C, TENANT_C)).rows.map((r) => r.id), [LEGS.toC]);
  // Another organization's member, no user and a NULL tenant: refused.
  assert.ok(FORBIDDEN(await incoming(connectAs, MEMBER_A, TENANT_B)), 'sender reading the recipient');
  assert.ok(FORBIDDEN(await incoming(connectAs, MEMBER_C, TENANT_B)), 'other organization');
  assert.ok(FORBIDDEN(await incoming(connectAs, null, TENANT_B)), 'no user');
  assert.ok(FORBIDDEN(await incoming(connectAs, MEMBER_B, null)), 'NULL tenant');
  // authenticated and a plain login hold no EXECUTE.
  assert.ok(NO_EXECUTE(await incoming(connectAs, MEMBER_B, TENANT_B, 'sql144_plain')), 'plain login');
  const c =await connectAs('checksops');
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE authenticated');
    await c.query("SELECT set_config('request.app_user_id', $1, true)", [MEMBER_B]);
    await assert.rejects(c.query('SELECT * FROM public.get_tenant_incoming_transfers($1::uuid)', [TENANT_B]),
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

test('PostgreSQL 16: SQL 144 with a relation it reads under FORCE ROW LEVEL SECURITY or a missing column refuses the pre-conditions; the file\'s own rules agree; nothing changes', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql144-drift-', 61447, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const inspect = async () => (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;

  for (const table of ['payment_transfers', 'tenants', 'shared_checks', 'check_intake_items', 'claims']) {
    await admin.query(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
    const forced = await inspect();
    assert.deepEqual(forced.precondition_failures, ['definer_can_write_relations'], `${table}: ${JSON.stringify(forced.release_sql_inspect)}`);
    assert.equal(forced.live_definition_sha256, ABSENT_PRE);
    const blocked = authorized(forced.live_definition_sha256);
    const noApply = await executeReleaseProductionApply(KEY, manifest(blocked), { root: ROOT, pin: blocked, connect, consumedPath: consumedPath() });
    assert.equal(noApply.ok, false, table);
    await assert.rejects(asOwner(connectAs, TEXT), (e) => e.code === '55000' && new RegExp(`sql144_definer_cannot_reach: .*${table}`).test(e.message), table);
    assert.equal(await present(admin), false, table);
    await admin.query(`ALTER TABLE public.${table} NO FORCE ROW LEVEL SECURITY`);
  }

  // A column the function reads missing: prerequisites missing, and the file refuses.
  await admin.query('ALTER TABLE public.payment_transfers RENAME COLUMN destination_tenant_id TO destination_moved');
  const missing = await inspect();
  assert.ok(missing.release_sql_inspect.prerequisites_missing.includes('column public.payment_transfers.destination_tenant_id'),
    JSON.stringify(missing.release_sql_inspect.prerequisites_missing));
  assert.ok(missing.precondition_failures.includes('prerequisites_present'));
  await assert.rejects(asOwner(connectAs, TEXT), (e) => e.code === '55000' && /sql144_prerequisite_missing: .*destination_tenant_id/.test(e.message));
  assert.equal(await present(admin), false);
  await admin.query('ALTER TABLE public.payment_transfers RENAME COLUMN destination_moved TO destination_tenant_id');
  assert.deepEqual((await inspect()).precondition_failures, []);
  assert.equal(TENANT_A.length, 36);
}));
