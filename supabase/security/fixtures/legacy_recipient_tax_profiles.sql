-- Disposable fixture matching the repo-known hosted table.
-- Synthetic placeholder only. Do not copy production rows.

BEGIN;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.tenants (
  id uuid PRIMARY KEY,
  name text
);

CREATE TABLE IF NOT EXISTS public.tenant_users (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id),
  user_id uuid NOT NULL,
  role text NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

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

GRANT USAGE ON SCHEMA public TO anon, authenticated, authenticator, service_role;
GRANT SELECT ON public.tenants TO anon, authenticated;
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

COMMIT;
