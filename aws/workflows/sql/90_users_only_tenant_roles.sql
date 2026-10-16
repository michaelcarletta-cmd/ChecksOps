-- AWS: users only, no tenant role tiers (SQL 90).
-- Forward migration on top of aws/rls/sql (02_helpers, 11_access_helpers,
-- 20_write_helpers, 21_proposed_write_policies, 24_complete_write_policies,
-- 29_mortgage_ops_library_parity, 35_manager_partner_parity) and
-- aws/workflows/sql 80. Refuses to run (55000 sql90_prerequisite_missing) when
-- the objects it changes are absent.
--
-- Owner policy:
--   - Every member of a tenant (any tenant_users row for it) is a user with the
--     same rights: check work, deposits, payments, inviting and removing
--     teammates, resetting a teammate's 2FA, company settings, email sender,
--     tax setup, Compliance & Docs. tenant_users.role is ignored by
--     authorization. This file does not change the tenant_role enum and does
--     not rewrite tenant_users.role data.
--   - Partners (users of other tenants on shared checks) stay read-only; other
--     tenants get nothing.
--   - No global user_roles admin/staff write path anywhere.
--   - The platform owner (aws_is_cross_tenant_reader(), is_platform_owner()) is
--     unchanged in the write helpers: its kept duties (tenant create and the
--     first invite, login disable, Check Alt setup, mortgage compensation,
--     Return to Queue and Adjust) are gated by the API.
--   - Platform roles in user_roles are set by the platform owner only.
--
-- Before: aws_can_write_tenant(t) = authenticated AND aws_can_access_tenant(t)
-- AND (cross-tenant reader OR user_roles admin OR user_roles staff), so an
-- invited tenant member without a global role could not write, while a global
-- admin/staff could. Several helpers also tiered on tenant_users.role.
--
-- 1) aws_is_tenant_member(t) (new): auth.uid() has a tenant_users row for t.
--    SECURITY DEFINER, search_path=public, row_security=off, so policy checks
--    read tenant_users without re-entering its RLS.
-- 2) aws_can_write_tenant(t) = authenticated AND t IS NOT NULL AND
--    (cross-tenant reader OR aws_is_tenant_member(t)). aws_can_write_check and
--    aws_can_write_claim call it, so every aws_write_* policy built on them
--    (checks, claims, deposits, loss drafts, partner connect/share in SQL 32,
--    ...) follows. Partners stay read-only: aws_can_write_check is owner-tenant
--    only.
-- 3) aws_can_write_same_tenant_user(u) = authenticated AND u IS NOT NULL AND
--    (cross-tenant reader OR auth.uid() shares a tenant with u).
-- 4) aws_can_access_tax_profiles(t) = aws_is_tenant_member(t). No platform-owner
--    or user_roles admin branch (the API matches: tax-secrets evaluateTaxAccess).
-- 5) aws_is_tenant_manager_admin() (SQL 35, Manager display reads) =
--    authenticated AND (cross-tenant reader OR any tenant membership). Drops
--    the user_roles admin and owner/admin branches. Replaced only if present.
-- 6) aws_can_manage_mortgage_library(t) (SQL 29) = authenticated AND t IS NOT
--    NULL AND aws_can_write_tenant(t). Drops the owner/admin branch (now
--    redundant). Replaced only if present.
-- 7) aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) (SQL 80): the caller
--    check becomes platform owner OR any member of _tenant_id; everything else
--    is SQL 80's body unchanged. Replaced only if present.
-- 8) Policies (DROP IF EXISTS + CREATE):
--    - aws_write_tenant_users: cross-tenant reader OR member of the row's tenant
--      (was: aws_can_write_tenant AND user_roles admin).
--    - aws_write_tenants (FOR UPDATE): cross-tenant reader OR member.
--    - aws_write_tenant_email_settings (only when the table exists): cross-tenant
--      reader OR member.
--    - aws_write_user_roles: the platform owner only (is_platform_owner()).
--      Was: cross-tenant reader, or same-tenant user plus user_roles admin.
--
-- Not changed: SELECT policies, and the additive member write policies of SQL
-- 72 and 79 (they already allow any member of the row's tenant via
-- aws_user_tenant_ids(), which is this rule).
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
      ('public.user_roles', to_regclass('public.user_roles')::oid),
      ('public.recipient_tax_profiles', to_regclass('public.recipient_tax_profiles')::oid),
      ('public.aws_is_authenticated()', to_regprocedure('public.aws_is_authenticated()')::oid),
      ('public.aws_is_cross_tenant_reader()', to_regprocedure('public.aws_is_cross_tenant_reader()')::oid),
      ('public.is_platform_owner()', to_regprocedure('public.is_platform_owner()')::oid),
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

CREATE OR REPLACE FUNCTION public.aws_is_tenant_member(_tenant_id uuid)
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
     );
$$;

COMMENT ON FUNCTION public.aws_is_tenant_member(uuid) IS
  'Owner policy: every member of the tenant is a user with the same rights. True when auth.uid() has a tenant_users row for _tenant_id; the role column is ignored (SQL 90).';

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
       OR public.aws_is_tenant_member(_tenant_id)
     );
$$;

COMMENT ON FUNCTION public.aws_can_write_tenant(uuid) IS
  'Write allowed when auth.uid() is a platform owner or any tenant_users member of _tenant_id. Global admin/staff without membership are denied; no role tiers (SQL 90).';

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
       )
     );
$$;

COMMENT ON FUNCTION public.aws_can_write_same_tenant_user(uuid) IS
  'Write another user-scoped row when authenticated and sharing a tenant with that user (or platform owner). No global admin/staff requirement and no role tiers (SQL 90).';

CREATE OR REPLACE FUNCTION public.aws_can_access_tax_profiles(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.aws_is_tenant_member(_tenant_id);
$$;

COMMENT ON FUNCTION public.aws_can_access_tax_profiles(uuid) IS
  'Tax-profile access: any tenant_users member of _tenant_id. No platform owner or user_roles admin branch; no role tiers (SQL 90).';

REVOKE ALL ON FUNCTION public.aws_is_tenant_member(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_write_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_write_same_tenant_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_access_tax_profiles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_is_tenant_member(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_write_tenant(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_write_same_tenant_user(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_access_tax_profiles(uuid) TO checksops, authenticated;

-- SQL 35 and SQL 29 helpers: replaced only when present.
DO $$
BEGIN
  IF to_regprocedure('public.aws_is_tenant_manager_admin()') IS NOT NULL THEN
    EXECUTE $fn$
CREATE OR REPLACE FUNCTION public.aws_is_tenant_manager_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $body$
  SELECT public.aws_is_authenticated()
     AND (
       public.aws_is_cross_tenant_reader()
       OR EXISTS (
         SELECT 1
         FROM public.tenant_users tu
         WHERE tu.user_id = auth.uid()
       )
     );
$body$
$fn$;
    EXECUTE $c$COMMENT ON FUNCTION public.aws_is_tenant_manager_admin() IS
  'True for platform owners or any tenant_users member. Used only for non-secret Manager display/config reads. No user_roles admin branch and no role tiers (SQL 90).'$c$;
  END IF;

  IF to_regprocedure('public.aws_can_manage_mortgage_library(uuid)') IS NOT NULL THEN
    EXECUTE $fn$
CREATE OR REPLACE FUNCTION public.aws_can_manage_mortgage_library(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $body$
  SELECT public.aws_is_authenticated()
     AND _tenant_id IS NOT NULL
     AND public.aws_can_write_tenant(_tenant_id);
$body$
$fn$;
    EXECUTE $c$COMMENT ON FUNCTION public.aws_can_manage_mortgage_library(uuid) IS
  'Any tenant_users member of _tenant_id or the platform owner (aws_can_write_tenant). Mortgage agents cannot backfill. No role tiers (SQL 90).'$c$;
  END IF;
END
$$;

-- SQL 80 Check Alt Auto-Deposit save: platform owner or any member.
DO $$
BEGIN
  IF to_regprocedure('public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb)') IS NOT NULL THEN
    EXECUTE $fn$
CREATE OR REPLACE FUNCTION public.aws_save_checkalt_tenant_auto_deposit(
  _tenant_id uuid,
  _settings jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $body$
DECLARE
  _key text;
  _max numeric;
  _enabled boolean;
  _row public.checkalt_tenant_accounts%ROWTYPE;
BEGIN
  IF _tenant_id IS NULL THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;
  IF _settings IS NULL OR jsonb_typeof(_settings) <> 'object' OR _settings = '{}'::jsonb THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;

  FOR _key IN SELECT jsonb_object_keys(_settings)
  LOOP
    IF _key NOT IN ('auto_approve_enabled', 'auto_approve_max_cents') THEN
      RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023', DETAIL = _key;
    END IF;
  END LOOP;

  IF NOT (
    public.is_platform_owner()
    OR EXISTS (
      SELECT 1
      FROM public.tenant_users tu
      WHERE tu.user_id = auth.uid()
        AND tu.tenant_id = _tenant_id
    )
  ) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  IF _settings ? 'auto_approve_max_cents'
     AND jsonb_typeof(_settings->'auto_approve_max_cents') <> 'null'
  THEN
    IF jsonb_typeof(_settings->'auto_approve_max_cents') <> 'number' THEN
      RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023', DETAIL = 'auto_approve_max_cents';
    END IF;
    _max := (_settings->>'auto_approve_max_cents')::numeric;
    IF _max < 0 OR _max <> trunc(_max) OR _max > 2147483647 THEN
      RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023', DETAIL = 'auto_approve_max_cents';
    END IF;
  END IF;

  IF _settings ? 'auto_approve_enabled' THEN
    IF jsonb_typeof(_settings->'auto_approve_enabled') <> 'boolean' THEN
      RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023', DETAIL = 'auto_approve_enabled';
    END IF;
    _enabled := (_settings->>'auto_approve_enabled')::boolean;
  END IF;

  UPDATE public.checkalt_tenant_accounts
  SET
    auto_approve_enabled = CASE
      WHEN _settings ? 'auto_approve_enabled' THEN _enabled
      ELSE auto_approve_enabled
    END,
    auto_approve_max_cents = CASE
      WHEN _settings ? 'auto_approve_max_cents' THEN
        CASE
          WHEN jsonb_typeof(_settings->'auto_approve_max_cents') = 'null' THEN NULL
          ELSE _max::integer
        END
      ELSE auto_approve_max_cents
    END,
    updated_at = now()
  WHERE tenant_id = _tenant_id
  RETURNING * INTO _row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object(
    'tenant_id', _row.tenant_id,
    'auto_approve_enabled', _row.auto_approve_enabled,
    'auto_approve_max_cents', _row.auto_approve_max_cents
  );
END;
$body$
$fn$;
    EXECUTE $c$COMMENT ON FUNCTION public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) IS
  'Any tenant_users member or the platform owner may persist Auto-Deposit (SQL 90; was owner/admin/manager/operator in SQL 80). Updates only auto_approve_enabled and auto_approve_max_cents on the caller''s own tenant row. Does not grant generic table UPDATE.'$c$;
    EXECUTE 'REVOKE ALL ON FUNCTION public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) TO checksops, authenticated';
  END IF;
END
$$;

DROP POLICY IF EXISTS aws_write_tenant_users ON public.tenant_users;
CREATE POLICY aws_write_tenant_users ON public.tenant_users
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND (public.aws_is_cross_tenant_reader() OR public.aws_is_tenant_member(tenant_id)))
  WITH CHECK (public.aws_is_authenticated() AND (public.aws_is_cross_tenant_reader() OR public.aws_is_tenant_member(tenant_id)));

DROP POLICY IF EXISTS aws_write_tenants ON public.tenants;
CREATE POLICY aws_write_tenants ON public.tenants
  FOR UPDATE TO authenticated
  USING (public.aws_is_authenticated() AND (public.aws_is_cross_tenant_reader() OR public.aws_is_tenant_member(id)))
  WITH CHECK (public.aws_is_authenticated() AND (public.aws_is_cross_tenant_reader() OR public.aws_is_tenant_member(id)));

DO $$
BEGIN
  IF to_regclass('public.tenant_email_settings') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS aws_write_tenant_email_settings ON public.tenant_email_settings';
    EXECUTE 'CREATE POLICY aws_write_tenant_email_settings ON public.tenant_email_settings
      FOR ALL TO authenticated
      USING (public.aws_is_authenticated() AND (public.aws_is_cross_tenant_reader() OR public.aws_is_tenant_member(tenant_id)))
      WITH CHECK (public.aws_is_authenticated() AND (public.aws_is_cross_tenant_reader() OR public.aws_is_tenant_member(tenant_id)))';
  END IF;
END
$$;

-- Platform roles: the platform owner only.
DROP POLICY IF EXISTS aws_write_user_roles ON public.user_roles;
CREATE POLICY aws_write_user_roles ON public.user_roles
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))
  WITH CHECK (public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false));
