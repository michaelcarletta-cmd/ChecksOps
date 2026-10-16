-- AWS: public.resolve_check_case is a tenant-scoped internal helper (SQL 87).
-- Forward migration on top of supabase/migrations/
-- 20260826125804_316a5658-9b2c-4b7d-aaf3-9b81a5d5ccfd.sql (and the grants repeated
-- in 20260826125833_87e8da50-4042-4498-871e-6d8abdd7eba2.sql). Does NOT rewrite or
-- reapply that migration and does not touch its triggers. Refuses to run
-- (55000 sql87_prerequisite_missing) when the objects it changes are absent.
--
-- The bug. The original body (SECURITY DEFINER, EXECUTE for authenticated and
-- service_role, no caller check):
--   - looked up a freedom_crm case by external_claim_id alone, so it returned
--     another tenant's case id (20260826125804:23-30), and did so again after an
--     ON CONFLICT on the global check_cases_external_claim_uidx (:73-75);
--   - read any claims row named by _claim_id, whatever its tenant, and copied its
--     policyholder name, email, phone, address, carrier, policy, mortgage company,
--     loan number and loss date into a case created for _tenant_id (:32-34, :51-71).
--
-- 1) public.resolve_check_case(uuid, uuid, uuid, text, text, text, text) keeps its
--    signature, parameter names and defaults, RETURNS uuid, LANGUAGE plpgsql,
--    VOLATILE, SECURITY DEFINER and search_path=public. Its body now:
--    - applies the claim-belongs-to-tenant rule of PR #991's server route
--      (aws/functions/api/workflow-rpc.mjs executeResolveCheckCase): a claims row
--      named by COALESCE(_claim_id, _external_claim_id) belongs to _tenant_id when
--      claims.org_id = _tenant_id, or org_id is NULL and one of _tenant_id's
--      check_intake_items references it. A _claim_id must be such a claim; an
--      _external_claim_id with no claims row is allowed as before. Where #991's
--      route returns claim_not_in_tenant, this helper links nothing to that id and
--      copies no claim data: it finds or creates only _tenant_id's own
--      claim-number case (external_claim_id NULL) from the caller's own
--      _claim_number / _insured_name / _property_address / _carrier_name, or
--      returns NULL when there is no claim number. It never raises, so the
--      check intake and loss draft triggers keep inserting rows;
--    - filters both freedom_crm lookups (before the insert and after ON CONFLICT)
--      by tenant_id = _tenant_id. When the global unique index conflicts with
--      another tenant's case, it returns NULL (the route's check_case_conflict)
--      instead of that case's id;
--    - copies claim data only from a _claim_id that belongs to _tenant_id.
--    No caller-role check: the function is an internal helper of the two
--    trigger functions below and is no longer callable by the API roles.
--
-- 2) EXECUTE. Its only callers are the trigger functions
--    tg_check_intake_assign_case() (BEFORE INSERT / UPDATE OF claim_id,
--    freedom_claim_id, tenant_id ON check_intake_items) and
--    tg_loss_draft_assign_case() (BEFORE INSERT / UPDATE OF claim_id,
--    check_intake_item_id ON loss_draft_tracking), both SECURITY DEFINER, so they
--    run it with their owner's privileges. The AWS API never calls it: the SPA's
--    supabase.rpc('resolve_check_case') (src/lib/checkCases.ts) goes to
--    POST /data/rpc, where resolve_check_case is in SAFE_WRITE_RPCS and is served
--    by the route's own SQL (workflow-rpc.mjs), not by this function. EXECUTE is
--    revoked from PUBLIC, anon, authenticated, service_role and checksops (each
--    where the role exists) and granted explicitly to the owner.
--    Guards, all checked in the first DO block before anything changes (so even a
--    psql autocommit run cannot leave the new body with the old ACL):
--    - 55000 case_owner_unsafe: resolve_check_case and both trigger functions must
--      have the same owner and both trigger functions must be SECURITY DEFINER
--      (otherwise the revoke could take EXECUTE away from the triggers and every
--      check intake or loss draft insert without a case would fail with 42501);
--      the owner must not itself be checksops, authenticated, anon or service_role
--      (the owner grant would hand EXECUTE straight back to that API role); and no
--      API role may be a member of the owner role (it would inherit or SET ROLE to
--      the owner's EXECUTE). PUBLIC cannot be a role member. The owner being a
--      member of an API role is not refused: the owner keeps its own explicit
--      grant, and a CREATEROLE owner is a member of every role it created.
--    - 55000 case_callers_unsafe: no function other than the two trigger functions
--      may reference resolve_check_case in its source, and no view, rule, policy,
--      SQL-standard function body, default or constraint may depend on it: the
--      revoke would break any such caller that runs as an API role.
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
  v_intake_owner oid;
  v_draft_owner oid;
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
      ('public.loss_draft_tracking', to_regclass('public.loss_draft_tracking')::oid),
      ('public.resolve_check_case(uuid, uuid, uuid, text, text, text, text)', to_regprocedure('public.resolve_check_case(uuid, uuid, uuid, text, text, text, text)')::oid),
      ('public.tg_check_intake_assign_case()', to_regprocedure('public.tg_check_intake_assign_case()')::oid),
      ('public.tg_loss_draft_assign_case()', to_regprocedure('public.tg_loss_draft_assign_case()')::oid),
      ('role checksops', (SELECT oid FROM pg_roles WHERE rolname = 'checksops')),
      ('role authenticated', (SELECT oid FROM pg_roles WHERE rolname = 'authenticated'))
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql87_prerequisite_missing: SQL 87 needs migration 20260826125804 (resolve_check_case and its trigger functions) applied first; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;

  SELECT p.proowner INTO v_fn_owner FROM pg_proc p
   WHERE p.oid = 'public.resolve_check_case(uuid, uuid, uuid, text, text, text, text)'::regprocedure;
  SELECT p.proowner, p.prosecdef INTO v_intake_owner, v_intake_secdef FROM pg_proc p
   WHERE p.oid = 'public.tg_check_intake_assign_case()'::regprocedure;
  SELECT p.proowner, p.prosecdef INTO v_draft_owner, v_draft_secdef FROM pg_proc p
   WHERE p.oid = 'public.tg_loss_draft_assign_case()'::regprocedure;
  SELECT r.rolname INTO v_owner FROM pg_roles r WHERE r.oid = v_fn_owner;

  IF v_fn_owner IS DISTINCT FROM v_intake_owner OR v_fn_owner IS DISTINCT FROM v_draft_owner THEN
    RAISE EXCEPTION 'case_owner_unsafe: resolve_check_case (owner %), tg_check_intake_assign_case (owner %) and tg_loss_draft_assign_case (owner %) must have the same owner before SQL 87 revokes EXECUTE',
      v_owner,
      (SELECT rolname FROM pg_roles WHERE oid = v_intake_owner),
      (SELECT rolname FROM pg_roles WHERE oid = v_draft_owner)
      USING ERRCODE = '55000';
  END IF;
  IF v_intake_secdef IS NOT TRUE OR v_draft_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'case_owner_unsafe: tg_check_intake_assign_case and tg_loss_draft_assign_case must be SECURITY DEFINER before SQL 87 revokes EXECUTE from the roles that write check_intake_items and loss_draft_tracking'
      USING ERRCODE = '55000';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['checksops', 'authenticated', 'anon', 'service_role'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role);
    IF v_owner = v_role THEN
      RAISE EXCEPTION 'case_owner_unsafe: resolve_check_case owner % is the API role %; the owner grant would give it EXECUTE back',
        v_owner, v_role
        USING ERRCODE = '55000';
    END IF;
    IF pg_has_role((SELECT oid FROM pg_roles WHERE rolname = v_role), v_fn_owner, 'MEMBER') THEN
      RAISE EXCEPTION 'case_owner_unsafe: the API role % is a member of resolve_check_case owner % and would keep its EXECUTE',
        v_role, v_owner
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  SELECT array_agg(name ORDER BY name) INTO v_callers
  FROM (
    SELECT 'function ' || p.oid::regprocedure::text AS name
      FROM pg_proc p
     WHERE p.prosrc ILIKE '%resolve_check_case%'
       AND p.oid NOT IN (
         'public.resolve_check_case(uuid, uuid, uuid, text, text, text, text)'::regprocedure,
         'public.tg_check_intake_assign_case()'::regprocedure,
         'public.tg_loss_draft_assign_case()'::regprocedure)
    UNION
    SELECT 'dependent ' || d.classid::regclass::text || ' ' || d.objid::text
      FROM pg_depend d
     WHERE d.refclassid = 'pg_proc'::regclass
       AND d.refobjid = 'public.resolve_check_case(uuid, uuid, uuid, text, text, text, text)'::regprocedure
  ) AS c;
  IF v_callers IS NOT NULL THEN
    RAISE EXCEPTION 'case_callers_unsafe: SQL 87 revokes EXECUTE on resolve_check_case from the API roles, but other objects call it: %',
      array_to_string(v_callers, ', ')
      USING ERRCODE = '55000';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.resolve_check_case(
  _tenant_id uuid,
  _claim_id uuid DEFAULT NULL,
  _external_claim_id uuid DEFAULT NULL,
  _claim_number text DEFAULT NULL,
  _insured_name text DEFAULT NULL,
  _property_address text DEFAULT NULL,
  _carrier_name text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_case_id uuid;
  v_ext uuid := COALESCE(_claim_id, _external_claim_id);
  v_claim public.claims%ROWTYPE;
  v_claim_found boolean := false;
  v_in_tenant boolean;
BEGIN
  IF _tenant_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- PR #991's rule: a claims row named by v_ext must belong to _tenant_id (its org,
  -- or an org-less claim one of _tenant_id's checks references). A _claim_id must
  -- be such a claim; an _external_claim_id with no claims row is allowed.
  IF v_ext IS NOT NULL THEN
    SELECT (c.org_id = _tenant_id
            OR (c.org_id IS NULL AND EXISTS (
              SELECT 1 FROM public.check_intake_items ci
               WHERE ci.claim_id = c.id AND ci.tenant_id = _tenant_id)))
      INTO v_in_tenant
      FROM public.claims c
     WHERE c.id = v_ext;
    v_claim_found := FOUND;
    IF (v_claim_found AND v_in_tenant IS NOT TRUE)
       OR (NOT v_claim_found AND _claim_id IS NOT NULL) THEN
      -- Outside _tenant_id: link nothing to this id and copy none of its data.
      v_ext := NULL;
    ELSIF _claim_id IS NOT NULL THEN
      SELECT * INTO v_claim FROM public.claims WHERE id = _claim_id;
    END IF;
  END IF;

  IF v_ext IS NOT NULL THEN
    SELECT id INTO v_case_id FROM public.check_cases
     WHERE tenant_id = _tenant_id
       AND external_system = 'freedom_crm'
       AND external_claim_id = v_ext
     LIMIT 1;
    IF v_case_id IS NOT NULL THEN
      RETURN v_case_id;
    END IF;
  END IF;

  IF v_ext IS NULL AND _claim_number IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_ext IS NULL THEN
    SELECT id INTO v_case_id FROM public.check_cases
     WHERE tenant_id = _tenant_id
       AND external_claim_id IS NULL
       AND claim_number IS NOT DISTINCT FROM _claim_number
     LIMIT 1;
    IF v_case_id IS NOT NULL THEN
      RETURN v_case_id;
    END IF;
  END IF;

  INSERT INTO public.check_cases (
    tenant_id, external_system, external_claim_id, claim_number, insured_name,
    insured_email, insured_phone, property_address, carrier_name, policy_number,
    mortgage_company_id, loan_number, loss_date
  ) VALUES (
    _tenant_id,
    CASE WHEN v_ext IS NULL THEN 'checksops' ELSE 'freedom_crm' END,
    v_ext,
    COALESCE(v_claim.claim_number, _claim_number),
    COALESCE(v_claim.policyholder_name, _insured_name),
    v_claim.policyholder_email,
    v_claim.policyholder_phone,
    COALESCE(v_claim.policyholder_address, _property_address),
    COALESCE(v_claim.insurance_company, _carrier_name),
    v_claim.policy_number,
    v_claim.mortgage_company_id,
    v_claim.loan_number,
    v_claim.loss_date
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_case_id;

  IF v_case_id IS NULL AND v_ext IS NOT NULL THEN
    -- check_cases_external_claim_uidx is global: the conflicting row may be another
    -- tenant's case, whose id is never returned.
    SELECT id INTO v_case_id FROM public.check_cases
     WHERE tenant_id = _tenant_id
       AND external_system = 'freedom_crm'
       AND external_claim_id = v_ext
     LIMIT 1;
  END IF;

  RETURN v_case_id;
END;
$$;

COMMENT ON FUNCTION public.resolve_check_case(uuid, uuid, uuid, text, text, text, text) IS
  'Internal helper of tg_check_intake_assign_case and tg_loss_draft_assign_case (SQL 87): finds or creates the caller tenant''s case; never reads, links or copies another tenant''s claim or case. EXECUTE for its owner only.';

-- Only the ACL changes here; every guard ran before the CREATE OR REPLACE.
DO $$
DECLARE
  v_owner name;
  v_role text;
BEGIN
  SELECT pg_get_userbyid(p.proowner) INTO v_owner FROM pg_proc p
   WHERE p.oid = 'public.resolve_check_case(uuid, uuid, uuid, text, text, text, text)'::regprocedure;
  REVOKE ALL ON FUNCTION public.resolve_check_case(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'checksops'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role);
    EXECUTE format('REVOKE ALL ON FUNCTION public.resolve_check_case(uuid, uuid, uuid, text, text, text, text) FROM %I', v_role);
  END LOOP;
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.resolve_check_case(uuid, uuid, uuid, text, text, text, text) TO %I', v_owner);
END
$$;
