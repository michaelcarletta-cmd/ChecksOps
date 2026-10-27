-- AWS: the payment-account stakeholder sync function, EXECUTE for its owner only (SQL 119).
-- AWS only: nothing under supabase/migrations changes.
--
-- Why: production (read-only inspect 2026-10-27, SSM 2db258df-47a8-414b-b7c6-b9686768c5b9,
-- main e5a7476a8) holds EXECUTE on public.sync_provider_stakeholder_account(uuid) for PUBLIC,
-- checksops and the owner. SQL 115 (aws/workflows/sql/115_provider_stakeholder_one_partner_payout.sql,
-- unchanged: its hash is pinned) replaces the function and takes EXECUTE away from PUBLIC, anon,
-- authenticated and service_role only, so its guard refuses the checksops entry
-- (function_acl_replaceable). This file runs in production immediately before SQL 115 and
-- leaves the owner as the only grantee; SQL 115 then passes its guard and reaches its intended
-- fingerprint unchanged. The same shape as SQL 103 before SQL 29.
--
-- 1) Refuses (55000 sql119_prerequisite_missing) unless the function and the role checksops
--    exist, and (42501 sql119_not_function_owner) unless the login running it owns the
--    function: only the owner's own entries can be taken away.
-- 2) Removes every privilege of PUBLIC and checksops on that one function, and of anon,
--    authenticated and service_role where those roles exist. PUBLIC too, although SQL 115 also
--    removes it: then the state this file leaves is one fixed fingerprint (EXECUTE for the
--    owner only) whatever the starting ACL, before or after SQL 115. The function is called
--    only by the SECURITY DEFINER public.trg_sync_provider_stakeholder_account(),
--    public.autoadd_partner_stakeholder_on_share() and
--    public.add_partner_stakeholder_to_check(uuid, uuid), all as the owner; the API never
--    calls it, so no caller loses access.
--
-- Not changed: the function's body, attributes and owner, its callers and triggers, and no
-- other function, policy, grant, table, column or row. Does not need SQL 115 and is not
-- needed by anything but SQL 115's guard; a no-op where the owner is already the only grantee
-- (staging after SQL 115). Nothing in the repository grants this function to checksops again
-- after it.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the
-- guarded SQL executor runs it inside one transaction.
-- Idempotent: safe to run more than once. Not applied by this change.

DO $sql119_guard$
DECLARE
  v_fn oid := pg_catalog.to_regprocedure('public.sync_provider_stakeholder_account(uuid)');
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.sync_provider_stakeholder_account(uuid)', v_fn),
      ('role checksops', (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql119_prerequisite_missing: missing %', array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = v_fn AND p.proowner = (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user)
  ) THEN
    RAISE EXCEPTION 'sql119_not_function_owner: public.sync_provider_stakeholder_account(uuid) is not owned by the login running SQL 119'
      USING ERRCODE = '42501';
  END IF;
END
$sql119_guard$;

REVOKE ALL ON FUNCTION public.sync_provider_stakeholder_account(uuid) FROM PUBLIC, checksops;

DO $sql119_optional_roles$
DECLARE
  grantee text;
BEGIN
  FOREACH grantee IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = grantee) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.sync_provider_stakeholder_account(uuid) FROM %I', grantee);
    END IF;
  END LOOP;
END
$sql119_optional_roles$;
