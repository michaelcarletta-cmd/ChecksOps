CREATE TABLE public.tenant_email_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES public.tenants(id) ON DELETE CASCADE,
  from_name text,
  reply_to text,
  sending_mode text NOT NULL DEFAULT 'platform' CHECK (sending_mode IN ('platform','custom')),
  provider text NOT NULL DEFAULT 'lovable' CHECK (provider IN ('lovable','resend','mailgun')),
  sending_domain text,
  from_address text,
  domain_status text NOT NULL DEFAULT 'unverified' CHECK (domain_status IN ('unverified','pending','verified','failed')),
  dns_records jsonb,
  verified_at timestamptz,
  last_verification_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_email_settings TO authenticated;
GRANT ALL ON public.tenant_email_settings TO service_role;

ALTER TABLE public.tenant_email_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members can view email settings"
ON public.tenant_email_settings FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.tenant_id = tenant_email_settings.tenant_id
      AND tu.user_id = auth.uid()
  )
);

CREATE POLICY "Tenant admins can insert email settings"
ON public.tenant_email_settings FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.tenant_id = tenant_email_settings.tenant_id
      AND tu.user_id = auth.uid()
      AND tu.role = 'admin'
  )
);

CREATE POLICY "Tenant admins can update email settings"
ON public.tenant_email_settings FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.tenant_id = tenant_email_settings.tenant_id
      AND tu.user_id = auth.uid()
      AND tu.role = 'admin'
  )
);

CREATE POLICY "Tenant admins can delete email settings"
ON public.tenant_email_settings FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.tenant_users tu
    WHERE tu.tenant_id = tenant_email_settings.tenant_id
      AND tu.user_id = auth.uid()
      AND tu.role = 'admin'
  )
);

CREATE OR REPLACE FUNCTION public.tenant_email_settings_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_email_settings_updated_at
BEFORE UPDATE ON public.tenant_email_settings
FOR EACH ROW EXECUTE FUNCTION public.tenant_email_settings_touch_updated_at();

CREATE INDEX idx_tenant_email_settings_tenant ON public.tenant_email_settings(tenant_id);