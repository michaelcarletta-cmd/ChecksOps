CREATE TABLE IF NOT EXISTS public.payment_provider_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'moov',
  environment text NOT NULL DEFAULT 'sandbox',
  provider_account_id text NOT NULL,
  provider_file_id text NOT NULL,
  provider_representative_id text,
  file_purpose text NOT NULL,
  file_name text NOT NULL,
  mime_type text,
  file_size_bytes bigint,
  requirement_id text,
  review_status text NOT NULL DEFAULT 'pending',
  review_reason text,
  provider_status_code text,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  uploaded_by uuid,
  last_synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_provider_files_unique_file
  ON public.payment_provider_files (provider, environment, provider_account_id, provider_file_id);
CREATE INDEX IF NOT EXISTS payment_provider_files_tenant_idx
  ON public.payment_provider_files (tenant_id, created_at DESC);

GRANT SELECT ON public.payment_provider_files TO authenticated;
GRANT ALL ON public.payment_provider_files TO service_role;

ALTER TABLE public.payment_provider_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members read their own verification file metadata"
  ON public.payment_provider_files FOR SELECT TO authenticated
  USING (public.is_tenant_member(auth.uid(), tenant_id) OR public.has_role(auth.uid(), 'admin'::app_role));

CREATE TRIGGER payment_provider_files_set_updated_at
  BEFORE UPDATE ON public.payment_provider_files
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();