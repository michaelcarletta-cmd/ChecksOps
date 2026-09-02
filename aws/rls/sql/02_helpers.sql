-- Session helpers for AWS RLS. Identity is request.app_user_id (application UUID).
-- Never read Cognito sub here. Roles come from user_roles / tenant_users.

CREATE OR REPLACE FUNCTION public.aws_user_tenant_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT tu.tenant_id
  FROM public.tenant_users tu
  WHERE tu.user_id = auth.uid();
$$;

COMMENT ON FUNCTION public.aws_user_tenant_ids() IS
  'Tenant ids for auth.uid() from tenant_users. Empty when request.app_user_id is unset. DEFINER so tenant_users RLS cannot recurse.';

REVOKE ALL ON FUNCTION public.aws_user_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_user_tenant_ids() TO checksops;

CREATE OR REPLACE FUNCTION public.aws_is_cross_tenant_reader()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(public.is_master_owner(), false)
      OR COALESCE(public.is_platform_owner(), false);
$$;

COMMENT ON FUNCTION public.aws_is_cross_tenant_reader() IS
  'True only for platform owners. Tenant admins with user_roles.admin are not cross-tenant.';
