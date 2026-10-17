-- AWS: users only, no tenant role tiers (SQL 90).
-- Forward migration on top of aws/rls/sql (02_helpers, 10_owner_helpers,
-- 11_access_helpers, 20_write_helpers, 21_proposed_write_policies,
-- 24_complete_write_policies, 29_mortgage_ops_library_parity,
-- 35_manager_partner_parity) and aws/workflows/sql 80. Refuses to run (55000
-- sql90_prerequisite_missing) when the objects it changes are absent.
--
-- Owner policy:
--   - Every member of a tenant (any tenant_users row for it) is a user with the
--     same rights: check work, deposits, payments, inviting and removing
--     teammates, resetting a teammate's 2FA, company settings, email sender,
--     tax setup, Compliance & Docs, the Auto-Deposit threshold.
--     tenant_users.role is ignored by authorization. This file does not change
--     the tenant_role enum and does not rewrite tenant_users.role data.
--   - Partners (users of other tenants on shared checks) stay read-only; other
--     tenants get nothing.
--   - No global user_roles admin/staff write path anywhere.
--   - The platform owner (aws_is_cross_tenant_reader(), is_platform_owner())
--     writes tenant data only where its listed duties need it. Its tenant
--     write branch is removed from aws_can_write_tenant / aws_can_write_check /
--     aws_can_write_claim and from the tenants UPDATE, tenant_email_settings,
--     tenant_users, deposit_batches, homeowner_check_uploads, referral_events
--     and tenant_partnerships policies.
--
--   Platform-owner writes kept (each for a listed duty):
--     * tenants INSERT (tenant create): aws_insert_tenants (new).
--     * tenant_users INSERT, first invite only: aws_insert_tenant_users, when
--       the tenant has no members (counted under the first-invite advisory
--       lock, aws_first_invite_allowed) and the invitee is not the platform
--       owner. The invitee's profile and Cognito link are created by the
--       DEFINER aws_invite_create_user_identity (members and the locked first
--       invite only).
--     * profiles INSERT (mortgage agent hire): aws_platform_owner_insert_profiles.
--     * contractor_profiles UPDATE (Contractor Pro approval):
--       aws_platform_owner_update_contractor_profiles.
--     * Its own user-scoped rows (sessions, notification preferences, ...):
--       aws_can_write_same_tenant_user(own id). It no longer writes other users'
--       user-scoped rows (pii_reveal_logs, user_sessions, notification_*,
--       deposit_notification_prefs, referrers, role_version_tracker).
--     * Check Alt setup: checkalt_tenant_accounts (aws_write_checkalt_tenant_
--       accounts, now platform owner only), SQL 81 registration (DEFINER),
--       checkalt_config (unchanged).
--     * Mortgage compensation, Return to Queue and Adjust: SQL 84/85/86
--       DEFINER functions (unchanged).
--     * platform_announcements and the other platform-only tables of SQL 24
--       (unchanged).
--     * user_roles: aws_write_user_roles, platform owner only.
--     * Platform bank / treasury: the platform's own Moov account (API only;
--       no tenant table write).
--
-- 1) aws_is_tenant_member(t) (new): auth.uid() has a tenant_users row for t.
--    SECURITY DEFINER, search_path=public, row_security=off, so policy checks
--    read tenant_users without re-entering its RLS.
-- 2) aws_can_write_tenant(t) = authenticated AND t IS NOT NULL AND
--    aws_is_tenant_member(t). aws_can_write_check(c) and aws_can_write_claim(c)
--    = the owning tenant's aws_can_write_tenant (their top-level
--    cross-tenant-reader branch is removed). Every aws_write_* policy built on
--    them follows. Partners stay read-only: aws_can_write_check is owner-tenant
--    only.
-- 3) aws_can_write_same_tenant_user(u) = authenticated AND u IS NOT NULL AND
--    (auth.uid() shares a tenant with u, OR u is the platform owner's own id).
-- 4) aws_can_access_tax_profiles(t) = aws_is_tenant_member(t). No platform-owner
--    or user_roles admin branch (the API matches: tax-secrets evaluateTaxAccess).
-- 5) aws_is_tenant_manager_admin() (SQL 35) = authenticated AND platform
--    owner. SQL 35's checkalt_config_public (platform-wide merchant, fi_key,
--    depositor account) is the platform owner's only. SQL 35's
--    deposit_provider_config_public shows members only the provider name and
--    status (capabilities stay with the platform owner). Members read their
--    own tenant's Check Alt status through is_checkalt_enabled_for_tenant and
--    checkalt_tenant_auto_deposit_public. Replaced only if present.
-- 6) aws_can_manage_mortgage_library(t) (SQL 29) = authenticated AND t IS NOT
--    NULL AND aws_can_write_tenant(t). Replaced only if present.
-- 7) aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) (SQL 80): the caller
--    must be a member of _tenant_id (a tenant setting; the platform owner is
--    refused); everything else is SQL 80's body unchanged. Replaced only if
--    present.
-- 8) Helpers (new): aws_tenant_has_no_members(t), aws_is_platform_owner_user(u),
--    aws_has_any_tenant_membership(), aws_first_invite_allowed(t) (takes the
--    first-invite advisory lock), and the DEFINER writers
--    aws_invite_create_user_identity(t, email, name, cognito_sub) and
--    aws_create_deposit_batch_for_item(item, provider) (assign_provider without
--    a batch: an empty batch cannot pass the deposit_batches policy).
-- 9) Policies (DROP IF EXISTS + CREATE):
--    - tenant_users: aws_write_tenant_users (FOR ALL) is replaced by
--      aws_insert_tenant_users (member of the row's tenant, or the platform
--      owner's first invite; never the platform owner as invitee) and
--      aws_delete_tenant_users (member). No UPDATE policy, so tenant_users.role
--      cannot be changed under RLS.
--    - aws_write_tenants (FOR UPDATE): member. aws_insert_tenants (FOR INSERT):
--      platform owner.
--    - aws_write_tenant_email_settings (when the table exists): member.
--    - aws_write_checkalt_tenant_accounts (when present): platform owner.
--    - aws_write_deposit_batches, aws_write_homeowner_check_uploads,
--      aws_write_referral_events, aws_write_tenant_partnerships (when
--      present): SQL 24's policy without the cross-tenant-reader branch.
--    - aws_write_user_roles: the platform owner only (is_platform_owner()).
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
      ('public.aws_can_write_check(uuid)', to_regprocedure('public.aws_can_write_check(uuid)')::oid),
      ('public.aws_can_write_claim(uuid)', to_regprocedure('public.aws_can_write_claim(uuid)')::oid),
      ('public.check_intake_items', to_regclass('public.check_intake_items')::oid),
      ('public.claims', to_regclass('public.claims')::oid),
      ('public.identity_accounts', to_regclass('public.identity_accounts')::oid),
      ('public.profiles', to_regclass('public.profiles')::oid),
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
     AND public.aws_is_tenant_member(_tenant_id);
$$;

COMMENT ON FUNCTION public.aws_can_write_tenant(uuid) IS
  'Write allowed only when auth.uid() is a tenant_users member of _tenant_id. The platform owner, global admin/staff without membership, partners and other tenants are denied; no role tiers (SQL 90).';

CREATE OR REPLACE FUNCTION public.aws_can_write_check(_check_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.check_intake_items ci
    WHERE ci.id = _check_id
      AND public.aws_can_write_tenant(ci.tenant_id)
  );
$$;

COMMENT ON FUNCTION public.aws_can_write_check(uuid) IS
  'Owner-tenant members only (aws_can_write_tenant of the check tenant). No platform-owner branch. Do not add shared_checks or aws_can_access_check here; partner read must not become write (SQL 90).';

CREATE OR REPLACE FUNCTION public.aws_can_write_claim(_claim_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.claims c
    WHERE c.id = _claim_id
      AND public.aws_can_write_tenant(c.org_id)
  );
$$;

COMMENT ON FUNCTION public.aws_can_write_claim(uuid) IS
  'Members of the claim tenant (org_id) only. No platform-owner branch (SQL 90).';

-- True when the tenant has no tenant_users rows yet (the platform owner's
-- first invite). DEFINER so the check sees every row of the tenant.
CREATE OR REPLACE FUNCTION public.aws_tenant_has_no_members(_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT _tenant_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.tenant_users tu WHERE tu.tenant_id = _tenant_id
     );
$$;

COMMENT ON FUNCTION public.aws_tenant_has_no_members(uuid) IS
  'True when _tenant_id has no tenant_users rows. Gates the platform owner''s first invite (SQL 90).';

-- True when _user_id is the platform owner (the same identity / profile email
-- rule as is_platform_owner(), for another user).
CREATE OR REPLACE FUNCTION public.aws_is_platform_owner_user(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT _user_id IS NOT NULL
     AND (
       EXISTS (
         SELECT 1
         FROM public.identity_accounts ia
         WHERE ia.application_user_id = _user_id
           AND lower(ia.email) = 'checksopsadmin@gmail.com'
       )
       OR EXISTS (
         SELECT 1
         FROM public.profiles p
         WHERE p.id = _user_id
           AND lower(p.email) = 'checksopsadmin@gmail.com'
       )
     );
$$;

COMMENT ON FUNCTION public.aws_is_platform_owner_user(uuid) IS
  'True when _user_id is the platform owner (identity or profile email, as is_platform_owner()). The platform owner is never a tenant member (SQL 90).';

-- True when auth.uid() has any tenant_users row.
CREATE OR REPLACE FUNCTION public.aws_has_any_tenant_membership()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.user_id = auth.uid());
$$;

COMMENT ON FUNCTION public.aws_has_any_tenant_membership() IS
  'True when auth.uid() is a member of any tenant (SQL 90).';

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
       EXISTS (
         SELECT 1
         FROM public.tenant_users mine
         JOIN public.tenant_users theirs ON theirs.tenant_id = mine.tenant_id
         WHERE mine.user_id = auth.uid()
           AND theirs.user_id = _user_id
       )
       OR (_user_id = auth.uid() AND COALESCE(public.is_platform_owner(), false))
     );
$$;

COMMENT ON FUNCTION public.aws_can_write_same_tenant_user(uuid) IS
  'Write a user-scoped row when authenticated and sharing a tenant with that user. The platform owner (no tenant membership) writes only its own rows; its kept cross-user writes are dedicated policies (profiles INSERT, contractor_profiles UPDATE). No global admin/staff requirement and no role tiers (SQL 90).';

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
REVOKE ALL ON FUNCTION public.aws_can_write_check(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_write_claim(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_tenant_has_no_members(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_is_platform_owner_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_has_any_tenant_membership() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_write_same_tenant_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_can_access_tax_profiles(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_is_tenant_member(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_write_tenant(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_write_check(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_write_claim(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_tenant_has_no_members(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_is_platform_owner_user(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_has_any_tenant_membership() TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_write_same_tenant_user(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_can_access_tax_profiles(uuid) TO checksops, authenticated;

-- The platform owner's first invite, serialized per tenant: takes the same
-- transaction advisory lock as the API (first-invite:<tenant>), then counts.
-- VOLATILE so the count after the lock sees a concurrent invite that
-- committed while this one waited.
CREATE OR REPLACE FUNCTION public.aws_first_invite_allowed(_tenant_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
BEGIN
  IF _tenant_id IS NULL OR NOT COALESCE(public.is_platform_owner(), false) THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('first-invite:' || _tenant_id::text, 0));
  RETURN NOT EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.tenant_id = _tenant_id);
END;
$$;

COMMENT ON FUNCTION public.aws_first_invite_allowed(uuid) IS
  'True when the caller is the platform owner and _tenant_id has no members, counted under the first-invite advisory lock (SQL 90).';

-- Invite: the invitee's profile and Cognito identity link. The caller must be
-- a member of _tenant_id, or the platform owner making a locked first invite.
-- Never the platform owner as invitee; never re-points an existing
-- cognito_sub; links a pending identity row (no cognito_sub yet) for the same
-- email; creates a profile only when no user exists. Returns the user id.
-- The membership itself is inserted by the API under aws_insert_tenant_users.
CREATE OR REPLACE FUNCTION public.aws_invite_create_user_identity(
  _tenant_id uuid,
  _email text,
  _full_name text,
  _cognito_sub text
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  _mail text := lower(btrim(COALESCE(_email, '')));
  _sub text := btrim(COALESCE(_cognito_sub, ''));
  _user uuid;
  _linked_sub text;
BEGIN
  IF auth.uid() IS NULL OR _tenant_id IS NULL OR _mail = '' OR _sub = '' THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;
  IF NOT (public.aws_is_tenant_member(_tenant_id) OR public.aws_first_invite_allowed(_tenant_id)) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF _mail = 'checksopsadmin@gmail.com' THEN
    RAISE EXCEPTION 'platform_owner_not_invitable' USING ERRCODE = '42501';
  END IF;

  -- An existing login keeps the user it is linked to.
  SELECT ia.application_user_id INTO _user
    FROM public.identity_accounts ia
   WHERE ia.cognito_sub = _sub;

  IF _user IS NULL THEN
    SELECT ia.application_user_id, ia.cognito_sub INTO _user, _linked_sub
      FROM public.identity_accounts ia
     WHERE lower(ia.email) = _mail
     LIMIT 1;
    IF _user IS NOT NULL AND _linked_sub IS NOT NULL THEN
      -- That user is linked to another login: never re-point it.
      RAISE EXCEPTION 'identity_link_conflict' USING ERRCODE = 'P0001';
    END IF;
    IF _user IS NOT NULL THEN
      UPDATE public.identity_accounts
         SET cognito_sub = _sub, status = 'active', linked_at = COALESCE(linked_at, now())
       WHERE application_user_id = _user
         AND cognito_sub IS NULL;
    ELSE
      SELECT p.id INTO _user FROM public.profiles p WHERE lower(p.email) = _mail LIMIT 1;
      IF _user IS NULL THEN
        _user := gen_random_uuid();
        INSERT INTO public.profiles (id, email, full_name)
        VALUES (_user, _mail, NULLIF(btrim(COALESCE(_full_name, '')), ''));
      END IF;
      IF _sub = _user::text THEN
        RAISE EXCEPTION 'unsafe_cognito_sub' USING ERRCODE = 'P0001';
      END IF;
      INSERT INTO public.identity_accounts (application_user_id, cognito_sub, email, status, linked_at, created_at)
      VALUES (_user, _sub, _mail, 'active', now(), now())
      ON CONFLICT DO NOTHING;
    END IF;
    -- Whatever happened above, the login must now be linked to _user.
    IF NOT EXISTS (
      SELECT 1 FROM public.identity_accounts ia
       WHERE ia.cognito_sub = _sub AND ia.application_user_id = _user
    ) THEN
      RAISE EXCEPTION 'identity_link_conflict' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF public.aws_is_platform_owner_user(_user) THEN
    RAISE EXCEPTION 'platform_owner_not_invitable' USING ERRCODE = '42501';
  END IF;
  RETURN _user;
END;
$$;

COMMENT ON FUNCTION public.aws_invite_create_user_identity(uuid, text, text, text) IS
  'Invite: creates or finds the invitee profile and Cognito link for a member of _tenant_id or the platform owner''s locked first invite. Refuses the platform owner; never re-points a cognito_sub (SQL 90).';

-- assign_provider without a batch: a new batch has no deposit items yet, so
-- no RLS policy (membership through the batch's items) can admit it. The
-- caller must be a member of the deposit item's check tenant and the item
-- must be pending assignment.
CREATE OR REPLACE FUNCTION public.aws_create_deposit_batch_for_item(_deposit_item_id uuid, _provider text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  _tenant uuid;
  _amount numeric;
  _status text;
  _id uuid;
BEGIN
  IF auth.uid() IS NULL OR _deposit_item_id IS NULL OR NULLIF(btrim(COALESCE(_provider, '')), '') IS NULL THEN
    RAISE EXCEPTION 'missing_required_field' USING ERRCODE = '22023';
  END IF;
  SELECT ci.tenant_id, di.amount, di.status::text
    INTO _tenant, _amount, _status
    FROM public.deposit_items di
    JOIN public.check_intake_items ci ON ci.id = di.check_id
   WHERE di.id = _deposit_item_id
     FOR UPDATE OF di;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.aws_is_tenant_member(_tenant) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;
  IF _status IS DISTINCT FROM 'pending_assignment' THEN
    RAISE EXCEPTION 'invalid_status' USING ERRCODE = 'P0001';
  END IF;
  EXECUTE 'INSERT INTO public.deposit_batches (provider, total_items, total_amount, created_by)
           VALUES ($1::public.deposit_provider, 1, $2, $3) RETURNING id'
     INTO _id
    USING _provider, COALESCE(_amount, 0), auth.uid();
  RETURN _id;
END;
$$;

COMMENT ON FUNCTION public.aws_create_deposit_batch_for_item(uuid, text) IS
  'Creates a one-item deposit batch for a pending deposit item of a tenant the caller is a member of (assign_provider without a batch). Members only (SQL 90).';

REVOKE ALL ON FUNCTION public.aws_first_invite_allowed(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_invite_create_user_identity(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aws_create_deposit_batch_for_item(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_first_invite_allowed(uuid) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_invite_create_user_identity(uuid, text, text, text) TO checksops, authenticated;
GRANT EXECUTE ON FUNCTION public.aws_create_deposit_batch_for_item(uuid, text) TO checksops, authenticated;

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
     AND public.aws_is_cross_tenant_reader();
$body$
$fn$;
    EXECUTE $c$COMMENT ON FUNCTION public.aws_is_tenant_manager_admin() IS
  'Platform owner only. Gates SQL 35 checkalt_config_public (platform-wide merchant, fi_key, depositor account) and the full deposit_provider_config_public row. Members read their own tenant''s Check Alt status through is_checkalt_enabled_for_tenant / checkalt_tenant_auto_deposit_public (SQL 90).'$c$;
  END IF;

  -- SQL 35 deposit_provider_config_public: members of any tenant see only the
  -- provider name and status the Deposit Ops console shows; capabilities
  -- stay with the platform owner. Same columns, so CREATE OR REPLACE keeps
  -- the grants.
  IF to_regclass('public.deposit_provider_config_public') IS NOT NULL THEN
    EXECUTE $v$
CREATE OR REPLACE VIEW public.deposit_provider_config_public
WITH (security_barrier = true, security_invoker = false)
AS
SELECT
  id,
  provider,
  display_name,
  is_active,
  is_stubbed,
  CASE WHEN public.aws_is_tenant_manager_admin() THEN capabilities END AS capabilities,
  created_at,
  updated_at
FROM public.deposit_provider_config
WHERE public.aws_is_tenant_manager_admin()
   OR public.aws_has_any_tenant_membership()
$v$;
    EXECUTE $c$COMMENT ON VIEW public.deposit_provider_config_public IS
  'Deposit provider name and status for tenant members (Deposit Ops console); capabilities only for the platform owner. Omits secret config JSON. Read-only (SQL 90).'$c$;
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
  'Any tenant_users member of _tenant_id (aws_can_write_tenant, members only; the platform owner is not a writer). Mortgage agents cannot backfill. No role tiers (SQL 90).'$c$;
  END IF;
END
$$;

-- SQL 80 Check Alt Auto-Deposit save: any member of the tenant (a tenant
-- setting, not Check Alt setup; the platform owner does not change it).
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

  IF NOT EXISTS (
    SELECT 1
    FROM public.tenant_users tu
    WHERE tu.user_id = auth.uid()
      AND tu.tenant_id = _tenant_id
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
  'Any tenant_users member of the tenant may persist Auto-Deposit; the platform owner may not (SQL 90; was platform owner or owner/admin/manager/operator in SQL 80). Updates only auto_approve_enabled and auto_approve_max_cents on the caller''s own tenant row. Does not grant generic table UPDATE.'$c$;
    EXECUTE 'REVOKE ALL ON FUNCTION public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.aws_save_checkalt_tenant_auto_deposit(uuid, jsonb) TO checksops, authenticated';
  END IF;
END
$$;

-- tenant_users: members add and remove teammates of their own tenant. The
-- platform owner may only make a tenant's first invite: the tenant has no
-- members yet, and the invitee is not the platform owner. The platform owner
-- is never added to a tenant by anyone. No UPDATE policy: tenant_users rows
-- (tenant_users.role included) are never updated under RLS.
DROP POLICY IF EXISTS aws_write_tenant_users ON public.tenant_users;
DROP POLICY IF EXISTS aws_insert_tenant_users ON public.tenant_users;
DROP POLICY IF EXISTS aws_delete_tenant_users ON public.tenant_users;
CREATE POLICY aws_insert_tenant_users ON public.tenant_users
  FOR INSERT TO authenticated
  WITH CHECK (
    public.aws_is_authenticated()
    AND NOT public.aws_is_platform_owner_user(user_id)
    AND (
      public.aws_is_tenant_member(tenant_id)
      OR (
        COALESCE(public.is_platform_owner(), false)
        AND public.aws_first_invite_allowed(tenant_id)
      )
    )
  );
CREATE POLICY aws_delete_tenant_users ON public.tenant_users
  FOR DELETE TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_tenant_member(tenant_id));

-- tenants: members update their own tenant; the platform owner creates
-- tenants (onboarding) and does not edit them.
DROP POLICY IF EXISTS aws_write_tenants ON public.tenants;
CREATE POLICY aws_write_tenants ON public.tenants
  FOR UPDATE TO authenticated
  USING (public.aws_is_authenticated() AND public.aws_is_tenant_member(id))
  WITH CHECK (public.aws_is_authenticated() AND public.aws_is_tenant_member(id));
DROP POLICY IF EXISTS aws_insert_tenants ON public.tenants;
CREATE POLICY aws_insert_tenants ON public.tenants
  FOR INSERT TO authenticated
  WITH CHECK (public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false));

DO $$
BEGIN
  -- Email sender: members of the tenant only.
  IF to_regclass('public.tenant_email_settings') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS aws_write_tenant_email_settings ON public.tenant_email_settings';
    EXECUTE 'CREATE POLICY aws_write_tenant_email_settings ON public.tenant_email_settings
      FOR ALL TO authenticated
      USING (public.aws_is_authenticated() AND public.aws_is_tenant_member(tenant_id))
      WITH CHECK (public.aws_is_authenticated() AND public.aws_is_tenant_member(tenant_id))';
  END IF;

  -- Check Alt setup (the tenant depositor account) is a platform-owner duty.
  -- Members change Auto-Deposit through aws_save_checkalt_tenant_auto_deposit
  -- (DEFINER), and production registration runs through SQL 81 (DEFINER).
  IF to_regclass('public.checkalt_tenant_accounts') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS aws_write_checkalt_tenant_accounts ON public.checkalt_tenant_accounts';
    EXECUTE 'CREATE POLICY aws_write_checkalt_tenant_accounts ON public.checkalt_tenant_accounts
      FOR ALL TO authenticated
      USING (public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))
      WITH CHECK (public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))';
  END IF;

  -- The platform owner's kept cross-user writes, per table: profiles INSERT
  -- (mortgage agent hire) and contractor_profiles UPDATE (Pro approval).
  IF to_regclass('public.profiles') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS aws_platform_owner_insert_profiles ON public.profiles';
    EXECUTE 'CREATE POLICY aws_platform_owner_insert_profiles ON public.profiles
      FOR INSERT TO authenticated
      WITH CHECK (public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))';
  END IF;
  IF to_regclass('public.contractor_profiles') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS aws_platform_owner_update_contractor_profiles ON public.contractor_profiles';
    EXECUTE 'CREATE POLICY aws_platform_owner_update_contractor_profiles ON public.contractor_profiles
      FOR UPDATE TO authenticated
      USING (public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))
      WITH CHECK (public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))';
  END IF;

  -- Tenant data with a direct cross-tenant-reader write branch in SQL 24: the
  -- branch is removed, the member/owner branches are unchanged.
  IF to_regclass('public.deposit_batches') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS aws_write_deposit_batches ON public.deposit_batches';
    EXECUTE 'CREATE POLICY aws_write_deposit_batches ON public.deposit_batches
      FOR ALL TO authenticated
      USING (EXISTS ( SELECT 1 FROM public.deposit_items di JOIN public.check_intake_items ci ON ci.id = di.check_id WHERE di.batch_id = deposit_batches.id AND public.aws_can_write_tenant(ci.tenant_id)))
      WITH CHECK (EXISTS ( SELECT 1 FROM public.deposit_items di JOIN public.check_intake_items ci ON ci.id = di.check_id WHERE di.batch_id = deposit_batches.id AND public.aws_can_write_tenant(ci.tenant_id)))';
  END IF;
  IF to_regclass('public.homeowner_check_uploads') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS aws_write_homeowner_check_uploads ON public.homeowner_check_uploads';
    EXECUTE 'CREATE POLICY aws_write_homeowner_check_uploads ON public.homeowner_check_uploads
      FOR ALL TO authenticated
      USING (public.aws_is_authenticated() AND (contractor_user_id = auth.uid() OR public.aws_can_write_check(converted_check_id)))
      WITH CHECK (public.aws_is_authenticated() AND (contractor_user_id = auth.uid() OR public.aws_can_write_check(converted_check_id)))';
  END IF;
  IF to_regclass('public.referral_events') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS aws_write_referral_events ON public.referral_events';
    EXECUTE 'CREATE POLICY aws_write_referral_events ON public.referral_events
      FOR ALL TO authenticated
      USING (public.aws_can_write_tenant(referrer_tenant_id) OR public.aws_can_write_tenant(referred_tenant_id))
      WITH CHECK (public.aws_can_write_tenant(referrer_tenant_id) OR public.aws_can_write_tenant(referred_tenant_id))';
  END IF;
  IF to_regclass('public.tenant_partnerships') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS aws_write_tenant_partnerships ON public.tenant_partnerships';
    EXECUTE 'CREATE POLICY aws_write_tenant_partnerships ON public.tenant_partnerships
      FOR ALL TO authenticated
      USING (public.aws_can_write_tenant(inviter_tenant_id) OR public.aws_can_write_tenant(invitee_tenant_id))
      WITH CHECK (public.aws_can_write_tenant(inviter_tenant_id) OR public.aws_can_write_tenant(invitee_tenant_id))';
  END IF;
END
$$;

-- Platform roles: the platform owner only.
DROP POLICY IF EXISTS aws_write_user_roles ON public.user_roles;
CREATE POLICY aws_write_user_roles ON public.user_roles
  FOR ALL TO authenticated
  USING (public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false))
  WITH CHECK (public.aws_is_authenticated() AND COALESCE(public.is_platform_owner(), false));
