/**
 * SQL 104 (aws/workflows/sql/104_payment_idempotency_keys_grant.sql) on PostgreSQL 16, through
 * its production tool, after the real SQL 91 (aws/workflows/sql/91_moov_onboarding.sql,
 * unchanged), from the table's grants as supabase migration 20260727224957 left them
 * (service_role only), the owner the non-superuser checksops_admin login:
 *
 *   - before SQL 104, an INSERT by checksops (a member of authenticated) fails at the grant
 *     layer ("permission denied for table payment_idempotency_keys"), before SQL 91's policies;
 *   - one apply reaches the intended fingerprint; the same INSERT then passes the grant layer and
 *     SQL 91's policy decides (row-level security refuses a caller who is not the onboarding
 *     writer); service_role's grants are unchanged;
 *   - the file run again is a no-op and the tool refuses a re-apply as already in place;
 *   - staging-like: the six grants already held by hand (#1062) read as already applied, with
 *     no precondition failure; a partial hand grant applies to the intended fingerprint.
 *
 * Run: node --test aws/tests/sql104-payment-idempotency-keys-grant-pg.test.mjs (as root the PG
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
const TABLE = 'public.payment_idempotency_keys';
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin('sql104', ROOT);
const PIN91 = loadReleaseProductionPin('sql91', ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const SQL91_TEXT = fs.readFileSync(path.join(ROOT, PIN91.filename), 'utf8');
const ALL_SIX = Object.freeze(['authenticated INSERT', 'authenticated SELECT', 'authenticated UPDATE', 'checksops INSERT', 'checksops SELECT', 'checksops UPDATE']);
// The table as the supabase migration left it: service_role's grant only (run as the superuser, before ownership).
const SUPABASE_ERA_GRANTS = `
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
REVOKE ALL ON TABLE public.payment_idempotency_keys FROM checksops, authenticated;
GRANT ALL ON TABLE public.payment_idempotency_keys TO service_role;`;

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
  const workstream = 'prod-sql104-pg-test';
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
    one_use_id: `sql104-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-19T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql104-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
  const fx = await releaseFixture(pg, prefix, port, { extra: [SUPABASE_ERA_GRANTS] });
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

/** The table's ACL lines (grantee privilege), the owner excluded. */
const tableAcl = async (admin) => (await admin.query(`SELECT pg_catalog.pg_get_userbyid(a.grantee) || ' ' || a.privilege_type AS line
  FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
  WHERE c.oid = $1::regclass AND a.grantee <> c.relowner ORDER BY 1`, [TABLE])).rows.map((r) => r.line);

/** An INSERT as the API login (checksops, a member of authenticated) for a tenant member; returns the error or null. */
async function insertAsApi(connectAs) {
  const c = await connectAs('checksops');
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.app_user_id', $1, true)", [MEMBER_A]);
    await c.query(`INSERT INTO ${TABLE} (tenant_id, idempotency_key, status) VALUES ($1::uuid, 'sql104-test', 'pending')`, [TENANT_A]);
    return null;
  } catch (error) {
    return error;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
}

test('PostgreSQL 16: from the supabase-era grants, SQL 104 through its production tool: the grant layer opens, SQL 91\'s policy decides, other grants unchanged', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql104-prod-', 59700, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const serviceRole = (await tableAcl(admin)).filter((line) => line.startsWith('service_role '));
  assert.ok(serviceRole.length > 0);
  assert.deepEqual((await tableAcl(admin)).filter((line) => !line.startsWith('service_role ')), []);

  // Before SQL 104: refused at the grant layer, before any policy.
  const before = await insertAsApi(connectAs);
  assert.equal(before?.code, '42501');
  assert.match(before.message, /permission denied for table payment_idempotency_keys/);

  const s = (await inspectReleaseProduction('sql104', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, { sql91: true });
  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql104', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, s.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  assert.deepEqual(await tableAcl(admin), [...ALL_SIX, ...serviceRole].sort());

  // After SQL 104: the grant layer passes; SQL 91's insert policy decides (MEMBER_A is not the
  // onboarding writer here, so row-level security refuses the row).
  const after = await insertAsApi(connectAs);
  assert.ok(after, 'SQL 91\'s policy still decides');
  assert.doesNotMatch(after.message, /permission denied for table/);
  assert.match(after.message, /row-level security/);

  // Idempotent: the file again is a no-op; the tool refuses a re-apply as already in place.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(TEXT);
  } finally {
    await owner.end();
  }
  assert.deepEqual(await tableAcl(admin), [...ALL_SIX, ...serviceRole].sort());
  const again = (await inspectReleaseProduction('sql104', { connect, pin, root: ROOT })).details;
  assert.equal(again.already_applied, true);
  assert.equal(again.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply('sql104', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
  // SQL 91 is still at its own intended fingerprint.
  const s91 = (await inspectReleaseProduction('sql91', { connect, pin: PIN91, root: ROOT })).details;
  assert.equal(s91.live_definition_sha256, PIN91.intended_replacement_sha256);
}));

test('PostgreSQL 16: staging-like, the grants already held by hand read as already applied; a partial hand grant applies to the intended fingerprint', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql104-stg-', 59800, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  // #1062's hand grant, as the owner would run it.
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(`GRANT SELECT, INSERT, UPDATE ON TABLE ${TABLE} TO checksops, authenticated`);
  } finally {
    await owner.end();
  }
  const held = (await inspectReleaseProduction('sql104', { connect, pin: PIN, root: ROOT })).details;
  assert.equal(held.already_applied, true);
  assert.equal(held.live_definition_sha256, PIN.intended_replacement_sha256);
  assert.deepEqual(held.precondition_failures, []);
  assert.equal(held.apply_preconditions_met, false);
  const heldInsert = await insertAsApi(connectAs);
  assert.doesNotMatch(heldInsert?.message || '', /permission denied for table/);

  // A partial grant (only checksops SELECT, plus a DELETE the file does not touch): the file adds the rest.
  await admin.query(`REVOKE ALL ON TABLE ${TABLE} FROM checksops, authenticated`);
  await admin.query(`GRANT SELECT, DELETE ON TABLE ${TABLE} TO checksops`);
  const partial = (await inspectReleaseProduction('sql104', { connect, pin: PIN, root: ROOT })).details;
  assert.equal(partial.already_applied, false);
  assert.deepEqual(partial.precondition_failures, [], JSON.stringify(partial.release_sql_inspect));
  const pin = authorized(partial.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql104', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  const acl = await tableAcl(admin);
  for (const line of [...ALL_SIX, 'checksops DELETE']) assert.ok(acl.includes(line), line);
}));
