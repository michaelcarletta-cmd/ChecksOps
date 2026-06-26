-- CheckAlt: manual-review approval tracking columns + cron-scheduled status polling.

ALTER TABLE public.checkalt_deposits
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS reject_code integer,
  ADD COLUMN IF NOT EXISTS reject_notes text;

-- Cron fallback: invoke checkalt-poll-status every 10 minutes so deposit
-- statuses keep reconciling even if the webhook never fires (CheckAlt's own
-- docs describe a pull/poll-based model, not a confirmed push/webhook one).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'checkalt-poll-status') THEN
    PERFORM cron.unschedule('checkalt-poll-status');
  END IF;
END $$;

SELECT cron.schedule(
  'checkalt-poll-status',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1) || '/functions/v1/checkalt-poll-status',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_service_role_key' LIMIT 1)
    ),
    body := '{}'::jsonb
  );
  $$
);
