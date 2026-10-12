-- SQL 72: users only, no admin-only actions inside a tenant.
--
-- ChecksOps has no admin or operator roles for tenant work: anyone with access
-- to a tenant may make edits there. The AWS write policies (aws_write_*) all go
-- through aws_can_write_tenant / aws_can_write_same_tenant_user, which also
-- required user_roles admin or staff, so ordinary members could not write.
--
-- This drops that role clause. Tenant isolation is unchanged: a write still
-- needs tenant_users membership of the row's tenant (aws_can_access_tenant),
-- and only the platform owner (aws_is_cross_tenant_reader) writes across
-- tenants. aws_can_write_check and aws_can_write_claim call
-- aws_can_write_tenant, so they follow.
--
-- Not changed: aws_write_user_roles. Platform roles carry cross-tenant access,
-- so letting members grant roles would let a user escape their tenant.

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
     AND public.aws_can_access_tenant(_tenant_id);
$$;

COMMENT ON FUNCTION public.aws_can_write_tenant(uuid) IS
  'Write allowed when auth.uid() is a platform owner or a tenant_users member of _tenant_id. No admin/staff role is required (SQL 72).';

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
       OR public.aws_can_access_same_tenant_user(_user_id)
     );
$$;

COMMENT ON FUNCTION public.aws_can_write_same_tenant_user(uuid) IS
  'Write another user-scoped row when authenticated and same-tenant (or platform owner). No admin/staff role is required (SQL 72).';

CREATE OR REPLACE FUNCTION public.aws_can_access_tax_profiles(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT _tenant_id IS NOT NULL
     AND (
       public.is_platform_owner()
       OR EXISTS (
         SELECT 1
         FROM public.tenant_users tu
         WHERE tu.tenant_id = _tenant_id
           AND tu.user_id = auth.uid()
       )
     );
$$;

COMMENT ON FUNCTION public.aws_can_access_tax_profiles(uuid) IS
  'Tax-profile access: platform owner or any tenant_users member of _tenant_id (SQL 72).';

DROP POLICY IF EXISTS aws_write_tenant_users ON public.tenant_users;
CREATE POLICY aws_write_tenant_users ON public.tenant_users
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));
