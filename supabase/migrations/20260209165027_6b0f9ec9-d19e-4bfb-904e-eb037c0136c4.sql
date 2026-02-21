
-- Update task reminders to 8:00 AM Eastern (13:00 UTC)
DO $$
DECLARE
  v_jobid integer;
BEGIN
  SELECT jobid INTO v_jobid
  FROM cron.job
  WHERE jobname = 'process-rd-check-tracking'
  LIMIT 1;

  IF v_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(
      v_jobid,
      schedule := '0 1,7,13,19 * * *'
    );
  END IF;
END $$;