
ALTER TABLE public.email_send_log
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_email_send_log_tenant_created
  ON public.email_send_log (tenant_id, created_at DESC) WHERE tenant_id IS NOT NULL;
