
CREATE OR REPLACE FUNCTION public.get_my_tenant_partner_codes()
RETURNS TABLE(tenant_id uuid, code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.tenant_id, a.code
  FROM public.tenant_partner_code_aliases a
  WHERE a.tenant_id IN (
    SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = auth.uid()
  )
  ORDER BY a.code;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_tenant_partner_codes() TO authenticated;
