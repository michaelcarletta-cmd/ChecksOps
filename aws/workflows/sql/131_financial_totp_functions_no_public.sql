-- SQL 131: the four financial TOTP enrollment functions, EXECUTE no longer granted to PUBLIC.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why: the read-only financial TOTP live inspect of production (2026-10-30, SSM
-- cfee4512-4988-4fd1-be77-b03d1b4cd50b, scripts/deployment-guard/financial-totp-live-inspect.mjs)
-- read the financial TOTP functions as SECURITY DEFINER (search_path public, pg_temp), owned by
-- checksops_admin, with EXECUTE for PUBLIC, checksops and the owner, their bodies equal to
-- aws/migrations/proposed/NOT_APPLIED_20260911_financial_totp_enrollment.sql. With PUBLIC, any
-- database login can call them directly, outside the API. SQL 130 (applied to staging and
-- production on 2026-10-30) removed PUBLIC from the fifth one,
-- public.consume_financial_totp_rate_limit(uuid, text, integer, integer); this file does the same
-- for the other four and nothing else:
--   public.financial_totp_upsert_enrollment(uuid, bytea, bytea, text)
--   public.financial_totp_get_enrollment(uuid)
--   public.financial_totp_mark_verified(uuid, bigint)
--   public.financial_totp_status(uuid)
--
-- Who keeps EXECUTE: checksops and the owner. The only callers are the API Lambda
-- (aws/functions/api/auth-financial-totp.mjs: all four; providers/production/checkalt-register.mjs:
-- get_enrollment and mark_verified), which connects as checksops (data.mjs withIdentity /
-- withIdentityWrite; db-health.mjs expects current_user checksops). No function, view, policy,
-- trigger or job in the repository calls them.
--
-- 1) Refuses (55000 sql131_prerequisite_missing) unless the four functions and the role
--    checksops exist, and (42501 sql131_not_function_owner) unless the login running it owns
--    each of them: only the owner's own entries can be taken away.
-- 2) For each function: REVOKE EXECUTE FROM PUBLIC, then GRANT EXECUTE TO checksops, as the
--    functions' own proposed file and SQL 130 pair them. checksops and the owner hold EXECUTE in
--    both databases already, so the GRANT changes nothing there; it only makes the state this file
--    leaves one fixed fingerprint (EXECUTE for checksops and the owner) from any accepted starting
--    ACL. The REVOKE removes PUBLIC where it is granted (production) and changes nothing where it
--    is not (staging, whose proposed-file load already revoked it).
--
-- Not changed: the functions' bodies, SECURITY DEFINER, search_path, results and owners;
-- consume_financial_totp_rate_limit (SQL 130's); no other function, table, column, policy, grant,
-- trigger or row; the lockout behavior. A no-op where PUBLIC holds no EXECUTE on them (the tools
-- then refuse it as already in place).
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the
-- guarded SQL executor runs it inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change.

DO $sql131_guard$
DECLARE
  v_missing text[];
  v_foreign text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.financial_totp_upsert_enrollment(uuid, bytea, bytea, text)',
       pg_catalog.to_regprocedure('public.financial_totp_upsert_enrollment(uuid, bytea, bytea, text)')::oid),
      ('public.financial_totp_get_enrollment(uuid)',
       pg_catalog.to_regprocedure('public.financial_totp_get_enrollment(uuid)')::oid),
      ('public.financial_totp_mark_verified(uuid, bigint)',
       pg_catalog.to_regprocedure('public.financial_totp_mark_verified(uuid, bigint)')::oid),
      ('public.financial_totp_status(uuid)',
       pg_catalog.to_regprocedure('public.financial_totp_status(uuid)')::oid),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql131_prerequisite_missing: missing %', array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  SELECT array_agg(p.oid::regprocedure::text ORDER BY p.proname) INTO v_foreign
  FROM pg_catalog.pg_proc p
  WHERE p.oid IN (
      pg_catalog.to_regprocedure('public.financial_totp_upsert_enrollment(uuid, bytea, bytea, text)'),
      pg_catalog.to_regprocedure('public.financial_totp_get_enrollment(uuid)'),
      pg_catalog.to_regprocedure('public.financial_totp_mark_verified(uuid, bigint)'),
      pg_catalog.to_regprocedure('public.financial_totp_status(uuid)'))
    AND p.proowner IS DISTINCT FROM (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user);
  IF v_foreign IS NOT NULL THEN
    RAISE EXCEPTION 'sql131_not_function_owner: % not owned by the login running SQL 131', array_to_string(v_foreign, ', ')
      USING ERRCODE = '42501';
  END IF;
END
$sql131_guard$;

REVOKE EXECUTE ON FUNCTION public.financial_totp_upsert_enrollment(uuid, bytea, bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.financial_totp_upsert_enrollment(uuid, bytea, bytea, text) TO checksops;

REVOKE EXECUTE ON FUNCTION public.financial_totp_get_enrollment(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.financial_totp_get_enrollment(uuid) TO checksops;

REVOKE EXECUTE ON FUNCTION public.financial_totp_mark_verified(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.financial_totp_mark_verified(uuid, bigint) TO checksops;

REVOKE EXECUTE ON FUNCTION public.financial_totp_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.financial_totp_status(uuid) TO checksops;
