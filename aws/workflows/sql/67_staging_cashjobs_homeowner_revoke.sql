-- Rollback for 67_staging_cashjobs_homeowner_grants.sql (staging only).
REVOKE INSERT, UPDATE, DELETE ON TABLE public.cash_jobs FROM checksops;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.cash_job_line_items FROM checksops;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.cash_job_attachments FROM checksops;
REVOKE INSERT ON TABLE public.homeowner_ledger_events FROM checksops;
-- Keep SELECT (already present for reads).
