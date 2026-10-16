-- AWS: Mortgage Agent compensation is platform owner only (SQL 86).
-- Forward migration on top of the Mortgage Agent compensation ledger (Cursor
-- SQL 47, aws/isolated/mortgage-agent-compensation/sql/
-- 47_mortgage_agent_compensation.sql, sha256 bdbdccbc...). Does NOT rewrite or
-- reapply SQL 47. Refuses to run (55000 sql47_prerequisite_missing) when the
-- SQL 47 objects it changes are absent. Independent of SQL 84/85.
--
-- 1) public.aws_can_admin_mortgage_agent_compensation() keeps SQL 47's
--    signature, return type, LANGUAGE sql, STABLE, SECURITY DEFINER,
--    search_path and row_security, but now returns
--    COALESCE(public.is_platform_owner(), false). SQL 47's version also
--    admitted any global user_roles 'admin' (and is_master_owner(), today an
--    alias of is_platform_owner()). Its callers, all in SQL 47 and all
--    Mortgage Agent compensation administration:
--      set_mortgage_agent_account_status, approve_mortgage_agent_compensation,
--      mark_mortgage_agent_compensation_paid, and the SELECT policies on
--      mortgage_agent_accounts, mortgage_agent_compensation_rates,
--      mortgage_agent_compensation_exclusions, mortgage_agent_compensation_entries,
--      mortgage_agent_compensation_batches and mortgage_agent_compensation_audit.
--    No Lambda code and no other SQL on main calls it. The Lambda
--    (mortgage-agent-compensation.mjs) already refuses everyone but the
--    platform owner. aws_is_active_mortgage_agent() (the Accept trigger) is
--    SECURITY DEFINER with row_security off, so Mortgage Agents' Accept does
--    not depend on the mortgage_agent_accounts policy.
--
-- 2) public.earn_mortgage_agent_compensation(uuid) had EXECUTE for PUBLIC,
--    checksops and authenticated and no caller check. Its only caller is the
--    SQL 47 completion trigger function tg_earn_mortgage_agent_compensation()
--    (SECURITY DEFINER), which runs it with its owner's privileges, so
--    EXECUTE is revoked from PUBLIC, checksops and authenticated. The function
--    body is unchanged; Complete still earns. This assumes the trigger
--    function and earn_mortgage_agent_compensation have the same owner (true
--    when SQL 47 was applied in one run); a read-only inspect must confirm it.
--
-- Not changed here: mortgage_agent_compensation_reconciliation(text) does not
-- call the helper (SECURITY DEFINER, no caller check, EXECUTE for checksops
-- and authenticated). Gating it means rewriting its SQL 47 body; it is
-- reachable only through the platform-owner Lambda route.
--
-- No table, column, row, rate, billing or payment change.
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
      ('public.mortgage_agent_compensation_entries', to_regclass('public.mortgage_agent_compensation_entries')::oid),
      ('public.aws_can_admin_mortgage_agent_compensation()', to_regprocedure('public.aws_can_admin_mortgage_agent_compensation()')::oid),
      ('public.earn_mortgage_agent_compensation(uuid)', to_regprocedure('public.earn_mortgage_agent_compensation(uuid)')::oid),
      ('public.tg_earn_mortgage_agent_compensation()', to_regprocedure('public.tg_earn_mortgage_agent_compensation()')::oid),
      ('public.is_platform_owner()', to_regprocedure('public.is_platform_owner()')::oid)
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql47_prerequisite_missing: SQL 86 needs SQL 47 (and the identity helpers) applied first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.aws_can_admin_mortgage_agent_compensation()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT COALESCE(public.is_platform_owner(), false);
$$;

COMMENT ON FUNCTION public.aws_can_admin_mortgage_agent_compensation() IS
  'Mortgage Agent compensation administration: platform owner only (SQL 86). Global admin, staff, tenant roles and Mortgage Agents are refused.';

REVOKE ALL ON FUNCTION public.earn_mortgage_agent_compensation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.earn_mortgage_agent_compensation(uuid) FROM checksops;
REVOKE ALL ON FUNCTION public.earn_mortgage_agent_compensation(uuid) FROM authenticated;
