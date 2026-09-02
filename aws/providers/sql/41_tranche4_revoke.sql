-- Rollback for Tranche 4 webhook receipts. Does not touch financial tables.

DROP POLICY IF EXISTS aws_provider_webhook_receipts_insert ON public.aws_provider_webhook_receipts;
DROP POLICY IF EXISTS aws_provider_webhook_receipts_select ON public.aws_provider_webhook_receipts;
REVOKE ALL ON TABLE public.aws_provider_webhook_receipts FROM checksops;
DROP TABLE IF EXISTS public.aws_provider_webhook_receipts;

REVOKE ALL ON FUNCTION public.aws_lookup_provider_account(text, text) FROM checksops;
DROP FUNCTION IF EXISTS public.aws_lookup_provider_account(text, text);

REVOKE ALL ON FUNCTION public.aws_lookup_checkalt_deposit(text) FROM checksops;
DROP FUNCTION IF EXISTS public.aws_lookup_checkalt_deposit(text);
