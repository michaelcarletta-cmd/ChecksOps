-- SQL 67: GUC-gated RLS write/select for payment_webhook_events.
-- Completes SQL 66, which GRANTed INSERT/UPDATE to checksops but left
-- RLS default-deny (no write policy). A swallowed 42501 aborted the
-- webhook transaction; COMMIT then rolled back the receipt and still
-- returned HTTP 200.
--
-- Does NOT activate SQL 64 financial functions.
-- Does NOT GRANT to PUBLIC / anon / authenticated.
-- Does NOT change HMAC, the webhook secret, or the Lovable destination.
-- Unique (provider, external_event_id) remains the apply idempotency key.

DROP POLICY IF EXISTS aws_provider_webhook_events_select ON public.payment_webhook_events;
CREATE POLICY aws_provider_webhook_events_select
  ON public.payment_webhook_events
  FOR SELECT
  TO checksops
  USING (
    current_setting('request.provider_webhook', true) = '1'
    OR current_setting('request.provider_webhook_apply', true) = '1'
  );

DROP POLICY IF EXISTS aws_provider_webhook_events_insert ON public.payment_webhook_events;
CREATE POLICY aws_provider_webhook_events_insert
  ON public.payment_webhook_events
  FOR INSERT
  TO checksops
  WITH CHECK (
    current_setting('request.provider_webhook_apply', true) = '1'
    AND current_setting('request.aws_financial_permissions_activated', true) = '1'
    AND provider = 'moov'
    AND environment = 'production'
  );

DROP POLICY IF EXISTS aws_provider_webhook_events_update ON public.payment_webhook_events;
CREATE POLICY aws_provider_webhook_events_update
  ON public.payment_webhook_events
  FOR UPDATE
  TO checksops
  USING (
    current_setting('request.provider_webhook_apply', true) = '1'
    AND current_setting('request.aws_financial_permissions_activated', true) = '1'
  )
  WITH CHECK (
    current_setting('request.provider_webhook_apply', true) = '1'
    AND current_setting('request.aws_financial_permissions_activated', true) = '1'
    AND provider = 'moov'
    AND environment = 'production'
  );

COMMENT ON POLICY aws_provider_webhook_events_insert ON public.payment_webhook_events IS
  'AWS production webhook apply only. checksops + apply GUCs. Not a browser write path.';
