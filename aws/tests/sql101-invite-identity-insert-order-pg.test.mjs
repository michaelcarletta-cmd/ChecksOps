/**
 * SQL 101 (aws/workflows/sql/101_invite_identity_insert_order.sql) on PostgreSQL 16.
 *
 * The AWS databases have profiles.id REFERENCES identity_accounts(application_user_id)
 * (profiles_id_identity_fkey, aws/rls/sql/25_fk_retarget.sql). The fixture
 * (helpers/release-sql-pg.mjs, every object owned by the non-superuser checksops_admin) adds
 * that constraint after SQL 29 / 30 / 90 are applied, then:
 *
 *   - SQL 90's aws_invite_create_user_identity refuses a brand-new email with 23503 on
 *     profiles_id_identity_fkey (the staging 2026-10-18 invite_identity_failed);
 *   - SQL 101 refuses to run without SQL 90 (55000 sql101_prerequisite_missing);
 *   - after SQL 101 (applied twice, as checksops_admin) the same invite returns a user with
 *     both its identity_accounts row and its profile; the platform owner's locked first invite
 *     works too;
 *   - every other path answers exactly as under SQL 90 (existing cognito_sub, a pending
 *     identity row, identity_link_conflict, platform owner refusals, missing fields,
 *     non-members), and an existing profile without an identity row (only possible without the
 *     constraint) keeps its id and gets no second profile;
 *   - the function keeps SQL 90's signature, attributes, comment and ACL.
 *
 * Run: sudo -n -u ubuntu /opt/node22/bin/node --test aws/tests/sql101-invite-identity-insert-order-pg.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { MEMBER_A, MEMBER_B, PLATFORM_OWNER, REPO_ROOT, TENANT_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const SQL_90 = fs.readFileSync(path.join(REPO_ROOT, 'aws/workflows/sql/90_users_only_tenant_roles.sql'), 'utf8');
const SQL_101 = fs.readFileSync(path.join(REPO_ROOT, 'aws/workflows/sql/101_invite_identity_insert_order.sql'), 'utf8');
const FK = 'ALTER TABLE public.profiles ADD CONSTRAINT profiles_id_identity_fkey FOREIGN KEY (id) REFERENCES public.identity_accounts(application_user_id) ON DELETE CASCADE';

const TENANT_EMPTY = '44444444-4444-4444-8444-444444444444';
const TEAMMATE = 'a1000000-0000-4000-8000-00000000000a';
const PENDING = 'a1000000-0000-4000-8000-0000000000d1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SEED = `
INSERT INTO public.tenants (id, name) VALUES ('${TENANT_EMPTY}', 'Empty');
UPDATE public.identity_accounts SET cognito_sub = 'sub-' || application_user_id::text;
INSERT INTO public.identity_accounts (application_user_id, email, status, cognito_sub) VALUES
  ('${TEAMMATE}', 't@example.invalid', 'active', 'sub-${TEAMMATE}'),
  ('${PENDING}', 'pending@example.invalid', 'invited', NULL);
INSERT INTO public.profiles (id, email) VALUES ('${TEAMMATE}', 't@example.invalid'), ('${PENDING}', 'pending@example.invalid');
INSERT INTO public.tenant_users (tenant_id, user_id, role) VALUES ('${TENANT_A}', '${TEAMMATE}', 'viewer');
`;

const FUNCTION_SHAPE = `
SELECT p.prosecdef, p.provolatile, p.proconfig, pg_get_function_result(p.oid) AS result,
       pg_get_function_identity_arguments(p.oid) AS args, l.lanname,
       pg_catalog.obj_description(p.oid, 'pg_proc') AS comment,
       (SELECT array_agg(x.line ORDER BY x.line) FROM (
          SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END || ' ' || a.privilege_type AS line
            FROM aclexplode(p.proacl) a) x) AS acl,
       pg_get_userbyid(p.proowner) AS owner
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
 WHERE p.oid = 'public.aws_invite_create_user_identity(uuid, text, text, text)'::regprocedure`;

test('PostgreSQL 16: SQL 101 inserts identity_accounts before profiles; every other invite path is SQL 90\'s', {
  timeout: 300000, skip: pgSkipReason() || false,
}, async (t) => {
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const fx = await releaseFixture(pg, 'pg-sql101-invite-', 63100);
  const { admin, connectAs } = fx;
  const asOwner = async (sql) => {
    const c = await connectAs('checksops_admin');
    try { await c.query(sql); } finally { await c.end(); }
  };
  try {
    await fx.applyPredecessors();
    // SQL 101 refuses before SQL 90 (its helpers and the function it replaces are missing).
    await assert.rejects(asOwner(SQL_101), (error) => error.code === '55000' && /sql101_prerequisite_missing/.test(error.message)
      && /aws_invite_create_user_identity/.test(error.message));
    await asOwner(SQL_90);
    await admin.query(SEED);
    // The live AWS constraint (aws/rls/sql/25_fk_retarget.sql).
    await admin.query(FK);

    /** One API request: a transaction as checksops (RLS on) for this user; rolled back. */
    const as = async (user, fn, { setup = [] } = {}) => {
      await admin.query('BEGIN');
      try {
        for (const sql of setup) await admin.query(sql);
        await admin.query('SET LOCAL ROLE checksops');
        await admin.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
        return await fn();
      } finally {
        await admin.query('ROLLBACK');
      }
    };
    const call = (tenantId, email, sub) => admin.query(
      'SELECT public.aws_invite_create_user_identity($1::uuid, $2, $3, $4)::text AS id', [tenantId, email, '  Fresh Person ', sub],
    ).then((r) => r.rows[0].id);
    /** The invite and what it left: the identity row of the login, the profile of the user, counts. */
    const invite = (user, tenantId, email, sub, opts) => as(user, async () => {
      const id = await call(tenantId, email, sub);
      // Read what it left as the superuser (RLS hides a non-teammate's profile from checksops).
      await admin.query('RESET ROLE');
      const identity = (await admin.query(
        'SELECT application_user_id::text AS id, email, status, linked_at IS NOT NULL AS linked FROM public.identity_accounts WHERE cognito_sub = $1', [sub],
      )).rows[0] || null;
      const profile = (await admin.query('SELECT id::text AS id, email, full_name FROM public.profiles WHERE id = $1::uuid', [id])).rows[0] || null;
      const counts = (await admin.query(
        'SELECT (SELECT count(*) FROM public.identity_accounts)::int AS identities, (SELECT count(*) FROM public.profiles)::int AS profiles',
      )).rows[0];
      return { id, identity, profile, counts };
    }, opts);
    /** An invite's outcome: the result, or the error's code, message and constraint. */
    const outcome = async (...args) => {
      try {
        return { ok: await invite(...args) };
      } catch (error) {
        return { code: error.code, message: error.message, constraint: error.constraint || null };
      }
    };
    const baseCounts = (await admin.query(
      'SELECT (SELECT count(*) FROM public.identity_accounts)::int AS identities, (SELECT count(*) FROM public.profiles)::int AS profiles',
    )).rows[0];

    // Every path other than a brand-new email, under the current function.
    const existingPaths = async () => ({
      existing_sub: await outcome(MEMBER_A, TENANT_A, 'other@example.invalid', `sub-${TEAMMATE}`),
      pending_identity: await outcome(MEMBER_A, TENANT_A, ' Pending@Example.invalid ', 'sub-pending-new'),
      link_conflict: await outcome(MEMBER_A, TENANT_A, 't@example.invalid', 'sub-new-login'),
      owner_email: await outcome(MEMBER_A, TENANT_A, 'ChecksOpsAdmin@gmail.com', 'sub-x'),
      owner_login: await outcome(MEMBER_A, TENANT_A, 'alias@example.invalid', `sub-${PLATFORM_OWNER}`),
      owner_not_first: await outcome(PLATFORM_OWNER, TENANT_A, 'fresh@example.invalid', 'sub-fresh'),
      non_member: await outcome(MEMBER_B, TENANT_A, 'fresh@example.invalid', 'sub-fresh'),
      missing_sub: await outcome(MEMBER_A, TENANT_A, 'fresh@example.invalid', '  '),
      missing_email: await outcome(MEMBER_A, TENANT_A, '', 'sub-fresh'),
    });

    // --- SQL 90 with the constraint: a brand-new email fails on the profile insert. ---
    const shape90 = (await admin.query(FUNCTION_SHAPE)).rows[0];
    for (const [user, tenantId] of [[MEMBER_A, TENANT_A], [PLATFORM_OWNER, TENANT_EMPTY]]) {
      const refused = await outcome(user, tenantId, 'fresh@example.invalid', 'sub-fresh');
      assert.equal(refused.code, '23503', JSON.stringify(refused));
      assert.equal(refused.constraint, 'profiles_id_identity_fkey');
      assert.match(refused.message, /insert or update on table "profiles" violates foreign key constraint "profiles_id_identity_fkey"/);
    }
    const before = await existingPaths();

    // --- SQL 101, applied twice by the owning login. ---
    await asOwner(SQL_101);
    await asOwner(SQL_101);

    // Same signature, attributes, comment and ACL as SQL 90 left; only the body differs.
    const shape101 = (await admin.query(FUNCTION_SHAPE)).rows[0];
    assert.deepEqual(shape101, shape90);
    assert.equal(shape101.prosecdef, true);
    assert.equal(shape101.provolatile, 'v');
    assert.deepEqual([...shape101.proconfig].sort(), ['row_security=off', 'search_path=public']);
    assert.deepEqual(shape101.acl, ['authenticated EXECUTE', 'checksops EXECUTE', 'checksops_admin EXECUTE']);
    assert.equal(shape101.owner, 'checksops_admin');
    assert.match(shape101.comment, /never re-points a cognito_sub \(SQL 90\)/);
    const prosrc = (await admin.query("SELECT prosrc FROM pg_proc WHERE oid = 'public.aws_invite_create_user_identity(uuid, text, text, text)'::regprocedure")).rows[0].prosrc;
    assert.ok(prosrc.indexOf('INSERT INTO public.identity_accounts') < prosrc.indexOf('INSERT INTO public.profiles'), 'identity row first');

    // The brand-new invite now succeeds with both rows.
    for (const [user, tenantId] of [[MEMBER_A, TENANT_A], [PLATFORM_OWNER, TENANT_EMPTY]]) {
      const made = await invite(user, tenantId, ' Fresh@Example.invalid ', 'sub-fresh');
      assert.match(made.id, UUID_RE, user);
      assert.deepEqual(made.identity, { id: made.id, email: 'fresh@example.invalid', status: 'active', linked: true }, user);
      assert.deepEqual(made.profile, { id: made.id, email: 'fresh@example.invalid', full_name: 'Fresh Person' }, user);
      assert.deepEqual(made.counts, { identities: baseCounts.identities + 1, profiles: baseCounts.profiles + 1 }, user);
    }
    // A blank name gives a NULL full_name, as SQL 90.
    const blank = await as(MEMBER_A, async () => {
      const id = (await admin.query('SELECT public.aws_invite_create_user_identity($1::uuid, $2, $3, $4)::text AS id', [TENANT_A, 'blank@example.invalid', '   ', 'sub-blank'])).rows[0].id;
      await admin.query('RESET ROLE');
      return (await admin.query('SELECT full_name FROM public.profiles WHERE id = $1::uuid', [id])).rows[0];
    });
    assert.deepEqual(blank, { full_name: null });

    // Every other path answers exactly as SQL 90 did.
    const after = await existingPaths();
    assert.deepEqual(after, before);
    // ... and what SQL 90 answered is the reviewed behaviour.
    assert.equal(after.existing_sub.ok.id, TEAMMATE);
    assert.deepEqual(after.existing_sub.ok.counts, baseCounts, 'an existing login creates nothing');
    assert.equal(after.pending_identity.ok.id, PENDING);
    assert.deepEqual(after.pending_identity.ok.identity, { id: PENDING, email: 'pending@example.invalid', status: 'active', linked: true });
    assert.deepEqual(after.pending_identity.ok.counts, baseCounts, 'a pending identity is linked, no new rows');
    assert.deepEqual(after.link_conflict, { code: 'P0001', message: 'identity_link_conflict', constraint: null });
    for (const key of ['owner_email', 'owner_login']) assert.deepEqual(after[key], { code: '42501', message: 'platform_owner_not_invitable', constraint: null }, key);
    for (const key of ['owner_not_first', 'non_member']) assert.deepEqual(after[key], { code: '42501', message: 'not_authorized', constraint: null }, key);
    for (const key of ['missing_sub', 'missing_email']) assert.deepEqual(after[key], { code: '22023', message: 'missing_required_field', constraint: null }, key);
    // The conflict changed nothing.
    assert.equal((await admin.query('SELECT cognito_sub FROM public.identity_accounts WHERE application_user_id = $1', [TEAMMATE])).rows[0].cognito_sub, `sub-${TEAMMATE}`);

    // Without the constraint (a profile with no identity row): the profile keeps its id and gets
    // no second profile; a login equal to that id is unsafe_cognito_sub. Same as SQL 90.
    const LONE = 'a1000000-0000-4000-8000-0000000000e1';
    const orphan = [
      'ALTER TABLE public.profiles DROP CONSTRAINT profiles_id_identity_fkey',
      `INSERT INTO public.profiles (id, email) VALUES ('${LONE}', 'lone@example.invalid')`,
    ];
    const linked = await invite(MEMBER_A, TENANT_A, 'lone@example.invalid', 'sub-lone', { setup: orphan });
    assert.equal(linked.id, LONE);
    assert.deepEqual(linked.identity, { id: LONE, email: 'lone@example.invalid', status: 'active', linked: true });
    assert.deepEqual(linked.profile, { id: LONE, email: 'lone@example.invalid', full_name: null });
    assert.deepEqual(linked.counts, { identities: baseCounts.identities + 1, profiles: baseCounts.profiles + 1 });
    await assert.rejects(invite(MEMBER_A, TENANT_A, 'lone@example.invalid', LONE, { setup: orphan }),
      (error) => error.code === 'P0001' && error.message === 'unsafe_cognito_sub');

    // The constraint is still in place (the rollbacks above restored it).
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'profiles_id_identity_fkey'")).rows[0].n, 1);
  } finally {
    await fx.close();
  }
});
