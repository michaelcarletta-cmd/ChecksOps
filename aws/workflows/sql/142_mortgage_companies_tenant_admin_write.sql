-- SQL 142: tenant admins may add and edit the shared mortgage company directory; deactivating,
-- reactivating and deleting a company stay platform-owner only. AWS only: nothing under
-- supabase/migrations changes.
--
-- Why: owner decision 2026-11-04 ("Option 2"). A tenant admin (mcarletta@freedomadj.com) could not add
-- or edit a mortgage company from Manager or a Loss Draft check. public.mortgage_companies is one
-- directory shared by every tenant, and its only write policy (aws/rls/sql/24_complete_write_policies.sql)
-- admits the platform owner alone:
--   aws_write_mortgage_companies FOR ALL TO authenticated
--     USING      (aws_is_authenticated() AND aws_is_cross_tenant_reader())
--     WITH CHECK (aws_is_authenticated() AND aws_is_cross_tenant_reader())
-- Evidence (2026-11-04): production API log 20:28:16Z, /prep/data/write mortgage_companies, rls_denied
-- "new row violates row-level security policy"; read-only production lookups (SSM da2687b5,
-- f90ee490) showed that exact policy live, the platform owner passing it, and the API login checksops
-- a member of authenticated with table SELECT, INSERT, UPDATE, DELETE.
--
-- Who counts as a tenant admin: public.aws_is_tenant_manager_admin() (aws/rls/sql/35_manager_partner_parity.sql),
-- the same test Manager uses: the platform owner, a user_roles admin, or a tenant_users owner/admin.
--
-- What this file does:
-- 1) Preconditions (RAISE, nothing changes otherwise):
--    a. public.mortgage_companies is an ordinary table (relkind 'r') with ROW LEVEL SECURITY enabled and
--       a boolean is_active column (sql142_table_missing, sql142_rls_disabled, sql142_is_active_missing);
--    b. aws_write_mortgage_companies exists, PERMISSIVE, FOR ALL, TO exactly {authenticated}, USING and
--       WITH CHECK both the platform-owner form above (sql142_owner_policy_missing,
--       sql142_owner_policy_collision): it stays the only way to deactivate, reactivate or delete;
--    c. public.aws_is_tenant_manager_admin() exists (sql142_function_missing);
--    d. no other policy on the table than aws_select_mortgage_companies, aws_write_mortgage_companies and
--       this file's two (sql142_unexpected_policy).
-- 2) Two PERMISSIVE policies TO authenticated (permissive policies OR with the owner policy):
--    aws_insert_mortgage_companies_tenant_admin FOR INSERT
--      WITH CHECK (aws_is_tenant_manager_admin() AND is_active)
--    aws_update_mortgage_companies_tenant_admin FOR UPDATE
--      USING      (aws_is_tenant_manager_admin() AND is_active)
--      WITH CHECK (aws_is_tenant_manager_admin() AND is_active)
--    So a tenant admin adds active companies and edits active ones; a row they write must stay active, and
--    an inactive row is not theirs to change (no reactivation). No DELETE policy for them.
-- 3) Post-check (RAISE, the transaction rolls back): both new policies have that exact shape and depend on
--    public.aws_is_tenant_manager_admin(); the owner policy still passes 1b; RLS is still enabled.
--
-- Not changed: aws_select_mortgage_companies, aws_write_mortgage_companies, any GRANT / REVOKE, ENABLE /
-- DISABLE / FORCE ROW LEVEL SECURITY, any function, the updated_at trigger, any column, row, or other
-- table. The API allowlist (write-allowlist.mjs) still decides which columns a write may carry; the
-- portal credential columns are not among them.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT and no SET LOCAL;
-- the guarded SQL executor and the production tool run it inside their one transaction and verify
-- before COMMIT.
-- Idempotent: DROP POLICY IF EXISTS then CREATE POLICY for this file's two policies; a re-run leaves the
-- same state (the guarded tools refuse a re-apply on the fingerprint first).
-- Not applied by this change: staging first, then production, through the guarded SQL path (AGENTS.md).

DO $sql142_preconditions$
DECLARE
  v_kind "char";
  v_rls boolean;
  v_type text;
  v_found boolean;
  v_permissive boolean;
  v_cmd "char";
  v_roles text[];
  v_using text;
  v_check text;
  v_other text[];
  v_owner_forms constant text[] := ARRAY[
    '(aws_is_authenticated() AND aws_is_cross_tenant_reader())',
    '(public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())'
  ];
BEGIN
  SELECT c.relkind, c.relrowsecurity INTO v_kind, v_rls
    FROM pg_catalog.pg_class c
   WHERE c.oid = pg_catalog.to_regclass('public.mortgage_companies');
  IF NOT FOUND OR v_kind IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION 'sql142_table_missing: public.mortgage_companies is not an ordinary table (relkind %)', v_kind
      USING ERRCODE = '42P01';
  END IF;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'sql142_rls_disabled: public.mortgage_companies does not have ROW LEVEL SECURITY enabled'
      USING ERRCODE = '55000', HINT = 'SQL 142 never enables RLS; restore it through its own reviewed change.';
  END IF;
  SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) INTO v_type
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = 'public.mortgage_companies'::pg_catalog.regclass
     AND a.attname = 'is_active' AND NOT a.attisdropped;
  IF v_type IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'sql142_is_active_missing: public.mortgage_companies.is_active is %', COALESCE(v_type, 'absent')
      USING ERRCODE = '42703';
  END IF;

  SELECT true, pol.polpermissive, pol.polcmd,
         ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r)::text END
                 FROM pg_catalog.unnest(pol.polroles) AS r ORDER BY 1),
         pg_catalog.pg_get_expr(pol.polqual, pol.polrelid),
         pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid)
    INTO v_found, v_permissive, v_cmd, v_roles, v_using, v_check
    FROM pg_catalog.pg_policy pol
   WHERE pol.polrelid = 'public.mortgage_companies'::pg_catalog.regclass
     AND pol.polname = 'aws_write_mortgage_companies';
  IF v_found IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'sql142_owner_policy_missing: aws_write_mortgage_companies does not exist'
      USING ERRCODE = '42704';
  END IF;
  IF v_permissive IS DISTINCT FROM true
     OR v_cmd IS DISTINCT FROM '*'
     OR v_roles IS DISTINCT FROM ARRAY['authenticated']::text[]
     OR v_using IS NULL OR NOT (v_using = ANY (v_owner_forms))
     OR v_check IS NULL OR NOT (v_check = ANY (v_owner_forms)) THEN
    RAISE EXCEPTION 'sql142_owner_policy_collision: aws_write_mortgage_companies permissive=% cmd=% roles=% using=% check=%',
      v_permissive, v_cmd, v_roles, v_using, v_check
      USING ERRCODE = '55000';
  END IF;

  IF pg_catalog.to_regprocedure('public.aws_is_tenant_manager_admin()') IS NULL THEN
    RAISE EXCEPTION 'sql142_function_missing: public.aws_is_tenant_manager_admin() does not exist'
      USING ERRCODE = '42883';
  END IF;

  SELECT ARRAY(SELECT pol.polname::text FROM pg_catalog.pg_policy pol
                WHERE pol.polrelid = 'public.mortgage_companies'::pg_catalog.regclass
                  AND pol.polname NOT IN ('aws_select_mortgage_companies', 'aws_write_mortgage_companies',
                                          'aws_insert_mortgage_companies_tenant_admin',
                                          'aws_update_mortgage_companies_tenant_admin')
                ORDER BY 1)
    INTO v_other;
  IF pg_catalog.cardinality(v_other) > 0 THEN
    RAISE EXCEPTION 'sql142_unexpected_policy: public.mortgage_companies has other policies %', v_other
      USING ERRCODE = '55000';
  END IF;
END
$sql142_preconditions$;

DROP POLICY IF EXISTS aws_insert_mortgage_companies_tenant_admin ON public.mortgage_companies;
CREATE POLICY aws_insert_mortgage_companies_tenant_admin ON public.mortgage_companies
  AS PERMISSIVE
  FOR INSERT TO authenticated
  WITH CHECK (public.aws_is_tenant_manager_admin() AND is_active);

DROP POLICY IF EXISTS aws_update_mortgage_companies_tenant_admin ON public.mortgage_companies;
CREATE POLICY aws_update_mortgage_companies_tenant_admin ON public.mortgage_companies
  AS PERMISSIVE
  FOR UPDATE TO authenticated
  USING (public.aws_is_tenant_manager_admin() AND is_active)
  WITH CHECK (public.aws_is_tenant_manager_admin() AND is_active);

DO $sql142_verify$
DECLARE
  v_name text;
  v_found boolean;
  v_permissive boolean;
  v_cmd "char";
  v_roles text[];
  v_using text;
  v_check text;
  v_depends boolean;
  v_rls boolean;
  v_admin_forms constant text[] := ARRAY[
    '(aws_is_tenant_manager_admin() AND is_active)',
    '(public.aws_is_tenant_manager_admin() AND is_active)'
  ];
  v_owner_forms constant text[] := ARRAY[
    '(aws_is_authenticated() AND aws_is_cross_tenant_reader())',
    '(public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())'
  ];
BEGIN
  FOREACH v_name IN ARRAY ARRAY['aws_insert_mortgage_companies_tenant_admin', 'aws_update_mortgage_companies_tenant_admin'] LOOP
    v_found := NULL;
    SELECT true, pol.polpermissive, pol.polcmd,
           ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r)::text END
                   FROM pg_catalog.unnest(pol.polroles) AS r ORDER BY 1),
           pg_catalog.pg_get_expr(pol.polqual, pol.polrelid),
           pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid),
           EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                    WHERE d.classid = 'pg_catalog.pg_policy'::pg_catalog.regclass
                      AND d.objid = pol.oid
                      AND d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass
                      AND d.refobjid = pg_catalog.to_regprocedure('public.aws_is_tenant_manager_admin()'))
      INTO v_found, v_permissive, v_cmd, v_roles, v_using, v_check, v_depends
      FROM pg_catalog.pg_policy pol
     WHERE pol.polrelid = 'public.mortgage_companies'::pg_catalog.regclass
       AND pol.polname = v_name;
    IF v_found IS DISTINCT FROM true
       OR v_permissive IS DISTINCT FROM true
       OR v_roles IS DISTINCT FROM ARRAY['authenticated']::text[]
       OR v_depends IS DISTINCT FROM true
       OR v_check IS NULL OR NOT (v_check = ANY (v_admin_forms))
       OR (v_name = 'aws_insert_mortgage_companies_tenant_admin' AND (v_cmd IS DISTINCT FROM 'a' OR v_using IS NOT NULL))
       OR (v_name = 'aws_update_mortgage_companies_tenant_admin' AND (v_cmd IS DISTINCT FROM 'w' OR v_using IS NULL OR NOT (v_using = ANY (v_admin_forms)))) THEN
      RAISE EXCEPTION 'sql142_tenant_admin_policy_not_created: % found=% permissive=% cmd=% roles=% using=% check=% depends=%',
        v_name, v_found, v_permissive, v_cmd, v_roles, v_using, v_check, v_depends
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  v_found := NULL;
  SELECT true, pol.polpermissive, pol.polcmd,
         ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r)::text END
                 FROM pg_catalog.unnest(pol.polroles) AS r ORDER BY 1),
         pg_catalog.pg_get_expr(pol.polqual, pol.polrelid),
         pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid)
    INTO v_found, v_permissive, v_cmd, v_roles, v_using, v_check
    FROM pg_catalog.pg_policy pol
   WHERE pol.polrelid = 'public.mortgage_companies'::pg_catalog.regclass
     AND pol.polname = 'aws_write_mortgage_companies';
  IF v_found IS DISTINCT FROM true
     OR v_permissive IS DISTINCT FROM true
     OR v_cmd IS DISTINCT FROM '*'
     OR v_roles IS DISTINCT FROM ARRAY['authenticated']::text[]
     OR v_using IS NULL OR NOT (v_using = ANY (v_owner_forms))
     OR v_check IS NULL OR NOT (v_check = ANY (v_owner_forms)) THEN
    RAISE EXCEPTION 'sql142_owner_policy_mutated: permissive=% cmd=% roles=% using=% check=%',
      v_permissive, v_cmd, v_roles, v_using, v_check
      USING ERRCODE = '55000';
  END IF;

  SELECT c.relrowsecurity INTO v_rls
    FROM pg_catalog.pg_class c
   WHERE c.oid = 'public.mortgage_companies'::pg_catalog.regclass;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'sql142_rls_disabled_after_apply'
      USING ERRCODE = '55000';
  END IF;
END
$sql142_verify$;
