/**
 * SQL 105 (aws/workflows/sql/105_onboarding_payment_table_grants.sql) on PostgreSQL 16, through
 * its production tool, after the real SQL 91 (aws/workflows/sql/91_moov_onboarding.sql,
 * unchanged), the owner the non-superuser checksops_admin login:
 *
 *   - from the four tables' original grants as the supabase migrations left them (authenticated:
 *     SELECT, INSERT, UPDATE, DELETE on payment_provider_accounts and payment_provider_methods,
 *     SELECT, INSERT, UPDATE on payment_method_verifications, SELECT on payment_event_log;
 *     service_role: ALL; checksops: nothing of its own): one apply reaches the intended
 *     fingerprint and checksops gains exactly the pinned lines on each table; authenticated's
 *     DELETE and service_role's grants are unchanged; an INSERT by checksops passes the grant
 *     layer and SQL 91's policy decides; the file run again is a no-op and the tool refuses a
 *     re-apply as already in place; SQL 91 keeps its fingerprint;
 *   - staging-like (what staging showed 2026-10-20 12:18:20Z: neither checksops nor authenticated
 *     effectively granted, service_role only): the INSERT fails at the grant layer ("permission
 *     denied for table payment_provider_accounts"), before SQL 91's policies; after one apply the
 *     grant layer opens and the policy decides; a partial grant applies to the intended
 *     fingerprint.
 *
 * Run: node --test aws/tests/sql105-onboarding-payment-table-grants-pg.test.mjs (as root the PG
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
const ACCOUNTS = 'public.payment_provider_accounts';
const METHODS = 'public.payment_provider_methods';
const VERIFICATIONS = 'public.payment_method_verifications';
const EVENT_LOG = 'public.payment_event_log';
const TABLES = Object.freeze([ACCOUNTS, METHODS, VERIFICATIONS, EVENT_LOG]);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin('sql105', ROOT);
const PIN91 = loadReleaseProductionPin('sql91', ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const SQL91_TEXT = fs.readFileSync(path.join(ROOT, PIN91.filename), 'utf8');
const ALL_SIX = Object.freeze(['authenticated INSERT', 'authenticated SELECT', 'authenticated UPDATE', 'checksops INSERT', 'checksops SELECT', 'checksops UPDATE']);
const ALL_FOUR = Object.freeze(['authenticated INSERT', 'authenticated SELECT', 'checksops INSERT', 'checksops SELECT']);
/** The pinned lines per table (the production pin's intended post-state). */
const PINNED = Object.freeze({ [ACCOUNTS]: ALL_SIX, [METHODS]: ALL_SIX, [VERIFICATIONS]: ALL_SIX, [EVENT_LOG]: ALL_FOUR });
const CHECKSOPS_LINES = Object.freeze(Object.fromEntries(TABLES.map((t) => [t, PINNED[t].filter((l) => l.startsWith('checksops '))])));
// The four tables as the supabase migrations left them (run as the superuser, before ownership).
const SUPABASE_ERA_GRANTS = `
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
REVOKE ALL ON TABLE ${TABLES.join(', ')} FROM checksops, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${ACCOUNTS}, ${METHODS} TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE ${VERIFICATIONS} TO authenticated;
GRANT SELECT ON TABLE ${EVENT_LOG} TO authenticated;
GRANT ALL ON TABLE ${TABLES.join(', ')} TO service_role;`;
// Staging as it refused checksops on 2026-10-20: service_role's grants only.
const SERVICE_ROLE_ONLY_GRANTS = `
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
REVOKE ALL ON TABLE ${TABLES.join(', ')} FROM checksops, authenticated;
GRANT ALL ON TABLE ${TABLES.join(', ')} TO service_role;`;

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
  const workstream = 'prod-sql105-pg-test';
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
    one_use_id: `sql105-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-20T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql105-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
    const owner = await fx.connectAs('checksops_admin');
    try {
      await owner.query(SQL91_TEXT);
    } finally {
      await owner.end();
    }
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
    await c.query(`INSERT INTO ${ACCOUNTS} (tenant_id, environment, provider_account_id, onboarding_status) VALUES ($1::uuid, 'sandbox', 'sql105-test', 'pending')`, [TENANT_A]);
    return null;
  } catch (error) {
    return error;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
}

test('PostgreSQL 16: from the supabase-era grants, SQL 105 through its production tool: checksops gains exactly the pinned lines, SQL 91\'s policy decides, other grants unchanged', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql105-prod-', 59710, SUPABASE_ERA_GRANTS, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const before = await tableAcls(admin);
  for (const table of TABLES) {
    assert.ok(before[table].includes('service_role SELECT'), table);
    assert.deepEqual(before[table].filter((line) => line.startsWith('checksops ')), [], table);
  }
  assert.deepEqual(before[ACCOUNTS].filter((line) => line.startsWith('authenticated ')), ['authenticated DELETE', 'authenticated INSERT', 'authenticated SELECT', 'authenticated UPDATE']);
  assert.deepEqual(before[EVENT_LOG].filter((line) => line.startsWith('authenticated ')), ['authenticated SELECT']);

  const s = (await inspectReleaseProduction('sql105', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, { sql91: true });
  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql105', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, s.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  // Exactly the pinned lines were added on each table (checksops's everywhere; authenticated
  // already held its own except INSERT on the event log); every line outside the pin
  // (authenticated's DELETE, service_role's) is unchanged.
  const after = await tableAcls(admin);
  assert.deepEqual(after, withPinned(before));
  for (const table of TABLES) {
    assert.deepEqual(after[table].filter((line) => line.startsWith('checksops ')), [...CHECKSOPS_LINES[table]], table);
    assert.deepEqual(after[table].filter((line) => !PINNED[table].includes(line)), before[table].filter((line) => !PINNED[table].includes(line)), table);
  }
  assert.ok(!before[EVENT_LOG].includes('authenticated INSERT') && after[EVENT_LOG].includes('authenticated INSERT'));
  assert.ok(after[ACCOUNTS].includes('authenticated DELETE'));
  assert.ok(!after[ACCOUNTS].includes('checksops DELETE'));
  assert.ok(!after[EVENT_LOG].includes('checksops UPDATE'));

  // After SQL 105: the grant layer passes; SQL 91's insert policy decides (MEMBER_A is not the
  // onboarding writer here, so row-level security refuses the row).
  const insert = await insertAsApi(connectAs);
  assert.ok(insert, 'SQL 91\'s policy still decides');
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
  const again = (await inspectReleaseProduction('sql105', { connect, pin, root: ROOT })).details;
  assert.equal(again.already_applied, true);
  assert.equal(again.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply('sql105', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
  // SQL 91 is still at its own intended fingerprint.
  const s91 = (await inspectReleaseProduction('sql91', { connect, pin: PIN91, root: ROOT })).details;
  assert.equal(s91.live_definition_sha256, PIN91.intended_replacement_sha256);
}));

test('PostgreSQL 16: staging-like (service_role only): permission denied before, the grant layer opens after one apply; a partial grant applies to the intended fingerprint', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql105-stg-', 59810, SERVICE_ROLE_ONLY_GRANTS, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const before = await tableAcls(admin);
  for (const table of TABLES) assert.deepEqual(before[table].filter((line) => !line.startsWith('service_role ')), [], table);

  // Before SQL 105: refused at the grant layer, before any policy (staging 2026-10-20 12:18:20Z).
  const denied = await insertAsApi(connectAs);
  assert.equal(denied?.code, '42501');
  assert.match(denied.message, /permission denied for table payment_provider_accounts/);

  const s = (await inspectReleaseProduction('sql105', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql105', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  assert.deepEqual(await tableAcls(admin), withPinned(before));
  const opened = await insertAsApi(connectAs);
  assert.ok(opened, 'SQL 91\'s policy still decides');
  assert.doesNotMatch(opened.message, /permission denied for table/);
  assert.match(opened.message, /row-level security/);

  // A partial grant (only checksops SELECT on one table, plus a DELETE the file does not touch):
  // the file adds the rest and keeps the DELETE.
  await admin.query(`REVOKE ALL ON TABLE ${TABLES.join(', ')} FROM checksops, authenticated`);
  await admin.query(`GRANT SELECT, DELETE ON TABLE ${METHODS} TO checksops`);
  const partial = (await inspectReleaseProduction('sql105', { connect, pin: PIN, root: ROOT })).details;
  assert.equal(partial.already_applied, false);
  assert.deepEqual(partial.precondition_failures, [], JSON.stringify(partial.release_sql_inspect));
  const pin2 = authorized(partial.live_definition_sha256);
  const applied2 = await executeReleaseProductionApply('sql105', manifest(pin2), { root: ROOT, pin: pin2, connect, consumedPath: consumedPath() });
  assert.equal(applied2.ok, true, JSON.stringify(applied2));
  assert.equal(applied2.details.receipt.after_hash, PIN.intended_replacement_sha256);
  const acls = await tableAcls(admin);
  for (const table of TABLES) for (const line of PINNED[table]) assert.ok(acls[table].includes(line), `${table} ${line}`);
  assert.ok(acls[METHODS].includes('checksops DELETE'));
}));
