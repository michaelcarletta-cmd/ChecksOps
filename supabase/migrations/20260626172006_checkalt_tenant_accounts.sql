-- ============================================================
-- CheckAlt (FinCapture) — per-tenant depositor accounts
--
-- CheckAlt's onboarding model is per-tenant, not ChecksOps-wide: each
-- organization gets its own registered depositor "user account" via
-- POST /fincapture/useraccount/register, which returns/establishes a
-- userId that becomes the ssoKey used on every later deposit call.
-- checkalt_config (base_url, default_enabled, secrets) remains the
-- platform-wide kill switch / connection settings; this table holds
-- the per-tenant identity FinCapture needs for deposit/process,
-- deposit/approve and deposit/history calls.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.checkalt_tenant_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  sso_user_id text NOT NULL,
  deposit_account_number text NOT NULL,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  registered_at timestamptz,
  last_register_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT checkalt_tenant_accounts_tenant_uq UNIQUE (tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_checkalt_tenant_accounts_tenant
  ON public.checkalt_tenant_accounts (tenant_id);

ALTER TABLE public.checkalt_tenant_accounts ENABLE ROW LEVEL SECURITY;

-- Tenant admins can see their own org's account; platform admins can see all.
-- No direct authenticated INSERT/UPDATE: the deposit_account_number is the
-- full bank account number FinCapture requires for registration, which is
-- more sensitive than the last-4-only pattern used elsewhere (tenant_bank_accounts).
-- Writes happen only through the checkalt-register-account edge function,
-- after a successful FinCapture registration call.
CREATE POLICY "Tenant and platform admins can view checkalt tenant accounts"
  ON public.checkalt_tenant_accounts FOR SELECT
  TO authenticated
  USING (
    public.is_tenant_admin(auth.uid(), tenant_id)
    OR public.has_role(auth.uid(), 'admin')
  );

CREATE POLICY "Service role manages checkalt tenant accounts"
  ON public.checkalt_tenant_accounts FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS update_checkalt_tenant_accounts_updated_at ON public.checkalt_tenant_accounts;
CREATE TRIGGER update_checkalt_tenant_accounts_updated_at
  BEFORE UPDATE ON public.checkalt_tenant_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Tenant-scoped replacement for is_checkalt_enabled(): true only when the
-- platform-wide switch is on AND this tenant has a registered, enabled account.
-- Mirrors is_checkalt_enabled()'s pattern of exposing just the boolean to
-- authenticated users, since checkalt_tenant_accounts itself is admin-only.
CREATE OR REPLACE FUNCTION public.is_checkalt_enabled_for_tenant(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    COALESCE((SELECT default_enabled FROM public.checkalt_config WHERE singleton = true LIMIT 1), false)
    AND EXISTS (
      SELECT 1 FROM public.checkalt_tenant_accounts
      WHERE tenant_id = _tenant_id AND enabled = true AND registered_at IS NOT NULL
    );
$$;

GRANT EXECUTE ON FUNCTION public.is_checkalt_enabled_for_tenant(uuid) TO authenticated;
