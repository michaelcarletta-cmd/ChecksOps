ALTER TABLE public.tenant_email_settings
  ADD COLUMN IF NOT EXISTS resend_domain_id text;