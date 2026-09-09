-- Legacy Lovable/Supabase only. Safe no-op on AWS RDS (no pg_cron / no job).
-- Disables the 10-minute checkalt-poll-status cron. Does not touch other jobs.
-- Do not apply this to production AWS RDS as a financial change; it only
-- unschedules a named cron job when that catalog exists.

DO $$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'checkalt-poll-status') THEN
    PERFORM cron.unschedule('checkalt-poll-status');
  END IF;
EXCEPTION
  WHEN undefined_function THEN
    NULL;
  WHEN undefined_table THEN
    NULL;
END $$;
