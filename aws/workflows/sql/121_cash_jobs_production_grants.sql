-- SQL 121: Cash Jobs on AWS - table grants and a deposit-time payment record that
-- does not need the application role to write cash_job_payments.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why (owner, 2026-10-27): "Make sure cash jobs works the same as claim checks ... When a
-- Job is created, it will show up under All Jobs where a tenant can open the file, upload
-- checks from clients which will move to review to proceed with the normal process but
-- will automatically be linked to that particular cash job."
--
--   - A job and its line items are written through /data/write (write-app-metadata.mjs
--     executeCashJobs / executeCashJobLineItems) as checksops. The restored database gave
--     checksops SELECT only (aws/db-copy/sql/02_grant_readonly_application_role.sql); the
--     table DML grants exist in staging through
--     aws/workflows/sql/67_staging_cashjobs_homeowner_grants.sql, which is staging-only.
--     PostgreSQL checks table privileges before row-level security, so without a grant the
--     INSERT is refused before aws_write_cash_jobs is evaluated.
--   - A check uploaded from a job is created by POST /workflow/checks with cash_job_id,
--     check_source 'cash_job' and cash_job_payment_class set server-side. When that check
--     becomes 'deposited', trg_sync_cash_job_check_payment (AFTER UPDATE OF status ON
--     check_intake_items; supabase/migrations/20260522142101_*.sql) inserts the job's
--     payment row into public.cash_job_payments. The function is SECURITY INVOKER, so on AWS
--     it runs as checksops, which holds no INSERT on cash_job_payments (a financial table:
--     no browser or generic-route write, and this file grants none). The deposit UPDATE of
--     a cash-job check would then fail as a whole.
--
-- 1) GRANT SELECT, INSERT, UPDATE, DELETE ON public.cash_jobs, public.cash_job_line_items
--    and public.cash_job_attachments TO checksops and authenticated (the same three tables
--    and privileges SQL 67 grants in staging). Does not grant TRUNCATE, REFERENCES or
--    TRIGGER, nor anything to PUBLIC or anon. aws_write_cash_jobs,
--    aws_write_cash_job_line_items and aws_write_cash_job_attachments
--    (aws/rls/sql/24_complete_write_policies.sql: aws_can_write_tenant(tenant_id)) remain
--    the authorization boundary.
-- 2) public.sync_cash_job_check_payment(): SECURITY DEFINER with search_path pinned to
--    public, pg_temp, so the payment row is written by the function's owner, only from the
--    trigger, only for a check_source 'cash_job' check with a cash_job_id that becomes
--    'deposited', once per check (the body is unchanged: it already skips an existing
--    payment for the same check). Every privilege of PUBLIC, checksops and authenticated on
--    the function is removed; a trigger function needs no EXECUTE grant to fire, and the
--    function cannot be called directly (it returns trigger). Requires that the login
--    running this file owns the function (42501 sql121_not_function_owner otherwise); a
--    NOTICE and no change when the function is absent.
--
-- Not changed: no grant on public.cash_job_payments; the function body, its trigger,
-- public.sync_cash_job_total_paid() and public.sync_cash_job_status(); no column, policy,
-- RLS setting or row.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the
-- guarded SQL executor runs it inside one transaction.
-- Idempotent: GRANT is a no-op when held; ALTER FUNCTION and REVOKE leave the same state on
-- every run.
--
-- NOT APPLIED. Needs a read-only production inspect first (do the tables, the
-- check_intake_items cash-job columns, the function and its trigger exist in production;
-- who owns the function; what checksops holds today), then staging and production through
-- the guarded SQL path (AGENTS.md). Registration in the release engine (spec, pins, tests)
-- is a separate change.

DO $sql121_grants$
DECLARE
  v_table text;
  v_grantee text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['cash_jobs', 'cash_job_line_items', 'cash_job_attachments'] LOOP
    IF pg_catalog.to_regclass(format('public.%I', v_table)) IS NULL THEN
      RAISE NOTICE 'SQL 121: public.% absent; skipped its grants', v_table;
      CONTINUE;
    END IF;
    FOREACH v_grantee IN ARRAY ARRAY['checksops', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_grantee) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO %I', v_table, v_grantee);
      ELSE
        RAISE NOTICE 'SQL 121: role % absent; skipped its grant on public.%', v_grantee, v_table;
      END IF;
    END LOOP;
  END LOOP;
END
$sql121_grants$;

DO $sql121_payment_trigger$
DECLARE
  v_fn oid := pg_catalog.to_regprocedure('public.sync_cash_job_check_payment()');
  v_grantee text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE NOTICE 'SQL 121: public.sync_cash_job_check_payment() absent; skipped';
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = v_fn
       AND p.proowner = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
  ) THEN
    RAISE EXCEPTION 'sql121_not_function_owner: public.sync_cash_job_check_payment() is not owned by the login running SQL 121'
      USING ERRCODE = '42501';
  END IF;
  ALTER FUNCTION public.sync_cash_job_check_payment() SECURITY DEFINER;
  ALTER FUNCTION public.sync_cash_job_check_payment() SET search_path = public, pg_temp;
  REVOKE ALL ON FUNCTION public.sync_cash_job_check_payment() FROM PUBLIC;
  FOREACH v_grantee IN ARRAY ARRAY['checksops', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_grantee) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.sync_cash_job_check_payment() FROM %I', v_grantee);
    END IF;
  END LOOP;
END
$sql121_payment_trigger$;
