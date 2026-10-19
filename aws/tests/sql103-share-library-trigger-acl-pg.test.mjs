/**
 * SQL 103 (aws/workflows/sql/103_share_library_trigger_acl.sql) then SQL 29
 * (aws/rls/sql/29_mortgage_ops_library_parity.sql, unchanged) on PostgreSQL 16, through their
 * production tools, from production's ACL on the trigger function (read-only inspect
 * 2026-10-19, main bf6b7555e): PUBLIC, checksops and owner EXECUTE, the owner the
 * non-superuser checksops_admin login.
 *
 *   - before SQL 103, SQL 29's guard refuses (function_acl_replaceable);
 *   - SQL 103's inspect passes; one apply reaches its intended fingerprint (owner only, the
 *     function otherwise unchanged);
 *   - SQL 29's guard then passes and its apply reaches its intended fingerprint
 *     1271ea9b61ec983f88e911b23c569403979fb5f560880021b58d3b1e57243c79, unchanged;
 *   - after SQL 29, SQL 103 is already in place (refused as a re-apply) and the file itself is
 *     a no-op (idempotent); the same holds when SQL 29 ran first from an owner-only ACL
 *     (staging).
 *
 * Run: node --test aws/tests/sql103-share-library-trigger-acl-pg.test.mjs (as root the PG
 * helpers run the server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import {
  executeReleaseProductionApply,
  inspectReleaseProduction,
  loadReleaseProductionPin,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import {
  executeLibraryProductionApply,
  inspectLibraryProduction,
  loadLibraryProductionPin,
} from '../../scripts/deployment-guard/lib/sql29-sql30-library-production-apply.mjs';
import { libraryFixture, pgSkipReason } from './helpers/library-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FN = 'public.share_library_docs_to_mortgage_request()';
const SQL29_INTENDED = '1271ea9b61ec983f88e911b23c569403979fb5f560880021b58d3b1e57243c79';
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN103 = loadReleaseProductionPin('sql103', ROOT);
const PIN29 = loadLibraryProductionPin('sql29', ROOT);
const TEXT103 = fs.readFileSync(path.join(ROOT, PIN103.filename), 'utf8');

const authorized = (pin, live) => Object.freeze({
  ...pin,
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: live,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
});
function manifest(key, pin) {
  const live = pin.expected_live_definition_sha256;
  const fingerprint = { sql: live };
  const workstream = `prod-${key}-sql103-pg-test`;
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
    one_use_id: `${key}-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-19T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql103-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
  const fx = await libraryFixture(pg, prefix, port);
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

const aclOf = async (admin) => (await admin.query(`SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END
  || ' ' || a.privilege_type || ' grantor=' || pg_catalog.pg_get_userbyid(a.grantor) AS line
  FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
  WHERE p.oid = pg_catalog.to_regprocedure($1) ORDER BY 1`, [FN])).rows.map((r) => r.line);

test('PostgreSQL 16: from production\'s trigger ACL, SQL 103 then SQL 29: SQL 29\'s guard passes and it reaches 1271ea9b... unchanged', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql103-29-', 58300, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const owner = await connectAs('checksops_admin');
  try {
    // Production 2026-10-19: PUBLIC (the default), checksops and the owner, granted by the owner.
    await owner.query(`GRANT EXECUTE ON FUNCTION ${FN} TO checksops`);
  } finally {
    await owner.end();
  }
  assert.deepEqual(await aclOf(admin), ['PUBLIC EXECUTE grantor=checksops_admin', 'checksops EXECUTE grantor=checksops_admin', 'checksops_admin EXECUTE grantor=checksops_admin']);
  assert.equal(PIN29.intended_replacement_sha256, SQL29_INTENDED);

  // Before SQL 103: SQL 29's guard refuses the checksops entry.
  const s29Before = (await inspectLibraryProduction('sql29', { connect, pin: PIN29, root: ROOT })).details;
  assert.deepEqual(s29Before.precondition_failures, ['function_acl_replaceable']);

  // SQL 103: read-only inspect passes; one apply on the intended fingerprint.
  const s103 = (await inspectReleaseProduction('sql103', { connect, pin: PIN103, root: ROOT })).details;
  assert.deepEqual(s103.precondition_failures, [], JSON.stringify(s103.release_sql_inspect));
  assert.equal(s103.already_applied, false);
  assert.deepEqual(s103.predecessors, {});
  assert.deepEqual(s103.release_sql_inspect.acl_functions, [{
    name: 'share_library_docs_to_mortgage_request()',
    state: 'different',
    acl: ['PUBLIC EXECUTE grantor=owner', 'checksops EXECUTE grantor=owner', 'owner EXECUTE grantor=owner'],
  }]);
  const pin103 = authorized(PIN103, s103.live_definition_sha256);
  const applied103 = await executeReleaseProductionApply('sql103', manifest('sql103', pin103), { root: ROOT, pin: pin103, connect, consumedPath: consumedPath() });
  assert.equal(applied103.ok, true, JSON.stringify(applied103));
  assert.equal(applied103.details.receipt.before_hash, s103.live_definition_sha256);
  assert.equal(applied103.details.receipt.after_hash, PIN103.intended_replacement_sha256);
  assert.deepEqual(await aclOf(admin), ['checksops_admin EXECUTE grantor=checksops_admin']);

  // SQL 29: the guard passes now, and its apply reaches its own intended fingerprint.
  const s29 = (await inspectLibraryProduction('sql29', { connect, pin: PIN29, root: ROOT })).details;
  assert.deepEqual(s29.precondition_failures, [], JSON.stringify(s29.sql29));
  const pin29 = authorized(PIN29, s29.live_definition_sha256);
  const applied29 = await executeLibraryProductionApply('sql29', manifest('sql29', pin29), { root: ROOT, pin: pin29, connect, consumedPath: consumedPath() });
  assert.equal(applied29.ok, true, JSON.stringify(applied29));
  assert.equal(applied29.details.receipt.after_hash, SQL29_INTENDED);
  assert.equal((await inspectLibraryProduction('sql29', { connect, pin: pin29, root: ROOT })).details.already_applied, true);

  // After SQL 29: SQL 103 is in place (a re-apply is refused) and the file is a no-op.
  const s103After = (await inspectReleaseProduction('sql103', { connect, pin: pin103, root: ROOT })).details;
  assert.equal(s103After.already_applied, true);
  const replay = await executeReleaseProductionApply('sql103', manifest('sql103', pin103), { root: ROOT, pin: pin103, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
  const again = await connectAs('checksops_admin');
  try {
    await again.query(TEXT103);
  } finally {
    await again.end();
  }
  assert.deepEqual(await aclOf(admin), ['checksops_admin EXECUTE grantor=checksops_admin']);
  assert.equal((await inspectLibraryProduction('sql29', { connect, pin: pin29, root: ROOT })).details.already_applied, true);
}));

test('PostgreSQL 16: SQL 29 first from an owner-only ACL (staging): SQL 103 is already in place; SQL 103 on the default ACL alone also works', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql103-stg-', 58400, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  // The default ACL (PUBLIC and owner): SQL 29 passes on its own (it revokes PUBLIC).
  const s29 = (await inspectLibraryProduction('sql29', { connect, pin: PIN29, root: ROOT })).details;
  assert.deepEqual(s29.precondition_failures, []);
  const pin29 = authorized(PIN29, s29.live_definition_sha256);
  const applied29 = await executeLibraryProductionApply('sql29', manifest('sql29', pin29), { root: ROOT, pin: pin29, connect, consumedPath: consumedPath() });
  assert.equal(applied29.ok, true, JSON.stringify(applied29));
  assert.equal(applied29.details.receipt.after_hash, SQL29_INTENDED);
  const s103 = (await inspectReleaseProduction('sql103', { connect, pin: PIN103, root: ROOT })).details;
  assert.equal(s103.already_applied, true);
  assert.equal(s103.live_definition_sha256, PIN103.intended_replacement_sha256);
  assert.equal(s103.apply_preconditions_met, false);
  // Re-adding PUBLIC (the default) is the other starting state SQL 103 accepts: PUBLIC revoked too.
  await admin.query(`GRANT EXECUTE ON FUNCTION ${FN} TO PUBLIC`);
  const withPublic = (await inspectReleaseProduction('sql103', { connect, pin: PIN103, root: ROOT })).details;
  assert.deepEqual(withPublic.precondition_failures, []);
  const pin103 = authorized(PIN103, withPublic.live_definition_sha256);
  const applied103 = await executeReleaseProductionApply('sql103', manifest('sql103', pin103), { root: ROOT, pin: pin103, connect, consumedPath: consumedPath() });
  assert.equal(applied103.ok, true, JSON.stringify(applied103));
  assert.equal(applied103.details.receipt.after_hash, PIN103.intended_replacement_sha256);
  assert.equal((await inspectLibraryProduction('sql29', { connect, pin: pin29, root: ROOT })).details.already_applied, true);
}));
