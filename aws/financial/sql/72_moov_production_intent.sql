-- DO NOT APPLY THIS FILE.
-- Reserved for a later human-approved Moov production activation.
-- AWS_FINANCIAL_PERMISSIONS_ACTIVATED, AWS_PROVIDER_EXECUTION_ENABLED, and
-- AWS_MOOV_ENABLED must remain false until that review.
--
-- This migration does not create checksops/production/providers.
-- It does not load credentials. It does not enable provider HTTP.
-- It does not GRANT financial activation (see 64_financial_activation_grants.sql).
--
-- Narrow schema only: persist-before-HTTP attempt marker on payment_transfers.
-- Unique (tenant_id, idempotency_key) and (provider, environment, provider_transfer_id)
-- already exist.

ALTER TABLE public.payment_transfers
  ADD COLUMN IF NOT EXISTS provider_http_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_class text,
  ADD COLUMN IF NOT EXISTS last_error text;

COMMENT ON COLUMN public.payment_transfers.provider_http_attempted_at IS
  'Set immediately before POST /accounts/{facilitator}/transfers. Presence without provider_transfer_id means reconcile, do not POST again.';
COMMENT ON COLUMN public.payment_transfers.failure_class IS
  'provider_timeout / db_after_provider / provider_* . Never used as authority to retry POST.';

SELECT 'NOT_APPLIED'::text AS aws_moov_production_intent_columns;
