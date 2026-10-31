/**
 * SQL 137 (aws/workflows/sql/137_platform_owner_identity.sql) on PostgreSQL 16, through its production
 * tool, the owner the non-superuser checksops_admin login, with the statements the API login
 * (checksops, a member of authenticated) can run for a resolved application user:
 *
 *   - staging's grants (aws/identity/sql/07: checksops SELECT, INSERT, UPDATE on identity_accounts;
 *     the fixture's table-level UPDATE on profiles): before, the platform owner is recognized, and a
 *     member who rewrites her own profiles.email to the owner mailbox, or moves the mailbox between
 *     identity rows, becomes the platform owner (is_platform_owner() and is_master_owner()); one apply
 *     reaches the intended fingerprint; after, the owner is still recognized (both functions), the
 *     member who edits her profiles.email to the mailbox is not, UPDATE and DELETE on identity_accounts
 *     are refused at the grant layer, INSERT and SELECT still pass (the unique index refuses a second
 *     owner mailbox), the function and table ACLs are the pinned ones; the file again is a no-op and the
 *     tool refuses a re-apply as already in place;
 *   - production's grants (aws/identity/sql/03: SELECT only): the same apply from that pre-state;
 *   - anon and service_role EXECUTE (Supabase-era) are revoked; another role's EXECUTE refuses the
 *     pre-conditions (function_acl_replaceable);
 *   - the file fails closed with nothing changed: an owner-mailbox profile outside the owner identity
 *     (sql137_owner_profile_without_identity), no owner identity row (sql137_owner_identity_count),
 *     no unique email index (sql137_owner_email_not_unique; the inspect also reports it missing).
 *
 * Run: node --test aws/tests/sql137-platform-owner-identity-pg.test.mjs (as root the PG helpers run
 * the server as the ubuntu account).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
import { MEMBER_A, MEMBER_B, PLATFORM_OWNER, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { FUNCTION, OWNER_MAILBOX, TABLE, identitySchema } from './helpers/sql137-identity-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const PIN = loadReleaseProductionPin('sql137', ROOT);
const TEXT = fs.readFileSync(path.join(ROOT, PIN.filename), 'utf8');
/** Expected pre-states (also derived without a database by release-sql137-executor.test.mjs). */
const PRE_PRODUCTION = '9862a392054d3adb7069949dac490f6423be86632abf0ac9d9d6c99d81ffdada';
const PRE_STAGING = '7349393da7ae7f94cd63f6796c76c5df2686f5274b84d7f6ad4a6ea405021f37';

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
  const workstream = 'prod-sql137-pg-test';
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
    one_use_id: `sql137-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-31T20:00:00.000Z',
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql137-pg-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

async function withPg(t, prefix, port, mode, fn) {
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
  const fx = await releaseFixture(pg, prefix, port, { extra: [identitySchema(mode)] });
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

/** The function's body and ACL, and the table's ACL (owner excluded). */
const acls = async (admin) => ({
  prosrc: (await admin.query(`SELECT p.prosrc FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [FUNCTION])).rows[0].prosrc,
  function: (await admin.query(`SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' WHEN a.grantee = p.proowner THEN 'owner' ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ' ' || a.privilege_type AS line
    FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    WHERE p.oid = $1::regprocedure ORDER BY 1`, [FUNCTION])).rows.map((r) => r.line),
  table: (await admin.query(`SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END || ' ' || a.privilege_type AS line
    FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
    WHERE c.oid = $1::regclass AND a.grantee <> c.relowner ORDER BY 1`, [TABLE])).rows.map((r) => r.line),
});

/**
 * Statements as the API login (checksops) for `user`, in one transaction that is always rolled back.
 * Each step is [sql, params]; returns one { rowCount, rows } or { error } per step (a failed step ends
 * the transaction).
 */
async function asApi(connectAs, user, steps) {
  const c = await connectAs('checksops');
  const out = [];
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
    for (const [sql, params] of steps) {
      try {
        const result = await c.query(sql, params);
        out.push({ rowCount: result.rowCount, rows: result.rows });
      } catch (error) {
        out.push({ error });
        break;
      }
    }
    return out;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
}
const OWNER_SQL = ['SELECT public.is_platform_owner() AS platform, public.is_master_owner() AS master', []];
const ownerOf = (result) => [result.rows[0].platform, result.rows[0].master];
const isOwner = async (connectAs, user) => ownerOf((await asApi(connectAs, user, [OWNER_SQL]))[0]);
/** A member rewrites her own profiles.email to the owner mailbox (the profiles branch). */
const profileTakeover = (user) => [[`UPDATE public.profiles SET email = $1 WHERE id = $2::uuid`, [OWNER_MAILBOX, user]], OWNER_SQL];
/** The owner mailbox moved from the owner's identity row to the member's (the identity branch). */
const identityTakeover = (user) => [
  [`UPDATE ${TABLE} SET email = 'moved@example.invalid' WHERE application_user_id = $1::uuid`, [PLATFORM_OWNER]],
  [`UPDATE ${TABLE} SET email = $1 WHERE application_user_id = $2::uuid`, [OWNER_MAILBOX, user]],
  OWNER_SQL,
];
const deniedOnTable = (result) => {
  assert.equal(result.error?.code, '42501', JSON.stringify(result));
  assert.match(result.error.message, /permission denied for table identity_accounts/);
};

async function runFile(connectAs) {
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query(TEXT);
  } finally {
    await owner.end();
  }
}
/** The file in a transaction that must fail with `code` and `pattern`; rolled back. */
async function fileRefuses(connectAs, code, pattern) {
  const owner = await connectAs('checksops_admin');
  try {
    await owner.query('BEGIN');
    await assert.rejects(owner.query(TEXT), (error) => error.code === code && pattern.test(error.message));
    await owner.query('ROLLBACK');
  } finally {
    await owner.end();
  }
}

async function applyAndCheck({ admin, connectAs }, expectedPre) {
  const connect = () => connectAs('checksops_admin');
  const s = (await inspectReleaseProduction('sql137', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, [], JSON.stringify(s.release_sql_inspect));
  assert.deepEqual(s.missing_dependencies, []);
  assert.equal(s.already_applied, false);
  assert.deepEqual(s.predecessors, {});
  if (expectedPre) assert.equal(s.live_definition_sha256, expectedPre);
  const pin = authorized(s.live_definition_sha256);
  const applied = await executeReleaseProductionApply('sql137', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.details.receipt.before_hash, s.live_definition_sha256);
  assert.equal(applied.details.receipt.after_hash, PIN.intended_replacement_sha256);
  const after = await acls(admin);
  assert.deepEqual(after.function, ['authenticated EXECUTE', 'checksops EXECUTE', 'owner EXECUTE']);
  assert.doesNotMatch(after.prosrc, /profiles/);
  return { pin, after };
}

test('PostgreSQL 16: staging\'s grants: an email rewrite makes a member the platform owner; SQL 137 through its production tool; then the owner is still recognized, the rewrite is not, identity_accounts UPDATE and DELETE are refused', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql137-stg-', 60135, 'staging', async (fx) => {
  const { admin, connectAs } = fx;
  const connect = () => connectAs('checksops_admin');
  const before = await acls(admin);
  assert.deepEqual(before.function, ['PUBLIC EXECUTE', 'authenticated EXECUTE', 'checksops EXECUTE', 'owner EXECUTE']);
  assert.deepEqual(before.table, ['authenticated SELECT', 'checksops INSERT', 'checksops SELECT', 'checksops UPDATE']);
  assert.match(before.prosrc, /public\.profiles/);

  // Before SQL 137: the owner is recognized, a member is not, until she rewrites an email.
  assert.deepEqual(await isOwner(connectAs, PLATFORM_OWNER), [true, true]);
  assert.deepEqual(await isOwner(connectAs, MEMBER_B), [false, false]);
  const viaProfile = await asApi(connectAs, MEMBER_B, profileTakeover(MEMBER_B));
  assert.equal(viaProfile[0].rowCount, 1, JSON.stringify(viaProfile));
  assert.deepEqual(ownerOf(viaProfile[1]), [true, true], 'finding 15: profiles.email makes the member the platform owner');
  const viaIdentity = await asApi(connectAs, MEMBER_B, identityTakeover(MEMBER_B));
  assert.deepEqual(viaIdentity.slice(0, 2).map((r) => r.rowCount), [1, 1], JSON.stringify(viaIdentity));
  assert.deepEqual(ownerOf(viaIdentity[2]), [true, true], 'finding 15: identity_accounts.email makes the member the platform owner');
  // The unique index alone does not stop it: a second owner mailbox is refused, the move is not.
  const second = await asApi(connectAs, MEMBER_B, [[`UPDATE ${TABLE} SET email = $1 WHERE application_user_id = $2::uuid`, [OWNER_MAILBOX, MEMBER_B]]]);
  assert.equal(second[0].error?.code, '23505');

  const { pin, after } = await applyAndCheck(fx, PRE_STAGING);
  assert.deepEqual(after.table, ['authenticated SELECT', 'checksops INSERT', 'checksops SELECT']);

  // After SQL 137: the owner is still the platform owner (and the master owner); nobody else is.
  assert.deepEqual(await isOwner(connectAs, PLATFORM_OWNER), [true, true]);
  for (const user of [MEMBER_A, MEMBER_B]) assert.deepEqual(await isOwner(connectAs, user), [false, false], user);
  // The member who edits her profiles.email to the owner mailbox (still allowed) is not the owner.
  const edited = await asApi(connectAs, MEMBER_B, profileTakeover(MEMBER_B));
  assert.equal(edited[0].rowCount, 1, JSON.stringify(edited));
  assert.deepEqual(ownerOf(edited[1]), [false, false], 'a profiles.email edit no longer makes a platform owner');
  // The identity rows are fixed for the API login: UPDATE and DELETE refused at the grant layer.
  deniedOnTable((await asApi(connectAs, MEMBER_B, identityTakeover(MEMBER_B)))[0]);
  deniedOnTable((await asApi(connectAs, MEMBER_B, [[`UPDATE ${TABLE} SET email = $1 WHERE application_user_id = $2::uuid`, [OWNER_MAILBOX, MEMBER_B]]]))[0]);
  deniedOnTable((await asApi(connectAs, MEMBER_B, [[`DELETE FROM ${TABLE} WHERE application_user_id = $1::uuid`, [PLATFORM_OWNER]]]))[0]);
  deniedOnTable((await asApi(connectAs, MEMBER_B, [[`TRUNCATE ${TABLE}`, []]]))[0]);
  // SELECT and INSERT (the mortgage desk hire, ON CONFLICT DO NOTHING) still pass; a second owner mailbox is refused.
  const read = await asApi(connectAs, MEMBER_B, [[`SELECT application_user_id::text AS id FROM ${TABLE} WHERE lower(email) = $1`, [OWNER_MAILBOX]]]);
  assert.deepEqual(read[0].rows, [{ id: PLATFORM_OWNER }]);
  const hire = `INSERT INTO ${TABLE} (cognito_sub, application_user_id, email, status, linked_at, created_at)
     VALUES ($1, $2::uuid, $3, 'active', now(), now()) ON CONFLICT (cognito_sub) DO NOTHING`;
  const hired = await asApi(connectAs, MEMBER_B, [[hire, [`sub-${crypto.randomUUID()}`, crypto.randomUUID(), 'new-agent@example.invalid']]]);
  assert.equal(hired[0].rowCount, 1, JSON.stringify(hired));
  const impostor = crypto.randomUUID();
  const twin = await asApi(connectAs, impostor, [[hire, [`sub-${crypto.randomUUID()}`, impostor, OWNER_MAILBOX]]]);
  assert.equal(twin[0].error?.code, '23505', JSON.stringify(twin));

  // Idempotent: the file again is a no-op; the tool refuses a re-apply as already in place.
  await runFile(connectAs);
  assert.deepEqual(await acls(admin), after);
  const again = (await inspectReleaseProduction('sql137', { connect, pin, root: ROOT })).details;
  assert.equal(again.already_applied, true);
  assert.equal(again.live_definition_sha256, PIN.intended_replacement_sha256);
  const replay = await executeReleaseProductionApply('sql137', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(replay.code, CODES.UNRELATED_MUTATION);
}));

test('PostgreSQL 16: production\'s grants (identity_accounts SELECT only): SQL 137 from that pre-state keeps the table ACL; the owner is recognized, a profiles.email edit is not', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql137-prd-', 60235, 'production', async (fx) => {
  const { admin, connectAs } = fx;
  const before = await acls(admin);
  assert.deepEqual(before.table, ['authenticated SELECT', 'checksops SELECT']);
  assert.deepEqual(ownerOf((await asApi(connectAs, MEMBER_B, profileTakeover(MEMBER_B)))[1]), [true, true]);
  const { after } = await applyAndCheck(fx, PRE_PRODUCTION);
  assert.deepEqual(after.table, before.table);
  assert.deepEqual(await isOwner(connectAs, PLATFORM_OWNER), [true, true]);
  assert.deepEqual(ownerOf((await asApi(connectAs, MEMBER_B, profileTakeover(MEMBER_B)))[1]), [false, false]);
}));

test('PostgreSQL 16: anon and service_role grants are revoked; another role\'s EXECUTE refuses the pre-conditions', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql137-roles-', 60335, 'staging', async (fx) => {
  const { admin, connectAs } = fx;
  const connect = () => connectAs('checksops_admin');
  for (const role of ['anon', 'service_role', 'reporting']) {
    await admin.query(`DO $$ BEGIN CREATE ROLE ${role} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  }
  await admin.query(`GRANT EXECUTE ON FUNCTION ${FUNCTION} TO reporting`);
  const refused = (await inspectReleaseProduction('sql137', { connect, pin: PIN, root: ROOT })).details;
  assert.equal(refused.already_applied, false);
  assert.deepEqual(refused.precondition_failures, ['function_acl_replaceable'], JSON.stringify(refused.release_sql_inspect));
  const blocked = authorized(refused.live_definition_sha256);
  const noApply = await executeReleaseProductionApply('sql137', manifest(blocked), { root: ROOT, pin: blocked, connect, consumedPath: consumedPath() });
  assert.equal(noApply.ok, false);
  assert.ok((await acls(admin)).function.includes('reporting EXECUTE'));
  await admin.query(`REVOKE EXECUTE ON FUNCTION ${FUNCTION} FROM reporting`);

  // Supabase-era grants: EXECUTE for anon and service_role, UPDATE / DELETE / TRUNCATE for anon and PUBLIC.
  await admin.query(`GRANT EXECUTE ON FUNCTION ${FUNCTION} TO anon, service_role`);
  await admin.query(`GRANT UPDATE, DELETE, TRUNCATE ON TABLE ${TABLE} TO anon, PUBLIC`);
  await admin.query(`GRANT SELECT ON TABLE ${TABLE} TO service_role`);
  const { after } = await applyAndCheck(fx, null);
  // The revoked lines are gone; service_role's SELECT (not a pinned privilege) stays.
  assert.deepEqual(after.table, ['authenticated SELECT', 'checksops INSERT', 'checksops SELECT', 'service_role SELECT']);
}));

test('PostgreSQL 16: the file fails closed with nothing changed: an owner-mailbox profile outside the owner identity, no owner identity, no unique email index', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql137-closed-', 60435, 'staging', async ({ admin, connectAs }) => {
  const connect = () => connectAs('checksops_admin');
  const before = await acls(admin);

  // A profile that already carries the owner mailbox for another user (an earlier rewrite): refuse,
  // even through the tool (the inspect reads no rows; the apply rolls back).
  await admin.query('UPDATE public.profiles SET email = $1 WHERE id = $2::uuid', [OWNER_MAILBOX, MEMBER_B]);
  await fileRefuses(connectAs, '55000', /sql137_owner_profile_without_identity: 1 profiles rows/);
  const s = (await inspectReleaseProduction('sql137', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(s.precondition_failures, []);
  const pin = authorized(s.live_definition_sha256);
  const refused = await executeReleaseProductionApply('sql137', manifest(pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
  assert.equal(refused.ok, false);
  assert.match(JSON.stringify(refused), /sql137_owner_profile_without_identity/);
  assert.deepEqual(await acls(admin), before);
  await admin.query('UPDATE public.profiles SET email = $1 WHERE id = $2::uuid', ['member-b@example.invalid', MEMBER_B]);

  // No identity row carries the owner mailbox (the owner known only by profile): refuse.
  await admin.query(`UPDATE ${TABLE} SET email = 'owner-elsewhere@example.invalid' WHERE application_user_id = $1::uuid`, [PLATFORM_OWNER]);
  await fileRefuses(connectAs, '55000', /sql137_owner_identity_count: 0 identity_accounts rows/);
  await admin.query(`UPDATE ${TABLE} SET status = 'pending', email = $1 WHERE application_user_id = $2::uuid`, [OWNER_MAILBOX, PLATFORM_OWNER]);
  await fileRefuses(connectAs, '55000', /sql137_owner_identity_count: 0 identity_accounts rows/);
  await admin.query(`UPDATE ${TABLE} SET status = 'active' WHERE application_user_id = $1::uuid`, [PLATFORM_OWNER]);

  // No unique email index: refuse; the inspect reports it missing.
  await admin.query('DROP INDEX public.identity_accounts_email_lower_key');
  await fileRefuses(connectAs, '55000', /sql137_owner_email_not_unique/);
  const missing = (await inspectReleaseProduction('sql137', { connect, pin: PIN, root: ROOT })).details;
  assert.deepEqual(missing.missing_dependencies, ['public.identity_accounts_email_lower_key']);
  assert.deepEqual(await acls(admin), before);
}));
