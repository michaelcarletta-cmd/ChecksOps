-- AWS staging: narrow GRANTs for CashJobs + homeowner timeline note inserts.
-- Does NOT grant payment tables (cash_job_payments) or amount-bearing financial DML.
-- Does NOT apply 64_financial_activation_grants.sql.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cash_jobs TO checksops;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cash_job_line_items TO checksops;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cash_job_attachments TO checksops;
-- Timeline notes only via API allowlist (amount column denied in write path).
GRANT SELECT, INSERT ON TABLE public.homeowner_ledger_events TO checksops;
