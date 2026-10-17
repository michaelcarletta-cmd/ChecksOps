-- SQL 97: financial_stepup_log rows that authorize money actions are written by the server only.
--
-- A step-up row with metadata.source = 'app_financial_totp' authorizes Check
-- Alt deposits, wallet funding and teammate 2FA resets for the rest of a
-- login (checkalt-authz loadSessionCheckAltStepUp, moov-fund-authz,
-- admin-reset-totp). The API removed financial_stepup_log from the /data/write
-- allowlist; this file closes the database side:
--
-- 1) INSERT is revoked from PUBLIC and authenticated (the Supabase-era client
--    grant) and granted to checksops directly, so the server's existing insert
--    path keeps working: auth-financial-totp insertAppStepUpLog and
--    admin-reset-totp consumeResetStepUp run as checksops, a member of
--    authenticated, and would otherwise lose INSERT with it.
-- 2) A BEFORE INSERT trigger (aws_financial_stepup_log_writer_guard) refuses a
--    row whose metadata.source is 'app_financial_totp' unless the inserting
--    transaction set app.stepup_writer = '1' (set_config(..., true)), which only
--    the server sets, right after it verified the code. A client-shaped insert
--    through any other path (a generic data write, a DEFINER function, a role
--    that kept INSERT) is refused with 42501 stepup_writer_required.
--
-- Deploy order: the Lambdas that set app.stepup_writer (auth-financial-totp.mjs,
-- admin-reset-totp.mjs) BEFORE this file; setting the GUC earlier is harmless.
--
-- Refuses to run (55000 sql97_prerequisite_missing) without the table and the
-- checksops / authenticated roles. Idempotent. No BEGIN/COMMIT. No data changes.
-- Not applied by this change.

DO $sql97_prereq$
BEGIN
  IF to_regclass('public.financial_stepup_log') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'checksops')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated')
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'financial_stepup_log' AND column_name = 'metadata')
  THEN
    RAISE EXCEPTION 'sql97_prerequisite_missing' USING ERRCODE = '55000';
  END IF;
END
$sql97_prereq$;

REVOKE INSERT ON TABLE public.financial_stepup_log FROM PUBLIC;
REVOKE INSERT ON TABLE public.financial_stepup_log FROM authenticated;
GRANT INSERT ON TABLE public.financial_stepup_log TO checksops;

CREATE OR REPLACE FUNCTION public.aws_financial_stepup_log_writer_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF COALESCE(NEW.metadata->>'source', '') = 'app_financial_totp'
     AND COALESCE(current_setting('app.stepup_writer', true), '') <> '1' THEN
    RAISE EXCEPTION 'stepup_writer_required: app_financial_totp step-ups are recorded by the server only'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.aws_financial_stepup_log_writer_guard() FROM PUBLIC;
COMMENT ON FUNCTION public.aws_financial_stepup_log_writer_guard() IS
  'SQL 97: an app_financial_totp step-up row needs the server''s transaction-local app.stepup_writer = 1 (auth-financial-totp, admin-reset-totp).';

DROP TRIGGER IF EXISTS aws_financial_stepup_log_writer_guard ON public.financial_stepup_log;
CREATE TRIGGER aws_financial_stepup_log_writer_guard
  BEFORE INSERT ON public.financial_stepup_log
  FOR EACH ROW
  EXECUTE FUNCTION public.aws_financial_stepup_log_writer_guard();
