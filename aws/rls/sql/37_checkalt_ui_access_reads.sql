-- CheckAlt tenant-facing read restriction.
-- Does not alter checkalt_config or checkalt_tenant_accounts columns.
-- Does not add business_unit. Does not change provider writes, registration,
-- polling, process, approve, or historical deposits.
-- Do not apply until authorized. Not SQL 36.

-- Global CheckAlt settings are platform-owner only.
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
WHERE public.is_platform_owner();

COMMENT ON VIEW public.checkalt_config_public IS
  'Platform-owner display of non-secret CheckAlt settings. Tenant users cannot read this view.';

GRANT SELECT ON public.checkalt_config_public TO authenticated, checksops;

-- Tenant Manager Auto-Deposit columns only.
DROP VIEW IF EXISTS public.checkalt_tenant_auto_deposit_public;
CREATE VIEW public.checkalt_tenant_auto_deposit_public
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  tenant_id,
  auto_approve_enabled,
  auto_approve_max_cents
FROM public.checkalt_tenant_accounts
WHERE public.aws_is_cross_tenant_reader()
   OR public.aws_can_access_tenant(tenant_id);

COMMENT ON VIEW public.checkalt_tenant_auto_deposit_public IS
  'Tenant-safe Auto-Deposit columns only. Omits sso_user_id, deposit account, registration payload, and PII.';

GRANT SELECT ON public.checkalt_tenant_auto_deposit_public TO authenticated, checksops;
