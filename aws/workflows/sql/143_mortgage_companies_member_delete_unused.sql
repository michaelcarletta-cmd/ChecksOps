-- SQL 143: any tenant member or active mortgage desk agent may add, edit and delete a mortgage company in the
-- shared directory; a company is deleted only when no file uses it. AWS only: nothing under
-- supabase/migrations changes.
--
-- Why: owner decisions of 2026-11-05: "Remove should delete it. It can always be added again later, anyone can
-- do this, mortgage agents should be able to share and edit list", then, on what a delete may do to the files
-- that use a company, "1" = delete only when unused: if no claim, loss draft (loss_draft_tracking) or check case
-- (check_cases) references the company, delete it permanently; if any does, refuse ("This company is used by N
-- files"), with no delete and nothing unlinked.
--
-- What references public.mortgage_companies (repository migrations; production's live constraints are read by the
-- guarded inspect before any apply):
--   claims.mortgage_company_id              FOREIGN KEY, no ON DELETE clause (NO ACTION): a delete fails;
--   loss_draft_tracking.mortgage_company_id FOREIGN KEY ON DELETE SET NULL: a delete silently unlinks the draft;
--   check_cases.mortgage_company_id         no FOREIGN KEY: a delete leaves the case pointing at nothing.
-- So the rule is enforced in the database, for every caller (the API, the platform owner, the admin login): a
-- BEFORE DELETE trigger refuses while any of the three tables has a row for the company. A BEFORE row trigger
-- runs before the foreign keys' actions (those are AFTER triggers), so SET NULL never runs on a refused delete,
-- and check_cases, which has no foreign key, is checked explicitly. The same trigger refuses changing a
-- company's id while it is used (an id change would orphan check_cases the same way).
--
-- The guard counts rows the caller cannot see: public.aws_mortgage_company_in_use_guard() is SECURITY DEFINER,
-- SET search_path = public, SET row_security = off, owned by the login that runs this file (checksops_admin in
-- production, which owns the tables). With row_security off, a query that RLS would filter raises instead of
-- returning fewer rows, so the guard can only see every row or fail closed (the delete is then refused). The
-- verify block requires its owner to own the three tables without FORCE ROW LEVEL SECURITY, or to bypass RLS,
-- and to hold SELECT on them.
--
-- Who may write (replaces SQL 142's two tenant-admin policies):
--   public.aws_can_edit_mortgage_company_directory() = aws_is_authenticated() AND
--     (aws_has_any_tenant_membership() OR aws_is_active_mortgage_agent(auth.uid()))
--   i.e. any member of any tenant (SQL 90: every member has the same rights, role ignored) or an active mortgage
--   desk agent (SQL 47 / SQL 100: has the mortgage_agent role and no inactive roster row).
--   aws_insert_mortgage_companies_member FOR INSERT WITH CHECK (editor AND is_active)
--   aws_update_mortgage_companies_member FOR UPDATE USING / WITH CHECK (editor AND is_active)
--   aws_delete_mortgage_companies_member FOR DELETE USING (editor AND is_active)
--   Deactivating and reactivating stay platform-owner only (a row they write must stay active; an inactive row is
--   not theirs to change or delete). aws_write_mortgage_companies (the platform owner, FOR ALL) is unchanged, and
--   its deletes are guarded by the same trigger.
--
-- What this file does:
-- 1) Preconditions (RAISE, nothing changes otherwise):
--    a. public.mortgage_companies is an ordinary table with ROW LEVEL SECURITY enabled, a uuid id and a boolean
--       is_active (sql143_table_missing, sql143_rls_disabled, sql143_column_missing);
--    b. claims, loss_draft_tracking and check_cases are ordinary tables with a uuid mortgage_company_id
--       (sql143_reference_missing);
--    c. aws_write_mortgage_companies is exactly the platform-owner form SQL 142 required
--       (sql143_owner_policy_missing, sql143_owner_policy_collision);
--    d. SQL 142's two policies are exactly SQL 142's form (sql143_sql142_policy_collision), and either both are
--       present (first run) or both are absent with this file's three present (a re-run)
--       (sql143_sql142_policy_missing);
--    e. aws_is_authenticated(), aws_has_any_tenant_membership() and aws_is_active_mortgage_agent(uuid) exist
--       (sql143_function_missing);
--    f. no other policy on the table than aws_select_mortgage_companies, aws_write_mortgage_companies, SQL 142's
--       two and this file's three (sql143_unexpected_policy).
-- 2) The editor helper, the guard function and its trigger; SQL 142's two policies dropped; this file's three
--    created.
-- 3) Post-check (RAISE, the transaction rolls back): the three policies have that exact shape and depend on the
--    helper; SQL 142's are gone; the owner policy still passes 1c; the trigger is enabled, BEFORE DELETE OR UPDATE
--    OF id, FOR EACH ROW, on the guard; the guard is SECURITY DEFINER with row_security off and its owner reads
--    the three tables without RLS; RLS is still enabled.
--
-- Errors: the guard raises SQLSTATE MC143 with message 'sql143_company_in_use: this company is used by N files' and
-- DETAIL a JSON object {"files": N, "claims": a, "loss_drafts": b, "check_cases": c}; the API maps it to a 409.
-- Limit: check_cases has no foreign key, so a check case written for a company in the same instant another
-- transaction deletes it is not blocked by a lock (claims and loss_draft_tracking are, through their keys).
--
-- Not changed: aws_select_mortgage_companies, aws_write_mortgage_companies, any table GRANT / REVOKE, ENABLE /
-- DISABLE / FORCE ROW LEVEL SECURITY, any column, foreign key, row, or other table. The API allowlist
-- (write-allowlist.mjs) still decides which columns a write may carry.
--
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT and no SET LOCAL; the guarded
-- SQL executor and the production tool run it inside their one transaction and verify before COMMIT.
-- Idempotent: CREATE OR REPLACE FUNCTION, DROP TRIGGER / POLICY IF EXISTS then CREATE; a re-run leaves the same
-- state (the guarded tools refuse a re-apply on the fingerprint first).
-- Not applied by this change: staging first, then production, through the guarded SQL path (AGENTS.md).

DO $sql143_preconditions$
DECLARE
  v_kind "char";
  v_rls boolean;
  v_type text;
  v_table text;
  v_name text;
  v_found boolean;
  v_permissive boolean;
  v_cmd "char";
  v_roles text[];
  v_using text;
  v_check text;
  v_present integer := 0;
  v_ours integer := 0;
  v_other text[];
  v_owner_forms constant text[] := ARRAY[
    '(aws_is_authenticated() AND aws_is_cross_tenant_reader())',
    '(public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())'
  ];
  v_sql142_forms constant text[] := ARRAY[
    '(aws_is_tenant_manager_admin() AND is_active)',
    '(public.aws_is_tenant_manager_admin() AND is_active)'
  ];
BEGIN
  SELECT c.relkind, c.relrowsecurity INTO v_kind, v_rls
    FROM pg_catalog.pg_class c
   WHERE c.oid = pg_catalog.to_regclass('public.mortgage_companies');
  IF NOT FOUND OR v_kind IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION 'sql143_table_missing: public.mortgage_companies is not an ordinary table (relkind %)', v_kind
      USING ERRCODE = '42P01';
  END IF;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'sql143_rls_disabled: public.mortgage_companies does not have ROW LEVEL SECURITY enabled'
      USING ERRCODE = '55000', HINT = 'SQL 143 never enables RLS; restore it through its own reviewed change.';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['id:uuid', 'is_active:boolean'] LOOP
    SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) INTO v_type
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = 'public.mortgage_companies'::pg_catalog.regclass
       AND a.attname = pg_catalog.split_part(v_name, ':', 1) AND NOT a.attisdropped;
    IF v_type IS DISTINCT FROM pg_catalog.split_part(v_name, ':', 2) THEN
      RAISE EXCEPTION 'sql143_column_missing: public.mortgage_companies.% is %', pg_catalog.split_part(v_name, ':', 1), COALESCE(v_type, 'absent')
        USING ERRCODE = '42703';
    END IF;
  END LOOP;

  FOREACH v_table IN ARRAY ARRAY['claims', 'loss_draft_tracking', 'check_cases'] LOOP
    v_type := NULL;
    SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) INTO v_type
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attname = 'mortgage_company_id' AND NOT a.attisdropped
     WHERE c.oid = pg_catalog.to_regclass('public.' || v_table) AND c.relkind = 'r';
    IF v_type IS DISTINCT FROM 'uuid' THEN
      RAISE EXCEPTION 'sql143_reference_missing: public.%.mortgage_company_id is %', v_table, COALESCE(v_type, 'absent')
        USING ERRCODE = '42703';
    END IF;
  END LOOP;

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
    RAISE EXCEPTION 'sql143_owner_policy_missing: aws_write_mortgage_companies does not exist'
      USING ERRCODE = '42704';
  END IF;
  IF v_permissive IS DISTINCT FROM true
     OR v_cmd IS DISTINCT FROM '*'
     OR v_roles IS DISTINCT FROM ARRAY['authenticated']::text[]
     OR v_using IS NULL OR NOT (v_using = ANY (v_owner_forms))
     OR v_check IS NULL OR NOT (v_check = ANY (v_owner_forms)) THEN
    RAISE EXCEPTION 'sql143_owner_policy_collision: aws_write_mortgage_companies permissive=% cmd=% roles=% using=% check=%',
      v_permissive, v_cmd, v_roles, v_using, v_check
      USING ERRCODE = '55000';
  END IF;

  FOREACH v_name IN ARRAY ARRAY['aws_insert_mortgage_companies_tenant_admin', 'aws_update_mortgage_companies_tenant_admin'] LOOP
    v_found := NULL;
    SELECT true, pol.polpermissive, pol.polcmd,
           ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r)::text END
                   FROM pg_catalog.unnest(pol.polroles) AS r ORDER BY 1),
           pg_catalog.pg_get_expr(pol.polqual, pol.polrelid),
           pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid)
      INTO v_found, v_permissive, v_cmd, v_roles, v_using, v_check
      FROM pg_catalog.pg_policy pol
     WHERE pol.polrelid = 'public.mortgage_companies'::pg_catalog.regclass
       AND pol.polname = v_name;
    IF v_found IS NOT DISTINCT FROM true THEN
      v_present := v_present + 1;
      IF v_permissive IS DISTINCT FROM true
         OR v_roles IS DISTINCT FROM ARRAY['authenticated']::text[]
         OR v_check IS NULL OR NOT (v_check = ANY (v_sql142_forms))
         OR (v_name = 'aws_insert_mortgage_companies_tenant_admin' AND (v_cmd IS DISTINCT FROM 'a' OR v_using IS NOT NULL))
         OR (v_name = 'aws_update_mortgage_companies_tenant_admin' AND (v_cmd IS DISTINCT FROM 'w' OR v_using IS NULL OR NOT (v_using = ANY (v_sql142_forms)))) THEN
        RAISE EXCEPTION 'sql143_sql142_policy_collision: % permissive=% cmd=% roles=% using=% check=%',
          v_name, v_permissive, v_cmd, v_roles, v_using, v_check
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END LOOP;
  SELECT pg_catalog.count(*) INTO v_ours
    FROM pg_catalog.pg_policy pol
   WHERE pol.polrelid = 'public.mortgage_companies'::pg_catalog.regclass
     AND pol.polname IN ('aws_insert_mortgage_companies_member', 'aws_update_mortgage_companies_member',
                         'aws_delete_mortgage_companies_member');
  IF NOT (v_present = 2 OR (v_present = 0 AND v_ours = 3)) THEN
    RAISE EXCEPTION 'sql143_sql142_policy_missing: SQL 142 policies present % of 2, SQL 143 policies present % of 3', v_present, v_ours
      USING ERRCODE = '55000', HINT = 'SQL 143 replaces SQL 142''s two policies; apply SQL 142 first.';
  END IF;

  FOREACH v_name IN ARRAY ARRAY['public.aws_is_authenticated()', 'public.aws_has_any_tenant_membership()',
                                'public.aws_is_active_mortgage_agent(uuid)'] LOOP
    IF pg_catalog.to_regprocedure(v_name) IS NULL THEN
      RAISE EXCEPTION 'sql143_function_missing: % does not exist', v_name
        USING ERRCODE = '42883';
    END IF;
  END LOOP;

  SELECT ARRAY(SELECT pol.polname::text FROM pg_catalog.pg_policy pol
                WHERE pol.polrelid = 'public.mortgage_companies'::pg_catalog.regclass
                  AND pol.polname NOT IN ('aws_select_mortgage_companies', 'aws_write_mortgage_companies',
                                          'aws_insert_mortgage_companies_tenant_admin',
                                          'aws_update_mortgage_companies_tenant_admin',
                                          'aws_insert_mortgage_companies_member',
                                          'aws_update_mortgage_companies_member',
                                          'aws_delete_mortgage_companies_member')
                ORDER BY 1)
    INTO v_other;
  IF pg_catalog.cardinality(v_other) > 0 THEN
    RAISE EXCEPTION 'sql143_unexpected_policy: public.mortgage_companies has other policies %', v_other
      USING ERRCODE = '55000';
  END IF;
END
$sql143_preconditions$;

-- 2a) Who may edit the shared directory: any tenant member or an active mortgage desk agent.
CREATE OR REPLACE FUNCTION public.aws_can_edit_mortgage_company_directory()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT public.aws_is_authenticated()
     AND (public.aws_has_any_tenant_membership()
          OR COALESCE(public.aws_is_active_mortgage_agent(auth.uid()), false));
$$;
REVOKE ALL ON FUNCTION public.aws_can_edit_mortgage_company_directory() FROM PUBLIC;
DO $sql143_editor_grant$
DECLARE
  v_grantee text;
BEGIN
  FOREACH v_grantee IN ARRAY ARRAY['authenticated', 'checksops'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_grantee) THEN
      EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION public.aws_can_edit_mortgage_company_directory() TO %I', v_grantee);
    END IF;
  END LOOP;
END
$sql143_editor_grant$;
COMMENT ON FUNCTION public.aws_can_edit_mortgage_company_directory() IS
  'SQL 143: true for a member of any tenant (SQL 90) or an active mortgage desk agent (SQL 47 / SQL 100); they may add, edit and delete active rows of the shared mortgage company directory.';

-- 2b) A company is deleted (or its id changed) only when no claim, loss draft or check case uses it.
CREATE OR REPLACE FUNCTION public.aws_mortgage_company_in_use_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
DECLARE
  v_claims bigint;
  v_loss_drafts bigint;
  v_check_cases bigint;
  v_total bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.id IS NOT DISTINCT FROM OLD.id THEN
    RETURN NEW;
  END IF;
  SELECT pg_catalog.count(*) INTO v_claims FROM public.claims WHERE mortgage_company_id = OLD.id;
  SELECT pg_catalog.count(*) INTO v_loss_drafts FROM public.loss_draft_tracking WHERE mortgage_company_id = OLD.id;
  SELECT pg_catalog.count(*) INTO v_check_cases FROM public.check_cases WHERE mortgage_company_id = OLD.id;
  v_total := v_claims + v_loss_drafts + v_check_cases;
  IF v_total > 0 THEN
    RAISE EXCEPTION 'sql143_company_in_use: this company is used by % files', v_total
      USING ERRCODE = 'MC143',
            DETAIL = pg_catalog.json_build_object('files', v_total, 'claims', v_claims,
                                                  'loss_drafts', v_loss_drafts, 'check_cases', v_check_cases)::text,
            HINT = 'A mortgage company is deleted only when no claim, loss draft or check case uses it (SQL 143).';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.aws_mortgage_company_in_use_guard() FROM PUBLIC;
DO $sql143_guard_revoke$
DECLARE
  v_grantee text;
BEGIN
  FOREACH v_grantee IN ARRAY ARRAY['authenticated', 'checksops'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_grantee) THEN
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION public.aws_mortgage_company_in_use_guard() FROM %I', v_grantee);
    END IF;
  END LOOP;
END
$sql143_guard_revoke$;
COMMENT ON FUNCTION public.aws_mortgage_company_in_use_guard() IS
  'SQL 143: refuses deleting a mortgage company (or changing its id) while any claims, loss_draft_tracking or check_cases row references it, for every caller; SQLSTATE MC143, DETAIL the counts as JSON. Runs before the foreign keys'' actions, so a refused delete unlinks nothing.';

DROP TRIGGER IF EXISTS aws_mortgage_company_in_use_guard ON public.mortgage_companies;
CREATE TRIGGER aws_mortgage_company_in_use_guard
  BEFORE DELETE OR UPDATE OF id ON public.mortgage_companies
  FOR EACH ROW EXECUTE FUNCTION public.aws_mortgage_company_in_use_guard();

-- 2c) SQL 142's tenant-admin policies give way to the member-or-agent ones.
DROP POLICY IF EXISTS aws_insert_mortgage_companies_tenant_admin ON public.mortgage_companies;
DROP POLICY IF EXISTS aws_update_mortgage_companies_tenant_admin ON public.mortgage_companies;

DROP POLICY IF EXISTS aws_insert_mortgage_companies_member ON public.mortgage_companies;
CREATE POLICY aws_insert_mortgage_companies_member ON public.mortgage_companies
  AS PERMISSIVE
  FOR INSERT TO authenticated
  WITH CHECK (public.aws_can_edit_mortgage_company_directory() AND is_active);

DROP POLICY IF EXISTS aws_update_mortgage_companies_member ON public.mortgage_companies;
CREATE POLICY aws_update_mortgage_companies_member ON public.mortgage_companies
  AS PERMISSIVE
  FOR UPDATE TO authenticated
  USING (public.aws_can_edit_mortgage_company_directory() AND is_active)
  WITH CHECK (public.aws_can_edit_mortgage_company_directory() AND is_active);

DROP POLICY IF EXISTS aws_delete_mortgage_companies_member ON public.mortgage_companies;
CREATE POLICY aws_delete_mortgage_companies_member ON public.mortgage_companies
  AS PERMISSIVE
  FOR DELETE TO authenticated
  USING (public.aws_can_edit_mortgage_company_directory() AND is_active);

DO $sql143_verify$
DECLARE
  v_name text;
  v_table text;
  v_found boolean;
  v_permissive boolean;
  v_cmd "char";
  v_roles text[];
  v_using text;
  v_check text;
  v_depends boolean;
  v_rls boolean;
  v_owner oid;
  v_definer boolean;
  v_config text[];
  v_tgtype integer;
  v_enabled "char";
  v_cols text;
  v_ok boolean;
  v_forms constant text[] := ARRAY[
    '(aws_can_edit_mortgage_company_directory() AND is_active)',
    '(public.aws_can_edit_mortgage_company_directory() AND is_active)'
  ];
  v_owner_forms constant text[] := ARRAY[
    '(aws_is_authenticated() AND aws_is_cross_tenant_reader())',
    '(public.aws_is_authenticated() AND public.aws_is_cross_tenant_reader())'
  ];
BEGIN
  FOREACH v_name IN ARRAY ARRAY['aws_insert_mortgage_companies_member', 'aws_update_mortgage_companies_member',
                                'aws_delete_mortgage_companies_member'] LOOP
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
                      AND d.refobjid = pg_catalog.to_regprocedure('public.aws_can_edit_mortgage_company_directory()'))
      INTO v_found, v_permissive, v_cmd, v_roles, v_using, v_check, v_depends
      FROM pg_catalog.pg_policy pol
     WHERE pol.polrelid = 'public.mortgage_companies'::pg_catalog.regclass
       AND pol.polname = v_name;
    IF v_found IS DISTINCT FROM true
       OR v_permissive IS DISTINCT FROM true
       OR v_roles IS DISTINCT FROM ARRAY['authenticated']::text[]
       OR v_depends IS DISTINCT FROM true
       OR (v_name = 'aws_insert_mortgage_companies_member' AND (v_cmd IS DISTINCT FROM 'a' OR v_using IS NOT NULL
             OR v_check IS NULL OR NOT (v_check = ANY (v_forms))))
       OR (v_name = 'aws_update_mortgage_companies_member' AND (v_cmd IS DISTINCT FROM 'w'
             OR v_using IS NULL OR NOT (v_using = ANY (v_forms)) OR v_check IS NULL OR NOT (v_check = ANY (v_forms))))
       OR (v_name = 'aws_delete_mortgage_companies_member' AND (v_cmd IS DISTINCT FROM 'd'
             OR v_using IS NULL OR NOT (v_using = ANY (v_forms)) OR v_check IS NOT NULL)) THEN
      RAISE EXCEPTION 'sql143_member_policy_not_created: % found=% permissive=% cmd=% roles=% using=% check=% depends=%',
        v_name, v_found, v_permissive, v_cmd, v_roles, v_using, v_check, v_depends
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy pol
              WHERE pol.polrelid = 'public.mortgage_companies'::pg_catalog.regclass
                AND pol.polname IN ('aws_insert_mortgage_companies_tenant_admin', 'aws_update_mortgage_companies_tenant_admin')) THEN
    RAISE EXCEPTION 'sql143_sql142_policy_not_dropped'
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
   WHERE pol.polrelid = 'public.mortgage_companies'::pg_catalog.regclass
     AND pol.polname = 'aws_write_mortgage_companies';
  IF v_found IS DISTINCT FROM true
     OR v_permissive IS DISTINCT FROM true
     OR v_cmd IS DISTINCT FROM '*'
     OR v_roles IS DISTINCT FROM ARRAY['authenticated']::text[]
     OR v_using IS NULL OR NOT (v_using = ANY (v_owner_forms))
     OR v_check IS NULL OR NOT (v_check = ANY (v_owner_forms)) THEN
    RAISE EXCEPTION 'sql143_owner_policy_mutated: permissive=% cmd=% roles=% using=% check=%',
      v_permissive, v_cmd, v_roles, v_using, v_check
      USING ERRCODE = '55000';
  END IF;

  -- The trigger: enabled, BEFORE, ROW, DELETE and UPDATE OF id only, on the guard.
  v_found := NULL;
  SELECT true, tg.tgtype, tg.tgenabled,
         (SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY a.attname)
            FROM pg_catalog.unnest(tg.tgattr::int2[]) AS k
            JOIN pg_catalog.pg_attribute a ON a.attrelid = tg.tgrelid AND a.attnum = k)
    INTO v_found, v_tgtype, v_enabled, v_cols
    FROM pg_catalog.pg_trigger tg
   WHERE tg.tgrelid = 'public.mortgage_companies'::pg_catalog.regclass
     AND tg.tgname = 'aws_mortgage_company_in_use_guard'
     AND NOT tg.tgisinternal
     AND tg.tgfoid = pg_catalog.to_regprocedure('public.aws_mortgage_company_in_use_guard()');
  -- tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE, 32 TRUNCATE, 64 INSTEAD.
  IF v_found IS DISTINCT FROM true OR v_tgtype IS DISTINCT FROM (1 | 2 | 8 | 16)
     OR v_enabled IS DISTINCT FROM 'O' OR v_cols IS DISTINCT FROM 'id' THEN
    RAISE EXCEPTION 'sql143_guard_trigger_not_created: found=% tgtype=% enabled=% columns=%', v_found, v_tgtype, v_enabled, v_cols
      USING ERRCODE = '55000';
  END IF;

  -- The guard sees every row: SECURITY DEFINER, row_security off, and its owner reads the three tables without RLS.
  SELECT p.proowner, p.prosecdef, p.proconfig INTO v_owner, v_definer, v_config
    FROM pg_catalog.pg_proc p
   WHERE p.oid = pg_catalog.to_regprocedure('public.aws_mortgage_company_in_use_guard()');
  IF v_definer IS DISTINCT FROM true
     OR v_config IS NULL OR NOT ('row_security=off' = ANY (v_config)) OR NOT ('search_path=public' = ANY (v_config)) THEN
    RAISE EXCEPTION 'sql143_guard_not_definer: prosecdef=% proconfig=%', v_definer, v_config
      USING ERRCODE = '55000';
  END IF;
  FOREACH v_table IN ARRAY ARRAY['claims', 'loss_draft_tracking', 'check_cases'] LOOP
    SELECT pg_catalog.has_table_privilege(v_owner, c.oid, 'SELECT')
       AND ((c.relowner = v_owner AND NOT c.relforcerowsecurity)
            OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid = v_owner AND (r.rolsuper OR r.rolbypassrls)))
      INTO v_ok
      FROM pg_catalog.pg_class c
     WHERE c.oid = ('public.' || v_table)::pg_catalog.regclass;
    IF v_ok IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'sql143_guard_cannot_see_all_rows: the guard''s owner % does not read public.% past row level security',
        pg_catalog.pg_get_userbyid(v_owner), v_table
        USING ERRCODE = '55000',
              HINT = 'The guard would miss rows the caller cannot see; run SQL 143 as the owner of the referencing tables.';
    END IF;
  END LOOP;

  SELECT c.relrowsecurity INTO v_rls
    FROM pg_catalog.pg_class c
   WHERE c.oid = 'public.mortgage_companies'::pg_catalog.regclass;
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'sql143_rls_disabled_after_apply'
      USING ERRCODE = '55000';
  END IF;
END
$sql143_verify$;
