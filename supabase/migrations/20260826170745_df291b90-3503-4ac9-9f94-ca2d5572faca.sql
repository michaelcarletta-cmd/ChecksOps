ALTER TABLE public.payment_provider_methods
  ADD COLUMN IF NOT EXISTS is_platform boolean NOT NULL DEFAULT false;

ALTER TABLE public.payment_provider_methods
  DROP CONSTRAINT payment_provider_methods_owner_chk;

ALTER TABLE public.payment_provider_methods
  ADD CONSTRAINT payment_provider_methods_owner_chk
  CHECK (tenant_id IS NOT NULL OR external_recipient_id IS NOT NULL OR is_platform);