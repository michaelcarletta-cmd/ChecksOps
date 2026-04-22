-- Reduce cron frequencies to cut backend compute costs
-- All functions also have in-code business-hours gates (6 AM – 10 PM ET)

-- check-scheduled-automations: 15 min → 30 min
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'check-scheduled-automations-every-minute'),
  schedule := '*/30 * * * *'
);

-- process-immediate-notifications: 10 min → 30 min
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'process-immediate-notifications-every-5min'),
  schedule := '*/30 * * * *'
);

-- scan-status-urgency: 2 hours → 4 hours
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'scan-status-urgency-hourly'),
  schedule := '0 */4 * * *'
);

-- auto-generate-claim-microtasks: 2 hours → 4 hours
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'auto-generate-claim-microtasks'),
  schedule := '0 */4 * * *'
);

-- endorsement-reminders: 6 hours → 8 hours
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'endorsement-reminders-every-6h'),
  schedule := '0 */8 * * *'
);