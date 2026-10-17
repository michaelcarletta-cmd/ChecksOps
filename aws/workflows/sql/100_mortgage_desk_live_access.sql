-- AWS: Mortgage Desk access as it is live in production (SQL 100).
-- RECORDS LIVE STATE. NOT AN ACCESS CHANGE.
--
-- Source of truth: the read-only production inspect of 2026-10-17
-- (scripts/deployment-guard/mortgage-desk-access-production-inspect.mjs at
-- source commit 09aa7ab00), SSM commands
--   ee5c42a3-fe1b-4da8-bb84-106766285bfa
--   45d46a8f-beeb-4ea7-9b1e-598fe6b980b4
--   041bc13d-70fa-4f43-805a-e4d7b22afd19
-- (recorded in ops/deployment-guard/mortgage-desk-access-production-inspect.json
-- and ops/production-mortgage-desk-access-inspect.md).
--
-- Production had Mortgage Desk agent access the repository lacked: the
-- repository's aws_select_ (aws/rls/sql/12_final_select_policies.sql) had no
-- agent queue term, its aws_write_ FOR ALL policy
-- (aws/rls/sql/24_complete_write_policies.sql) is not live, and the agent
-- policies, helpers and column grants below were never in the repository.
-- This file writes production's state down so a database rebuilt from the
-- repository (12, 24, then SQL 50, then this file) ends where production is.
-- Applied to production it changes nothing: every definition, policy and
-- grant below is the live one.
--
-- 1) Helpers (SECURITY DEFINER, LANGUAGE sql, STABLE, search_path and
--    row_security set; owned by the applying login, checksops_admin live).
--    Each body is byte for byte the live prosrc (sha256 as the inspect
--    computes it):
--      aws_is_mortgage_ops_agent()
--        787bad580adace93c661f60d4486e6623fbd4c6004c8e42b38e3bb9c0ff957ba
--        (body from SQL 39, mortgage_ops_agent_accept_complete, on the
--        unmerged cursor/* Mortgage Ops branches)
--      aws_mortgage_agent_queue_visible(text, uuid)
--        b9f70c8b1421f264b4537d4eac9e7ad18f81281648a33197b55aa826ff6b6711
--        (body from mortgage_ops_agent_access, 29_/31_, on the same branches)
--      aws_is_active_mortgage_agent(uuid)
--        2bba15b20b7e43c60fadf7032e834ec1937183af865d14ab1985a5bdd4f12117
--        (body from SQL 47; in the repository only as the test fixture
--        aws/tests/fixtures/mortgage-agent-compensation/47_mortgage_agent_compensation.sql).
--        It reads public.mortgage_agent_accounts, which only SQL 47 creates,
--        so it is created only when that table exists (it does live).
--    The full definitions (pg_get_functiondef, so attributes and SET values
--    search_path = public, row_security = off included) are confirmed against
--    the production inspect output: functiondef_sha256 matches live for all three
--      aws_is_mortgage_ops_agent()
--        9a0fd53811d4bfaf8f06fe530eddea5b9c6b3fb69d8371d5608b0a8b2635b007
--      aws_mortgage_agent_queue_visible(text, uuid)
--        e8012bab7455679ba9a53341cd679b063cc6d7b9df977a35d5d92933b34bc6d2
--      aws_is_active_mortgage_agent(uuid)
--        d8846afb599babf83e5657ec63e54a7cd8a6e950bec96096ab5925972b37c98b
--    EXECUTE grants, as live (production inspect of 2026-10-17 at source commit
--    969e2b2b1, SSM command 24b9f38c-d721-4b82-b3a5-056c6c84d37a; every entry
--    granted by checksops_admin, the owner):
--      aws_is_mortgage_ops_agent()                 authenticated, checksops (not PUBLIC)
--      aws_mortgage_agent_queue_visible(text, uuid) PUBLIC, checksops
--      aws_is_active_mortgage_agent(uuid)          PUBLIC, authenticated, checksops
--    Each is reset from PUBLIC, authenticated and checksops and then granted,
--    so the result is exact whatever those three roles held before. Function
--    comments are not recorded (CREATE OR REPLACE keeps them).
-- 2) The five live policies on public.mortgage_handling_requests, nothing
--    else: aws_select_mortgage_handling_requests (with the agent queue term),
--    aws_select_mortgage_ops_agent_queue, aws_update_mortgage_ops_accept_complete,
--    aws_insert_mortgage_handling_requests, aws_delete_mortgage_handling_requests.
--    Drops the repository-only aws_write_mortgage_handling_requests (24),
--    which is not live. aws_update_mortgage_ops_accept_complete carries its
--    live comment (the SQL 39 text; sha256 34ef5bf77e463d6ee683477d160b50ff9fd7bab6383d8802082a8d1605b61301,
--    equal to the live comment's sha256 in the same inspect); the other four
--    have none live.
-- 3) The live grants on public.mortgage_handling_requests:
--      checksops      SELECT, INSERT, DELETE; UPDATE on the 17 columns below
--      authenticated  UPDATE (accepted_at, assigned_employee_id, completed_at) only
--    and revokes from authenticated what SQL 50 grants it that is not live.
--    Confirmed against the production inspect output: authenticated has no
--    table-level ACL entry on mortgage_handling_requests, so the REVOKEs below
--    are a no-op on production.
--
-- Numbering: SQL 100, after SQL 98 (tenant fee collection) and SQL 99 (the
-- Desk completion trigger).
--
-- Not changed: RLS stays enabled and not forced; no table, column, row or
-- trigger; no other table.
--
-- Transactions: like the other aws/workflows/sql files this has no
-- BEGIN/COMMIT; the guarded SQL executor runs it inside one transaction.
-- Idempotent. Not applied by this change.

DO $sql100_prereq$
DECLARE
  v_missing text[];
BEGIN
  SELECT array_agg(name ORDER BY name) INTO v_missing
  FROM (
    VALUES
      ('public.mortgage_handling_requests', to_regclass('public.mortgage_handling_requests')::oid),
      ('public.has_role(uuid, public.app_role)', to_regprocedure('public.has_role(uuid, public.app_role)')::oid),
      ('public.aws_is_authenticated()', to_regprocedure('public.aws_is_authenticated()')::oid),
      ('public.aws_is_cross_tenant_reader()', to_regprocedure('public.aws_is_cross_tenant_reader()')::oid),
      ('public.aws_can_access_tenant(uuid)', to_regprocedure('public.aws_can_access_tenant(uuid)')::oid),
      ('public.aws_can_write_tenant(uuid)', to_regprocedure('public.aws_can_write_tenant(uuid)')::oid),
      ('auth.uid()', to_regprocedure('auth.uid()')::oid)
  ) AS req(name, obj)
  WHERE obj IS NULL;
  IF v_missing IS NULL THEN
    SELECT array_agg(want.col ORDER BY want.col) INTO v_missing
    FROM unnest(ARRAY[
      'tenant_id', 'status', 'assigned_employee_id', 'accepted_at', 'cancelled_at', 'claim_number',
      'completed_at', 'homeowner_email', 'homeowner_name', 'homeowner_phone', 'insurance_company',
      'loan_number', 'mortgage_company', 'mortgage_servicer', 'note', 'property_address',
      'updated_at', 'work_notes'
    ]) AS want(col)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema = 'public' AND c.table_name = 'mortgage_handling_requests' AND c.column_name = want.col);
  END IF;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'sql100_prerequisite_missing: SQL 100 needs the RLS helpers and public.mortgage_handling_requests; missing %',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '55000';
  END IF;
END
$sql100_prereq$;

-- 1) Helpers -----------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.aws_is_mortgage_ops_agent()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.aws_is_authenticated()
     AND public.has_role(auth.uid(), 'mortgage_agent'::public.app_role);
$$;

CREATE OR REPLACE FUNCTION public.aws_mortgage_agent_queue_visible(
  p_status text,
  p_assigned_employee_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.has_role(auth.uid(), 'mortgage_agent'::public.app_role)
     AND (
       p_status IN ('requested', 'in_progress')
       OR p_assigned_employee_id = auth.uid()
     );
$$;

REVOKE ALL ON FUNCTION public.aws_is_mortgage_ops_agent() FROM PUBLIC, authenticated, checksops;
GRANT EXECUTE ON FUNCTION public.aws_is_mortgage_ops_agent() TO authenticated, checksops;
REVOKE ALL ON FUNCTION public.aws_mortgage_agent_queue_visible(text, uuid) FROM PUBLIC, authenticated, checksops;
GRANT EXECUTE ON FUNCTION public.aws_mortgage_agent_queue_visible(text, uuid) TO PUBLIC, checksops;

DO $sql100_active_agent$
BEGIN
  IF to_regclass('public.mortgage_agent_accounts') IS NULL THEN
    RAISE NOTICE 'sql100: public.mortgage_agent_accounts (SQL 47) is absent; public.aws_is_active_mortgage_agent(uuid) not recorded here';
    RETURN;
  END IF;
  EXECUTE $sql100_active_agent_def$
CREATE OR REPLACE FUNCTION public.aws_is_active_mortgage_agent(_user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT
    _user_id IS NOT NULL
    AND public.has_role(_user_id, 'mortgage_agent'::public.app_role)
    AND NOT EXISTS (
      SELECT 1
      FROM public.mortgage_agent_accounts a
      WHERE a.application_user_id = _user_id
        AND a.status = 'inactive'
    );
$$
$sql100_active_agent_def$;
  REVOKE ALL ON FUNCTION public.aws_is_active_mortgage_agent(uuid) FROM PUBLIC, authenticated, checksops;
  GRANT EXECUTE ON FUNCTION public.aws_is_active_mortgage_agent(uuid) TO PUBLIC, authenticated, checksops;
END
$sql100_active_agent$;

-- 2) Policies on public.mortgage_handling_requests -------------------------------

-- Repository-only (24), not live.
DROP POLICY IF EXISTS aws_write_mortgage_handling_requests ON public.mortgage_handling_requests;

DROP POLICY IF EXISTS aws_select_mortgage_handling_requests ON public.mortgage_handling_requests;
CREATE POLICY aws_select_mortgage_handling_requests ON public.mortgage_handling_requests
  FOR SELECT TO authenticated
  USING (
    public.aws_is_cross_tenant_reader()
    OR public.aws_can_access_tenant(tenant_id)
    OR public.aws_mortgage_agent_queue_visible(status, assigned_employee_id)
  );

DROP POLICY IF EXISTS aws_select_mortgage_ops_agent_queue ON public.mortgage_handling_requests;
CREATE POLICY aws_select_mortgage_ops_agent_queue ON public.mortgage_handling_requests
  FOR SELECT TO authenticated, checksops
  USING (public.aws_is_mortgage_ops_agent());

DROP POLICY IF EXISTS aws_update_mortgage_ops_accept_complete ON public.mortgage_handling_requests;
CREATE POLICY aws_update_mortgage_ops_accept_complete ON public.mortgage_handling_requests
  FOR UPDATE TO authenticated, checksops
  USING (
    public.aws_is_mortgage_ops_agent()
    AND (
      (status = 'requested' AND assigned_employee_id IS NULL)
      OR assigned_employee_id = auth.uid()
    )
  )
  WITH CHECK (
    public.aws_is_mortgage_ops_agent()
    AND assigned_employee_id = auth.uid()
    AND status IN ('in_progress', 'completed', 'cancelled')
    AND (
      (status = 'in_progress' AND accepted_at IS NOT NULL)
      OR status IN ('completed', 'cancelled')
    )
  );
COMMENT ON POLICY aws_update_mortgage_ops_accept_complete ON public.mortgage_handling_requests IS
  'Mortgage agent Accept (requested+unassigned → self+in_progress+accepted_at) and Complete/Cancel only when assigned to the caller. Not a table-wide UPDATE grant.';

DROP POLICY IF EXISTS aws_insert_mortgage_handling_requests ON public.mortgage_handling_requests;
CREATE POLICY aws_insert_mortgage_handling_requests ON public.mortgage_handling_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    public.aws_is_cross_tenant_reader()
    OR (
      public.aws_can_write_tenant(tenant_id)
      AND status = 'requested'
      AND assigned_employee_id IS NULL
    )
  );

DROP POLICY IF EXISTS aws_delete_mortgage_handling_requests ON public.mortgage_handling_requests;
CREATE POLICY aws_delete_mortgage_handling_requests ON public.mortgage_handling_requests
  FOR DELETE TO authenticated
  USING (
    public.aws_is_cross_tenant_reader()
    OR public.aws_can_write_tenant(tenant_id)
  );

-- 3) Grants on public.mortgage_handling_requests --------------------------------

GRANT SELECT, INSERT, DELETE ON TABLE public.mortgage_handling_requests TO checksops;
GRANT UPDATE (
  accepted_at,
  assigned_employee_id,
  cancelled_at,
  claim_number,
  completed_at,
  homeowner_email,
  homeowner_name,
  homeowner_phone,
  insurance_company,
  loan_number,
  mortgage_company,
  mortgage_servicer,
  note,
  property_address,
  status,
  updated_at,
  work_notes
) ON TABLE public.mortgage_handling_requests TO checksops;

-- authenticated: live has only the three Accept / Complete columns. SQL 50
-- also grants it table SELECT, INSERT, DELETE and UPDATE on the other
-- columns; none of that is live.
REVOKE SELECT, INSERT, DELETE ON TABLE public.mortgage_handling_requests FROM authenticated;
REVOKE UPDATE (
  cancelled_at,
  claim_number,
  homeowner_email,
  homeowner_name,
  homeowner_phone,
  insurance_company,
  loan_number,
  mortgage_company,
  mortgage_servicer,
  note,
  property_address,
  status,
  updated_at,
  work_notes
) ON TABLE public.mortgage_handling_requests FROM authenticated;
GRANT UPDATE (
  accepted_at,
  assigned_employee_id,
  completed_at
) ON TABLE public.mortgage_handling_requests TO authenticated;
