/**
 * SQL 139 (aws/workflows/sql/139_tenant_billing_accounts_write_policy_reconcile.sql) on PostgreSQL 16, the
 * behaviour. public.tenant_billing_accounts as staging showed it on 2026-11-01 (helpers/sql139-billing-schema.mjs:
 * the repository's SELECT policy, the live-only aws_select_ / aws_write_tenant_billing_accounts_job TO checksops on
 * aws_monthly_billing_job(), and an authenticated write policy that does not call aws_can_write_tenant), owned
 * like production by a non-superuser checksops_admin; the API login checksops is a member of authenticated.
 *
 *   - before SQL 139 a tenant member (aws_can_write_tenant true) sees the row but SELECT ... FOR UPDATE and
 *     UPDATE return 0 rows (the staging finding, lock:0);
 *   - after it (applied as the table owner) the same session updates its own tenant's row (1 row), never
 *     another tenant's; the monthly billing job path (checksops, aws_monthly_billing_job()) still writes;
 *   - SELECT policies, both _job policies, RLS flags and table grants are byte-for-byte unchanged
 *     (pg_get_expr before and after);
 *   - the file refuses, changing nothing, when the _job policy is missing, has another condition or other
 *     roles, the write policy is missing or RESTRICTIVE, RLS is disabled, or aws_can_write_tenant(uuid) is gone;
 *   - run again on a reconciled table it succeeds and leaves the same state (idempotent);
 *   - with SQL 136 applied first (its RESTRICTIVE aws_money_write_gate_* on the 24 money tables), SQL 139 still
 *     applies and the two compose: the member writes its own row only with request.money_write = '1'.
 * The engine and executor path is aws/tests/release-sql139-executor.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MEMBER_A, TENANT_A, TENANT_B, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { DRIFTED, billingSchema } from './helpers/sql139-billing-schema.mjs';
import { moneySchema } from './helpers/sql136-money-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEXT = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/139_tenant_billing_accounts_write_policy_reconcile.sql'), 'utf8');
const SQL136 = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/136_money_write_restrictive_policies.sql'), 'utf8');
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');

const POLICIES_SQL = `SELECT pol.polname AS name, pol.polcmd::text AS cmd, pol.polpermissive AS permissive,
  ARRAY(SELECT pg_catalog.pg_get_userbyid(r)::text FROM pg_catalog.unnest(pol.polroles) r ORDER BY 1) AS roles,
  pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS qual, pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS chk
FROM pg_catalog.pg_policy pol WHERE pol.polrelid = 'public.tenant_billing_accounts'::regclass ORDER BY 1`;
const TABLE_SQL = `SELECT c.relrowsecurity, c.relforcerowsecurity, c.relacl::text AS acl, pg_catalog.pg_get_userbyid(c.relowner) AS owner
FROM pg_catalog.pg_class c WHERE c.oid = 'public.tenant_billing_accounts'::regclass`;

test('the SQL 139 file: one guard, one DROP and CREATE of aws_write_tenant_billing_accounts as SQL 24 has it, one verify; nothing else', () => {
  const body = stripComments(TEXT);
  const outside = body.replace(/\$(sql139_[a-z]+)\$[\s\S]*?\$\1\$/g, 'BLOCK');
  const statements = outside.split(';').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
  assert.deepEqual(statements, [
    'DO BLOCK',
    'DROP POLICY IF EXISTS aws_write_tenant_billing_accounts ON public.tenant_billing_accounts',
    'CREATE POLICY aws_write_tenant_billing_accounts ON public.tenant_billing_accounts FOR ALL TO authenticated USING (public.aws_can_write_tenant(tenant_id)) WITH CHECK (public.aws_can_write_tenant(tenant_id))',
    'DO BLOCK',
  ]);
  // The CREATE is SQL 24's statement for this table, verbatim.
  const sql24 = fs.readFileSync(path.join(ROOT, 'aws/rls/sql/24_complete_write_policies.sql'), 'utf8');
  const start = sql24.indexOf('DROP POLICY IF EXISTS aws_write_tenant_billing_accounts ON');
  const create = sql24.slice(start, sql24.indexOf(';', sql24.indexOf('CREATE POLICY aws_write_tenant_billing_accounts ON', start)) + 1);
  assert.ok(TEXT.includes(create), 'SQL 24 block');
  assert.doesNotMatch(outside, /\b(GRANT|REVOKE|ALTER TABLE|ROW LEVEL SECURITY|CREATE OR REPLACE|DROP FUNCTION|INSERT INTO|UPDATE public|DELETE FROM|TRUNCATE)\b/);
  assert.doesNotMatch(outside, /\b(BEGIN|COMMIT|SET LOCAL)\b/);
  for (const code of ['sql139_table_missing', 'sql139_rls_disabled', 'sql139_write_policy_missing', 'sql139_write_policy_shape',
    'sql139_job_policy_missing', 'sql139_job_policy_collision', 'sql139_function_missing', 'sql139_write_policy_not_reconciled',
    'sql139_job_policy_mutated', 'sql139_rls_disabled_after_reconcile']) {
    assert.ok(TEXT.includes(`'${code}`), code);
  }
});

test('PostgreSQL 16: SQL 139 reconciles the drifted billing write policy; SELECT and _job policies unchanged; fail-closed; idempotent; composes with SQL 136', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql139-', 61390, { extra: [billingSchema({ member: MEMBER_A })] });
  const { admin, connectAs } = fx;
  /** One API transaction as checksops (member of authenticated) for MEMBER_A, with the given GUCs. */
  const asApi = async (gucs, run) => {
    const c = await connectAs('checksops');
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('request.app_user_id', $1, true)", [MEMBER_A]);
      for (const g of gucs) await c.query('SELECT set_config($1, $2, true)', [g, '1']);
      const value = await run(c);
      await c.query('COMMIT');
      return value;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await c.end();
    }
  };
  const member = (tenant = TENANT_A, gucs = []) => asApi(gucs, async (c) => ({
    sel: (await c.query('SELECT count(*)::int AS n FROM public.tenant_billing_accounts WHERE tenant_id = $1', [tenant])).rows[0].n,
    lock: (await c.query('SELECT id FROM public.tenant_billing_accounts WHERE tenant_id = $1 FOR UPDATE', [tenant])).rowCount,
    upd: (await c.query("UPDATE public.tenant_billing_accounts SET note = 'member' WHERE tenant_id = $1", [tenant])).rowCount,
  }));
  const asOwner = async (sql) => {
    const owner = await connectAs('checksops_admin');
    try { await owner.query(sql); } finally { await owner.end(); }
  };
  /** Runs `setup` as the superuser and then the file as the owner, in one transaction that is rolled back. */
  const refusedWith = async (setup) => {
    await admin.query('BEGIN');
    try {
      await admin.query(setup);
      await admin.query('SET LOCAL ROLE checksops_admin');
      await admin.query(TEXT);
      return null;
    } catch (error) {
      return String(error.message).split(':')[0];
    } finally {
      await admin.query('ROLLBACK');
    }
  };
  const snapshot = async () => ({ policies: (await admin.query(POLICIES_SQL)).rows, table: (await admin.query(TABLE_SQL)).rows[0] });
  const others = (snap) => snap.policies.filter((p) => p.name !== 'aws_write_tenant_billing_accounts');
  try {
    await admin.query(`INSERT INTO public.tenant_billing_accounts (tenant_id, note) VALUES ($1, 'seed'), ($2, 'seed')`, [TENANT_A, TENANT_B]);

    // Before SQL 139: the member sees its row but cannot lock or update it (the staging finding).
    assert.deepEqual(await member(), { sel: 1, lock: 0, upd: 0 });
    assert.equal(await asApi([], async (c) => (await c.query('SELECT public.aws_can_write_tenant($1) AS ok', [TENANT_A])).rows[0].ok), true);
    const before = await snapshot();
    const drifted = before.policies.find((p) => p.name === 'aws_write_tenant_billing_accounts');
    assert.ok(DRIFTED.includes('is_platform_owner()') && drifted.qual.includes('is_platform_owner()'), drifted.qual);
    assert.doesNotMatch(`${drifted.qual} ${drifted.chk}`, /aws_can_write_tenant/);

    // (b) Fail-closed: each refuses in a transaction that changes nothing.
    const P = 'ON public.tenant_billing_accounts';
    assert.equal(await refusedWith(`DROP POLICY aws_write_tenant_billing_accounts_job ${P}`), 'sql139_job_policy_missing');
    assert.equal(await refusedWith(`ALTER POLICY aws_write_tenant_billing_accounts_job ${P} USING (true)`), 'sql139_job_policy_collision');
    assert.equal(await refusedWith(`ALTER POLICY aws_write_tenant_billing_accounts_job ${P} WITH CHECK (public.aws_monthly_billing_job() OR public.is_platform_owner())`), 'sql139_job_policy_collision');
    assert.equal(await refusedWith(`ALTER POLICY aws_write_tenant_billing_accounts_job ${P} TO checksops, authenticated`), 'sql139_job_policy_collision');
    assert.equal(await refusedWith(`DROP POLICY aws_write_tenant_billing_accounts_job ${P};
      CREATE POLICY aws_write_tenant_billing_accounts_job ${P} AS RESTRICTIVE FOR ALL TO checksops USING (public.aws_monthly_billing_job()) WITH CHECK (public.aws_monthly_billing_job())`), 'sql139_job_policy_collision');
    assert.equal(await refusedWith(`DROP POLICY aws_write_tenant_billing_accounts_job ${P};
      CREATE POLICY aws_write_tenant_billing_accounts_job ${P} FOR UPDATE TO checksops USING (public.aws_monthly_billing_job()) WITH CHECK (public.aws_monthly_billing_job())`), 'sql139_job_policy_collision');
    assert.equal(await refusedWith(`DROP POLICY aws_write_tenant_billing_accounts ${P}`), 'sql139_write_policy_missing');
    assert.equal(await refusedWith(`DROP POLICY aws_write_tenant_billing_accounts ${P};
      CREATE POLICY aws_write_tenant_billing_accounts ${P} AS RESTRICTIVE FOR ALL TO authenticated USING (true) WITH CHECK (true)`), 'sql139_write_policy_shape');
    assert.equal(await refusedWith(`DROP POLICY aws_write_tenant_billing_accounts ${P};
      CREATE POLICY aws_write_tenant_billing_accounts ${P} FOR UPDATE TO authenticated USING (true)`), 'sql139_write_policy_shape');
    assert.equal(await refusedWith('ALTER TABLE public.tenant_billing_accounts DISABLE ROW LEVEL SECURITY'), 'sql139_rls_disabled');
    assert.equal(await refusedWith('ALTER FUNCTION public.aws_can_write_tenant(uuid) RENAME TO sql139_test_renamed'), 'sql139_function_missing');
    assert.deepEqual(await snapshot(), before, 'nothing changed by a refused run');
    assert.deepEqual(await member(), { sel: 1, lock: 0, upd: 0 });

    // (a) The file, as the table owner.
    await asOwner(TEXT);
    const after = await snapshot();
    const write = after.policies.find((p) => p.name === 'aws_write_tenant_billing_accounts');
    assert.deepEqual({ ...write }, { name: 'aws_write_tenant_billing_accounts', cmd: '*', permissive: true, roles: ['authenticated'],
      qual: 'aws_can_write_tenant(tenant_id)', chk: 'aws_can_write_tenant(tenant_id)' });
    // (d) Every other policy, the RLS flags, the owner and the table grants exactly as before.
    assert.deepEqual(others(after), others(before));
    assert.deepEqual(after.table, before.table);
    assert.deepEqual(others(after).map((p) => p.name), ['aws_select_tenant_billing_accounts', 'aws_select_tenant_billing_accounts_job', 'aws_write_tenant_billing_accounts_job']);
    // The member now locks and updates its own tenant's row, never another tenant's.
    assert.deepEqual(await member(), { sel: 1, lock: 1, upd: 1 });
    assert.deepEqual(await member(TENANT_B), { sel: 0, lock: 0, upd: 0 });
    // The monthly billing job path (checksops with aws_monthly_billing_job()) still writes any tenant's row.
    const job = await connectAs('checksops');
    try {
      await job.query('BEGIN');
      await job.query("SELECT set_config('request.monthly_billing_job', '1', true)");
      assert.equal((await job.query("UPDATE public.tenant_billing_accounts SET note = 'job' WHERE tenant_id = $1", [TENANT_B])).rowCount, 1);
      await job.query('COMMIT');
    } finally {
      await job.end();
    }

    // (c) Run again: succeeds and leaves the same state.
    await asOwner(TEXT);
    assert.deepEqual(await snapshot(), after);
    assert.deepEqual(await member(), { sel: 1, lock: 1, upd: 1 });
  } finally {
    await fx.close();
  }

  // Composes with SQL 136 (its restrictive money-write gates applied first, as staging may have them).
  const fx2 = await releaseFixture(pg, 'pg-sql139-136-', 61392, { extra: [moneySchema({ member: MEMBER_A }), billingSchema({ member: MEMBER_A })] });
  try {
    const owner = await fx2.connectAs('checksops_admin');
    try {
      await owner.query(SQL136);
      await owner.query(TEXT);
    } finally {
      await owner.end();
    }
    await fx2.admin.query(`INSERT INTO public.tenant_billing_accounts (tenant_id, note) VALUES ($1, 'seed')`, [TENANT_A]);
    const update = async (gucs) => {
      const c = await fx2.connectAs('checksops');
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('request.app_user_id', $1, true)", [MEMBER_A]);
        for (const g of gucs) await c.query('SELECT set_config($1, $2, true)', [g, '1']);
        const n = (await c.query("UPDATE public.tenant_billing_accounts SET note = 'x' WHERE tenant_id = $1", [TENANT_A])).rowCount;
        await c.query('ROLLBACK');
        return n;
      } finally {
        await c.end();
      }
    };
    assert.equal(await update([]), 0, 'SQL 136 gate: no flag, no write');
    assert.equal(await update(['request.money_write']), 1, 'SQL 136 gate open and SQL 139 policy: own tenant row');
    const gates = (await fx2.admin.query("SELECT count(*)::int AS n FROM pg_catalog.pg_policy WHERE polrelid = 'public.tenant_billing_accounts'::regclass AND polname LIKE 'aws_money_write_gate_%'")).rows[0].n;
    assert.equal(gates, 3);
  } finally {
    await fx2.close();
  }
});
