
-- Add checkalt provider to deposit_provider enum
ALTER TYPE public.deposit_provider ADD VALUE IF NOT EXISTS 'checkalt';

-- Per-tenant CheckAlt depositor account registrations
CREATE TABLE IF NOT EXISTS public.checkalt_tenant_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES public.tenants(id) ON DELETE CASCADE,
  sso_user_id TEXT NOT NULL,
  deposit_account_number TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  registered_at TIMESTAMPTZ,
  last_register_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.checkalt_tenant_accounts TO authenticated;
GRANT ALL ON public.checkalt_tenant_accounts TO service_role;
ALTER TABLE public.checkalt_tenant_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant admins view own checkalt account"
  ON public.checkalt_tenant_accounts FOR SELECT TO authenticated
  USING (
    public.is_tenant_admin(auth.uid(), tenant_id)
    OR public.has_role(auth.uid(), 'admin'::app_role)
  );
CREATE POLICY "Tenant admins manage own checkalt account"
  ON public.checkalt_tenant_accounts FOR ALL TO authenticated
  USING (
    public.is_tenant_admin(auth.uid(), tenant_id)
    OR public.has_role(auth.uid(), 'admin'::app_role)
  )
  WITH CHECK (
    public.is_tenant_admin(auth.uid(), tenant_id)
    OR public.has_role(auth.uid(), 'admin'::app_role)
  );

-- Per-tenant enablement check (platform switch + tenant registered + tenant enabled)
CREATE OR REPLACE FUNCTION public.is_checkalt_enabled_for_tenant(_tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE((SELECT default_enabled FROM public.checkalt_config WHERE singleton = true LIMIT 1), false)
    AND EXISTS (
      SELECT 1 FROM public.checkalt_tenant_accounts
      WHERE tenant_id = _tenant_id
        AND enabled = true
        AND registered_at IS NOT NULL
    );
$$;
