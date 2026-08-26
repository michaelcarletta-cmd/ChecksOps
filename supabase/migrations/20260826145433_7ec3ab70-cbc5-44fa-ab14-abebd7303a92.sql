-- Stage 12: backend-only tables should not be reachable from the Data API
REVOKE ALL ON public.payment_idempotency_keys FROM anon, authenticated;
REVOKE ALL ON public.plaid_webhook_cursors FROM anon, authenticated;
GRANT ALL ON public.payment_idempotency_keys TO service_role;
GRANT ALL ON public.plaid_webhook_cursors TO service_role;