-- AWS: the Mortgage Ops auto-share trigger function, EXECUTE for its owner only (SQL 103).
-- AWS only: nothing under supabase/migrations changes.
--
-- Why: production (read-only inspect 2026-10-19, main bf6b7555e) holds EXECUTE on
-- public.share_library_docs_to_mortgage_request() for PUBLIC, checksops and the owner.
-- SQL 29 (aws/rls/sql/29_mortgage_ops_library_parity.sql, unchanged: its hash is in the
-- append-only release ledger) replaces the function and takes EXECUTE away from PUBLIC
-- only, so its guard refuses the checksops entry (function_acl_replaceable). This file
-- runs in production immediately before SQL 29 and leaves the owner as the only grantee;
-- SQL 29 then passes its guard and reaches its intended fingerprint unchanged.
--
-- 1) Refuses (55000 sql103_prerequisite_missing) unless the function and the roles
--    checksops and authenticated exist, and (42501 sql103_not_function_owner) unless the
--    login running it owns the function: only the owner's own entries can be taken away.
-- 2) Removes every privilege of PUBLIC, checksops and authenticated on that one function.
--    PUBLIC too, although SQL 29 also removes it: then the state this file leaves is one
--    fixed fingerprint (EXECUTE for the owner only) whatever the starting ACL, before or
--    after SQL 29. A trigger function needs no EXECUTE grant to fire.
--
-- Not changed: the function's body, attributes and owner, its trigger, and no other
-- function, policy, grant, table, column or row. Does not need SQL 29 and is not needed by
-- anything but SQL 29's guard; a no-op where the owner is already the only grantee (staging
-- after SQL 29). Nothing in the repository grants this function to checksops or
-- authenticated again after it.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the
-- guarded SQL executor runs it inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change.

DO $sql103_guard$
DECLARE
  v_fn oid := pg_catalog.to_regprocedure('public.share_library_docs_to_mortgage_request()');
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.share_library_docs_to_mortgage_request()', v_fn),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops')),
      ('role authenticated', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'authenticated'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql103_prerequisite_missing: missing %', array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = v_fn AND p.proowner = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
  ) THEN
    RAISE EXCEPTION 'sql103_not_function_owner: public.share_library_docs_to_mortgage_request() is not owned by the login running SQL 103'
      USING ERRCODE = '42501';
  END IF;
END
$sql103_guard$;

REVOKE ALL ON FUNCTION public.share_library_docs_to_mortgage_request() FROM PUBLIC, checksops, authenticated;
