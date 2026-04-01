
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'outlook-auto-sync-every-5min'),
  schedule := '*/5 * * * *',
  command := $$
  SELECT net.http_post(
    url := 'https://yvagrvfkeuvzjezfsbun.supabase.co/functions/v1/outlook-email-sync',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2YWdydmZrZXV2emplemZzYnVuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4NzcyMjUsImV4cCI6MjA4NzQ1MzIyNX0.1Jgm-plSdEFFnPrtA492s0jH-GQcCN08WplZS_VrtEg", "apikey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2YWdydmZrZXV2emplemZzYnVuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4NzcyMjUsImV4cCI6MjA4NzQ1MzIyNX0.1Jgm-plSdEFFnPrtA492s0jH-GQcCN08WplZS_VrtEg"}'::jsonb,
    body := '{"action": "sync_all_claims"}'::jsonb
  ) AS request_id;
  $$
);
