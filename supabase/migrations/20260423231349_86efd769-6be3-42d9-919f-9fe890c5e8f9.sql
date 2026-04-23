CREATE OR REPLACE FUNCTION public.get_tenant_users_with_profiles(_tenant_id uuid)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  role text,
  created_at timestamptz,
  full_name text,
  email text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    tu.id,
    tu.user_id,
    tu.role::text,
    tu.created_at,
    p.full_name,
    p.email
  FROM public.tenant_users tu
  LEFT JOIN public.profiles p ON p.id = tu.user_id
  WHERE tu.tenant_id = _tenant_id
    AND (
      -- Caller must be a member of this tenant OR a system admin
      EXISTS (
        SELECT 1 FROM public.tenant_users x
        WHERE x.tenant_id = _tenant_id AND x.user_id = auth.uid()
      )
      OR public.has_role(auth.uid(), 'admin'::public.app_role)
    )
  ORDER BY tu.created_at ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_tenant_users_with_profiles(uuid) TO authenticated;