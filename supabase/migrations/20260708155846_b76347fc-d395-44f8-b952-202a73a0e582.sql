
ALTER TABLE public.suppressed_emails
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE public.suppressed_emails
  DROP CONSTRAINT IF EXISTS suppressed_emails_email_key;

CREATE UNIQUE INDEX IF NOT EXISTS suppressed_emails_email_tenant_uniq
  ON public.suppressed_emails (email, COALESCE(tenant_id::text, 'GLOBAL'));

CREATE INDEX IF NOT EXISTS idx_suppressed_emails_tenant
  ON public.suppressed_emails (tenant_id) WHERE tenant_id IS NOT NULL;
