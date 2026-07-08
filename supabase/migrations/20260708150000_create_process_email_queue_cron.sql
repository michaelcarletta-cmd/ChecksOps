-- Actually create the process-email-queue cron job. The email
-- infrastructure migration (20260430101148_email_infra.sql) only
-- documented this step as something an external setup tool would apply
-- dynamically via the Supabase Management API — it was never actually
-- created as a tracked migration, so transactional emails have been
-- enqueued successfully but never dispatched: they sit in email_send_log
-- as "pending" indefinitely since nothing ever calls the dispatcher.
--
-- Reuses the same vault secrets (supabase_url, supabase_service_role_key)
-- already used by the working checkalt-poll-status cron job
-- (20260626120000_checkalt_approve_and_cron.sql), rather than the
-- never-created "email_queue_service_role_key" secret referenced in the
-- original comment.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-email-queue') THEN
    PERFORM cron.unschedule('process-email-queue');
  END IF;
END $$;

SELECT cron.schedule(
  'process-email-queue',
  '5 seconds',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1) || '/functions/v1/process-email-queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_service_role_key' LIMIT 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
