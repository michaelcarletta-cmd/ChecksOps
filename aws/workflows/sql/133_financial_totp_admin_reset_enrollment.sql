-- SQL 133: a teammate's financial TOTP enrollment can be reset (deleted) by the server, for a
-- tenant-mate, under the same gate the API applies.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why: a verified financial TOTP enrollment can never be replaced. The API (aws/functions/api/
-- auth-financial-totp.mjs handleMfaAssociate) answers 409 enrollment_reset_required when the row has
-- verified_at, and public.financial_totp_upsert_enrollment raises verified_enrollment_exists. The only
-- reset path, the teammate reset (aws/functions/api/admin-reset-totp.mjs, User Management "Reset
-- two-factor authentication"), clears the Cognito factor and profiles.totp_enrolled_at but never the
-- public.financial_totp_enrollments row: the API connects as checksops, which holds no privilege on
-- that table (aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql revokes them),
-- and no financial_totp_* function deletes a row or clears verified_at. So the button leaves the
-- authenticator enrolled, the teammate's next enrollment still gets the 409, and a user who lost the
-- phone has no way back in. Owner 2026-10-30: "ok build the reset after SQL 131 and the lockout fix".
--
-- What this file does:
-- 1) public.financial_totp_admin_reset_enrollment(p_actor_user_id uuid, p_target_user_id uuid): new,
--    plpgsql, VOLATILE, SECURITY DEFINER, search_path = public, pg_temp, owned by the applying login
--    (the owner of the table, as the other financial_totp_* functions are). The API calls it once per
--    teammate reset, after its own checks and after it has consumed the caller's team.reset_totp
--    step-up, inside the same transaction and before it touches Cognito. The database enforces the
--    API's rules again (defense in depth), each refusal an exception so nothing is deleted:
--      a. both ids present (22023 invalid_reset); p_actor_user_id = auth.uid() (42501
--         enrollment_caller_mismatch): the caller acts only as itself;
--      b. actor != target (42501 cannot_reset_own_totp): a login that lost its second factor, or a
--         stolen session, cannot drop its own;
--      c. the target shares one of the actor's tenants (42501 reset_target_not_teammate): the API's
--         RESET_TOTP_TEAMMATE_SQL, the same tenant_users self-join, the role column not read;
--      d. the target is not the platform owner (42501 platform_owner_protected): the API's
--         RESET_TOTP_TARGET_IS_PLATFORM_OWNER_SQL, identity_accounts or profiles email
--         checksopsadmin@gmail.com (lower-cased); the owner's own recovery stays a one-off guarded
--         migration;
--      e. then DELETE the target's financial_totp_enrollments row. Returns TABLE(cleared boolean):
--         true when a row was deleted, false when the target had none (idempotent: no error).
--    Deleting the row (rather than clearing verified_at) also drops the secret, the used timestep and
--    SQL 132's failed_attempts / locked_until, so the teammate's next enrollment starts clean through
--    financial_totp_upsert_enrollment. Never returns the secret, nonce, key id or any timestamp; the
--    reset is recorded by the API's step-up consumption row (financial_stepup_log, action
--    team.reset_totp.consumed, metadata.target_user_id), which commits in the same transaction.
-- 2) EXECUTE: REVOKE ALL FROM PUBLIC (a new function is otherwise executable by every login), then
--    GRANT EXECUTE TO checksops (the API login). The owner keeps its own. The ACL is checksops and the
--    owner, as the proposed file's functions, SQL 130, SQL 131 and SQL 132 leave theirs.
--
-- Not changed: no table, column, policy, RLS setting, table grant, trigger or row; no other function
-- (financial_totp_get_enrollment, financial_totp_mark_verified, financial_totp_upsert_enrollment,
-- financial_totp_status, SQL 130's consume_financial_totp_rate_limit and SQL 132's
-- financial_totp_count_code_check keep their bodies and ACLs). No self-service reset: a user cannot
-- reset their own enrollment through this function or any other path. Cognito and profiles are the
-- API's, as before.
--
-- Refuses to run (55000 sql133_prerequisite_missing) without public.financial_totp_enrollments,
-- public.tenant_users, public.identity_accounts, public.profiles and the columns it reads, auth.uid()
-- and role checksops, and (55000 sql133_definer_cannot_reach) unless the applying login owns each of
-- those four relations without FORCE ROW LEVEL SECURITY (or is a superuser or BYPASSRLS): a DEFINER
-- function whose owner cannot delete the enrollment row, or whose gate reads were filtered by RLS,
-- would refuse every teammate reset or let one through on a partial view.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL
-- executor runs it inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change.

DO $sql133_prereq$
DECLARE
  v_missing text[];
  v_unreachable text;
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.financial_totp_enrollments', pg_catalog.to_regclass('public.financial_totp_enrollments')::oid),
      ('public.tenant_users', pg_catalog.to_regclass('public.tenant_users')::oid),
      ('public.identity_accounts', pg_catalog.to_regclass('public.identity_accounts')::oid),
      ('public.profiles', pg_catalog.to_regclass('public.profiles')::oid),
      ('auth.uid()', pg_catalog.to_regprocedure('auth.uid()')::oid),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg('column public.' || want.tbl || '.' || want.col ORDER BY want.tbl, want.col) INTO v_missing
    FROM (VALUES
      ('financial_totp_enrollments', 'application_user_id'),
      ('tenant_users', 'tenant_id'), ('tenant_users', 'user_id'),
      ('identity_accounts', 'application_user_id'), ('identity_accounts', 'email'),
      ('profiles', 'id'), ('profiles', 'email')) AS want(tbl, col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = want.tbl AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql133_prerequisite_missing: SQL 133 needs the financial TOTP enrollment, tenant membership and identity schema first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  SELECT string_agg(t.oid::regclass::text, ', ' ORDER BY t.oid::regclass::text) INTO v_unreachable
  FROM pg_catalog.pg_class t
  JOIN pg_catalog.pg_roles me ON me.rolname = current_user
  WHERE t.oid IN (pg_catalog.to_regclass('public.financial_totp_enrollments'), pg_catalog.to_regclass('public.tenant_users'),
                  pg_catalog.to_regclass('public.identity_accounts'), pg_catalog.to_regclass('public.profiles'))
    AND NOT (me.rolsuper OR me.rolbypassrls
             OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity));
  IF v_unreachable IS NOT NULL THEN
    RAISE EXCEPTION 'sql133_definer_cannot_reach: the login running SQL 133 must own % (without FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS',
      v_unreachable
      USING ERRCODE = '55000';
  END IF;
END
$sql133_prereq$;

CREATE OR REPLACE FUNCTION public.financial_totp_admin_reset_enrollment(p_actor_user_id uuid, p_target_user_id uuid)
RETURNS TABLE(cleared boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted boolean;
BEGIN
  IF p_actor_user_id IS NULL OR p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid_reset'
      USING ERRCODE = '22023';
  END IF;
  IF p_actor_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'enrollment_caller_mismatch'
      USING ERRCODE = '42501';
  END IF;
  -- Resetting your own second factor here would let a session that lost it (or a stolen session)
  -- drop it without the factor (the API's cannot_reset_own_totp).
  IF p_actor_user_id = p_target_user_id THEN
    RAISE EXCEPTION 'cannot_reset_own_totp'
      USING ERRCODE = '42501';
  END IF;
  -- Owner policy, as the API's RESET_TOTP_TEAMMATE_SQL: the target shares one of the actor's tenants
  -- (the role column is not read); partners and other tenants do not act.
  IF NOT EXISTS (
    SELECT 1
      FROM public.tenant_users mine
      JOIN public.tenant_users theirs ON theirs.tenant_id = mine.tenant_id
     WHERE mine.user_id = p_actor_user_id
       AND theirs.user_id = p_target_user_id
  ) THEN
    RAISE EXCEPTION 'reset_target_not_teammate'
      USING ERRCODE = '42501';
  END IF;
  -- Nobody resets the platform owner (the API's RESET_TOTP_TARGET_IS_PLATFORM_OWNER_SQL: identity or
  -- profile email); the owner's own recovery is a one-off guarded migration.
  IF EXISTS (
    SELECT 1
      FROM public.identity_accounts ia
     WHERE ia.application_user_id = p_target_user_id
       AND lower(ia.email) = 'checksopsadmin@gmail.com'
  ) OR EXISTS (
    SELECT 1
      FROM public.profiles p
     WHERE p.id = p_target_user_id
       AND lower(p.email) = 'checksopsadmin@gmail.com'
  ) THEN
    RAISE EXCEPTION 'platform_owner_protected'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.financial_totp_enrollments AS e
   WHERE e.application_user_id = p_target_user_id;
  v_deleted := FOUND;

  RETURN QUERY SELECT v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.financial_totp_admin_reset_enrollment(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.financial_totp_admin_reset_enrollment(uuid, uuid) TO checksops;
