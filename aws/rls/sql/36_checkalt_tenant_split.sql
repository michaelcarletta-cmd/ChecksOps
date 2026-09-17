-- CheckAlt tenant configuration split.
-- Does not enable provider execution, registration, polling, or money movement.
-- Does not rewrite checkalt_deposits rows or fabricate cleared_at / depositDate.

-- Per-tenant Business Unit. Existing Freedom (and any other) rows inherit the
-- singleton value once so current config is not lost; later saves are
-- tenant-scoped and never write back to checkalt_config.
ALTER TABLE public.checkalt_tenant_accounts
  ADD COLUMN IF NOT EXISTS business_unit text;

COMMENT ON COLUMN public.checkalt_tenant_accounts.business_unit IS
  'Tenant-specific CheckAlt Business Unit. Not stored on the platform singleton.';

UPDATE public.checkalt_tenant_accounts AS a
SET business_unit = c.business_unit
FROM public.checkalt_config AS c
WHERE c.singleton IS TRUE
  AND a.business_unit IS NULL
  AND c.business_unit IS NOT NULL
  AND length(trim(c.business_unit)) > 0;

CREATE OR REPLACE FUNCTION public.aws_is_platform_checkalt_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.aws_is_authenticated()
     AND public.aws_is_cross_tenant_reader();
$$;

COMMENT ON FUNCTION public.aws_is_platform_checkalt_admin() IS
  'True only for the ChecksOps platform owner. Tenant user_roles.admin does not qualify.';

REVOKE ALL ON FUNCTION public.aws_is_platform_checkalt_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_is_platform_checkalt_admin() TO checksops, authenticated;

-- Platform CheckAlt display. Omits FI key value, deposit account, Business Unit,
-- Auto-Deposit, cached JWT, and webhook secret.
DROP VIEW IF EXISTS public.checkalt_config_public;
CREATE VIEW public.checkalt_config_public
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  id,
  singleton,
  base_url,
  merchant,
  (fi_key IS NOT NULL AND length(trim(fi_key)) > 0) AS fi_key_configured,
  default_enabled,
  notes,
  created_at,
  updated_at,
  updated_by
FROM public.checkalt_config
WHERE public.aws_is_platform_checkalt_admin();

COMMENT ON VIEW public.checkalt_config_public IS
  'Platform-owner CheckAlt display. Omits FI key, tenant deposit/BU, Auto-Deposit, and secrets.';

GRANT SELECT ON public.checkalt_config_public TO authenticated, checksops;

-- ChecksOps Tenant Management read of per-tenant CheckAlt fields.
-- Includes the full deposit account because platform admins must edit it.
-- Omits raw last_register_payload.
DROP VIEW IF EXISTS public.checkalt_tenant_accounts_admin;
CREATE VIEW public.checkalt_tenant_accounts_admin
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  id,
  tenant_id,
  sso_user_id,
  deposit_account_number,
  first_name,
  last_name,
  email,
  business_unit,
  enabled,
  registered_at,
  (last_register_payload ? 'sso_key') AS has_sso_key,
  auto_approve_enabled,
  auto_approve_max_cents,
  created_at,
  updated_at
FROM public.checkalt_tenant_accounts
WHERE public.aws_is_platform_checkalt_admin();

COMMENT ON VIEW public.checkalt_tenant_accounts_admin IS
  'ChecksOps-only per-tenant CheckAlt configuration. Ordinary tenant users cannot SELECT this view.';

GRANT SELECT ON public.checkalt_tenant_accounts_admin TO authenticated, checksops;

-- Tenant-facing Auto-Deposit only. No account numbers, ssoKey, BU, or payloads.
DROP VIEW IF EXISTS public.checkalt_tenant_auto_deposit_public;
CREATE VIEW public.checkalt_tenant_auto_deposit_public
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  tenant_id,
  auto_approve_enabled,
  auto_approve_max_cents,
  enabled,
  (registered_at IS NOT NULL) AS registered,
  (sso_user_id IS NOT NULL AND length(trim(sso_user_id)) > 0) AS has_registration
FROM public.checkalt_tenant_accounts
WHERE public.aws_is_cross_tenant_reader()
   OR (
     public.aws_is_tenant_manager_admin()
     AND public.aws_can_access_tenant(tenant_id)
   );

COMMENT ON VIEW public.checkalt_tenant_auto_deposit_public IS
  'Tenant-manager Auto-Deposit flags only. No deposit account, ssoKey, Business Unit, or register payload.';

GRANT SELECT ON public.checkalt_tenant_auto_deposit_public TO authenticated, checksops;

-- Base table: platform owner only. Ordinary tenant members cannot SELECT
-- full account numbers / sso keys / register payloads.
DROP POLICY IF EXISTS aws_select_checkalt_tenant_accounts ON public.checkalt_tenant_accounts;
CREATE POLICY aws_select_checkalt_tenant_accounts ON public.checkalt_tenant_accounts
  FOR SELECT TO authenticated
  USING (public.aws_is_cross_tenant_reader());

-- No generic tenant writes. Dedicated RPCs perform Auto-Deposit and
-- ChecksOps tenant-account updates. Authenticated browser writes stay closed
-- except for the platform owner (still not used by the AWS write allowlist).
DROP POLICY IF EXISTS aws_write_checkalt_tenant_accounts ON public.checkalt_tenant_accounts;
CREATE POLICY aws_write_checkalt_tenant_accounts ON public.checkalt_tenant_accounts
  FOR ALL TO authenticated
  USING (public.aws_is_cross_tenant_reader())
  WITH CHECK (public.aws_is_cross_tenant_reader());
