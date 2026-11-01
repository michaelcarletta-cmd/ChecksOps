/**
 * SQL 136 (aws/workflows/sql/136_money_write_restrictive_policies.sql) on PostgreSQL 16, the behaviour
 * (security audit 2026-10-29, finding 14). The 24 money tables as the repository leaves them
 * (helpers/sql136-money-schema.mjs: RLS, the API login's grants and SQL 24's real FOR ALL write
 * policy), owned like production by a non-superuser checksops_admin; the API login checksops is a member of
 * authenticated.
 *
 *   - before SQL 136 a tenant member's session writes every money table directly (the finding);
 *   - after it (applied as the table owner), without a server GUC the same session can INSERT nothing
 *     (row-level security refusal) and UPDATE and DELETE no row, on every one of the 24 tables, while
 *     SELECT is unchanged;
 *   - with request.money_write = '1', request.financial_execution = '1', request.moov_onboarding = '1'
 *     or request.provider_webhook_apply = '1' (the #1498 API writers, SQL 72 and SQL 91) it can, still
 *     only for its own tenant (the permissive SQL 24 policy still decides which rows);
 *   - a SECURITY DEFINER writer owned by the table owner (SQL 98 / 109 / 113 / 120's shape) still writes
 *     without the flag;
 *   - the file refuses, changing nothing, while a money table is FORCE ROW LEVEL SECURITY, a SECURITY
 *     DEFINER writer is owned by a role that cannot bypass the table's RLS, or a SECURITY INVOKER trigger
 *     function writes a money table (tg_accrue_mortgage_ops_billing's case).
 * The generic /data/write route refusing all 24 tables is aws/tests/money-write-flag.test.mjs; the engine
 * and executor path is aws/tests/release-sql136-executor.test.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MEMBER_A, TENANT_A, TENANT_B, pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';
import { MONEY_TABLES, moneySchema } from './helpers/sql136-money-schema.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEXT = fs.readFileSync(path.join(ROOT, 'aws/workflows/sql/136_money_write_restrictive_policies.sql'), 'utf8');
const GUCS = Object.freeze(['request.money_write', 'request.financial_execution', 'request.moov_onboarding', 'request.provider_webhook_apply']);
const extraCols = () => '';
const extraVals = () => '';
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');

test('the SQL 136 money table list is finding 14\'s (money-write-flag.test.mjs MONEY_TABLES) and the file covers each table with three restrictive policies', () => {
  const flagTest = fs.readFileSync(path.join(ROOT, 'aws/tests/money-write-flag.test.mjs'), 'utf8');
  const listed = flagTest.slice(flagTest.indexOf('export const MONEY_TABLES'), flagTest.indexOf(']);', flagTest.indexOf('export const MONEY_TABLES')));
  assert.deepEqual([...listed.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), [...MONEY_TABLES]);
  for (const t of MONEY_TABLES) {
    for (const cmd of ['insert', 'update', 'delete']) {
      assert.match(TEXT, new RegExp(`CREATE POLICY aws_money_write_gate_${cmd}_${t} ON public\\.${t}\\n  AS RESTRICTIVE FOR ${cmd.toUpperCase()} TO authenticated\\n`), `${cmd} ${t}`);
    }
  }
  assert.equal((TEXT.match(/^CREATE POLICY /gm) || []).length, 72);
  assert.doesNotMatch(stripComments(TEXT), /FOR ALL/);
  assert.doesNotMatch(stripComments(TEXT), /\bDROP POLICY IF EXISTS aws_write_/);
});

test('PostgreSQL 16: SQL 136 restricts every money write to a server GUC; SELECT, definer writers and the tenant rule unchanged; fail-closed preconditions', { timeout: 600000 }, async (t) => {
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
  const fx = await releaseFixture(pg, 'pg-sql136-', 61360, { extra: [moneySchema({ member: MEMBER_A })] });
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
  const writeAll = async (gucs, tenant = TENANT_A) => {
    const out = {};
    for (const table of MONEY_TABLES) {
      out[table] = await asApi(gucs, async (c) => {
        await c.query('SAVEPOINT ins');
        const ins = await c.query(`INSERT INTO public.${table} (tenant_id, note${extraCols(table)}) VALUES ($1, 'x'${extraVals(table)}) RETURNING id`, [tenant])
          .then(async (r) => { await c.query('RELEASE SAVEPOINT ins'); return r.rowCount; },
            async (e) => { await c.query('ROLLBACK TO SAVEPOINT ins'); return e.code === '42501' ? e.code : `${e.code} ${e.message}`; });
        const upd = (await c.query(`UPDATE public.${table} SET note = 'y' WHERE tenant_id = $1 AND note = 'seed'`, [tenant])).rowCount;
        const del = (await c.query(`DELETE FROM public.${table} WHERE tenant_id = $1 AND note = 'seed-delete'`, [tenant])).rowCount;
        const sel = (await c.query(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0].n;
        return { ins, upd, del, sel };
      }).catch((e) => ({ error: e.code }));
    }
    return out;
  };
  const seed = async () => {
    for (const table of MONEY_TABLES) {
      await admin.query(`DELETE FROM public.${table}`);
      await admin.query(`INSERT INTO public.${table} (tenant_id, note${extraCols(table)}) VALUES ($1, 'seed'${extraVals(table)}), ($1, 'seed-delete'${extraVals(table)})`, [TENANT_A]);
    }
  };
  const asOwner = async (sql) => {
    const owner = await connectAs('checksops_admin');
    try { await owner.query(sql); } finally { await owner.end(); }
  };
  const refusedWith = async (sql) => {
    const owner = await connectAs('checksops_admin');
    try {
      await owner.query('BEGIN');
      await owner.query(sql);
      await owner.query(TEXT);
      return null;
    } catch (error) {
      return String(error.message).split(':')[0];
    } finally {
      await owner.query('ROLLBACK').catch(() => {});
      await owner.end();
    }
  };
  try {
    // Before SQL 136: the finding. A tenant member's session writes every money table without any flag.
    await seed();
    for (const [table, r] of Object.entries(await writeAll([]))) assert.deepEqual(r, { ins: 1, upd: 1, del: 1, sel: 2 }, `before ${table}`);

    // Fail-closed preconditions: each refuses in a transaction that changes nothing.
    assert.equal(await refusedWith('ALTER TABLE public.payment_transfers FORCE ROW LEVEL SECURITY'), 'sql136_force_rls');
    assert.equal(await refusedWith(`CREATE FUNCTION public.sql136_test_invoker_accrual() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN INSERT INTO public.check_billing_events (tenant_id, unit_price_cents) VALUES (NEW.tenant_id, 1); RETURN NEW; END $f$;
CREATE TRIGGER sql136_test_accrual AFTER UPDATE ON public.payment_wallets FOR EACH ROW EXECUTE FUNCTION public.sql136_test_invoker_accrual();`),
    'sql136_invoker_trigger_writes_money_table');
    await admin.query('CREATE ROLE sql136_plain NOLOGIN NOSUPERUSER NOBYPASSRLS');
    {
      // A DEFINER writer owned by a role that is neither the owner nor RLS-exempt (created by the superuser).
      await admin.query('BEGIN');
      try {
        await admin.query(`CREATE FUNCTION public.sql136_test_plain_writer() RETURNS void LANGUAGE sql SECURITY DEFINER AS $f$ UPDATE public.payment_wallets SET note = note $f$;
ALTER FUNCTION public.sql136_test_plain_writer() OWNER TO sql136_plain;`);
        let code = null;
        await admin.query('SAVEPOINT s');
        try { await admin.query(TEXT); } catch (e) { code = String(e.message).split(':')[0]; }
        assert.equal(code, 'sql136_definer_writer_cannot_bypass_rls');
      } finally {
        await admin.query('ROLLBACK');
      }
    }
    for (const table of MONEY_TABLES) {
      const n = (await admin.query("SELECT count(*)::int AS n FROM pg_catalog.pg_policy WHERE polrelid = $1::regclass AND polname LIKE 'aws_money_write_gate_%'", [`public.${table}`])).rows[0].n;
      assert.equal(n, 0, `nothing applied by a refused run: ${table}`);
    }

    // The file, as the table owner.
    await asOwner(TEXT);
    const policies = (await admin.query(`SELECT c.relname, pol.polname, pol.polcmd, pol.polpermissive, pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) AS qual,
      pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) AS chk FROM pg_catalog.pg_policy pol JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
      WHERE pol.polname LIKE 'aws_money_write_gate_%' ORDER BY 1, 2`)).rows;
    assert.equal(policies.length, 72);
    assert.ok(policies.every((p) => p.polpermissive === false));
    assert.deepEqual([...new Set(policies.map((p) => p.polcmd))].sort(), ['a', 'd', 'w']);
    const fnAcl = (await admin.query(`SELECT has_function_privilege('checksops', 'public.aws_money_write_allowed()', 'EXECUTE') AS api,
      has_function_privilege('authenticated', 'public.aws_money_write_allowed()', 'EXECUTE') AS auth,
      EXISTS (SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a WHERE p.oid = 'public.aws_money_write_allowed()'::regprocedure AND a.grantee = 0) AS public_grant,
      (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = 'public.aws_money_write_allowed()'::regprocedure) AS secdef`)).rows[0];
    assert.deepEqual(fnAcl, { api: true, auth: true, public_grant: false, secdef: false });

    // After: no flag, nothing written; SELECT unchanged.
    await seed();
    for (const [table, r] of Object.entries(await writeAll([]))) {
      assert.deepEqual(r, { ins: '42501', upd: 0, del: 0, sel: 2 }, `no flag ${table}`);
    }
    // Each server GUC opens every money table to the session's own tenant.
    for (const guc of GUCS) {
      await seed();
      for (const [table, r] of Object.entries(await writeAll([guc]))) assert.deepEqual(r, { ins: 1, upd: 1, del: 1, sel: 2 }, `${guc} ${table}`);
    }
    // A GUC set to anything but '1' does not.
    await seed();
    const notOne = await asApi([], async (c) => {
      await c.query("SELECT set_config('request.money_write', 'on', true)");
      return c.query("INSERT INTO public.payment_transfers (tenant_id, note) VALUES ($1, 'x')", [TENANT_A]).then(() => 'ok', (e) => e.code);
    });
    assert.equal(notOne, '42501');
    // The permissive SQL 24 policy still decides the tenant: with the flag, another tenant stays refused.
    await seed();
    for (const [table, r] of Object.entries(await writeAll(['request.money_write'], TENANT_B))) {
      assert.deepEqual(r, { ins: '42501', upd: 0, del: 0, sel: 2 }, `other tenant ${table}`);
    }
    // A SECURITY DEFINER writer owned by the table owner still writes without the flag.
    await asOwner(`CREATE FUNCTION public.sql136_test_owner_writer(_t uuid) RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public AS $f$
      WITH u AS (UPDATE public.payment_transfers SET note = 'definer' WHERE tenant_id = _t RETURNING 1) SELECT count(*)::int FROM u $f$;
      GRANT EXECUTE ON FUNCTION public.sql136_test_owner_writer(uuid) TO checksops;`);
    await seed();
    assert.equal(await asApi([], async (c) => (await c.query('SELECT public.sql136_test_owner_writer($1) AS n', [TENANT_A])).rows[0].n), 2);
    // Re-running the file leaves the same policies (idempotent).
    await asOwner(TEXT);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_catalog.pg_policy WHERE polname LIKE 'aws_money_write_gate_%'")).rows[0].n, 72);
  } finally {
    await admin.end().catch(() => {});
    fx.server.stop();
  }
});
