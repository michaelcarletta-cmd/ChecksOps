-- AWS: public.tg_claim_id_assign_case links only a case of the row's own tenant (SQL 88).
-- Forward migration on top of supabase/migrations/
-- 20260826125804_316a5658-9b2c-4b7d-aaf3-9b81a5d5ccfd.sql (lines 137-175; the ACL in
-- 20260826125833_87e8da50-4042-4498-871e-6d8abdd7eba2.sql line 3). Does NOT rewrite or
-- reapply that migration and does not touch its triggers. Refuses to run
-- (55000 sql88_prerequisite_missing) when the objects it relies on are absent.
--
-- The bug. The original trigger function (SECURITY DEFINER, BEFORE INSERT OR UPDATE OF
-- claim_id on homeowner_ledger_events, homeowner_ledger_tokens,
-- homeowner_ledger_check_uploads, mortgage_releases, claim_check_mortgage_draws and
-- signature_requests) sets NEW.case_id to the freedom_crm case whose external_claim_id
-- is NEW.claim_id, looked up by that id alone (20260826125804:144-148): it never checks
-- that the case belongs to the row's tenant, nor that the claim belongs to the case's
-- tenant, so a row can be linked to another tenant's case. It copies no other data and
-- calls no other function (in particular not the SQL 87 case helper), so SQL 87's
-- owner-only EXECUTE on that helper does not affect it.
--
-- 1) public.tg_claim_id_assign_case() keeps RETURNS trigger, LANGUAGE plpgsql, VOLATILE,
--    SECURITY DEFINER and search_path=public, and still acts only when NEW.case_id is
--    NULL and NEW.claim_id is not. It links the freedom_crm case for NEW.claim_id only
--    when
--    - the row's tenant is the case's tenant, for a table with a tenant_id column (the
--      three homeowner ledger tables; read through to_jsonb(NEW) so one body serves all
--      six tables); a row whose tenant_id is NULL links nothing; and
--    - the claim belongs to the case's tenant by PR #991's / SQL 87's rule: claims.org_id
--      is that tenant, or org_id is NULL and one of that tenant's check_intake_items
--      references the claim. For the three tables without a tenant column
--      (mortgage_releases, claim_check_mortgage_draws, signature_requests) this is the
--      only check: the row's tenant is its claim's.
--    Otherwise NEW.case_id stays NULL. It never raises, so partner ingestion and other
--    server writes with no user keep inserting rows. Same-tenant data links exactly as
--    before, except an org-less claim no check of the case's tenant references (as in
--    SQL 87).
--
-- 2) EXECUTE. A trigger function is never called with the caller's EXECUTE privilege
--    (PostgreSQL checks EXECUTE only at CREATE TRIGGER), and calling it directly fails, so
--    EXECUTE is revoked from PUBLIC, anon, authenticated, service_role and checksops (each
--    where the role exists) and granted explicitly to the owner, as SQL 87 does.
--    Guards, all checked in the first DO block before anything changes (so even a psql
--    autocommit run cannot leave the new body with the old ACL):
--    - 55000 claim_case_owner_unsafe: tg_claim_id_assign_case, the SQL 87 case helper
--      and the two other case trigger functions (tg_check_intake_assign_case,
--      tg_loss_draft_assign_case) must have one owner and all be SECURITY DEFINER (the
--      case objects stay one owner's, as SQL 87 requires of its helper and callers); the
--      owner must not itself be checksops, authenticated, anon or service_role; and no
--      API role may be a member of the owner role. PUBLIC cannot be a role member.
--    - 55000 claim_case_callers_unsafe: no other function may name
--      tg_claim_id_assign_case in its source, and nothing but triggers (pg_trigger) may
--      depend on it (no view, rule, policy, SQL-standard function body, default or
--      constraint).
--
-- No table, column, row, trigger or policy change.
--
-- Transactions: like main's other aws/workflows/sql files this has no
-- BEGIN/COMMIT; the guarded SQL executor runs it inside one transaction.
-- Idempotent: safe to run more than once.

DO $$
DECLARE
  v_missing text[];
  v_fn_owner oid;
  v_helper_owner oid;
  v_intake_owner oid;
  v_draft_owner oid;
  v_fn_secdef boolean;
  v_helper_secdef boolean;
  v_intake_secdef boolean;
  v_draft_secdef boolean;
  v_owner name;
  v_role text;
  v_callers text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.check_cases', to_regclass('public.check_cases')::oid),
      ('public.claims', to_regclass('public.claims')::oid),
      ('public.check_intake_items', to_regclass('public.check_intake_items')::oid),
      ('public.homeowner_ledger_events', to_regclass('public.homeowner_ledger_events')::oid),
      ('public.homeowner_ledger_tokens', to_regclass('public.homeowner_ledger_tokens')::oid),
      ('public.homeowner_ledger_check_uploads', to_regclass('public.homeowner_ledger_check_uploads')::oid),
      ('public.mortgage_releases', to_regclass('public.mortgage_releases')::oid),
      ('public.claim_check_mortgage_draws', to_regclass('public.claim_check_mortgage_draws')::oid),
      ('public.signature_requests', to_regclass('public.signature_requests')::oid),
      ('public.tg_claim_id_assign_case()', to_regprocedure('public.tg_claim_id_assign_case()')::oid),
      ('public.resolve_check_case(uuid, uuid, uuid, text, text, text, text)', to_regprocedure('public.resolve_check_case(uuid, uuid, uuid, text, text, text, text)')::oid),
      ('public.tg_check_intake_assign_case()', to_regprocedure('public.tg_check_intake_assign_case()')::oid),
      ('public.tg_loss_draft_assign_case()', to_regprocedure('public.tg_loss_draft_assign_case()')::oid),
      ('role checksops', (SELECT oid FROM pg_roles WHERE rolname = 'checksops')),
      ('role authenticated', (SELECT oid FROM pg_roles WHERE rolname = 'authenticated'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql88_prerequisite_missing: SQL 88 needs migration 20260826125804 (tg_claim_id_assign_case, the case helper and trigger functions, the tables they read) applied first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  SELECT p.proowner, p.prosecdef INTO v_fn_owner, v_fn_secdef FROM pg_proc p
   WHERE p.oid = 'public.tg_claim_id_assign_case()'::regprocedure;
  SELECT p.proowner, p.prosecdef INTO v_helper_owner, v_helper_secdef FROM pg_proc p
   WHERE p.oid = 'public.resolve_check_case(uuid, uuid, uuid, text, text, text, text)'::regprocedure;
  SELECT p.proowner, p.prosecdef INTO v_intake_owner, v_intake_secdef FROM pg_proc p
   WHERE p.oid = 'public.tg_check_intake_assign_case()'::regprocedure;
  SELECT p.proowner, p.prosecdef INTO v_draft_owner, v_draft_secdef FROM pg_proc p
   WHERE p.oid = 'public.tg_loss_draft_assign_case()'::regprocedure;
  SELECT r.rolname INTO v_owner FROM pg_roles r WHERE r.oid = v_fn_owner;

  IF v_fn_owner IS DISTINCT FROM v_helper_owner
     OR v_fn_owner IS DISTINCT FROM v_intake_owner
     OR v_fn_owner IS DISTINCT FROM v_draft_owner THEN
    RAISE EXCEPTION 'claim_case_owner_unsafe: tg_claim_id_assign_case (owner %), resolve_check_case (owner %), tg_check_intake_assign_case (owner %) and tg_loss_draft_assign_case (owner %) must have the same owner before SQL 88',
      v_owner,
      (SELECT rolname FROM pg_roles WHERE oid = v_helper_owner),
      (SELECT rolname FROM pg_roles WHERE oid = v_intake_owner),
      (SELECT rolname FROM pg_roles WHERE oid = v_draft_owner)
      USING ERRCODE = '55000';
  END IF;
  IF v_fn_secdef IS NOT TRUE OR v_helper_secdef IS NOT TRUE OR v_intake_secdef IS NOT TRUE OR v_draft_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'claim_case_owner_unsafe: tg_claim_id_assign_case, resolve_check_case, tg_check_intake_assign_case and tg_loss_draft_assign_case must all be SECURITY DEFINER before SQL 88'
      USING ERRCODE = '55000';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['checksops', 'authenticated', 'anon', 'service_role'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role);
    IF v_owner = v_role THEN
      RAISE EXCEPTION 'claim_case_owner_unsafe: tg_claim_id_assign_case owner % is the API role %; the owner grant would give it EXECUTE back',
        v_owner, v_role
        USING ERRCODE = '55000';
    END IF;
    IF pg_has_role((SELECT oid FROM pg_roles WHERE rolname = v_role), v_fn_owner, 'MEMBER') THEN
      RAISE EXCEPTION 'claim_case_owner_unsafe: the API role % is a member of tg_claim_id_assign_case owner % and would keep its EXECUTE',
        v_role, v_owner
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  SELECT array_agg(name ORDER BY name) INTO v_callers
  FROM (
    SELECT 'function ' || p.oid::regprocedure::text AS name
      FROM pg_proc p
     WHERE p.prosrc ILIKE '%tg_claim_id_assign_case%'
       AND p.oid <> 'public.tg_claim_id_assign_case()'::regprocedure
    UNION
    SELECT 'dependent ' || d.classid::regclass::text || ' ' || d.objid::text
      FROM pg_depend d
     WHERE d.refclassid = 'pg_proc'::regclass
       AND d.refobjid = 'public.tg_claim_id_assign_case()'::regprocedure
       AND d.classid <> 'pg_trigger'::regclass
  ) AS c;
  IF v_callers IS NOT NULL THEN
    RAISE EXCEPTION 'claim_case_callers_unsafe: SQL 88 revokes EXECUTE on tg_claim_id_assign_case from the API roles, but other objects use it: %',
      array_to_string(v_callers, ', ')
      USING ERRCODE = '55000';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.tg_claim_id_assign_case()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row jsonb;
  v_has_tenant boolean;
  v_tenant uuid;
BEGIN
  IF NEW.case_id IS NULL AND NEW.claim_id IS NOT NULL THEN
    v_row := to_jsonb(NEW);
    v_has_tenant := v_row ? 'tenant_id';
    v_tenant := (v_row ->> 'tenant_id')::uuid;
    IF v_has_tenant AND v_tenant IS NULL THEN
      RETURN NEW;
    END IF;
    -- The case must be the row's tenant's (when the table has a tenant), and the claim
    -- must belong to the case's tenant: its org, or an org-less claim one of that
    -- tenant's checks references.
    SELECT cc.id INTO NEW.case_id
      FROM public.check_cases cc
      JOIN public.claims c ON c.id = cc.external_claim_id
     WHERE cc.external_system = 'freedom_crm'
       AND cc.external_claim_id = NEW.claim_id
       AND (NOT v_has_tenant OR cc.tenant_id = v_tenant)
       AND (c.org_id = cc.tenant_id
            OR (c.org_id IS NULL AND EXISTS (
              SELECT 1 FROM public.check_intake_items ci
               WHERE ci.claim_id = c.id AND ci.tenant_id = cc.tenant_id)))
     LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tg_claim_id_assign_case() IS
  'Case trigger of the homeowner ledger, mortgage release, mortgage draw and signature request tables (SQL 88): links only the freedom_crm case of the row''s own tenant for a claim that belongs to that tenant. EXECUTE for its owner only.';

-- Only the ACL changes here; every guard ran before the CREATE OR REPLACE.
DO $$
DECLARE
  v_owner name;
  v_role text;
BEGIN
  SELECT pg_get_userbyid(p.proowner) INTO v_owner FROM pg_proc p
   WHERE p.oid = 'public.tg_claim_id_assign_case()'::regprocedure;
  REVOKE ALL ON FUNCTION public.tg_claim_id_assign_case() FROM PUBLIC;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'checksops'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role);
    EXECUTE format('REVOKE ALL ON FUNCTION public.tg_claim_id_assign_case() FROM %I', v_role);
  END LOOP;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.tg_claim_id_assign_case() TO %I', v_owner);
END
$$;
