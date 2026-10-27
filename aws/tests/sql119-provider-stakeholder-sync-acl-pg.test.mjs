/**
 * SQL 119 (aws/workflows/sql/119_provider_stakeholder_sync_acl.sql) then SQL 115 on PostgreSQL 16,
 * each through its production tool, the owner the non-superuser checksops_admin login, from the
 * real supabase function, trigger function and triggers (helpers/sql115-provider-stakeholder-schema.mjs)
 * with production's ACL (read-only inspect 2026-10-27, SSM 2db258df-47a8-414b-b7c6-b9686768c5b9):
 * EXECUTE for PUBLIC, checksops and the owner.
 *
 *   - SQL 115's inspect refuses that ACL (function_acl_replaceable), as in production;
 *   - SQL 119 applies once and reaches its intended fingerprint (owner only, grantor the owner)
 *     with the function's body, attributes and owner, the trigger function and the triggers
 *     unchanged, and the payment-account triggers still writing as the owner;
 *   - SQL 115 then passes its pre-conditions and reaches its intended fingerprint unchanged
 *     (8aed39a4...); SQL 119 is then refused as already in place;
 *   - the file run again is a no-op.
 *
 * Run: node --test aws/tests/sql119-provider-stakeholder-sync-acl-pg.test.mjs (as root the PG
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
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { PROVIDER_STAKEHOLDER_SCHEMA, SANDBOX_ACCOUNT, SYNC_FUNCTION, TENANT_B } from './helpers/sql115-provider-stakeholder-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PINS = { sql119: loadReleaseProductionPin('sql119', ROOT), sql115: loadReleaseProductionPin('sql115', ROOT) };
const TEXT = fs.readFileSync(path.join(ROOT, PINS.sql119.filename), 'utf8');

const authorized = (key, live) => Object.freeze({
  ...PINS[key],
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: live,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
});
function manifest(key, pin) {
  const live = pin.expected_live_definition_sha256;
  const fingerprint = { sql: live };
  const workstream = `prod-${key}-pg-test`;
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
    build_timestamp: '2026-10-27T12:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql119-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

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
  const fx = await releaseFixture(pg, prefix, port, { extra: [PROVIDER_STAKEHOLDER_SCHEMA] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/** The function's EXECUTE ACL ('owner' for the owner's own line). */
const executeAcl = async (admin) => (await admin.query(`SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' WHEN a.grantee = p.proowner THEN 'owner'
    ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ' ' || a.privilege_type AS line
  FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
  WHERE p.oid = $1::regprocedure ORDER BY 1`, [SYNC_FUNCTION])).rows.map((r) => r.line);
/** Everything about the function but its ACL, the trigger function and the triggers, as PostgreSQL prints them. */
const unchangedSide = async (admin) => ({
  fn: (await admin.query(`SELECT md5(pg_catalog.pg_get_functiondef(p.oid)) || ' ' || p.proowner::regrole::text AS d FROM pg_catalog.pg_proc p
    WHERE p.oid = $1::regprocedure`, [SYNC_FUNCTION])).rows[0].d,
  trigger_fn: (await admin.query(`SELECT md5(pg_catalog.pg_get_functiondef(p.oid)) || ' ' || COALESCE(p.proacl::text, '') AS d FROM pg_catalog.pg_proc p
    WHERE p.oid = 'public.trg_sync_provider_stakeholder_account()'::regprocedure`)).rows[0].d,
  triggers: (await admin.query(`SELECT t.tgname || ' ' || pg_catalog.pg_get_triggerdef(t.oid) AS d FROM pg_catalog.pg_trigger t
    WHERE t.tgname LIKE 'trg_sync_provider_stakeholder_%' ORDER BY 1`)).rows.map((r) => r.d),
});

test('PostgreSQL 16: production\'s ACL refuses SQL 115; SQL 119 leaves the owner only, then SQL 115 passes and reaches its intended fingerprint', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql119-prod-', 59919, async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  // Production's ACL: PUBLIC, checksops and the owner (the supabase-era anon, authenticated and
  // service_role lines are not there).
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(`REVOKE ALL ON FUNCTION ${SYNC_FUNCTION} FROM anon, authenticated, service_role`);
    await owner.query(`GRANT EXECUTE ON FUNCTION ${SYNC_FUNCTION} TO checksops`);
  } finally {
    await owner.end();
  }
  assert.deepEqual(await executeAcl(admin), ['PUBLIC EXECUTE', 'checksops EXECUTE', 'owner EXECUTE']);
  const side = await unchangedSide(admin);
  assert.equal(side.triggers.length, 2);

  // SQL 115 refuses it, as the production inspect of 2026-10-27 did.
  const blocked = (await inspectReleaseProduction('sql115', { connect, pin: PINS.sql115, root: ROOT })).details;
  assert.equal(blocked.already_applied, false);
  assert.deepEqual(blocked.precondition_failures, ['function_acl_replaceable'], JSON.stringify(blocked.release_sql_inspect));

  // SQL 119 through its production tool.
  const s = (await inspectReleaseProduction('sql119', { connect, pin: PINS.sql119, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.release_sql_inspect.acl_functions[0].acl, ['PUBLIC EXECUTE grantor=owner', 'checksops EXECUTE grantor=owner', 'owner EXECUTE grantor=owner']);
  const pin119 = authorized('sql119', s.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql119', manifest('sql119', pin119), { root: ROOT, pin: pin119, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, s.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PINS.sql119.intended_replacement_sha256);
  assert.deepEqual(await executeAcl(admin), ['owner EXECUTE']);
  assert.deepEqual(await unchangedSide(admin), side);
  // The payment-account triggers still run the function as the owner (SECURITY DEFINER).
  await admin.query(`INSERT INTO public.payment_provider_accounts (id, tenant_id, provider, environment, provider_account_id, display_name)
    VALUES ('${SANDBOX_ACCOUNT}', '${TENANT_B}', 'moov', 'sandbox', 'moov-sandbox-b', 'B')`);
  const member = await connectAs('checksops');
  try {
    await assert.rejects(member.query(`SELECT ${SYNC_FUNCTION.replace('(uuid)', '')}($1::uuid)`, [TENANT_B]), (e) => e.code === '42501');
  } finally {
    await member.end();
  }

  // The file again is a no-op; the tool refuses a re-apply as already in place.
  const again = await connectAs('checksops_admin');
  try {
    await again.query(TEXT);
  } finally {
    await again.end();
  }
  assert.deepEqual(await executeAcl(admin), ['owner EXECUTE']);
  const done = (await inspectReleaseProduction('sql119', { connect, pin: pin119, root: ROOT })).details;
  assert.equal(done.already_applied, true);
  assert.equal(done.live_definition_sha256, PINS.sql119.intended_replacement_sha256);
  assert.equal((await executeReleaseProductionApply('sql119', manifest('sql119', pin119), { root: ROOT, pin: pin119, connect, consumedPath: consumedPath() })).code, CODES.UNRELATED_MUTATION);

  // SQL 115 now passes its guard and reaches its intended fingerprint, file and pin unchanged.
  const ready = (await inspectReleaseProduction('sql115', { connect, pin: PINS.sql115, root: ROOT })).details;
  assert.deepEqual(ready.precondition_failures, [], JSON.stringify(ready.release_sql_inspect));
  assert.equal(ready.already_applied, false);
  const pin115 = authorized('sql115', ready.live_definition_sha256);
  const applied115 = await executeReleaseProductionApply('sql115', manifest('sql115', pin115), { root: ROOT, pin: pin115, connect, consumedPath: consumedPath() });
  assert.equal(applied115.ok, true, JSON.stringify(applied115));
  assert.equal(applied115.details.receipt.after_hash, PINS.sql115.intended_replacement_sha256);
  assert.equal(PINS.sql115.intended_replacement_sha256, '8aed39a49d988a60bdedac07a3a97f424a9de5c1499e4f50738f749326a62452');
  assert.deepEqual(await executeAcl(admin), ['owner EXECUTE']);
  // After SQL 115 SQL 119 stays in place (its fingerprint reads only the ACL).
  const after115 = (await inspectReleaseProduction('sql119', { connect, pin: pin119, root: ROOT })).details;
  assert.equal(after115.already_applied, true);
}));
