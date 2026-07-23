
DROP POLICY IF EXISTS "Public can view active tenants for login routing" ON public.tenants;
DROP POLICY IF EXISTS "Authenticated can view active tenants for routing" ON public.tenants;

DROP VIEW IF EXISTS public.tenants_public;

CREATE VIEW public.tenants_public
WITH (security_invoker = true) AS
SELECT
  id, name, slug, logo_url, primary_color, secondary_color,
  custom_domain, subscription_status, plan_tier, is_system_tenant, partner_code
FROM public.tenants
WHERE subscription_status = 'active';

GRANT SELECT
  (id, name, slug, logo_url, primary_color, secondary_color, custom_domain,
   subscription_status, plan_tier, is_system_tenant, partner_code)
  ON public.tenants TO anon, authenticated;

GRANT SELECT ON public.tenants_public TO anon, authenticated;

CREATE POLICY "Public routing fields for active tenants"
  ON public.tenants
  FOR SELECT
  TO anon, authenticated
  USING (subscription_status = 'active');
