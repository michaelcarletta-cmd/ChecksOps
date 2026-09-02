-- Rollback Tranche 2 DML grants. SELECT remains so AWS reads are unaffected.
-- Does not revoke Tranche 1 grants on check_message_reads / notification_preferences.

REVOKE UPDATE ON TABLE public.check_intake_items FROM checksops, authenticated;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.check_payees FROM checksops, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.check_endorsements FROM checksops, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.check_endorsement_events FROM checksops, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.check_audit_log FROM checksops, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.check_messages FROM checksops, authenticated;
