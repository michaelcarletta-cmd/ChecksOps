
CREATE TABLE public.recipient_tax_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  recipient_key TEXT NOT NULL,
  recipient_name TEXT,
  tin TEXT,
  address_street TEXT,
  address_city TEXT,
  address_state TEXT,
  address_zip TEXT,
  account_number TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, recipient_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.recipient_tax_profiles TO authenticated;
GRANT ALL ON public.recipient_tax_profiles TO service_role;

ALTER TABLE public.recipient_tax_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant members read recipient_tax_profiles"
  ON public.recipient_tax_profiles FOR SELECT
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.tenant_id = recipient_tax_profiles.tenant_id AND tu.user_id = auth.uid()));

CREATE POLICY "tenant members insert recipient_tax_profiles"
  ON public.recipient_tax_profiles FOR INSERT
  TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.tenant_id = recipient_tax_profiles.tenant_id AND tu.user_id = auth.uid()));

CREATE POLICY "tenant members update recipient_tax_profiles"
  ON public.recipient_tax_profiles FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.tenant_id = recipient_tax_profiles.tenant_id AND tu.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.tenant_id = recipient_tax_profiles.tenant_id AND tu.user_id = auth.uid()));

CREATE POLICY "tenant members delete recipient_tax_profiles"
  ON public.recipient_tax_profiles FOR DELETE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.tenant_id = recipient_tax_profiles.tenant_id AND tu.user_id = auth.uid()));

CREATE TRIGGER recipient_tax_profiles_set_updated_at
  BEFORE UPDATE ON public.recipient_tax_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
