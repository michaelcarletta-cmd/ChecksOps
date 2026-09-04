-- Rollback for 68_staging_class_a_grants.sql
DROP FUNCTION IF EXISTS public.aws_public_homeowner_ledger_by_token(text);
DROP FUNCTION IF EXISTS public.aws_public_homeowner_claim_by_token(text);
REVOKE INSERT, UPDATE ON TABLE public.email_send_log FROM checksops;
REVOKE INSERT, UPDATE ON TABLE public.suppressed_emails FROM checksops;
REVOKE INSERT, UPDATE ON TABLE public.email_unsubscribe_tokens FROM checksops;
REVOKE INSERT, UPDATE ON TABLE public.homeowner_ledger_tokens FROM checksops;
REVOKE INSERT, UPDATE ON TABLE public.homeowner_check_uploads FROM checksops;
REVOKE INSERT, UPDATE ON TABLE public.homeowner_ledger_check_uploads FROM checksops;
