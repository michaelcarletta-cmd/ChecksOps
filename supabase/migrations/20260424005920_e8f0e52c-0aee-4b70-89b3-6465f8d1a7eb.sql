CREATE OR REPLACE FUNCTION public.lookup_tenant_by_partner_code(_code text)
RETURNS TABLE(id uuid, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.id, t.name
  FROM public.tenants t
  WHERE t.partner_code = upper(trim(_code))
    AND t.subscription_status = 'active'
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_tenant_by_partner_code(text) TO authenticated;