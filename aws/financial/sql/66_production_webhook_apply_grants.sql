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

-- Production webhook apply and money-path dispatch write these tables as
-- checksops. Grants are role-scoped, not PUBLIC. Browser roles stay denied.
GRANT INSERT, UPDATE ON TABLE public.payment_transfers TO checksops;
GRANT UPDATE ON TABLE public.payment_provider_accounts TO checksops;
GRANT UPDATE ON TABLE public.payment_provider_methods TO checksops;
GRANT UPDATE ON TABLE public.external_payment_recipients TO checksops;
GRANT UPDATE ON TABLE public.stakeholder_accounts TO checksops;
GRANT UPDATE ON TABLE public.payment_transfer_groups TO checksops;
GRANT INSERT, UPDATE ON TABLE public.wallet_funding_requests TO checksops;
GRANT UPDATE ON TABLE public.disbursement_batches TO checksops;
GRANT UPDATE ON TABLE public.disbursement_splits TO checksops;
GRANT INSERT, UPDATE ON TABLE public.payment_wallets TO checksops;
GRANT INSERT ON TABLE public.payment_wallet_ledger TO checksops;

COMMENT ON TABLE public.payment_webhook_events IS
  'Moov/CheckAlt webhook idempotency. AWS production apply inserts here before mutating payment_* rows. UNIQUE (provider, external_event_id).';
