-- AWS: users only, tenant roles decide (SQL 90).
-- Forward migration on top of aws/rls/sql (02_helpers, 11_access_helpers,
-- 20_write_helpers, 21_proposed_write_policies, 24_complete_write_policies).
-- Refuses to run (55000 sql90_prerequisite_missing) when the objects it
-- changes are absent.
--
-- Owner policy:
--   - Users only. A global user_roles admin/staff role gives no write access
--     inside a tenant. The platform owner (aws_is_cross_tenant_reader()) is
--     unchanged here: its remaining duties (Check Alt setup, mortgage agent
--     compensation, disabling a login, tenant onboarding) are gated by the API.
--   - Owner, admin, manager and operator act; viewers and partners do not.
--   - Team management (tenant_users, tenant settings, sender settings, tax
--     profiles) is owner and admin of that tenant only.
--   - Every check is per tenant: the tenant must be one of the caller's own
--     tenant_users tenants.
--
-- Before: aws_can_write_tenant(t) = authenticated AND aws_can_access_tenant(t)
-- AND (cross-tenant reader OR user_roles admin OR user_roles staff). An invited
-- tenant owner/admin/operator without a global role could not write, while a
-- global admin/staff who was only a viewer of the tenant could.
--
-- 1) New helpers (SECURITY DEFINER, search_path=public, row_security=off, so
--    policy checks read tenant_users without re-entering its RLS):
--    - aws_is_tenant_actor(t): auth.uid() has a tenant_users row for t with role
--      owner, admin, manager or operator.
--    - aws_is_tenant_team_manager(t): the same with role owner or admin.
-- 2) aws_can_write_tenant(t) = authenticated AND t IS NOT NULL AND
--    (cross-tenant reader OR aws_is_tenant_actor(t)). aws_can_write_check and
--    aws_can_write_claim call it, so every aws_write_* policy built on them
--    (checks, claims, deposits, loss drafts, partner connect/share in SQL 32,
--    ...) follows. No user_roles clause.
-- 3) aws_can_write_same_tenant_user(u) = authenticated AND u IS NOT NULL AND
--    (cross-tenant reader OR auth.uid() is owner/admin of a tenant u belongs
--    to). Replaces "same tenant AND user_roles admin/staff".
-- 4) aws_can_access_tax_profiles(t): owner/admin of t only. Drops the
--    platform-owner and user_roles admin branches (the API has the same rule,
--    aws/functions/api/tax-secrets.mjs evaluateTaxAccess).
-- 5) Policies (DROP IF EXISTS + CREATE):
--    - aws_write_tenant_users: cross-tenant reader OR team manager of the row's
--      tenant (was: aws_can_write_tenant AND user_roles admin).
--    - aws_write_tenants (FOR UPDATE): cross-tenant reader OR team manager.
--    - aws_write_tenant_email_settings (only when the table exists): cross-tenant
--      reader OR team manager.
--
-- Not changed: aws_write_user_roles (platform roles), SELECT policies, and the
-- additive member policies of SQL 72, 79 and 80.
--
-- Transactions: like main's other aws/workflows/sql files this has no
-- BEGIN/COMMIT; the guarded SQL executor runs it inside one transaction.
-- Idempotent: safe to run more than once.

DO $$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.tenant_users', to_regclass('public.tenant_users')::oid),
      ('public.tenants', to_regclass('public.tenants')::oid),
      ('public.recipient_tax_profiles', to_regclass('public.recipient_tax_profiles')::oid),
      ('public.aws_is_authenticated()', to_regprocedure('public.aws_is_authenticated()')::oid),
      ('public.aws_is_cross_tenant_reader()', to_regprocedure('public.aws_is_cross_tenant_reader()')::oid),
      ('public.aws_can_access_tenant(uuid)', to_regprocedure('public.aws_can_access_tenant(uuid)')::oid),
      ('public.aws_can_write_tenant(uuid)', to_regprocedure('public.aws_can_write_tenant(uuid)')::oid),
      ('public.aws_can_write_same_tenant_user(uuid)', to_regprocedure('public.aws_can_write_same_tenant_user(uuid)')::oid),
      ('public.aws_can_access_tax_profiles(uuid)', to_regprocedure('public.aws_can_access_tax_profiles(uuid)')::oid),
      ('role checksops', (SELECT oid FROM pg_roles WHERE rolname = 'checksops')),
      ('role authenticated', (SELECT oid FROM pg_roles WHERE rolname = 'authenticated'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql90_prerequisite_missing: SQL 90 needs the aws/rls/sql helpers and policies applied first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.aws_is_tenant_actor(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT _tenant_id IS NOT NULL
     AND auth.uid() IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.tenant_users tu
       WHERE tu.tenant_id = _tenant_id
         AND tu.user_id = auth.uid()
         AND lower(tu.role::text) IN ('owner', 'admin', 'manager', 'operator')
     );
$$;

COMMENT ON FUNCTION public.aws_is_tenant_actor(uuid) IS
  'Owner policy: owner, admin, manager and operator act; viewers and partners do not. True when auth.uid() has one of those tenant_users roles in _tenant_id (SQL 90).';

CREATE OR REPLACE FUNCTION public.aws_is_tenant_team_manager(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT _tenant_id IS NOT NULL
     AND auth.uid() IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.tenant_users tu
       WHERE tu.tenant_id = _tenant_id
         AND tu.user_id = auth.uid()
         AND lower(tu.role::text) IN ('owner', 'admin')
     );
$$;

COMMENT ON FUNCTION public.aws_is_tenant_team_manager(uuid) IS
  'Owner policy: team management is owner and admin only. True when auth.uid() is owner or admin of _tenant_id in tenant_users (SQL 90).';

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
     AND (
       public.aws_is_cross_tenant_reader()
       OR public.aws_is_tenant_actor(_tenant_id)
     );
$$;

COMMENT ON FUNCTION public.aws_can_write_tenant(uuid) IS
  'Write allowed when auth.uid() is a platform owner or an owner/admin/manager/operator of _tenant_id in tenant_users. Viewers, partners and global user_roles admin/staff are denied (SQL 90).';

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
       OR EXISTS (
         SELECT 1
         FROM public.tenant_users mine
         JOIN public.tenant_users theirs ON theirs.tenant_id = mine.tenant_id
         WHERE mine.user_id = auth.uid()
           AND theirs.user_id = _user_id
           AND lower(mine.role::text) IN ('owner', 'admin')
       )
     );
$$;

COMMENT ON FUNCTION public.aws_can_write_same_tenant_user(uuid) IS
  'Write another user-scoped row only when authenticated and owner/admin of a tenant that user belongs to (or platform owner). Global user_roles admin/staff are denied (SQL 90).';

CREATE OR REPLACE FUNCTION public.aws_can_access_tax_profiles(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.aws_is_tenant_team_manager(_tenant_id);
$$;

COMMENT ON FUNCTION public.aws_can_access_tax_profiles(uuid) IS
  'Tax-profile access: owner or admin of _tenant_id in tenant_users only. No platform owner or user_roles admin branch (SQL 90).';

REVOKE ALL ON FUNCTION public.aws_is_tenant_actor(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_is_tenant_team_manager(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_write_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_write_same_tenant_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_access_tax_profiles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_is_tenant_actor(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_is_tenant_team_manager(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_write_tenant(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_write_same_tenant_user(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_access_tax_profiles(uuid) TO checksops, authenticated;

DROP POLICY IF EXISTS aws_write_tenant_users ON public.tenant_users;
CREATE POLICY aws_write_tenant_users ON public.tenant_users
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND (public.aws_is_cross_tenant_reader() OR public.aws_is_tenant_team_manager(tenant_id)))
  WITH CHECK (public.aws_is_authenticated() AND (public.aws_is_cross_tenant_reader() OR public.aws_is_tenant_team_manager(tenant_id)));

DROP POLICY IF EXISTS aws_write_tenants ON public.tenants;
CREATE POLICY aws_write_tenants ON public.tenants
  FOR UPDATE TO authenticated
  USING (public.aws_is_authenticated() AND (public.aws_is_cross_tenant_reader() OR public.aws_is_tenant_team_manager(id)))
  WITH CHECK (public.aws_is_authenticated() AND (public.aws_is_cross_tenant_reader() OR public.aws_is_tenant_team_manager(id)));

DO $$
BEGIN
  IF to_regclass('public.tenant_email_settings') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS aws_write_tenant_email_settings ON public.tenant_email_settings';
    EXECUTE 'CREATE POLICY aws_write_tenant_email_settings ON public.tenant_email_settings
      FOR ALL TO authenticated
      USING (public.aws_is_authenticated() AND (public.aws_is_cross_tenant_reader() OR public.aws_is_tenant_team_manager(tenant_id)))
      WITH CHECK (public.aws_is_authenticated() AND (public.aws_is_cross_tenant_reader() OR public.aws_is_tenant_team_manager(tenant_id)))';
  END IF;
END
$$;
