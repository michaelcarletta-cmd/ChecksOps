CREATE OR REPLACE VIEW public.tenants_public
WITH (security_invoker = on) AS
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

GRANT SELECT ON public.tenants_public TO anon, authenticated;