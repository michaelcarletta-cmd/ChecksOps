-- SQL 139: public.tenant_billing_accounts' authenticated write policy back to the repository's
-- tenant-write contract. AWS only: nothing under supabase/migrations changes.
--
-- Why: on staging the policy aws_write_tenant_billing_accounts has a live condition that differs from
-- the repository's (aws/rls/sql/24_complete_write_policies.sql):
--   aws_write_tenant_billing_accounts FOR ALL TO authenticated
--     USING (public.aws_can_write_tenant(tenant_id))
--     WITH CHECK (public.aws_can_write_tenant(tenant_id))
-- Evidence: the read-only billing write diagnostic on staging (#1515, main 1e51f8d3):
--   - lock:0: SELECT ... FOR UPDATE of the member's own tenant row returns 0 rows, so the UPDATE USING
--     policies hide the row, although public.aws_can_write_tenant(tenant) is true for that member;
--   - the write policy's USING and WITH CHECK renderings hash (sha256, first 12 hex) to 8c72ef93d1e5 and
--     do not depend on public.aws_can_write_tenant(uuid) (pg_depend). The repository rendering
--     aws_can_write_tenant(tenant_id) hashes to 2523b078754a. The live text behind 8c72ef93d1e5 is not
--     known and this file does not assume it;
--   - aws_write_tenant_billing_accounts_job (ALL TO checksops) USING and WITH CHECK, and
--     aws_select_tenant_billing_accounts_job (SELECT TO checksops), hash to 1c3f7a3edd76, the rendering
--     aws_monthly_billing_job();
--   - aws_select_tenant_billing_accounts hashes to 7b9c86002fdd,
--     (aws_is_cross_tenant_reader() OR aws_can_access_tenant(tenant_id)), as the repository;
--   - the table's trigger is the repository's (c10d3ecdb68d), there is no rule, and there is one
--     public.aws_can_write_tenant overload.
-- Precedent: aws/write-path/guarded-sql-executor/sql/39_tmp_write_policy_reconcile.sql reconciled the
-- same kind of drift on public.tenant_maintenance_payments, and refused unless its _job policy was intact.
--
-- What this file does:
-- 1) Preconditions (RAISE, nothing changes otherwise):
--    a. public.tenant_billing_accounts is an ordinary table (relkind 'r') with ROW LEVEL SECURITY enabled
--       (sql139_table_missing, sql139_rls_disabled);
--    b. aws_write_tenant_billing_accounts exists, is PERMISSIVE and FOR ALL (sql139_write_policy_missing,
--       sql139_write_policy_shape). Its USING / WITH CHECK may be anything: the drifted text is unknown,
--       and the staging read-live pins the exact pre-state (expected_live_definition_sha256);
--    c. aws_write_tenant_billing_accounts_job exists, is PERMISSIVE, FOR ALL, TO exactly {checksops},
--       and its USING and WITH CHECK both render as aws_monthly_billing_job() (with or without public.
--       and outer parentheses) (sql139_job_policy_missing, sql139_job_policy_collision): the machine
--       write authority (monthly billing job) lives there, so replacing the authenticated policy must
--       not be what removes it;
--    d. public.aws_can_write_tenant(uuid) exists (sql139_function_missing).
-- 2) DROP POLICY aws_write_tenant_billing_accounts, then CREATE it as the repository's SQL 24 policy:
--    FOR ALL TO authenticated USING / WITH CHECK (public.aws_can_write_tenant(tenant_id)).
-- 3) Post-check (RAISE, the transaction rolls back): the policy is PERMISSIVE, FOR ALL, TO exactly
--    {authenticated}, both expressions render as the intended form and depend on
--    public.aws_can_write_tenant(uuid); the _job policy still passes 1c; RLS is still enabled.
--
-- Not changed: aws_select_tenant_billing_accounts, aws_select_tenant_billing_accounts_job,
-- aws_write_tenant_billing_accounts_job, any other policy (SQL 136's three RESTRICTIVE gate policies on
-- this table, applied or not, have other names and AND with this permissive policy), any GRANT / REVOKE,
-- ENABLE / DISABLE / FORCE ROW LEVEL SECURITY, any function
-- (aws_can_write_tenant, aws_monthly_billing_job), trigger, column, row, or any other table.
--
-- Production: unverified. Nothing here says production has the same drift; a read-only production
-- inspect decides that before any production pin.
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT and no SET LOCAL;
-- the guarded SQL executor and the production tool run it inside their one transaction (lock_timeout
-- 5s) and verify before COMMIT.
-- Idempotent: on a table already reconciled every precondition passes and DROP POLICY IF EXISTS then
-- CREATE POLICY leaves the same state (the guarded tools refuse a re-apply on the fingerprint first).
-- Not applied by this change: staging first, then production, through the guarded SQL path (AGENTS.md).

DO $sql139_preconditions$
DECLARE
  v_kind "char";
  v_rls boolean;
  v_found boolean;
  v_permissive boolean;
  v_cmd "char";
  v_roles text[];
  v_using text;
  v_check text;
  v_job_forms constant text[] := ARRAY[
    'aws_monthly_billing_job()',
    '(aws_monthly_billing_job())',
    'public.aws_monthly_billing_job()',
    '(public.aws_monthly_billing_job())'
  ];
BEGIN
  SELECT c.relkind, c.relrowsecurity INTO v_kind, v_rls
    FROM pg_catalog.pg_class c
   WHERE c.oid = pg_catalog.to_regclass('public.tenant_billing_accounts');
  IF NOT FOUND OR v_kind IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION 'sql139_table_missing: public.tenant_billing_accounts is not an ordinary table (relkind %)', v_kind
      USING ERRCODE = '42P01';
  END IF;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'sql139_rls_disabled: public.tenant_billing_accounts does not have ROW LEVEL SECURITY enabled'
      USING ERRCODE = '55000', HINT = 'SQL 139 never enables RLS; restore it through its own reviewed change.';
  END IF;

  SELECT true, pol.polpermissive, pol.polcmd INTO v_found, v_permissive, v_cmd
    FROM pg_catalog.pg_policy pol
   WHERE pol.polrelid = 'public.tenant_billing_accounts'::pg_catalog.regclass
     AND pol.polname = 'aws_write_tenant_billing_accounts';
  IF v_found IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'sql139_write_policy_missing: aws_write_tenant_billing_accounts does not exist'
      USING ERRCODE = '42704';
  END IF;
  IF v_permissive IS DISTINCT FROM true OR v_cmd IS DISTINCT FROM '*' THEN
    RAISE EXCEPTION 'sql139_write_policy_shape: aws_write_tenant_billing_accounts permissive=% cmd=%', v_permissive, v_cmd
      USING ERRCODE = '55000';
  END IF;

  v_found := NULL;
  SELECT true, pol.polpermissive, pol.polcmd,
         ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r)::text END
                 FROM pg_catalog.unnest(pol.polroles) AS r ORDER BY 1),
         pg_catalog.pg_get_expr(pol.polqual, pol.polrelid),
         pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid)
    INTO v_found, v_permissive, v_cmd, v_roles, v_using, v_check
    FROM pg_catalog.pg_policy pol
   WHERE pol.polrelid = 'public.tenant_billing_accounts'::pg_catalog.regclass
     AND pol.polname = 'aws_write_tenant_billing_accounts_job';
  IF v_found IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'sql139_job_policy_missing: aws_write_tenant_billing_accounts_job does not exist'
      USING ERRCODE = '42704',
            HINT = 'The monthly billing job writes through this policy. Do not replace the authenticated policy while it is gone.';
  END IF;
  IF v_permissive IS DISTINCT FROM true
     OR v_cmd IS DISTINCT FROM '*'
     OR v_roles IS DISTINCT FROM ARRAY['checksops']::text[]
     OR v_using IS NULL OR NOT (v_using = ANY (v_job_forms))
     OR v_check IS NULL OR NOT (v_check = ANY (v_job_forms)) THEN
    RAISE EXCEPTION 'sql139_job_policy_collision: aws_write_tenant_billing_accounts_job permissive=% cmd=% roles=% using=% check=%',
      v_permissive, v_cmd, v_roles, v_using, v_check
      USING ERRCODE = '55000';
  END IF;

  IF pg_catalog.to_regprocedure('public.aws_can_write_tenant(uuid)') IS NULL THEN
    RAISE EXCEPTION 'sql139_function_missing: public.aws_can_write_tenant(uuid) does not exist'
      USING ERRCODE = '42883';
  END IF;
END
$sql139_preconditions$;

DROP POLICY IF EXISTS aws_write_tenant_billing_accounts ON public.tenant_billing_accounts;
CREATE POLICY aws_write_tenant_billing_accounts ON public.tenant_billing_accounts
  FOR ALL TO authenticated
  USING (public.aws_can_write_tenant(tenant_id))
  WITH CHECK (public.aws_can_write_tenant(tenant_id));

DO $sql139_verify$
DECLARE
  v_found boolean;
  v_permissive boolean;
  v_cmd "char";
  v_roles text[];
  v_using text;
  v_check text;
  v_depends boolean;
  v_rls boolean;
  v_write_forms constant text[] := ARRAY[
    'aws_can_write_tenant(tenant_id)',
    '(aws_can_write_tenant(tenant_id))',
    'public.aws_can_write_tenant(tenant_id)',
    '(public.aws_can_write_tenant(tenant_id))'
  ];
  v_job_forms constant text[] := ARRAY[
    'aws_monthly_billing_job()',
    '(aws_monthly_billing_job())',
    'public.aws_monthly_billing_job()',
    '(public.aws_monthly_billing_job())'
  ];
BEGIN
  SELECT true, pol.polpermissive, pol.polcmd,
         ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r)::text END
                 FROM pg_catalog.unnest(pol.polroles) AS r ORDER BY 1),
         pg_catalog.pg_get_expr(pol.polqual, pol.polrelid),
         pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid),
         EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                  WHERE d.classid = 'pg_catalog.pg_policy'::pg_catalog.regclass
                    AND d.objid = pol.oid
                    AND d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                    AND d.refobjid = pg_catalog.to_regprocedure('public.aws_can_write_tenant(uuid)'))
    INTO v_found, v_permissive, v_cmd, v_roles, v_using, v_check, v_depends
    FROM pg_catalog.pg_policy pol
   WHERE pol.polrelid = 'public.tenant_billing_accounts'::pg_catalog.regclass
     AND pol.polname = 'aws_write_tenant_billing_accounts';
  IF v_found IS DISTINCT FROM true
     OR v_permissive IS DISTINCT FROM true
     OR v_cmd IS DISTINCT FROM '*'
     OR v_roles IS DISTINCT FROM ARRAY['authenticated']::text[]
     OR v_using IS NULL OR NOT (v_using = ANY (v_write_forms))
     OR v_check IS NULL OR NOT (v_check = ANY (v_write_forms))
     OR v_depends IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'sql139_write_policy_not_reconciled: permissive=% cmd=% roles=% using=% check=% depends=%',
      v_permissive, v_cmd, v_roles, v_using, v_check, v_depends
      USING ERRCODE = '55000';
  END IF;

  v_found := NULL;
  SELECT true, pol.polpermissive, pol.polcmd,
         ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r)::text END
                 FROM pg_catalog.unnest(pol.polroles) AS r ORDER BY 1),
         pg_catalog.pg_get_expr(pol.polqual, pol.polrelid),
         pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid)
    INTO v_found, v_permissive, v_cmd, v_roles, v_using, v_check
    FROM pg_catalog.pg_policy pol
   WHERE pol.polrelid = 'public.tenant_billing_accounts'::pg_catalog.regclass
     AND pol.polname = 'aws_write_tenant_billing_accounts_job';
  IF v_found IS DISTINCT FROM true
     OR v_permissive IS DISTINCT FROM true
     OR v_cmd IS DISTINCT FROM '*'
     OR v_roles IS DISTINCT FROM ARRAY['checksops']::text[]
     OR v_using IS NULL OR NOT (v_using = ANY (v_job_forms))
     OR v_check IS NULL OR NOT (v_check = ANY (v_job_forms)) THEN
    RAISE EXCEPTION 'sql139_job_policy_mutated: permissive=% cmd=% roles=% using=% check=%',
      v_permissive, v_cmd, v_roles, v_using, v_check
      USING ERRCODE = '55000';
  END IF;

  SELECT c.relrowsecurity INTO v_rls
    FROM pg_catalog.pg_class c
   WHERE c.oid = 'public.tenant_billing_accounts'::pg_catalog.regclass;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'sql139_rls_disabled_after_reconcile'
      USING ERRCODE = '55000';
  END IF;
END
$sql139_verify$;
