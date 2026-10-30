-- SQL 132: financial TOTP lockout after repeated code checks without a success.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why: public.financial_totp_enrollments has failed_attempts and locked_until
-- (aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql, the live definition
-- per the read-only financial TOTP inspect of production on 2026-10-30, SSM
-- cfee4512-4988-4fd1-be77-b03d1b4cd50b), but nothing ever increments failed_attempts or sets
-- locked_until: financial_totp_get_enrollment(uuid) only returns them and
-- financial_totp_mark_verified(uuid, bigint) only resets them on a success. The API connects as
-- checksops, which holds no privilege on the table (the proposed file revokes them), so it cannot keep
-- the counter itself. The only bound on guessing a 6-digit authenticator code is the rate limit of
-- SQL 130 (consume_financial_totp_rate_limit, action code_check, 5 per 300 s per user): about 1440
-- guesses a day, for ever.
--
-- What this file does:
-- 1) public.financial_totp_count_code_check(p_user_id uuid): new, plpgsql, VOLATILE, SECURITY DEFINER,
--    search_path = public, pg_temp, owned by the applying login (the owner of the table, as the other
--    financial_totp_* functions are). The API calls it once per code check, after it has read the
--    enrollment and before it compares the code, and commits the count before the comparison, so a
--    wrong code (which fails the request and rolls it back) still counts.
--      a. p_user_id must not be NULL (22023 invalid_enrollment) and must be auth.uid() (42501
--         enrollment_caller_mismatch): a caller can neither count against nor read another user's row.
--      b. While the row is locked (locked_until > now()) it changes nothing and returns allowed false
--         with the seconds left; the API then refuses without comparing the code, with the same answer
--         as a wrong code.
--      c. Otherwise, in one UPDATE of the user's row, failed_attempts + 1; when that reaches 10 the row
--         is locked for 15 minutes (locked_until = now() + 15 minutes). Returns allowed true and the new
--         count. The row lock serializes concurrent checks, and the UPDATE re-reads the row after waiting
--         for it, so no check slips past a lock another check has just set. Every check is counted
--         before its code is compared; a correct code is cleared by financial_totp_mark_verified, which
--         already sets failed_attempts 0 and locked_until NULL (unchanged), so failed_attempts counts the
--         consecutive checks without a success. An expired lock does not reset the count: after the
--         first lockout each further check without a success locks the row again, until a correct code.
--      d. No enrollment row: no row returned (the API answers not enrolled).
--    Returns TABLE(allowed boolean, failed_attempts integer, retry_after_seconds integer). Never returns
--    the secret, nonce, key id or any timestamp.
--    Why 10 and 15 minutes: the rate limit already stops the sixth check inside 300 s, so a person with
--    an authenticator never reaches ten consecutive failures by mistyping; ten failures need at least two
--    rate-limit windows of nothing but wrong codes. 15 minutes is three rate-limit windows, so guessing
--    drops from 1440 codes a day to about 96 (one per 15 minutes once locked), while a real user who
--    mistypes after a lockout waits 15 minutes, not longer.
-- 2) EXECUTE: REVOKE ALL FROM PUBLIC (a new function is otherwise executable by every login), then
--    GRANT EXECUTE TO checksops (the API login). The owner keeps its own. The ACL is checksops and the
--    owner, as the proposed file's functions and SQL 130 pair theirs.
--
-- Not changed: no table, column, policy, RLS setting, table grant, trigger or row; no other function
-- (financial_totp_get_enrollment, financial_totp_mark_verified, financial_totp_upsert_enrollment,
-- financial_totp_status and SQL 130's consume_financial_totp_rate_limit keep their bodies and ACLs).
-- Not a reset path: nothing here clears a lock; a correct code does, as before.
--
-- Refuses to run (55000 sql132_prerequisite_missing) without public.financial_totp_enrollments and
-- the three columns it uses, public.financial_totp_mark_verified(uuid, bigint), auth.uid() and role
-- checksops, and (55000 sql132_definer_cannot_write) unless the applying login owns
-- public.financial_totp_enrollments without FORCE ROW LEVEL SECURITY (or is a superuser or BYPASSRLS):
-- a DEFINER function whose owner cannot write the row would make every code check fail.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL
-- executor runs it inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change.

DO $sql132_prereq$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.financial_totp_enrollments', pg_catalog.to_regclass('public.financial_totp_enrollments')::oid),
      ('public.financial_totp_mark_verified(uuid, bigint)', pg_catalog.to_regprocedure('public.financial_totp_mark_verified(uuid, bigint)')::oid),
      ('auth.uid()', pg_catalog.to_regprocedure('auth.uid()')::oid),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg('column public.financial_totp_enrollments.' || want.col ORDER BY want.col) INTO v_missing
    FROM (VALUES ('application_user_id'), ('failed_attempts'), ('locked_until')) AS want(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = 'financial_totp_enrollments' AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql132_prerequisite_missing: SQL 132 needs the financial TOTP enrollment schema first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class t
    JOIN pg_catalog.pg_roles me ON me.rolname = current_user
    WHERE t.oid = pg_catalog.to_regclass('public.financial_totp_enrollments')
      AND NOT (me.rolsuper OR me.rolbypassrls
               OR (pg_catalog.pg_has_role(current_user, t.relowner, 'USAGE') AND NOT t.relforcerowsecurity))
  ) THEN
    RAISE EXCEPTION 'sql132_definer_cannot_write: the login running SQL 132 must own public.financial_totp_enrollments (without FORCE ROW LEVEL SECURITY), or be a superuser or BYPASSRLS'
      USING ERRCODE = '55000';
  END IF;
END
$sql132_prereq$;

CREATE OR REPLACE FUNCTION public.financial_totp_count_code_check(p_user_id uuid)
RETURNS TABLE(allowed boolean, failed_attempts integer, retry_after_seconds integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := now();
  v_attempts integer;
  v_locked_until timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid_enrollment'
      USING ERRCODE = '22023';
  END IF;
  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'enrollment_caller_mismatch'
      USING ERRCODE = '42501';
  END IF;

  -- One check counted, and the row locked when this check is the tenth without a success. The
  -- WHERE is re-evaluated against the latest row version once the row lock is acquired, so a check
  -- waiting behind the one that locks the row sees the lock and updates nothing.
  UPDATE public.financial_totp_enrollments AS e
     SET failed_attempts = e.failed_attempts + 1,
         locked_until = CASE
           WHEN e.failed_attempts + 1 >= 10 THEN v_now + interval '15 minutes'
           ELSE NULL
         END
   WHERE e.application_user_id = p_user_id
     AND (e.locked_until IS NULL OR e.locked_until <= v_now)
  RETURNING e.failed_attempts INTO v_attempts;

  IF FOUND THEN
    RETURN QUERY SELECT true, v_attempts, 0;
    RETURN;
  END IF;

  -- Locked, or no enrollment.
  SELECT e.failed_attempts, e.locked_until INTO v_attempts, v_locked_until
    FROM public.financial_totp_enrollments AS e
   WHERE e.application_user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT false, v_attempts,
    GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_locked_until - v_now)))::integer);
END;
$$;

REVOKE ALL ON FUNCTION public.financial_totp_count_code_check(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.financial_totp_count_code_check(uuid) TO checksops;
