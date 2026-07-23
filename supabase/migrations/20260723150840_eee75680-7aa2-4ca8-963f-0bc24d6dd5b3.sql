CREATE OR REPLACE VIEW public.tenants_public AS
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
  partner_code,
  is_system_tenant,
  max_checks_per_month
FROM public.tenants
WHERE subscription_status = 'active';

ALTER VIEW public.tenants_public RESET (security_invoker);

GRANT SELECT ON public.tenants_public TO anon;
GRANT SELECT ON public.tenants_public TO authenticated;
GRANT SELECT ON public.tenants_public TO service_role;