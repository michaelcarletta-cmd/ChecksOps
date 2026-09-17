-- Manager / Partners parity: tenant-safe public-column reads.
-- Does not open base public.tenants across tenants.
-- Does not grant CheckAlt execution, provider connectivity, polling,
-- registration, or money movement. Does not add provider/config writes.

CREATE OR REPLACE FUNCTION public.aws_is_tenant_manager_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.aws_is_authenticated()
     AND (
       public.aws_is_cross_tenant_reader()
       OR public.has_role(auth.uid(), 'admin'::public.app_role)
       OR EXISTS (
         SELECT 1
         FROM public.tenant_users tu
         WHERE tu.user_id = auth.uid()
           AND lower(tu.role::text) IN ('admin', 'owner')
       )
     );
$$;

COMMENT ON FUNCTION public.aws_is_tenant_manager_admin() IS
  'True for platform owners, user_roles.admin, or tenant_users admin/owner. Used only for non-secret Manager display/config reads.';

REVOKE ALL ON FUNCTION public.aws_is_tenant_manager_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_is_tenant_manager_admin() TO checksops, authenticated;

-- Active-tenant public columns only. security_invoker=false so partner-name
-- resolution is not blocked by membership-only aws_select_tenants.
-- Base tenants SELECT policy is unchanged.
DROP VIEW IF EXISTS public.tenants_public;
CREATE VIEW public.tenants_public
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  id,
  name,
  slug,
  logo_url,
  primary_color,
  secondary_color,
  custom_domain,
  subscription_status,
  plan_tier,
  is_system_tenant,
  partner_code
FROM public.tenants
WHERE subscription_status = 'active';

COMMENT ON VIEW public.tenants_public IS
  'Public branding/partner-name columns for active tenants. Does not expose base tenants or non-public columns.';

GRANT SELECT ON public.tenants_public TO anon, authenticated, checksops;

-- Non-secret CheckAlt settings for Manager admins. Omits cached JWT and webhook secret.
DROP VIEW IF EXISTS public.checkalt_config_public;
CREATE VIEW public.checkalt_config_public
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  id,
  singleton,
  base_url,
  merchant,
  fi_key,
  business_unit,
  depositor_account_id,
  default_enabled,
  auto_approve_enabled,
  auto_approve_max_cents,
  notes,
  created_at,
  updated_at,
  updated_by
FROM public.checkalt_config
WHERE public.aws_is_tenant_manager_admin();

COMMENT ON VIEW public.checkalt_config_public IS
  'Tenant-manager display of non-secret CheckAlt settings. Secrets stay on checkalt_config.';

GRANT SELECT ON public.checkalt_config_public TO authenticated, checksops;

-- Non-secret Deposit Ops provider display metadata. Omits config JSON.
DROP VIEW IF EXISTS public.deposit_provider_config_public;
CREATE VIEW public.deposit_provider_config_public
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  id,
  provider,
  display_name,
  is_active,
  is_stubbed,
  capabilities,
  created_at,
  updated_at
FROM public.deposit_provider_config
WHERE public.aws_is_tenant_manager_admin();

COMMENT ON VIEW public.deposit_provider_config_public IS
  'Tenant-manager display of deposit provider metadata. Omits secret config JSON. Read-only.';

GRANT SELECT ON public.deposit_provider_config_public TO authenticated, checksops;
