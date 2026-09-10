-- Restrict platform-wide access to the dedicated ChecksOps platform account.
-- mcarletta@freedomadj.com is a Freedom Adjustment tenant user and must resolve
-- through tenant_users like every other tenant login.

CREATE OR REPLACE FUNCTION public.is_platform_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM auth.users u
    WHERE u.id = auth.uid()
      AND lower(u.email) = 'checksopsadmin@gmail.com'
  )
  OR EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND lower(p.email) = 'checksopsadmin@gmail.com'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_master_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_platform_owner();
$$;

COMMENT ON FUNCTION public.is_platform_owner() IS
  'Platform owner only when authenticated as checksopsadmin@gmail.com.';

COMMENT ON FUNCTION public.is_master_owner() IS
  'Compatibility alias for is_platform_owner(); tenant UUIDs do not grant cross-tenant access.';
