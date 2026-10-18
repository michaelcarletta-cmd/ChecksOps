-- AWS: invite a new user with the identity row first (SQL 101).
-- Forward migration on top of SQL 90 (users only, no tenant role tiers).
-- AWS only: nothing under supabase/migrations changes.
--
-- Why: on the AWS databases (staging and production) profiles.id references
-- identity_accounts(application_user_id) ON DELETE CASCADE
-- (profiles_id_identity_fkey, aws/rls/sql/25_fk_retarget.sql). SQL 90's
-- public.aws_invite_create_user_identity(uuid, text, text, text), for an email
-- with no identity and no profile, inserted the profile before the
-- identity_accounts row, so every invite of a brand-new email failed with
-- 23503 (seen on staging 2026-10-18 through Admin -> Tenants:
-- invite_identity_failed: insert or update on table "profiles" violates
-- foreign key constraint "profiles_id_identity_fkey"). The API before SQL 90
-- (tenant-admin.mjs at f78e16d99) inserted identity_accounts first.
--
-- 1) public.aws_invite_create_user_identity(uuid, text, text, text) replaced
--    with the same signature, attributes (VOLATILE, SECURITY DEFINER,
--    search_path = public, row_security = off), comment and ACL (EXECUTE
--    revoked from PUBLIC, granted to checksops and authenticated). Only the
--    new-user branch changes: when no identity row has the email, the
--    identity_accounts row (application_user_id, cognito_sub, email, status
--    'active', linked_at, created_at; ON CONFLICT DO NOTHING) is inserted
--    first, and the profile (id, email, full_name) only after the login is
--    confirmed linked to that user, and only when no profile has the email.
--    An existing profile with that email keeps its id, as in SQL 90.
--    Everything else is SQL 90's: the caller checks (member of the tenant, or
--    the platform owner's locked first invite), platform_owner_not_invitable,
--    an existing cognito_sub keeps its user, a pending identity row (no
--    cognito_sub) for the email is linked, identity_link_conflict (another
--    login on the email's identity, or the login not linked after the
--    insert), unsafe_cognito_sub, and the return value.
--
-- Not changed: no other function, no policy, grant, table, column or row.
-- Refuses to run (55000 sql101_prerequisite_missing) without SQL 90 (the
-- helpers it calls and the function it replaces) and the tables, columns and
-- roles it uses. Do not re-run SQL 90 after SQL 101: that would put the
-- profile-first insert back.
--
-- Transactions: like main's other aws/workflows/sql files this has no
-- BEGIN/COMMIT; the guarded SQL executor runs it inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change.

DO $sql101_prereq$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.aws_invite_create_user_identity(uuid, text, text, text) (SQL 90)', to_regprocedure('public.aws_invite_create_user_identity(uuid, text, text, text)')::oid),
      ('public.aws_is_tenant_member(uuid) (SQL 90)', to_regprocedure('public.aws_is_tenant_member(uuid)')::oid),
      ('public.aws_first_invite_allowed(uuid) (SQL 90)', to_regprocedure('public.aws_first_invite_allowed(uuid)')::oid),
      ('public.aws_is_platform_owner_user(uuid) (SQL 90)', to_regprocedure('public.aws_is_platform_owner_user(uuid)')::oid),
      ('auth.uid()', to_regprocedure('auth.uid()')::oid),
      ('public.identity_accounts', to_regclass('public.identity_accounts')::oid),
      ('public.profiles', to_regclass('public.profiles')::oid),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops')),
      ('role authenticated', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'authenticated'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg(want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (
      VALUES
        ('identity_accounts', 'application_user_id'), ('identity_accounts', 'cognito_sub'),
        ('identity_accounts', 'email'), ('identity_accounts', 'status'),
        ('identity_accounts', 'linked_at'), ('identity_accounts', 'created_at'),
        ('profiles', 'id'), ('profiles', 'email'), ('profiles', 'full_name')
    ) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql101_prerequisite_missing: SQL 101 needs SQL 90 applied first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;
END
$sql101_prereq$;

-- Invite: the invitee's profile and Cognito identity link. The caller must be
-- a member of _tenant_id, or the platform owner making a locked first invite.
-- Never the platform owner as invitee; never re-points an existing
-- cognito_sub; links a pending identity row (no cognito_sub yet) for the same
-- email; creates the identity row, then a profile, only when no user exists
-- (profiles.id references identity_accounts). Returns the user id.
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
  _new_profile boolean := false;
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
        _new_profile := true;
      END IF;
      IF _sub = _user::text THEN
        RAISE EXCEPTION 'unsafe_cognito_sub' USING ERRCODE = 'P0001';
      END IF;
      -- The identity row first: profiles.id references identity_accounts(application_user_id).
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
    -- Then the profile, only when no profile has the email.
    IF _new_profile THEN
      INSERT INTO public.profiles (id, email, full_name)
      VALUES (_user, _mail, NULLIF(btrim(COALESCE(_full_name, '')), ''));
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

REVOKE ALL ON FUNCTION public.aws_invite_create_user_identity(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aws_invite_create_user_identity(uuid, text, text, text) TO checksops, authenticated;
