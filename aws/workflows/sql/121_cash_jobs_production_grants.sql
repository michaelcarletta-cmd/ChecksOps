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
-- 3) public.aws_record_cash_job_checkalt_payment() (new trigger function, SECURITY DEFINER,
--    search_path public, pg_temp, row_security off) and trigger
--    aws_checkalt_deposit_cash_job_payment, AFTER INSERT OR UPDATE OF status ON
--    public.checkalt_deposits. Owner, 2026-10-27: "yes, record cash-job payments on Check Alt
--    approval". A check deposited through Check Alt never becomes 'deposited' (its
--    checkalt_deposits row goes submitted, then cleared; SQL 120's header), so the trigger in
--    2) never fires for it and the job would show nothing collected.
--      a. When a deposit becomes submitted or cleared (approved or accepted) from any other
--         status, and its check is check_source 'cash_job' with a cash_job_id: inserts the
--         job's payment row exactly as sync_cash_job_check_payment() does (amount = the
--         check's amount, payment_method 'check', reference_number = the check id, the same
--         notes by payment class), unless a payment for that check already exists. Once per
--         check, whichever path records it first; the 'deposited' path then skips it.
--      b. When the deposit is then rejected, errors or is a duplicate, no other deposit of
--         the check is submitted or cleared, and the check is not 'deposited': deletes that
--         automatic payment (reference_number = the check id, payment_method 'check'), so a
--         check that did not go through is not counted as collected. A payment entered by
--         hand (another reference) is never touched.
--    EXECUTE on the function is revoked from PUBLIC, checksops and authenticated.
--    Adds one public trigger: the DB validator's justified set and expected count must follow
--    once this file is applied (as #1309 did for SQL 120), not before.
--
-- Not changed: no grant on public.cash_job_payments; sync_cash_job_check_payment()'s body and trigger,
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

-- 3) Cash-job payment on Check Alt approval ---------------------------------------
CREATE OR REPLACE FUNCTION public.aws_record_cash_job_checkalt_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET row_security = off
AS $$
DECLARE
  v_new text := lower(COALESCE(NEW.status, ''));
  v_old text := CASE WHEN TG_OP = 'UPDATE' THEN lower(COALESCE(OLD.status, '')) ELSE '' END;
  v_check record;
BEGIN
  IF NEW.check_intake_item_id IS NULL OR v_new = v_old THEN
    RETURN NULL;
  END IF;

  SELECT c.id, c.tenant_id, c.cash_job_id, c.check_source, c.cash_job_payment_class,
         c.amount, c.uploaded_by, c.status
    INTO v_check
    FROM public.check_intake_items c
   WHERE c.id = NEW.check_intake_item_id;
  IF v_check.id IS NULL OR v_check.check_source IS DISTINCT FROM 'cash_job' OR v_check.cash_job_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_new IN ('submitted', 'cleared') AND v_old NOT IN ('submitted', 'cleared') THEN
    IF EXISTS (
      SELECT 1 FROM public.cash_job_payments p
       WHERE p.cash_job_id = v_check.cash_job_id
         AND p.reference_number = v_check.id::text) THEN
      RETURN NULL;
    END IF;
    INSERT INTO public.cash_job_payments (
      tenant_id, cash_job_id, created_by,
      amount, payment_method, payment_date,
      reference_number, notes
    ) VALUES (
      v_check.tenant_id, v_check.cash_job_id, v_check.uploaded_by,
      COALESCE(v_check.amount, 0), 'check', CURRENT_DATE,
      v_check.id::text,
      CASE v_check.cash_job_payment_class
        WHEN 'initial_deposit' THEN 'Initial deposit check via ChecksOps'
        WHEN 'final_payment' THEN 'Final payment check via ChecksOps'
        WHEN 'progress_payment' THEN 'Progress payment check via ChecksOps'
        ELSE 'Check deposit via ChecksOps'
      END
    );
    RETURN NULL;
  END IF;

  IF v_new IN ('rejected', 'error', 'duplicate') AND v_old IN ('submitted', 'cleared')
     AND v_check.status IS DISTINCT FROM 'deposited'
     AND NOT EXISTS (
       SELECT 1 FROM public.checkalt_deposits d
        WHERE d.check_intake_item_id = NEW.check_intake_item_id
          AND d.id <> NEW.id
          AND lower(COALESCE(d.status, '')) IN ('submitted', 'cleared')) THEN
    DELETE FROM public.cash_job_payments p
     WHERE p.cash_job_id = v_check.cash_job_id
       AND p.reference_number = v_check.id::text
       AND p.payment_method = 'check';
  END IF;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION public.aws_record_cash_job_checkalt_payment() FROM PUBLIC;
DO $sql121_checkalt_revoke$
DECLARE
  v_grantee text;
BEGIN
  FOREACH v_grantee IN ARRAY ARRAY['checksops', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_grantee) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.aws_record_cash_job_checkalt_payment() FROM %I', v_grantee);
    END IF;
  END LOOP;
END
$sql121_checkalt_revoke$;
COMMENT ON FUNCTION public.aws_record_cash_job_checkalt_payment() IS
  'SQL 121: records a cash-job check''s payment when its Check Alt deposit is approved or accepted (once per check, shared with sync_cash_job_check_payment); removes that automatic payment when the deposit is then rejected and the check did not go through.';

DROP TRIGGER IF EXISTS aws_checkalt_deposit_cash_job_payment ON public.checkalt_deposits;
CREATE TRIGGER aws_checkalt_deposit_cash_job_payment
  AFTER INSERT OR UPDATE OF status ON public.checkalt_deposits
  FOR EACH ROW EXECUTE FUNCTION public.aws_record_cash_job_checkalt_payment();
