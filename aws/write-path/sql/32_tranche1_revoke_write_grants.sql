-- Rollback Tranche 1 DML grants. SELECT remains so AWS reads are unaffected.

REVOKE INSERT, UPDATE, DELETE ON TABLE public.check_message_reads FROM checksops, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.notification_preferences FROM checksops, authenticated;
