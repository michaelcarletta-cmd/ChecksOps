
-- Repair migration: idempotent re-creation of tenant infrastructure

-- Enums (skip if exist)
DO $$ BEGIN CREATE TYPE public.tenant_role AS ENUM ('admin', 'operator', 'viewer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.tenant_plan_tier AS ENUM ('starter', 'pro', 'enterprise'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tenants table
CREATE TABLE IF NOT EXISTS public.tenants (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo_url TEXT,
  primary_color TEXT DEFAULT '#3B82F6',
  secondary_color TEXT DEFAULT '#1E293B',
  custom_domain TEXT UNIQUE,
  stripe_customer_id TEXT,
  subscription_status TEXT DEFAULT 'inactive',
  plan_tier tenant_plan_tier DEFAULT 'starter',
  is_system_tenant BOOLEAN DEFAULT false,
  max_checks_per_month INTEGER DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tenant users table
CREATE TABLE IF NOT EXISTS public.tenant_users (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role tenant_role NOT NULL DEFAULT 'viewer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, user_id)
);

-- Insert system tenant if missing
INSERT INTO public.tenants (name, slug, is_system_tenant, subscription_status, plan_tier)
SELECT 'Freedom Claims', 'freedom-claims', true, 'active', 'enterprise'
WHERE NOT EXISTS (SELECT 1 FROM public.tenants WHERE is_system_tenant = true);

-- Helper function
CREATE OR REPLACE FUNCTION public.system_tenant_id()
RETURNS UUID LANGUAGE sql STABLE
AS $$ SELECT id FROM public.tenants WHERE is_system_tenant = true LIMIT 1; $$;

-- Add tenant_id columns if missing
ALTER TABLE public.check_intake_items ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.check_payees ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.check_endorsements ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.check_review_decisions ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.check_reissue_requests ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);
ALTER TABLE public.check_audit_log ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id);

-- Backfill
UPDATE public.check_intake_items SET tenant_id = public.system_tenant_id() WHERE tenant_id IS NULL;
UPDATE public.check_payees SET tenant_id = public.system_tenant_id() WHERE tenant_id IS NULL;
UPDATE public.check_endorsements SET tenant_id = public.system_tenant_id() WHERE tenant_id IS NULL;
UPDATE public.check_review_decisions SET tenant_id = public.system_tenant_id() WHERE tenant_id IS NULL;
UPDATE public.check_reissue_requests SET tenant_id = public.system_tenant_id() WHERE tenant_id IS NULL;
UPDATE public.check_audit_log SET tenant_id = public.system_tenant_id() WHERE tenant_id IS NULL;

-- Set defaults
ALTER TABLE public.check_intake_items ALTER COLUMN tenant_id SET DEFAULT public.system_tenant_id();
ALTER TABLE public.check_payees ALTER COLUMN tenant_id SET DEFAULT public.system_tenant_id();
ALTER TABLE public.check_endorsements ALTER COLUMN tenant_id SET DEFAULT public.system_tenant_id();
ALTER TABLE public.check_review_decisions ALTER COLUMN tenant_id SET DEFAULT public.system_tenant_id();
ALTER TABLE public.check_reissue_requests ALTER COLUMN tenant_id SET DEFAULT public.system_tenant_id();
ALTER TABLE public.check_audit_log ALTER COLUMN tenant_id SET DEFAULT public.system_tenant_id();

-- Indexes (IF NOT EXISTS)
CREATE INDEX IF NOT EXISTS idx_tenant_users_user_id ON public.tenant_users(user_id);
CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant_id ON public.tenant_users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenants_slug ON public.tenants(slug);
CREATE INDEX IF NOT EXISTS idx_tenants_custom_domain ON public.tenants(custom_domain);
CREATE INDEX IF NOT EXISTS idx_check_intake_items_tenant ON public.check_intake_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_check_payees_tenant ON public.check_payees(tenant_id);
CREATE INDEX IF NOT EXISTS idx_check_endorsements_tenant ON public.check_endorsements(tenant_id);
CREATE INDEX IF NOT EXISTS idx_check_review_decisions_tenant ON public.check_review_decisions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_check_reissue_requests_tenant ON public.check_reissue_requests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_check_audit_log_tenant ON public.check_audit_log(tenant_id);

-- Security definer functions
CREATE OR REPLACE FUNCTION public.get_user_tenant_ids(_user_id UUID)
RETURNS UUID[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT COALESCE(ARRAY_AGG(tenant_id), '{}') FROM public.tenant_users WHERE user_id = _user_id; $$;

CREATE OR REPLACE FUNCTION public.is_tenant_member(_user_id UUID, _tenant_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.tenant_users WHERE user_id = _user_id AND tenant_id = _tenant_id); $$;

CREATE OR REPLACE FUNCTION public.is_tenant_admin(_user_id UUID, _tenant_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.tenant_users WHERE user_id = _user_id AND tenant_id = _tenant_id AND role = 'admin'); $$;

-- RLS
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_users ENABLE ROW LEVEL SECURITY;

-- Policies (drop first to avoid duplicates)
DROP POLICY IF EXISTS "Members can view their tenant" ON public.tenants;
DROP POLICY IF EXISTS "System admins can create tenants" ON public.tenants;
DROP POLICY IF EXISTS "System admins can update tenants" ON public.tenants;
DROP POLICY IF EXISTS "System admins can delete tenants" ON public.tenants;

CREATE POLICY "Members can view their tenant" ON public.tenants FOR SELECT
  USING (public.is_tenant_member(auth.uid(), id) OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "System admins can create tenants" ON public.tenants FOR INSERT
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "System admins can update tenants" ON public.tenants FOR UPDATE
  USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "System admins can delete tenants" ON public.tenants FOR DELETE
  USING (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "View tenant users" ON public.tenant_users;
DROP POLICY IF EXISTS "Insert tenant users" ON public.tenant_users;
DROP POLICY IF EXISTS "Update tenant users" ON public.tenant_users;
DROP POLICY IF EXISTS "Delete tenant users" ON public.tenant_users;

CREATE POLICY "View tenant users" ON public.tenant_users FOR SELECT
  USING (public.is_tenant_member(auth.uid(), tenant_id) OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Insert tenant users" ON public.tenant_users FOR INSERT
  WITH CHECK (public.is_tenant_admin(auth.uid(), tenant_id) OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Update tenant users" ON public.tenant_users FOR UPDATE
  USING (public.is_tenant_admin(auth.uid(), tenant_id) OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Delete tenant users" ON public.tenant_users FOR DELETE
  USING (public.is_tenant_admin(auth.uid(), tenant_id) OR public.has_role(auth.uid(), 'admin'));

-- Triggers (drop first)
DROP TRIGGER IF EXISTS update_tenants_updated_at ON public.tenants;
DROP TRIGGER IF EXISTS update_tenant_users_updated_at ON public.tenant_users;
CREATE TRIGGER update_tenants_updated_at BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_tenant_users_updated_at BEFORE UPDATE ON public.tenant_users
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Storage bucket for tenant logos
INSERT INTO storage.buckets (id, name, public)
VALUES ('tenant-logos', 'tenant-logos', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Authenticated users can upload tenant logos" ON storage.objects;
DROP POLICY IF EXISTS "Public can view tenant logos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can update tenant logos" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can delete tenant logos" ON storage.objects;

CREATE POLICY "Authenticated users can upload tenant logos"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'tenant-logos');
CREATE POLICY "Public can view tenant logos"
ON storage.objects FOR SELECT
USING (bucket_id = 'tenant-logos');
CREATE POLICY "Authenticated users can update tenant logos"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'tenant-logos');
CREATE POLICY "Authenticated users can delete tenant logos"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'tenant-logos');

-- Email config columns
ALTER TABLE public.tenants
ADD COLUMN IF NOT EXISTS email_from_name text,
ADD COLUMN IF NOT EXISTS email_from_address text,
ADD COLUMN IF NOT EXISTS email_reply_to text,
ADD COLUMN IF NOT EXISTS email_provider text DEFAULT 'none',
ADD COLUMN IF NOT EXISTS email_provider_config jsonb DEFAULT '{}'::jsonb;
