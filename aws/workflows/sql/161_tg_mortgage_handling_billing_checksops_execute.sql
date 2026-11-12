-- SQL 161: EXECUTE for checksops on public.tg_record_mortgage_handling_billing(), the one grant
-- staging lacks and production holds.
--
-- Why: SQL 160 (aws/workflows/sql/160_no_additional_check_mortgage_charge_or_manual_deposit_fee.sql,
-- release key sql160) replaces four billing functions with CREATE OR REPLACE and no GRANT or REVOKE,
-- so each function keeps its live ACL, and its spec (scripts/deployment-guard/lib/release-sql-specs.mjs
-- sql160) fingerprints the ACL production holds (ops/deployment-guard/billing-trigger-inspect.json
-- production_inspect.observed_functions). The staging read-live of SQL 160 on 2026-11-12 (GitHub
-- Actions run 43307779123, guarded-staging-sql-executor, mode read-live, approved commit
-- 83a508fb10b32c30ff702231443ff11f7df68163) reported already_applied false and
-- precondition_failures [], and the staging function ACLs:
--   record_check_billing_event()            checksops, owner                     (as production)
--   accrue_mortgage_ops_billing(uuid)       PUBLIC, authenticated, checksops, owner (as production)
--   earn_mortgage_agent_compensation(uuid)  owner                                (as production)
--   tg_record_mortgage_handling_billing()   PUBLIC, owner        (production also: checksops)
-- CREATE OR REPLACE keeps that ACL, so in staging SQL 160's post-state could never equal its
-- intended fingerprint and its apply would roll back (post-condition intended_state). The owner
-- (2026-11-12): "A new SQL 161 that gives staging that one permission, then SQL 160".
--
-- A new migration, not an edit to any earlier file (AGENTS.md: migrations are append-only). SQL 160
-- and its spec, pins and evidence are not changed.
--
-- Changes: GRANT EXECUTE ON FUNCTION public.tg_record_mortgage_handling_billing() TO checksops.
-- Afterwards the function's EXECUTE ACL is PUBLIC, checksops and the owner, each granted by the
-- owner: the ACL production already holds (owner checksops_admin, every grant by checksops_admin).
-- In production this file is a no-op (the grant is held), so production is expected to read as
-- already in the intended state.
--
-- Not changed: no REVOKE (PUBLIC and the owner keep EXECUTE); the function's body, language,
-- SECURITY DEFINER, search_path, result and owner; the trigger tr_record_mortgage_handling_billing
-- on public.check_intake_items; the other three SQL 160 functions; no other function, table, column,
-- policy, grant, trigger or row.
--
-- Preconditions fail closed: the function and the role checksops must exist (sql161_* exceptions,
-- nothing changes otherwise).
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the
-- guarded SQL executor runs it inside one transaction.
-- Idempotent: GRANT of a held privilege is a no-op. Not applied by this change: staging first,
-- then production, through the guarded SQL path (AGENTS.md).

DO $sql161_preconditions$
BEGIN
  IF pg_catalog.to_regprocedure('public.tg_record_mortgage_handling_billing()') IS NULL THEN
    RAISE EXCEPTION 'sql161_function_missing: public.tg_record_mortgage_handling_billing() does not exist'
      USING ERRCODE = '42883';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'checksops') THEN
    RAISE EXCEPTION 'sql161_role_missing: role checksops does not exist'
      USING ERRCODE = '42704';
  END IF;
END
$sql161_preconditions$;

GRANT EXECUTE ON FUNCTION public.tg_record_mortgage_handling_billing() TO checksops;
