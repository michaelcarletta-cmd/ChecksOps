DROP POLICY IF EXISTS "Public routing fields for active tenants" ON public.tenants;

ALTER VIEW public.tenants_public SET (security_invoker = false);
GRANT SELECT ON public.tenants_public TO anon, authenticated;