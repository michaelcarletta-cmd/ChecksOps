-- Write-authorization helpers for AWS staging.
-- Does not ENABLE ROW LEVEL SECURITY. Does not change SELECT policies.
-- Tenant admin/staff never grant cross-tenant writes.
-- Cross-tenant writes require is_master_owner() or is_platform_owner() only.

CREATE OR REPLACE FUNCTION public.aws_is_authenticated()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT auth.uid() IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.aws_can_write_tenant(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.aws_is_authenticated()
     AND _tenant_id IS NOT NULL
     AND public.aws_can_access_tenant(_tenant_id)
     AND (
       public.aws_is_cross_tenant_reader()
       OR public.has_role(auth.uid(), 'admin'::public.app_role)
       OR public.has_role(auth.uid(), 'staff'::public.app_role)
     );
$$;

COMMENT ON FUNCTION public.aws_can_write_tenant(uuid) IS
  'Write allowed when auth.uid() is a platform owner or a tenant_users member of _tenant_id who also holds user_roles admin/staff. Global admin/staff without membership is denied.';

CREATE OR REPLACE FUNCTION public.aws_can_write_check(_check_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.aws_is_cross_tenant_reader()
      OR EXISTS (
        SELECT 1
        FROM public.check_intake_items ci
        WHERE ci.id = _check_id
          AND public.aws_can_write_tenant(ci.tenant_id)
      );
$$;

CREATE OR REPLACE FUNCTION public.aws_can_write_claim(_claim_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.aws_is_cross_tenant_reader()
      OR EXISTS (
        SELECT 1
        FROM public.claims c
        WHERE c.id = _claim_id
          AND public.aws_can_write_tenant(c.org_id)
      );
$$;

CREATE OR REPLACE FUNCTION public.aws_can_write_same_tenant_user(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.aws_is_authenticated()
     AND _user_id IS NOT NULL
     AND (
       public.aws_is_cross_tenant_reader()
       OR (
         public.aws_can_access_same_tenant_user(_user_id)
         AND (
           public.has_role(auth.uid(), 'admin'::public.app_role)
           OR public.has_role(auth.uid(), 'staff'::public.app_role)
         )
       )
     );
$$;

COMMENT ON FUNCTION public.aws_can_write_same_tenant_user(uuid) IS
  'Write another user-scoped row only when authenticated, same-tenant (or platform owner), and admin/staff. Global admin without tenant_users is denied.';

REVOKE ALL ON FUNCTION public.aws_is_authenticated() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_write_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_write_check(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_write_claim(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_write_same_tenant_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_is_authenticated() TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_write_tenant(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_write_check(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_write_claim(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_write_same_tenant_user(uuid) TO checksops, authenticated;
