-- Tranche 1: narrow DML grants for allowlisted write tables only.
-- Does not change default_transaction_read_only.
-- Does not GRANT on financial, provider, or workflow tables.
-- RLS policies remain the authorization boundary.

REVOKE ALL ON TABLE public.check_message_reads FROM PUBLIC;
REVOKE ALL ON TABLE public.notification_preferences FROM PUBLIC;

GRANT SELECT ON TABLE public.check_message_reads TO checksops, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.check_message_reads TO checksops, authenticated;

GRANT SELECT ON TABLE public.notification_preferences TO checksops, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.notification_preferences TO checksops, authenticated;
