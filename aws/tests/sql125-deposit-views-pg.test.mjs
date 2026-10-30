/**
 * SQL 125 (security_invoker on the four Supabase-era deposit views) against PostgreSQL 16: the
 * release fixture (the real AWS RLS helper files, tenants A and B with one member each, the
 * platform owner), the deposit tables and views copied out of their supabase migrations with the
 * real aws_select_ policies of 12_final_select_policies.sql (helpers/sql125-deposit-views-schema.mjs),
 * then aws/workflows/sql/125_deposit_views_security_invoker.sql applied by checksops_admin, the
 * non-superuser login that owns the views and tables (as in staging and production).
 *
 * The views are read as the API reads them (POST /data/query): checksops, RLS on,
 * request.app_user_id set, one committed transaction per request.
 *
 *   - before SQL 125: a member of tenant A reads tenant B's deposit item through every view (the
 *     finding);
 *   - the file refuses a login that does not own the views, and is idempotent;
 *   - after: through every view a member reads only their own tenant's deposit items, with the
 *     exception and attachment counts of those items, and a check shared with the other tenant
 *     does not show its deposit item to the partner; the platform owner still reads both tenants;
 *     the base tables answer exactly as before; the definitions, owner and grants are unchanged.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { MEMBER_A, MEMBER_B, PLATFORM_OWNER, REPO_ROOT, TENANT_A, TENANT_B, CHECK_A, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { DEPOSIT_VIEWS, ITEM_A, ITEM_B, depositViewsSchema } from './helpers/sql125-deposit-views-schema.mjs';

const SQL_125 = fs.readFileSync(path.join(REPO_ROOT, 'aws/workflows/sql/125_deposit_views_security_invoker.sql'), 'utf8');
// The deposit item id each view returns, and the owner column of the per-owner view.
const ITEM_COLUMN = Object.freeze({
  'public.deposit_queue_scored': 'id',
  'public.deposit_reminder_queue': 'deposit_item_id',
  'public.deposit_aging_dashboard': 'id',
});

test('PostgreSQL 16: SQL 125 limits the four deposit views to the caller\'s own tenants\' deposit items', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql125-views-', 59670, { extra: [depositViewsSchema()] });
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
    const rows = (user, sql) => as(user, async () => (await client.query(sql)).rows);
    /** The deposit items (and their open exception count where the view has one) a user reads through each view. */
    const through = async (user) => {
      const out = {};
      for (const [view, column] of Object.entries(ITEM_COLUMN)) {
        const counts = view === 'public.deposit_aging_dashboard' ? 'deposit_slip_count' : 'open_exception_count';
        out[view] = (await rows(user, `SELECT ${column}::text AS item, ${counts}::int AS n FROM ${view} ORDER BY 1`)).map((r) => [r.item, r.n]);
      }
      out['public.deposit_owner_performance'] = (await rows(user, 'SELECT owner_id::text AS owner, open_items::int AS n FROM public.deposit_owner_performance ORDER BY 1'))
        .map((r) => [r.owner, r.n]);
      return out;
    };
    const both = {
      'public.deposit_queue_scored': [[ITEM_A, 1], [ITEM_B, 1]],
      'public.deposit_reminder_queue': [[ITEM_A, 1], [ITEM_B, 1]],
      'public.deposit_aging_dashboard': [[ITEM_A, 1], [ITEM_B, 1]],
      'public.deposit_owner_performance': [[MEMBER_A, 1], [MEMBER_B, 1]],
    };
    const only = (item, member) => ({
      'public.deposit_queue_scored': [[item, 1]],
      'public.deposit_reminder_queue': [[item, 1]],
      'public.deposit_aging_dashboard': [[item, 1]],
      'public.deposit_owner_performance': [[member, 1]],
    });
    const baseTables = async (user) => ({
      items: (await rows(user, 'SELECT id::text FROM public.deposit_items ORDER BY 1')).map((r) => r.id),
      exceptions: (await rows(user, 'SELECT deposit_item_id::text AS id FROM public.deposit_exceptions ORDER BY 1')).map((r) => r.id),
      attachments: (await rows(user, 'SELECT deposit_item_id::text AS id FROM public.deposit_attachments ORDER BY 1')).map((r) => r.id),
    });
    const catalog = async () => (await client.query(`SELECT c.oid::regclass::text AS name, pg_catalog.pg_get_userbyid(c.relowner) AS owner,
        COALESCE(c.reloptions, ARRAY[]::text[]) AS options, md5(pg_catalog.pg_get_viewdef(c.oid)) AS def,
        has_table_privilege('checksops', c.oid, 'SELECT') AS checksops_select
      FROM pg_catalog.pg_class c WHERE c.oid = ANY($1::regclass[]) ORDER BY 1`, [DEPOSIT_VIEWS])).rows;

    // The partner case: tenant A shares CHECK_A with tenant B.
    await client.query(`INSERT INTO public.shared_checks (check_id, source_tenant_id, target_tenant_id) VALUES ('${CHECK_A}', '${TENANT_A}', '${TENANT_B}')`);

    // Before SQL 125 (the finding): the views run as their owner, so every member reads both tenants.
    assert.deepEqual(await through(MEMBER_A), both);
    assert.deepEqual(await through(MEMBER_B), both);
    // The base tables already answer under RLS: each member reads only their own tenant's item.
    const tablesA = await baseTables(MEMBER_A);
    const tablesB = await baseTables(MEMBER_B);
    assert.deepEqual(tablesA, { items: [ITEM_A], exceptions: [ITEM_A], attachments: [ITEM_A] });
    assert.deepEqual(tablesB, { items: [ITEM_B], exceptions: [ITEM_B], attachments: [ITEM_B] });
    const before = await catalog();
    assert.deepEqual(before.map((v) => [v.owner, v.options, v.checksops_select]), DEPOSIT_VIEWS.map(() => ['checksops_admin', [], true]));

    // A login that does not own the views is refused; nothing changes.
    await client.query('CREATE ROLE sql125_other LOGIN NOSUPERUSER');
    const other = await fx.connectAs('sql125_other');
    try {
      await assert.rejects(other.query(SQL_125), (error) => error.code === '42501' && /sql125_not_view_owner/.test(error.message));
    } finally {
      await other.end();
    }
    assert.deepEqual((await catalog()).map((v) => v.options), DEPOSIT_VIEWS.map(() => []));

    // SQL 125 by the owning login, twice (idempotent).
    const owner = await fx.connectAs('checksops_admin');
    try {
      await owner.query(SQL_125);
      await owner.query(SQL_125);
    } finally {
      await owner.end();
    }

    // After: each member reads only their own tenant's deposit items through every view; the
    // partner tenant does not see the shared check's deposit item.
    assert.deepEqual(await through(MEMBER_A), only(ITEM_A, MEMBER_A));
    assert.deepEqual(await through(MEMBER_B), only(ITEM_B, MEMBER_B));
    // The platform owner still reads both tenants.
    assert.deepEqual(await through(PLATFORM_OWNER), both);
    // Someone with no membership reads nothing.
    const stranger = 'a1000000-0000-4000-8000-0000000000ff';
    assert.deepEqual(await through(stranger), {
      'public.deposit_queue_scored': [], 'public.deposit_reminder_queue': [], 'public.deposit_aging_dashboard': [], 'public.deposit_owner_performance': [],
    });
    // The base tables answer exactly as before.
    assert.deepEqual(await baseTables(MEMBER_A), tablesA);
    assert.deepEqual(await baseTables(MEMBER_B), tablesB);
    // Only the options changed: definitions, owner and grants as before.
    const after = await catalog();
    for (const row of after) {
      const was = before.find((v) => v.name === row.name);
      assert.deepEqual(row.options, ['security_invoker=true'], row.name);
      assert.equal(row.def, was.def, row.name);
      assert.equal(row.owner, 'checksops_admin', row.name);
      assert.equal(row.checksops_select, true, row.name);
    }
  } finally {
    await client.end().catch(() => {});
    await fx.close();
  }
});
