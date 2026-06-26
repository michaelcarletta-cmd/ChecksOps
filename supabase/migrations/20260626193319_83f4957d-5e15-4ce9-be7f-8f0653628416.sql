ALTER TABLE public.checkalt_webhook_events
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS action text,
  ADD COLUMN IF NOT EXISTS severity text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkalt_webhook_events_idem
  ON public.checkalt_webhook_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;