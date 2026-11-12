/**
 * SQL 161 (aws/workflows/sql/161_tg_mortgage_handling_billing_checksops_execute.sql) on PostgreSQL 16, through its
 * production tool and as a plain file run by the owner (the non-superuser checksops_admin login). The function is a stub
 * with the live attributes (plpgsql, SECURITY DEFINER, SET search_path = public, RETURNS trigger) under its live trigger
 * tr_record_mortgage_handling_billing on check_intake_items:
 *
 *   - staging's ACL (PUBLIC and the owner; SQL 160's staging read-live, run 43307779123): the inspect reads the staging
 *     pre-state derived from the spec; one apply reaches the intended fingerprint and adds exactly checksops EXECUTE,
 *     granted by the owner; owner, SECURITY DEFINER, proconfig, body and trigger unchanged; the file run twice more is a
 *     no-op and the tool refuses a re-apply as already in place;
 *   - production's ACL (PUBLIC, checksops and the owner): the inspect reads the intended state (already_applied true)
 *     and the file is a no-op;
 *   - the function or the role checksops missing: the file fails closed (sql161_function_missing,
 *     sql161_role_missing) with nothing changed.
 *
 * Run: node --test aws/tests/sql161-tg-mortgage-handling-billing-checksops-execute-pg.test.mjs (as root the PG helpers
 * run the server as the ubuntu account).
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
import { releaseIntendedState, releaseStateHash } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEY = 'sql161';
const FN = 'public.tg_record_mortgage_handling_billing()';
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin(KEY, ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
const STAGING_ACL = Object.freeze(['PUBLIC EXECUTE grantor=owner', 'owner EXECUTE grantor=owner']);
const PRODUCTION_ACL = Object.freeze(['PUBLIC EXECUTE grantor=owner', 'checksops EXECUTE grantor=owner', 'owner EXECUTE grantor=owner']);
/** The pre-states, derived from the spec (also by release-sql161-executor.test.mjs). */
const withAcl = (acl) => {
  const state = releaseIntendedState(KEY, TEXT);
  state.acl_functions[FN].acl = [...acl];
  return releaseStateHash(KEY, state);
};
const STAGING_PRE = withAcl(STAGING_ACL);
const PRODUCTION_PRE = withAcl(PRODUCTION_ACL);

/**
 * The stub: the live attributes, the live trigger, owned by checksops_admin after the fixture's ownership pass (which
 * rewrites the grantor to the new owner). `acl` is the ACL after `REVOKE ALL ... FROM PUBLIC`: an explicit ACL, as a
 * database whose function was ever granted holds.
 */
const stub = (grantees) => `CREATE FUNCTION ${FN} RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $f$ BEGIN RETURN NEW; END $f$;
CREATE TRIGGER tr_record_mortgage_handling_billing AFTER INSERT OR UPDATE ON public.check_intake_items
  FOR EACH ROW EXECUTE FUNCTION ${FN};
REVOKE ALL ON FUNCTION ${FN} FROM PUBLIC;
${grantees.map((g) => `GRANT EXECUTE ON FUNCTION ${FN} TO ${g};`).join('\n')}`;

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
  const workstream = 'prod-sql161-pg-test';
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
    one_use_id: `sql161-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-11-12T00:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql161-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

async function withPg(t, prefix, port, grantees, fn) {
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [stub(grantees)] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/** The function's owner, attributes, body hash and EXECUTE entries (grantee, grantor, grant option), and its trigger. */
async function functionState(admin) {
  const { rows } = await admin.query(`SELECT pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig, p.provolatile,
      pg_catalog.pg_get_function_result(p.oid) AS result, pg_catalog.md5(p.prosrc) AS body,
      ARRAY(SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END || ' ' || a.privilege_type
                   || ' grantor=' || pg_catalog.pg_get_userbyid(a.grantor) || CASE WHEN a.is_grantable THEN ' grantable' ELSE '' END
              FROM pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a ORDER BY 1) AS acl,
      (SELECT pg_catalog.array_agg(t.tgname::text || ' ' || t.tgrelid::regclass::text || ' ' || t.tgenabled::text ORDER BY t.tgname)
         FROM pg_catalog.pg_trigger t WHERE t.tgfoid = p.oid) AS triggers
    FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure($1)`, [FN]);
  return rows[0] ?? null;
}
const asOwner = async (connectAs, sql) => {
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(sql);
  } finally {
    await owner.end();
  }
};

test('PostgreSQL 16: staging\'s ACL (PUBLIC and the owner): the derived pre-state; SQL 161 through its production tool adds exactly checksops EXECUTE, granted by the owner; the file twice more is a no-op; a re-apply is refused', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql161-stg-', 59161, ['PUBLIC'], async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const before = await functionState(admin);
  assert.equal(before.owner, 'checksops_admin');
  assert.deepEqual(before.acl, ['PUBLIC EXECUTE grantor=checksops_admin', 'checksops_admin EXECUTE grantor=checksops_admin']);
  assert.deepEqual(before.triggers, ['tr_record_mortgage_handling_billing check_intake_items O']);

  const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.deepEqual(s.missing_dependencies ?? [], []);
  assert.deepEqual(s.predecessors, {});
  assert.equal(s.already_applied, false);
  assert.equal(s.live_definition_sha256, STAGING_PRE);
  assert.deepEqual(s.release_sql_inspect.acl_functions, [{ name: FN.replace('public.', ''), state: 'different', acl: [...STAGING_ACL] }]);

  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, STAGING_PRE);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);

  // Exactly checksops EXECUTE added, granted by the owner without grant option; everything else as before.
  const after = await functionState(admin);
  assert.deepEqual(after.acl, ['PUBLIC EXECUTE grantor=checksops_admin', 'checksops EXECUTE grantor=checksops_admin', 'checksops_admin EXECUTE grantor=checksops_admin']);
  assert.deepEqual({ ...after, acl: null }, { ...before, acl: null });

  // Idempotent: the file twice more as the owner changes nothing; the tool refuses a re-apply as already in place.
  await asOwner(connectAs, TEXT);
  await asOwner(connectAs, TEXT);
  assert.deepEqual(await functionState(admin), after);
  const again = (await inspectReleaseProduction(KEY, { connect, pin, root: ROOT })).details;
  assert.equal(again.already_applied, true);
  assert.deepEqual(again.precondition_failures, []);
  assert.equal(again.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply(KEY, manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
  assert.deepEqual(await functionState(admin), after);
}));

test('PostgreSQL 16: production\'s ACL (PUBLIC, checksops and the owner): already in the intended state; the file is a no-op', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql161-prd-', 59261, ['PUBLIC', 'checksops'], async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const before = await functionState(admin);
  assert.deepEqual(before.acl, ['PUBLIC EXECUTE grantor=checksops_admin', 'checksops EXECUTE grantor=checksops_admin', 'checksops_admin EXECUTE grantor=checksops_admin']);
  const s = (await inspectReleaseProduction(KEY, { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.equal(s.already_applied, true);
  assert.equal(s.live_definition_sha256, PRODUCTION_PRE);
  assert.equal(s.live_definition_sha256, PIN.intended_replacement_sha256);
  assert.deepEqual(s.release_sql_inspect.acl_functions, [{ name: FN.replace('public.', ''), state: 'intended', acl: [...PRODUCTION_ACL] }]);
  await asOwner(connectAs, TEXT);
  await asOwner(connectAs, TEXT);
  assert.deepEqual(await functionState(admin), before);
}));

test('PostgreSQL 16: the function or the role checksops missing: the file fails closed (sql161_function_missing, sql161_role_missing) with nothing changed', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql161-missing-', 59361, ['PUBLIC'], async ({ admin, connectAs }) => {
  const before = await functionState(admin);
  // The role missing (dropped inside a transaction that is rolled back).
  await admin.query('BEGIN');
  try {
    await admin.query('DROP OWNED BY checksops');
    await admin.query('DROP ROLE checksops');
    await assert.rejects(admin.query(TEXT), (error) => error.code === '42704' && /sql161_role_missing: role checksops does not exist/.test(error.message));
  } finally {
    await admin.query('ROLLBACK');
  }
  assert.deepEqual(await functionState(admin), before);
  // The function missing: the inspect names it and the file refuses.
  await admin.query(`DROP FUNCTION ${FN} CASCADE`);
  const s = (await inspectReleaseProduction(KEY, { connect: () => connectAs('checksops_admin'), pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.missing_dependencies, [FN]);
  assert.equal(s.already_applied, false);
  assert.equal(s.live_definition_sha256, releaseStateHash(KEY, {}));
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query('BEGIN');
    await assert.rejects(owner.query(TEXT), (error) => error.code === '42883' && /sql161_function_missing/.test(error.message));
    await owner.query('ROLLBACK');
  } finally {
    await owner.end();
  }
  assert.equal(await functionState(admin), null);
  const blocked = authorized(s.live_definition_sha256);
  const noApply = await executeReleaseProductionApply(KEY, manifest(blocked), { root: ROOT, pin: blocked, connect: () => connectAs('checksops_admin'), consumedPath: consumedPath() });
  assert.equal(noApply.ok, false);
}));
