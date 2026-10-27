/**
 * SQL 121 against PostgreSQL 16: Cash Jobs on AWS. Every object is owned by a non-superuser
 * checksops_admin LOGIN (production's admin login, which applies the file); the API login checksops
 * (a member of authenticated) writes cash jobs, updates checks and writes checkalt_deposits, as the
 * /data/write, deposit and Check Alt paths do. The cash-job tables carry the real aws_write_ policies
 * (aws/rls/sql/24_complete_write_policies.sql; aws_can_write_tenant stubbed to one tenant), and
 * check_intake_items' cash-job columns, sync_cash_job_check_payment() and its trigger come from their
 * own Supabase migration, sync_cash_job_total_paid() and sync_cash_job_status() from theirs. Before
 * SQL 121 checksops holds SELECT only on the cash-job tables (the restored database's grant).
 *
 * Owner rules (2026-10-27): "Make sure cash jobs works the same as claim checks"; "yes, record
 * cash-job payments on Check Alt approval." A check is counted once it is approved, once per check,
 * and not when it did not go through; a payment entered by hand and checks that are not cash-job
 * checks are never touched.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AWS_ROOT, pgSkipReason, policyBlock, startPg } from './helpers/stakeholder-policies-pg.mjs';
import { RELEASE_SQL_SPECS, releaseFunctionDefinitions } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';

const REPO = path.join(AWS_ROOT, '..');
const SQL_121 = path.join(AWS_ROOT, 'workflows/sql/121_cash_jobs_production_grants.sql');
const SUPABASE_CHECK_PAYMENT = path.join(REPO, 'supabase/migrations/20260522142101_6c46a740-87fc-48ab-afd4-07af285f1ae3.sql');
const SUPABASE_TOTALS = path.join(REPO, 'supabase/migrations/20260522135038_c36d2ed7-8b23-4f1f-9b33-9bc834cad00b.sql');
const sha = (text) => createHash('sha256').update(text).digest('hex');

const T_A = '11111111-1111-4111-8111-111111111111'; // the tenant checksops may write
const T_B = '22222222-2222-4222-8222-222222222222';
const USER = 'a1000000-0000-4000-8000-000000000001';
const JOB = 'b0000000-0000-4000-8000-000000000001';
const JOB_2 = 'b0000000-0000-4000-8000-000000000002';
const C_DEP = 'c0000000-0000-4000-8000-000000000001'; // deposited (the existing trigger)
const C_ALT = 'c0000000-0000-4000-8000-000000000002'; // Check Alt submitted, cleared, then deposited, then duplicate
const C_REJ = 'c0000000-0000-4000-8000-000000000003'; // Check Alt cleared on insert, then rejected
const C_TWO = 'c0000000-0000-4000-8000-000000000004'; // two deposits
const C_PEND = 'c0000000-0000-4000-8000-000000000005'; // rejected before approval
const C_INS = 'c0000000-0000-4000-8000-000000000006'; // an insurance check (not a cash-job check)
const C_NOJOB = 'c0000000-0000-4000-8000-000000000007'; // check_source cash_job without a job

const totalsSql = () => {
  const text = fs.readFileSync(SUPABASE_TOTALS, 'utf8');
  const from = text.indexOf('CREATE OR REPLACE FUNCTION public.sync_cash_job_total_paid()');
  const to = text.indexOf('CREATE INDEX IF NOT EXISTS idx_cash_jobs_tenant_id');
  assert.ok(from > 0 && to > from);
  return text.slice(from, to);
};

const SCHEMA = () => `
CREATE ROLE checksops_admin LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE checksops LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
CREATE ROLE authenticated NOLOGIN;
GRANT authenticated TO checksops;
GRANT CREATE, USAGE ON SCHEMA public TO checksops_admin;
GRANT USAGE ON SCHEMA public TO checksops, authenticated;
SET ROLE checksops_admin;
CREATE FUNCTION public.aws_can_write_tenant(_tenant uuid) RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT _tenant = '${T_A}'::uuid $$;
CREATE TABLE public.cash_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, title text,
  contract_amount numeric NOT NULL DEFAULT 0, total_paid numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'estimate', updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.cash_job_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, cash_job_id uuid REFERENCES public.cash_jobs(id), description text);
CREATE TABLE public.cash_job_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, cash_job_id uuid REFERENCES public.cash_jobs(id), file_path text);
CREATE TABLE public.cash_job_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, cash_job_id uuid NOT NULL REFERENCES public.cash_jobs(id),
  created_by uuid, amount numeric NOT NULL, payment_method text, payment_date date, reference_number text, notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE public.check_intake_items (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, status text NOT NULL DEFAULT 'needs_review', amount numeric, uploaded_by uuid);
CREATE TABLE public.checkalt_deposits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_intake_item_id uuid, tenant_id uuid,
  status text NOT NULL DEFAULT 'pending', submitted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
${fs.readFileSync(SUPABASE_CHECK_PAYMENT, 'utf8')};
${totalsSql()}
ALTER TABLE public.cash_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_job_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_job_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_job_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.check_intake_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checkalt_deposits ENABLE ROW LEVEL SECURITY;
${policyBlock('24_complete_write_policies.sql', 'aws_write_cash_jobs')}
${policyBlock('24_complete_write_policies.sql', 'aws_write_cash_job_line_items')}
${policyBlock('24_complete_write_policies.sql', 'aws_write_cash_job_attachments')}
${policyBlock('24_complete_write_policies.sql', 'aws_write_cash_job_payments')}
CREATE POLICY api_checks ON public.check_intake_items FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY api_deposits ON public.checkalt_deposits FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- The restored database: SELECT only on the cash-job tables and cash_job_payments; the check and
-- Check Alt paths update checks and write deposits.
GRANT SELECT ON public.cash_jobs, public.cash_job_line_items, public.cash_job_attachments, public.cash_job_payments TO checksops;
GRANT SELECT, UPDATE ON public.check_intake_items TO checksops;
GRANT SELECT, INSERT, UPDATE ON public.checkalt_deposits TO checksops;
INSERT INTO public.cash_jobs (id, tenant_id, title, contract_amount) VALUES
  ('${JOB}', '${T_A}', 'Roof', 10000), ('${JOB_2}', '${T_A}', 'Siding', 4000);
INSERT INTO public.check_intake_items (id, tenant_id, amount, uploaded_by, check_source, cash_job_id, cash_job_payment_class) VALUES
  ('${C_DEP}', '${T_A}', 1000, '${USER}', 'cash_job', '${JOB}', 'initial_deposit'),
  ('${C_ALT}', '${T_A}', 2500, '${USER}', 'cash_job', '${JOB}', 'progress_payment'),
  ('${C_REJ}', '${T_A}', 700, '${USER}', 'cash_job', '${JOB_2}', 'final_payment'),
  ('${C_TWO}', '${T_A}', 300, NULL, 'cash_job', '${JOB_2}', NULL),
  ('${C_PEND}', '${T_A}', 50, '${USER}', 'cash_job', '${JOB_2}', 'other'),
  ('${C_INS}', '${T_A}', 9000, '${USER}', 'insurance', NULL, NULL),
  ('${C_NOJOB}', '${T_A}', 80, '${USER}', 'cash_job', NULL, NULL);
-- A payment entered by hand on JOB_2, and one whose reference is the insurance check's id.
INSERT INTO public.cash_job_payments (tenant_id, cash_job_id, amount, payment_method, payment_date, reference_number, notes) VALUES
  ('${T_A}', '${JOB_2}', 400, 'check', '2026-10-01', 'manual-1', 'entered by hand'),
  ('${T_A}', '${JOB_2}', 10, 'check', '2026-10-01', '${C_INS}', 'entered by hand with a check id');
RESET ROLE;
`;

test('SQL 121: cash-job grants, the definer payment trigger and the cash-job payment at Check Alt approval (PostgreSQL 16)', { timeout: 240000, skip: pgSkipReason() || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-sql121-cash-', 56400);
  const superuser = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  const owner = new pg.Client({ host: server.host, port: server.port, user: 'checksops_admin', database: 'postgres' });
  const api = new pg.Client({ host: server.host, port: server.port, user: 'checksops', database: 'postgres' });
  const payments = async (job) => (await superuser.query(
    `SELECT reference_number, amount::text AS amount, payment_method, notes, created_by, payment_date = CURRENT_DATE AS today
       FROM public.cash_job_payments WHERE cash_job_id = $1 ORDER BY created_at`, [job])).rows;
  const refs = async (job) => (await payments(job)).map((p) => p.reference_number);
  const totalPaid = async (job) => (await superuser.query('SELECT total_paid::text AS t FROM public.cash_jobs WHERE id = $1', [job])).rows[0].t;
  const deposit = async (check, status) => (await api.query(
    'INSERT INTO public.checkalt_deposits (check_intake_item_id, tenant_id, status) VALUES ($1, $2, $3) RETURNING id', [check, T_A, status])).rows[0].id;
  const setDeposit = (id, status) => api.query('UPDATE public.checkalt_deposits SET status = $2 WHERE id = $1', [id, status]);
  const refused = async (promise, code, re) => {
    await assert.rejects(promise, (error) => {
      assert.equal(error.code, code, error.message);
      if (re) assert.match(error.message, re);
      return true;
    });
  };
  try {
    await superuser.connect();
    await superuser.query(SCHEMA());
    await owner.connect();
    await api.connect();

    // Before SQL 121: privileges are checked before RLS, so a job insert is refused outright, and a
    // cash-job check cannot become deposited (the invoker trigger cannot write cash_job_payments).
    await refused(api.query(`INSERT INTO public.cash_jobs (tenant_id, title) VALUES ('${T_A}', 'x')`), '42501', /permission denied for table cash_jobs/);
    await refused(api.query(`UPDATE public.check_intake_items SET status = 'deposited' WHERE id = '${C_DEP}'`), '42501', /permission denied for table cash_job_payments/);
    const reviewed = (await superuser.query("SELECT prosrc FROM pg_catalog.pg_proc WHERE oid = 'public.sync_cash_job_check_payment()'::regprocedure")).rows[0].prosrc;
    // The reviewed body the spec pins is the one the Supabase migration defines, as PostgreSQL stores it.
    assert.equal(sha(reviewed), RELEASE_SQL_SPECS.sql121.acl_functions[0].attributes.prosrc_sha256);
    assert.equal(sha(reviewed), sha(releaseFunctionDefinitions(fs.readFileSync(SUPABASE_CHECK_PAYMENT, 'utf8')).sync_cash_job_check_payment.prosrc));

    await owner.query(fs.readFileSync(SQL_121, 'utf8'));
    await owner.query(fs.readFileSync(SQL_121, 'utf8')); // idempotent

    // 1) Grants: SELECT, INSERT, UPDATE, DELETE on the three tables for checksops and authenticated, nothing else.
    const privs = (await superuser.query(`
      SELECT t.table_name, r.role, p.priv, has_table_privilege(r.role, 'public.' || t.table_name, p.priv) AS ok
        FROM (VALUES ('cash_jobs'), ('cash_job_line_items'), ('cash_job_attachments'), ('cash_job_payments')) t(table_name)
       CROSS JOIN (VALUES ('checksops'), ('authenticated')) r(role)
       CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)`)).rows;
    for (const row of privs) {
      const want = row.table_name === 'cash_job_payments'
        ? row.priv === 'SELECT' && row.role === 'checksops'
        : ['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(row.priv);
      assert.equal(row.ok, want, `${row.role} ${row.priv} ${row.table_name}`);
    }
    const publicAcl = (await superuser.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
      WHERE c.relname IN ('cash_jobs', 'cash_job_line_items', 'cash_job_attachments', 'cash_job_payments') AND a.grantee = 0`)).rows[0].n;
    assert.equal(publicAcl, 0);
    // RLS stays the boundary: the API writes jobs, line items and attachments of its tenant only.
    await api.query(`INSERT INTO public.cash_jobs (tenant_id, title) VALUES ('${T_A}', 'Gutters')`);
    await api.query(`INSERT INTO public.cash_job_line_items (tenant_id, cash_job_id, description) VALUES ('${T_A}', '${JOB}', 'shingles')`);
    await api.query(`INSERT INTO public.cash_job_attachments (tenant_id, cash_job_id, file_path) VALUES ('${T_A}', '${JOB}', 'a.pdf')`);
    await api.query(`UPDATE public.cash_jobs SET title = 'Roof (full)' WHERE id = '${JOB}'`);
    await api.query(`DELETE FROM public.cash_job_line_items WHERE description = 'shingles'`);
    await refused(api.query(`INSERT INTO public.cash_jobs (tenant_id, title) VALUES ('${T_B}', 'other tenant')`), '42501', /row-level security/);
    await refused(api.query(`INSERT INTO public.cash_job_payments (tenant_id, cash_job_id, amount) VALUES ('${T_A}', '${JOB}', 1)`), '42501', /permission denied for table cash_job_payments/);

    // 2) sync_cash_job_check_payment(): owner's definer, search_path pinned, EXECUTE for the owner only, body unchanged.
    const fn = async (identity) => (await superuser.query(`
      SELECT p.prosecdef, p.proconfig, pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.prosrc,
             has_function_privilege('checksops', p.oid, 'EXECUTE') AS checksops_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
             (SELECT count(*)::int FROM pg_catalog.aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_entries,
             (SELECT array_agg(pg_catalog.pg_get_userbyid(a.grantee)::text) FROM pg_catalog.aclexplode(p.proacl) a) AS grantees
        FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`, [identity])).rows[0];
    for (const identity of ['public.sync_cash_job_check_payment()', 'public.aws_record_cash_job_checkalt_payment()']) {
      const row = await fn(identity);
      assert.equal(row.prosecdef, true, identity);
      assert.equal(row.owner, 'checksops_admin', identity);
      assert.equal(row.checksops_exec, false, identity);
      assert.equal(row.authenticated_exec, false, identity);
      assert.equal(row.public_entries, 0, identity);
      assert.deepEqual(row.grantees, ['checksops_admin'], identity);
    }
    const sync = await fn('public.sync_cash_job_check_payment()');
    assert.deepEqual(sync.proconfig, ['search_path=public, pg_temp']);
    assert.equal(sync.prosrc, reviewed);
    assert.deepEqual((await fn('public.aws_record_cash_job_checkalt_payment()')).proconfig, ['search_path=public, pg_temp', 'row_security=off']);
    // A trigger function cannot be called directly.
    await refused(api.query('SELECT public.aws_record_cash_job_checkalt_payment()'), '42501');

    // The deposit path now works through the API login: one payment, as the owner, once.
    await api.query(`UPDATE public.check_intake_items SET status = 'deposited' WHERE id = '${C_DEP}'`);
    assert.deepEqual(await payments(JOB), [{
      reference_number: C_DEP, amount: '1000', payment_method: 'check', notes: 'Initial deposit check via ChecksOps', created_by: USER, today: true,
    }]);
    await api.query(`UPDATE public.check_intake_items SET status = 'needs_review' WHERE id = '${C_DEP}'`);
    await api.query(`UPDATE public.check_intake_items SET status = 'deposited' WHERE id = '${C_DEP}'`);
    assert.deepEqual(await refs(JOB), [C_DEP]);
    assert.equal(await totalPaid(JOB), '1000');

    // 3) Check Alt: pending records nothing; submitted records the payment once; cleared and a later
    // 'deposited' add nothing; a duplicate once the check is deposited keeps it.
    const alt = await deposit(C_ALT, 'pending');
    assert.deepEqual(await refs(JOB), [C_DEP]);
    await setDeposit(alt, 'submitted');
    const altRows = (await payments(JOB)).filter((p) => p.reference_number === C_ALT);
    assert.deepEqual(altRows, [{
      reference_number: C_ALT, amount: '2500', payment_method: 'check', notes: 'Progress payment check via ChecksOps', created_by: USER, today: true,
    }]);
    await setDeposit(alt, 'cleared');
    await setDeposit(alt, 'CLEARED');
    await api.query(`UPDATE public.check_intake_items SET status = 'deposited' WHERE id = '${C_ALT}'`);
    assert.deepEqual(await refs(JOB), [C_DEP, C_ALT]);
    assert.equal(await totalPaid(JOB), '3500');
    await setDeposit(alt, 'duplicate');
    assert.deepEqual(await refs(JOB), [C_DEP, C_ALT], 'a deposited check keeps its payment');

    // Inserted already cleared: recorded; then rejected: only that automatic payment is removed; the
    // hand-entered payments of the same job stay; the job's total follows.
    const rej = await deposit(C_REJ, 'cleared');
    assert.deepEqual(await refs(JOB_2), ['manual-1', C_INS, C_REJ]);
    assert.equal(await totalPaid(JOB_2), '1110');
    assert.equal((await payments(JOB_2)).find((p) => p.reference_number === C_REJ).notes, 'Final payment check via ChecksOps');
    await setDeposit(rej, 'rejected');
    assert.deepEqual(await refs(JOB_2), ['manual-1', C_INS]);
    assert.equal(await totalPaid(JOB_2), '410');
    // Approved again by a new deposit: recorded again, once.
    const rej2 = await deposit(C_REJ, 'submitted');
    await setDeposit(rej2, 'cleared');
    assert.deepEqual(await refs(JOB_2), ['manual-1', C_INS, C_REJ]);

    // Two deposits of one check: a rejection while the other is approved keeps the payment; an error
    // on the last approved one removes it. No uploader: created_by stays empty; class other / none.
    const two1 = await deposit(C_TWO, 'submitted');
    const two2 = await deposit(C_TWO, 'submitted');
    assert.equal((await payments(JOB_2)).filter((p) => p.reference_number === C_TWO).length, 1);
    const twoRow = (await payments(JOB_2)).find((p) => p.reference_number === C_TWO);
    assert.deepEqual([twoRow.created_by, twoRow.notes], [null, 'Check deposit via ChecksOps']);
    await setDeposit(two1, 'rejected');
    assert.ok((await refs(JOB_2)).includes(C_TWO));
    await setDeposit(two2, 'error');
    assert.ok(!(await refs(JOB_2)).includes(C_TWO));

    // Rejected or errored before approval: nothing recorded, nothing removed.
    const pend = await deposit(C_PEND, 'pending');
    await setDeposit(pend, 'pending_approval');
    await setDeposit(pend, 'rejected');
    await deposit(C_PEND, 'error');
    assert.deepEqual(await refs(JOB_2), ['manual-1', C_INS, C_REJ]);

    // Not a cash-job check (or no job): never recorded, never removed, even with a matching reference.
    const ins = await deposit(C_INS, 'submitted');
    await setDeposit(ins, 'cleared');
    await setDeposit(ins, 'rejected');
    const noJob = await deposit(C_NOJOB, 'cleared');
    await setDeposit(noJob, 'rejected');
    assert.deepEqual(await refs(JOB_2), ['manual-1', C_INS, C_REJ]);
    assert.equal((await superuser.query('SELECT count(*)::int AS n FROM public.cash_job_payments')).rows[0].n, 5);

    // The trigger as the file leaves it (rendered as the engine reads it, search_path pg_catalog);
    // re-running the file changes nothing.
    await superuser.query("SELECT pg_catalog.set_config('search_path', 'pg_catalog', false)");
    const trig =(await superuser.query(`SELECT pg_catalog.pg_get_triggerdef(t.oid) AS def, t.tgenabled FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'public.checkalt_deposits'::regclass AND NOT t.tgisinternal`)).rows;
    assert.deepEqual(trig, [{ def: RELEASE_SQL_SPECS.sql121.triggers[0].def, tgenabled: 'O' }]);
    await owner.query(fs.readFileSync(SQL_121, 'utf8'));
    assert.equal((await superuser.query('SELECT count(*)::int AS n FROM public.cash_job_payments')).rows[0].n, 5);
  } finally {
    await api.end().catch(() => {});
    await owner.end().catch(() => {});
    await superuser.end().catch(() => {});
    server.stop();
  }
});
