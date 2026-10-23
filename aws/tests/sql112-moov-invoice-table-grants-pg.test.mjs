/**
 * SQL 112 (aws/workflows/sql/112_moov_invoice_table_grants.sql) on PostgreSQL 16, through its
 * production tool, the owner the non-superuser checksops_admin login:
 *
 *   - from the two tables' grants as the supabase migration 20260819015105 left them
 *     (authenticated: SELECT, INSERT, UPDATE, DELETE on both; service_role: ALL; checksops:
 *     nothing of its own): one apply reaches the intended fingerprint and checksops gains
 *     exactly the pinned lines on each table; authenticated's UPDATE and DELETE on
 *     moov_invoice_customers and service_role's grants are unchanged; a write by checksops
 *     passes the grant layer and row-level security decides; the file run again is a no-op and
 *     the tool refuses a re-apply as already in place;
 *   - every pinned line already held (what the production inspect may find, since the owner's
 *     invoice send of 2026-10-23 worked): the inspect reports already_applied true, so nothing
 *     is applied;
 *   - service_role only: the write fails at the grant layer ("permission denied for table
 *     moov_invoices"), before any policy; after one apply the grant layer opens and RLS decides;
 *     a partial grant applies to the intended fingerprint and keeps a line outside it.
 *
 * Run: node --test aws/tests/sql112-moov-invoice-table-grants-pg.test.mjs (as root the PG
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
import { CUSTOMERS, INVOICES, MOOV_INVOICE_TABLES, SERVICE_ROLE_ONLY_INVOICE_GRANTS, SUPABASE_ERA_INVOICE_GRANTS } from './helpers/sql112-invoice-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TABLES = Object.freeze([INVOICES, CUSTOMERS]);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin('sql112', ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const ALL_EIGHT = Object.freeze(['authenticated DELETE', 'authenticated INSERT', 'authenticated SELECT', 'authenticated UPDATE', 'checksops DELETE', 'checksops INSERT', 'checksops SELECT', 'checksops UPDATE']);
const ALL_FOUR = Object.freeze(['authenticated INSERT', 'authenticated SELECT', 'checksops INSERT', 'checksops SELECT']);
/** The pinned lines per table (the production pin's intended post-state). */
const PINNED = Object.freeze({ [INVOICES]: ALL_EIGHT, [CUSTOMERS]: ALL_FOUR });
const CHECKSOPS_LINES = Object.freeze(Object.fromEntries(TABLES.map((t) => [t, PINNED[t].filter((l) => l.startsWith('checksops '))])));

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
  const workstream = 'prod-sql112-pg-test';
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
    one_use_id: `sql112-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-23T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql112-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
  const fx = await releaseFixture(pg, prefix, port, { extra: [MOOV_INVOICE_TABLES, grants] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/** Every table's ACL lines (grantee privilege), the owner excluded. */
const tableAcls = async (admin) => Object.fromEntries(await Promise.all(TABLES.map(async (table) => [table, (await admin.query(`SELECT pg_catalog.pg_get_userbyid(a.grantee) || ' ' || a.privilege_type AS line
  FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
  WHERE c.oid = $1::regclass AND a.grantee <> c.relowner ORDER BY 1`, [table])).rows.map((r) => r.line)])));
const withPinned = (acls) => Object.fromEntries(TABLES.map((t) => [t, [...new Set([...acls[t], ...PINNED[t]])].sort()]));

/** An INSERT as the API login (checksops, a member of authenticated) for a tenant member; returns the error or null. */
async function insertAsApi(connectAs) {
  const c = await connectAs('checksops');
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.app_user_id', $1, true)", [MEMBER_A]);
    await c.query(`INSERT INTO ${INVOICES} (tenant_id, status, amount_cents) VALUES ($1::uuid, 'draft', 100)`, [TENANT_A]);
    return null;
  } catch (error) {
    return error;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
}

test('PostgreSQL 16: from the supabase-era grants, SQL 112 through its production tool: checksops gains exactly the pinned lines, RLS decides, other grants unchanged', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql112-prod-', 59712, SUPABASE_ERA_INVOICE_GRANTS, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const before = await tableAcls(admin);
  for (const table of TABLES) {
    assert.ok(before[table].includes('service_role SELECT'), table);
    assert.deepEqual(before[table].filter((line) => line.startsWith('checksops ')), [], table);
    assert.deepEqual(before[table].filter((line) => line.startsWith('authenticated ')), ['authenticated DELETE', 'authenticated INSERT', 'authenticated SELECT', 'authenticated UPDATE'], table);
  }

  const s = (await inspectReleaseProduction('sql112', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, {});
  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql112', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, s.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  // Exactly the pinned lines were added on each table (checksops's; authenticated already held
  // its own); every line outside the pin (authenticated's UPDATE and DELETE on the customers
  // table, service_role's) is unchanged.
  const after = await tableAcls(admin);
  assert.deepEqual(after, withPinned(before));
  for (const table of TABLES) {
    assert.deepEqual(after[table].filter((line) => line.startsWith('checksops ')), [...CHECKSOPS_LINES[table]], table);
    assert.deepEqual(after[table].filter((line) => !PINNED[table].includes(line)), before[table].filter((line) => !PINNED[table].includes(line)), table);
  }
  assert.ok(after[CUSTOMERS].includes('authenticated DELETE'));
  assert.ok(!after[CUSTOMERS].includes('checksops DELETE'));
  assert.ok(after[INVOICES].includes('checksops DELETE'));

  // After SQL 112: the grant layer passes; row-level security decides (no policy here).
  const insert = await insertAsApi(connectAs);
  assert.ok(insert, 'row-level security still decides');
  assert.doesNotMatch(insert.message, /permission denied for table/);
  assert.match(insert.message, /row-level security/);

  // Idempotent: the file again is a no-op; the tool refuses a re-apply as already in place.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(TEXT);
  } finally {
    await owner.end();
  }
  assert.deepEqual(await tableAcls(admin), after);
  const again = (await inspectReleaseProduction('sql112', { connect, pin, root: ROOT })).details;
  assert.equal(again.already_applied, true);
  assert.equal(again.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply('sql112', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: every pinned line already held: the inspect reports already_applied true on the committed pin, nothing to apply', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql112-held-', 59812, SUPABASE_ERA_INVOICE_GRANTS, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${INVOICES} TO checksops`);
  await admin.query(`GRANT SELECT, INSERT ON TABLE ${CUSTOMERS} TO checksops`);
  const before = await tableAcls(admin);
  const s = (await inspectReleaseProduction('sql112', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, true);
  assert.equal(s.live_definition_sha256, PIN.intended_replacement_sha256);
  assert.equal(s.read_only, true);
  assert.deepEqual(await tableAcls(admin), before);
  // A pin whose recorded pre-state is the intended state is refused as already in place.
  const pin = authorized(s.live_definition_sha256);
  const replay = await executeReleaseProductionApply('sql112', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
  assert.deepEqual(await tableAcls(admin), before);
}));

test('PostgreSQL 16: service_role only: permission denied before, the grant layer opens after one apply; a partial grant applies to the intended fingerprint', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql112-svc-', 59912, SERVICE_ROLE_ONLY_INVOICE_GRANTS, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const before = await tableAcls(admin);
  for (const table of TABLES) assert.deepEqual(before[table].filter((line) => !line.startsWith('service_role ')), [], table);

  // Before SQL 112: refused at the grant layer, before any policy.
  const denied = await insertAsApi(connectAs);
  assert.equal(denied?.code, '42501');
  assert.match(denied.message, /permission denied for table moov_invoices/);

  const s = (await inspectReleaseProduction('sql112', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql112', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  assert.deepEqual(await tableAcls(admin), withPinned(before));
  const opened = await insertAsApi(connectAs);
  assert.ok(opened, 'row-level security still decides');
  assert.doesNotMatch(opened.message, /permission denied for table/);
  assert.match(opened.message, /row-level security/);

  // A partial grant (only checksops SELECT on the invoices table, plus an UPDATE on the
  // customers table the file does not pin): the file adds the rest and keeps the UPDATE.
  await admin.query(`REVOKE ALL ON TABLE ${INVOICES}, ${CUSTOMERS} FROM checksops, authenticated`);
  await admin.query(`GRANT SELECT ON TABLE ${INVOICES} TO checksops`);
  await admin.query(`GRANT UPDATE ON TABLE ${CUSTOMERS} TO checksops`);
  const partial = (await inspectReleaseProduction('sql112', { connect, pin: PIN, root: ROOT })).details;
  assert.equal(partial.already_applied, false);
  assert.deepEqual(partial.precondition_failures, [], JSON.stringify(partial.release_sql_inspect));
  const pin2 = authorized(partial.live_definition_sha256);
  const applied2 = await executeReleaseProductionApply('sql112', manifest(pin2), { root: ROOT, pin: pin2, connect, consumedPath: consumedPath() });
  assert.equal(applied2.ok, true, JSON.stringify(applied2));
  assert.equal(applied2.details.receipt.after_hash, PIN.intended_replacement_sha256);
  const acls = await tableAcls(admin);
  for (const table of TABLES) for (const line of PINNED[table]) assert.ok(acls[table].includes(line), `${table} ${line}`);
  assert.ok(acls[CUSTOMERS].includes('checksops UPDATE'));
}));
