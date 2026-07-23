-- 1. Create the public-safe view
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
  plan_tier
FROM public.tenants
WHERE subscription_status = 'active';

GRANT SELECT ON public.tenants_public TO anon, authenticated;

-- 2. Drop the overly-permissive anon policy on the base table
DROP POLICY IF EXISTS "Public can view active tenants by slug or domain" ON public.tenants;

-- 3. Re-add a restricted equivalent for authenticated users only
-- (so the base table stays reachable by authenticated flows that pre-existed).
-- Members can already view their own tenant via "Members can view their tenant";
-- this covers cross-tenant slug lookup by any signed-in user (e.g. white-label routing).
CREATE POLICY "Authenticated can view active tenants for routing"
ON public.tenants
FOR SELECT
TO authenticated
USING (subscription_status = 'active');