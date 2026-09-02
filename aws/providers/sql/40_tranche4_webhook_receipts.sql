-- Tranche 4: staging-only webhook receipt table + provider-id lookup.
-- Does not GRANT DML on payment_transfers, wallets, checkalt_deposits, or other financial tables.
-- Does not change default_transaction_read_only.
-- RLS remains the authorization boundary for tenant data.

CREATE TABLE IF NOT EXISTS public.aws_provider_webhook_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  external_event_id text NOT NULL,
  event_type text,
  payload_sha256 text,
  mapped_tenant_id uuid,
  mapped_internal_id uuid,
  dry_run boolean NOT NULL DEFAULT true,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_event_id)
);

COMMENT ON TABLE public.aws_provider_webhook_receipts IS
  'AWS staging webhook receipts. Dry-run by default. Not a financial ledger.';

ALTER TABLE public.aws_provider_webhook_receipts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.aws_provider_webhook_receipts FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE public.aws_provider_webhook_receipts TO checksops;

DROP POLICY IF EXISTS aws_provider_webhook_receipts_insert ON public.aws_provider_webhook_receipts;
CREATE POLICY aws_provider_webhook_receipts_insert
  ON public.aws_provider_webhook_receipts
  FOR INSERT
  TO checksops
  WITH CHECK (current_setting('request.provider_webhook', true) = '1');

DROP POLICY IF EXISTS aws_provider_webhook_receipts_select ON public.aws_provider_webhook_receipts;
CREATE POLICY aws_provider_webhook_receipts_select
  ON public.aws_provider_webhook_receipts
  FOR SELECT
  TO checksops
  USING (current_setting('request.provider_webhook', true) = '1');

CREATE OR REPLACE FUNCTION public.aws_lookup_provider_account(
  p_provider text,
  p_provider_account_id text
) RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  provider text,
  provider_account_id text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id, a.tenant_id, a.provider, a.provider_account_id
  FROM public.payment_provider_accounts a
  WHERE a.provider = p_provider
    AND a.provider_account_id = p_provider_account_id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.aws_lookup_provider_account(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_lookup_provider_account(text, text) TO checksops;

CREATE OR REPLACE FUNCTION public.aws_lookup_checkalt_deposit(
  p_reference text
) RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  checkalt_reference text,
  status text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT d.id, d.tenant_id, d.checkalt_reference, d.status
  FROM public.checkalt_deposits d
  WHERE d.checkalt_reference = p_reference
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.aws_lookup_checkalt_deposit(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_lookup_checkalt_deposit(text) TO checksops;
