/**
 * SQL 126 (the Supabase-era SECURITY DEFINER reads check their caller themselves; security audit
 * finding 4, database part) against PostgreSQL 16: the release fixture (the real AWS RLS helper
 * files, tenants A and B with one member each, the platform owner), the thirteen functions exactly
 * as their supabase migrations define them (the restored state) with the tables they read
 * (helpers/sql126-definer-reads-schema.mjs), then aws/workflows/sql/126_definer_reads_caller_gates.sql
 * applied by checksops_admin, the non-superuser login that owns the functions and tables (as in
 * staging and production).
 *
 * The functions are called as the API calls them (POST /data/rpc): checksops, RLS on,
 * request.app_user_id set, one committed transaction per request.
 *
 *   - before SQL 126: a member of tenant A who holds the global user_roles admin and staff (a tenant
 *     admin) reads tenant B through every function (the finding);
 *   - the file is idempotent and leaves every function's arguments, defaults, result, language,
 *     volatility, SECURITY DEFINER, search_path and owner as they were; EXECUTE is checksops' and
 *     the owner's only;
 *   - after: that tenant admin is refused the owner-only reads and tenant B's reads, keeps tenant A's
 *     (and get_stuck_checks only for tenant A), is refused another user's has_permission and tenant
 *     B's claim settlement, and the unread counts cover only checks they may read; tenant B's owner,
 *     the partner on a check A shares with B, keeps that check's claim settlement and unread count;
 *     the platform owner (no user_roles row) reads everything.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CHECK_A, MEMBER_A, MEMBER_B, PLATFORM_OWNER, REPO_ROOT, TENANT_A, TENANT_B, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { CHECK_B, SQL126_IDENTITIES, definerReadsSchema } from './helpers/sql126-definer-reads-schema.mjs';

const SQL_126 = fs.readFileSync(path.join(REPO_ROOT, 'aws/workflows/sql/126_definer_reads_caller_gates.sql'), 'utf8');
const OWNER_ONLY = Object.freeze([
  'SELECT count(*)::int AS n FROM public.get_all_checks_safety_net()',
  'SELECT public.get_deposit_ops_kpis() AS v',
  'SELECT public.get_deposit_exception_kpis() AS v',
  'SELECT public.get_deposit_aging_summary() AS v',
]);
const TENANT_RAISING = Object.freeze([
  'SELECT public.get_check_dashboard_counts_for_tenant($1) AS v',
  'SELECT public.get_loss_draft_dashboard_counts_for_tenant($1) AS v',
  'SELECT public.get_tenant_check_usage($1) AS v',
]);

test('PostgreSQL 16: SQL 126 keeps each Supabase-era definer read to the callers the API gates allow', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql126-gates-', 59690, { extra: definerReadsSchema() });
  const client = await fx.connectAs('ubuntu');
  try {
    /** One API request: a committed transaction as checksops (RLS on) for this user. */
    const as = async (user, fn) => {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL ROLE checksops');
        await client.query("SELECT set_config('request.app_user_id', $1, true)", [user]);
        const out = await fn();
        await client.query('COMMIT');
        return out;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    };
    const rows = (user, sql, params = []) => as(user, async () => (await client.query(sql, params)).rows);
    const one = async (user, sql, params = []) => (await rows(user, sql, params))[0];
    /** The SQLSTATE a call fails with, or 'ok'. */
    const outcome = async (user, sql, params = []) => {
      try {
        await rows(user, sql, params);
        return 'ok';
      } catch (error) {
        return error.code || String(error.message);
      }
    };
    const stuck = async (user) => (await rows(user, 'SELECT id::text AS id FROM public.get_stuck_checks() ORDER BY 1')).map((r) => r.id);
    const unread = async (user) => (await rows(user, 'SELECT check_id::text AS c, unread_count::int AS n FROM public.get_check_unread_counts() ORDER BY 1'))
      .map((r) => [r.c, r.n]);
    const totalUnread = async (user) => Number((await one(user, 'SELECT public.get_total_unread_check_messages() AS n')).n);
    const settlement = async (user, check) => (await one(user, 'SELECT public.get_check_claim_settlement($1) AS v', [check])).v;
    const users = async (user, tenant) => (await rows(user, 'SELECT user_id::text AS u, email FROM public.get_tenant_users_with_profiles($1) ORDER BY 1', [tenant]))
      .map((r) => r.u);
    const checkalt = async (user, tenant) => (await one(user, 'SELECT public.is_checkalt_enabled_for_tenant($1) AS v', [tenant])).v;
    const both = [CHECK_A, CHECK_B].sort();
    const attributes = async () => (await fx.admin.query(`SELECT p.oid::regprocedure::text AS identity, pg_catalog.pg_get_function_arguments(p.oid) AS args,
        pg_catalog.pg_get_function_result(p.oid) AS result, l.lanname AS language, p.provolatile::text AS volatility, p.prosecdef AS definer,
        p.proconfig AS config, pg_catalog.pg_get_userbyid(p.proowner) AS owner
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
      WHERE p.oid = ANY($1::regprocedure[]) ORDER BY 1`, [SQL126_IDENTITIES])).rows;
    const acl = async () => (await fx.admin.query(`SELECT p.oid::regprocedure::text AS identity,
        ARRAY(SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' WHEN a.grantee = p.proowner THEN 'owner' ELSE pg_catalog.pg_get_userbyid(a.grantee) END
              || ' ' || a.privilege_type FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a ORDER BY 1)::text[] AS acl
      FROM pg_catalog.pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY 1`, [SQL126_IDENTITIES])).rows;

    // Before SQL 126 (the restored supabase functions, EXECUTE PUBLIC and the owner): the tenant
    // admin of tenant A reads tenant B through every function.
    const before = await attributes();
    assert.equal(before.length, SQL126_IDENTITIES.length);
    for (const row of before) assert.equal(row.owner, 'checksops_admin', row.identity);
    for (const row of await acl()) assert.deepEqual(row.acl, ['PUBLIC EXECUTE', 'owner EXECUTE'], row.identity);
    assert.equal((await one(MEMBER_A, OWNER_ONLY[0])).n, 2);
    for (const sql of OWNER_ONLY.slice(1)) assert.equal(await outcome(MEMBER_A, sql), 'ok', sql);
    assert.deepEqual(await stuck(MEMBER_A), both);
    for (const sql of TENANT_RAISING) assert.equal(await outcome(MEMBER_A, sql, [TENANT_B]), 'ok', sql);
    assert.equal((await one(MEMBER_A, TENANT_RAISING[0], [TENANT_B])).v.total_checks, 1);
    assert.deepEqual(await users(MEMBER_A, TENANT_B), [MEMBER_B]);
    assert.equal(await checkalt(MEMBER_A, TENANT_B), true);
    assert.equal(await outcome(MEMBER_A, 'SELECT public.has_permission($1, $2) AS v', [MEMBER_B, 'read']), 'ok');
    assert.equal((await settlement(MEMBER_A, CHECK_B)).claim.claim_number, 'CLM-B');
    assert.deepEqual((await unread(MEMBER_A)).map(([c]) => c), both);

    // The file, as the owning login, twice (idempotent).
    const owner = await fx.connectAs('checksops_admin');
    try {
      await owner.query(SQL_126);
      await owner.query(SQL_126);
    } finally {
      await owner.end();
    }
    // Same arguments, defaults, results, languages, volatility, SECURITY DEFINER, search_path and
    // owner; EXECUTE for checksops and the owner only.
    assert.deepEqual(await attributes(), before);
    for (const row of await acl()) assert.deepEqual(row.acl, ['checksops EXECUTE', 'owner EXECUTE'], row.identity);

    // The tenant admin of tenant A (user_roles admin and staff): no owner-only read, nothing of
    // tenant B, everything of tenant A as before.
    for (const sql of OWNER_ONLY) assert.equal(await outcome(MEMBER_A, sql), '42501', sql);
    assert.deepEqual(await stuck(MEMBER_A), [CHECK_A]);
    for (const sql of TENANT_RAISING) {
      assert.equal(await outcome(MEMBER_A, sql, [TENANT_B]), '42501', sql);
      assert.equal(await outcome(MEMBER_A, sql, [TENANT_A]), 'ok', sql);
    }
    assert.equal((await one(MEMBER_A, TENANT_RAISING[0], [TENANT_A])).v.total_checks, 1);
    assert.equal((await one(MEMBER_A, TENANT_RAISING[2], [TENANT_A])).v.count, 1);
    assert.deepEqual(await users(MEMBER_A, TENANT_B), []);
    assert.deepEqual(await users(MEMBER_A, TENANT_A), [MEMBER_A]);
    assert.equal(await checkalt(MEMBER_A, TENANT_B), false);
    assert.equal(await checkalt(MEMBER_A, TENANT_A), true);
    assert.equal(await outcome(MEMBER_A, 'SELECT public.has_permission($1, $2) AS v', [MEMBER_B, 'read']), '42501');
    assert.equal((await one(MEMBER_A, 'SELECT public.has_permission($1, $2) AS v', [MEMBER_A, 'manage_users'])).v, true);
    assert.equal(await settlement(MEMBER_A, CHECK_B), null);
    assert.equal((await settlement(MEMBER_A, CHECK_A)).claim.claim_number, 'CLM-A');
    // Only CHECK_A: the two messages from tenant B's owner (their own message is not unread).
    assert.deepEqual(await unread(MEMBER_A), [[CHECK_A, 2]]);
    assert.equal(await totalUnread(MEMBER_A), 2);

    // Tenant B's owner (no user_roles row) is the partner on CHECK_A, which tenant A shares with B.
    for (const sql of OWNER_ONLY) assert.equal(await outcome(MEMBER_B, sql), '42501', sql);
    assert.equal(await outcome(MEMBER_B, 'SELECT * FROM public.get_stuck_checks()'), '42501');
    assert.equal((await settlement(MEMBER_B, CHECK_A)).claim.claim_number, 'CLM-A');
    assert.equal((await settlement(MEMBER_B, CHECK_B)).claim.claim_number, 'CLM-B');
    for (const sql of TENANT_RAISING) {
      assert.equal(await outcome(MEMBER_B, sql, [TENANT_A]), '42501', sql);
      assert.equal(await outcome(MEMBER_B, sql, [TENANT_B]), 'ok', sql);
    }
    assert.equal((await one(MEMBER_B, TENANT_RAISING[2], [TENANT_B])).v.count, 2);
    assert.deepEqual(await users(MEMBER_B, TENANT_A), []);
    assert.equal(await checkalt(MEMBER_B, TENANT_B), true);
    // Its own check's thread (its own messages: none unread) and the shared check's (one from A).
    assert.deepEqual(await unread(MEMBER_B), [[CHECK_A, 1], [CHECK_B, 0]].sort((a, b) => a[0].localeCompare(b[0])));
    assert.equal(await totalUnread(MEMBER_B), 1);
    assert.equal(await outcome(MEMBER_B, 'SELECT public.has_permission($1, $2) AS v', [MEMBER_A, 'read']), '42501');
    assert.equal((await one(MEMBER_B, 'SELECT public.has_permission($1, $2) AS v', [MEMBER_B, 'read'])).v, false);

    // The platform owner (no user_roles row, no tenant): every global and cross-tenant read.
    assert.equal((await one(PLATFORM_OWNER, OWNER_ONLY[0])).n, 2);
    assert.deepEqual((await one(PLATFORM_OWNER, OWNER_ONLY[1])).v, { open_items: 3 });
    assert.deepEqual((await one(PLATFORM_OWNER, OWNER_ONLY[2])).v, { open_exceptions: 2 });
    assert.deepEqual((await one(PLATFORM_OWNER, OWNER_ONLY[3])).v, { awaiting_deposit: 1 });
    assert.deepEqual(await stuck(PLATFORM_OWNER), both);
    for (const tenant of [TENANT_A, TENANT_B]) {
      for (const sql of TENANT_RAISING) assert.equal(await outcome(PLATFORM_OWNER, sql, [tenant]), 'ok', sql);
      assert.equal(await checkalt(PLATFORM_OWNER, tenant), true);
    }
    assert.equal((await one(PLATFORM_OWNER, TENANT_RAISING[0], [TENANT_B])).v.total_checks, 1);
    assert.deepEqual(await users(PLATFORM_OWNER, TENANT_B), [MEMBER_B]);
    assert.equal((await one(PLATFORM_OWNER, 'SELECT public.has_permission($1, $2) AS v', [MEMBER_A, 'manage_users'])).v, true);
    assert.equal((await settlement(PLATFORM_OWNER, CHECK_B)).claim.claim_number, 'CLM-B');
    assert.deepEqual((await unread(PLATFORM_OWNER)).map(([c]) => c), both);
    assert.equal(await totalUnread(PLATFORM_OWNER), 6);

    // No signed-in user: nothing.
    assert.equal(await outcome('', OWNER_ONLY[1]), '42501');
    assert.equal(await outcome('', TENANT_RAISING[0], [TENANT_A]), '42501');
    assert.deepEqual(await unread(''), []);
  } finally {
    await client.end().catch(() => {});
    await fx.close();
  }
});
