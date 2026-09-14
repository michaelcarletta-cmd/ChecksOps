-- Production Moov webhook apply grants for the AWS API role (checksops).
-- Does NOT activate SQL 64 financial functions.
-- Does NOT change the existing Lovable/Supabase Moov webhook destination.
-- Does NOT GRANT table-wide DML to PUBLIC / anon / authenticated.
--
-- Apply only to production RDS when the AWS production webhook receiver is
-- enabled. The Lambda still fail-closes unless:
--   current_setting('request.provider_webhook_apply') = '1'
--   AND current_setting('request.aws_financial_permissions_activated') = '1'
--   AND AWS_PROVIDER_WEBHOOK_DRY_RUN=false
--
-- Unique (provider, external_event_id) remains the apply idempotency key.

GRANT INSERT, UPDATE ON TABLE public.payment_webhook_events TO checksops;
GRANT INSERT ON TABLE public.payment_event_log TO checksops;

COMMENT ON TABLE public.payment_webhook_events IS
  'Moov/CheckAlt webhook idempotency. AWS production apply inserts here before mutating payment_* rows. UNIQUE (provider, external_event_id).';
