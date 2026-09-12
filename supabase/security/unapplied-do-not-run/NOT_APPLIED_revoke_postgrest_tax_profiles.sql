-- =============================================================================
-- NOT SAFE TO APPLY WITHOUT AUTHORIZED PREFLIGHT
-- NOT SAFE TO APPLY / NOT A SUPABASE CLI MIGRATION / NOT FOR db push
-- =============================================================================
--
-- This file is intentionally outside supabase/migrations/ so GitHub Supabase
-- integration, `supabase db push`, Lovable merge deploys, oneshots, and
-- wildcard runners cannot discover it.
--
-- Created originally with: supabase migration new revoke_postgrest_tax_profiles
-- Then moved to supabase/security/unapplied-do-not-run/ to prevent auto-apply.
--
-- DO NOT:
--   - supabase db push
--   - supabase migration up
--   - copy this file into supabase/migrations/
--   - apply without the fail-closed preflight gate succeeding
--   - apply to RDS / AWS (checksops) databases
--
-- The ONLY authorized execution method is:
--   scripts/run-hosted-tax-profile-containment.mjs
-- Direct psql, supabase db push, and Git merge cannot apply this file.
-- The wrapper independently validates the connection host / pooler username /
-- TLS / database name. PostgreSQL does NOT expose the Supabase project ref;
-- -v expected_project_ref is defense in depth, not connection proof.
--
-- This script never SELECTs table rows or column tin values.
-- It does not create SECURITY DEFINER functions.
-- PostgREST NOTIFY runs only after a successful COMMIT of a mutating apply.
-- Keep classification checks in sync with
-- supabase/security/preflight_gate_revoke_postgrest_tax_profiles.sql
-- =============================================================================

\if :{?expected_project_ref}
\else
\echo 'ERROR: set -v expected_project_ref=<non-secret project ref>'
\quit 1
\endif
\if :{?expected_database}
\else
\echo 'ERROR: set -v expected_database=<current_database() value>'
\quit 1
\endif
\if :{?expected_owner}
\else
\echo 'ERROR: set -v expected_owner=<table owner role>'
\quit 1
\endif

SELECT set_config('checksops.expected_project_ref', :'expected_project_ref', false);
SELECT set_config('checksops.expected_database', :'expected_database', false);
SELECT set_config('checksops.expected_owner', :'expected_owner', false);
SELECT set_config('checksops.containment_mutated', 'false', false);

BEGIN;

DO $containment$
DECLARE
  expected_project text := current_setting('checksops.expected_project_ref', true);
  expected_db      text := current_setting('checksops.expected_database', true);
  expected_owner   text := current_setting('checksops.expected_owner', true);
  rel              regclass;
  rel_oid          oid;
  nsp              text;
  owner_name       text;
  relkind          "char";
  rls_on           boolean;
  force_rls        boolean;
  col_names        text[];
  missing_cols     text[];
  tin_udt          text;
  pol_names        text[];
  expected_pol     text[] := ARRAY[
    'tenant members read recipient_tax_profiles',
    'tenant members insert recipient_tax_profiles',
    'tenant members update recipient_tax_profiles',
    'tenant members delete recipient_tax_profiles'
  ];
  extra_pol        text[];
  classification   text;
  col              record;
  dep              record;
  fn               record;
  pub              record;
  job              record;
  trg              record;
  role_name        text;
  mem              record;
  data_api_roles   text[] := ARRAY['anon', 'authenticated', 'authenticator'];
  allowed_grant_roles text[] := ARRAY[
    'postgres', 'supabase_admin', 'service_role', 'authenticated', 'anon', 'authenticator'
  ];
  hosted_projects  text[] := ARRAY['nbcqwpysqgyxrrbgtmkw'];
  has_auth_dml     boolean;
  has_service      boolean;
  has_member_pols  boolean;
  has_expected_policy_bodies boolean;
  expected_using_norm constant text :=
    'exists select 1 from tenant_users tu where tu.tenant_id = recipient_tax_profiles.tenant_id and tu.user_id = auth.uid';
  has_data_api_table_priv boolean;
  has_data_api_column_priv boolean;
  rls_ok           boolean;
  unsafe_reason    text;
  graphql_comment  text;
BEGIN
  IF expected_project IS NULL OR expected_project = '' OR expected_project = 'expected_project_ref' THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: expected_project_ref was not supplied';
  END IF;
  IF expected_db IS NULL OR expected_db = '' OR expected_db = 'expected_database' THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: expected_database was not supplied';
  END IF;
  IF expected_owner IS NULL OR expected_owner = '' OR expected_owner = 'expected_owner' THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: expected_owner was not supplied';
  END IF;
  IF NOT (expected_project = ANY (hosted_projects)) THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: project identity is not the authorized hosted ref';
  END IF;
  IF current_database() IS DISTINCT FROM expected_db THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: database identity mismatch';
  END IF;
  IF current_database() LIKE 'checksops%' THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: RDS/AWS database name pattern refused';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname ILIKE 'checksops%' OR rolname ILIKE 'aws_%') THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: AWS/RDS role pattern present';
  END IF;

  rel := to_regclass('public.recipient_tax_profiles');
  IF rel IS NULL THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: table public.recipient_tax_profiles is missing';
  END IF;

  SELECT c.oid, n.nspname, pg_get_userbyid(c.relowner), c.relkind, c.relrowsecurity, c.relforcerowsecurity
    INTO rel_oid, nsp, owner_name, relkind, rls_on, force_rls
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = rel;

  IF nsp IS DISTINCT FROM 'public' OR relkind IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: unexpected schema/relkind';
  END IF;
  IF owner_name IS DISTINCT FROM expected_owner THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: unexpected table owner';
  END IF;

  SELECT coalesce(array_agg(a.attname ORDER BY a.attnum), ARRAY[]::text[])
    INTO col_names
  FROM pg_attribute a
  WHERE a.attrelid = rel_oid AND a.attnum > 0 AND NOT a.attisdropped;

  missing_cols := ARRAY(
    SELECT x FROM unnest(ARRAY[
      'id', 'tenant_id', 'recipient_key', 'recipient_name', 'tin',
      'address_street', 'address_city', 'address_state', 'address_zip',
      'account_number', 'notes', 'created_at', 'updated_at'
    ]) AS x
    WHERE NOT (x = ANY (col_names))
  );
  IF array_length(missing_cols, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: missing expected columns';
  END IF;

  SELECT t.typname INTO tin_udt
  FROM pg_attribute a
  JOIN pg_type t ON t.oid = a.atttypid
  WHERE a.attrelid = rel_oid AND a.attname = 'tin' AND NOT a.attisdropped;
  IF tin_udt IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: column tin has unexpected type';
  END IF;

  FOR dep IN
    SELECT DISTINCT n.nspname AS schema_name, c.relname AS object_name, c.relkind
    FROM pg_depend d
    JOIN pg_class c ON c.oid = CASE WHEN d.classid = 'pg_rewrite'::regclass THEN (
      SELECT r.ev_class FROM pg_rewrite r WHERE r.oid = d.objid
    ) ELSE d.objid END
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE d.refobjid = rel_oid
      AND c.oid <> rel_oid
      AND c.relkind IN ('v', 'm', 'f')
  LOOP
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: dependent object %.% relkind=%',
      dep.schema_name, dep.object_name, dep.relkind;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('v', 'm', 'f')
      AND (
        (n.nspname = 'public' AND c.relname ILIKE '%recipient_tax_profiles%')
        OR (n.nspname IN ('graphql', 'graphql_public') AND (
          c.relname ILIKE '%recipient_tax_profiles%'
          OR (
            c.relkind IN ('v', 'm')
            AND pg_get_viewdef(c.oid, true) ILIKE '%recipient_tax_profiles%'
          )
        ))
      )
  ) THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: view, matview, foreign table, or GraphQL object references recipient_tax_profiles';
  END IF;

  graphql_comment := coalesce(obj_description(rel_oid, 'pg_class'), '');
  IF graphql_comment ILIKE '%graphql%' THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: table comment indicates GraphQL exposure';
  END IF;

  FOR fn IN
    SELECT n.nspname AS schema_name, p.proname, p.prosecdef, p.prokind
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosrc ILIKE '%recipient_tax_profiles%'
  LOOP
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: routine %.% references the table',
      fn.schema_name, fn.proname;
  END LOOP;

  FOR pub IN
    SELECT pt.pubname
    FROM pg_publication_tables pt
    WHERE pt.schemaname = 'public' AND pt.tablename = 'recipient_tax_profiles'
  LOOP
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: table is in a publication';
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    FOR job IN
      SELECT jobid::text AS job_id
      FROM cron.job
      WHERE command ILIKE '%recipient_tax_profiles%'
    LOOP
      RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: pg_cron job references the table';
    END LOOP;
  END IF;

  FOR trg IN
    SELECT t.tgname
    FROM pg_trigger t
    WHERE t.tgrelid = rel_oid AND NOT t.tgisinternal
      AND t.tgname IS DISTINCT FROM 'recipient_tax_profiles_set_updated_at'
  LOOP
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: unexpected trigger';
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_policy p
    WHERE p.polrelid = rel_oid AND p.polname ILIKE 'aws_%'
  ) THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: unexpected aws_* policy';
  END IF;

  FOR mem IN
    SELECT m.rolname AS member_name, g.rolname AS group_name
    FROM pg_auth_members am
    JOIN pg_roles m ON m.oid = am.member
    JOIN pg_roles g ON g.oid = am.roleid
    WHERE (m.rolname IN ('anon', 'authenticated', 'authenticator')
           AND (g.rolname IN ('service_role', 'postgres')
                OR g.rolname ILIKE 'checksops%'
                OR g.rolname ILIKE 'aws_%'))
       OR (g.rolname IN ('anon', 'authenticated', 'authenticator')
           AND (m.rolname ILIKE 'checksops%' OR m.rolname ILIKE 'aws_%'))
  LOOP
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: role-membership ambiguity';
  END LOOP;

  SELECT coalesce(array_agg(p.polname ORDER BY p.polname), ARRAY[]::text[])
    INTO pol_names
  FROM pg_policy p
  WHERE p.polrelid = rel_oid;

  extra_pol := ARRAY(
    SELECT p FROM unnest(pol_names) AS p
    WHERE NOT (p = ANY (expected_pol))
  );
  has_member_pols := (pol_names @> expected_pol) AND (expected_pol @> pol_names);

  has_expected_policy_bodies :=
    EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = rel_oid
        AND p.polname = 'tenant members read recipient_tax_profiles'
        AND p.polcmd = 'r'
        AND cardinality(p.polroles) = 1
        AND pg_get_userbyid(p.polroles[1]) = 'authenticated'
        AND btrim(regexp_replace(regexp_replace(lower(replace(replace(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), 'public.', ''), '"', '')), '[()]', '', 'g'), '[[:space:]]+', ' ', 'g'))
            = expected_using_norm
        AND pg_get_expr(p.polwithcheck, p.polrelid) IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = rel_oid
        AND p.polname = 'tenant members insert recipient_tax_profiles'
        AND p.polcmd = 'a'
        AND cardinality(p.polroles) = 1
        AND pg_get_userbyid(p.polroles[1]) = 'authenticated'
        AND pg_get_expr(p.polqual, p.polrelid) IS NULL
        AND btrim(regexp_replace(regexp_replace(lower(replace(replace(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), 'public.', ''), '"', '')), '[()]', '', 'g'), '[[:space:]]+', ' ', 'g'))
            = expected_using_norm
    )
    AND EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = rel_oid
        AND p.polname = 'tenant members update recipient_tax_profiles'
        AND p.polcmd = 'w'
        AND cardinality(p.polroles) = 1
        AND pg_get_userbyid(p.polroles[1]) = 'authenticated'
        AND btrim(regexp_replace(regexp_replace(lower(replace(replace(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), 'public.', ''), '"', '')), '[()]', '', 'g'), '[[:space:]]+', ' ', 'g'))
            = expected_using_norm
        AND btrim(regexp_replace(regexp_replace(lower(replace(replace(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), 'public.', ''), '"', '')), '[()]', '', 'g'), '[[:space:]]+', ' ', 'g'))
            = expected_using_norm
    )
    AND EXISTS (
      SELECT 1 FROM pg_policy p
      WHERE p.polrelid = rel_oid
        AND p.polname = 'tenant members delete recipient_tax_profiles'
        AND p.polcmd = 'd'
        AND cardinality(p.polroles) = 1
        AND pg_get_userbyid(p.polroles[1]) = 'authenticated'
        AND btrim(regexp_replace(regexp_replace(lower(replace(replace(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), 'public.', ''), '"', '')), '[()]', '', 'g'), '[[:space:]]+', ' ', 'g'))
            = expected_using_norm
        AND pg_get_expr(p.polwithcheck, p.polrelid) IS NULL
    );

  IF EXISTS (
    SELECT 1
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) AS a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE c.oid = rel_oid
      AND c.relacl IS NOT NULL
      AND a.grantee <> 0
      AND NOT (r.rolname = ANY (allowed_grant_roles))
      AND r.rolname IS DISTINCT FROM owner_name
  ) THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: unexpected custom grantee';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: required Data API role missing';
  END IF;

  has_auth_dml :=
    has_table_privilege('authenticated', rel, 'SELECT')
    AND has_table_privilege('authenticated', rel, 'INSERT')
    AND has_table_privilege('authenticated', rel, 'UPDATE')
    AND has_table_privilege('authenticated', rel, 'DELETE');

  has_service :=
    has_table_privilege('service_role', rel, 'SELECT')
    AND has_table_privilege('service_role', rel, 'INSERT')
    AND has_table_privilege('service_role', rel, 'UPDATE')
    AND has_table_privilege('service_role', rel, 'DELETE');

  has_data_api_table_priv := false;
  FOREACH role_name IN ARRAY data_api_roles LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      IF has_table_privilege(role_name, rel, 'SELECT')
         OR has_table_privilege(role_name, rel, 'INSERT')
         OR has_table_privilege(role_name, rel, 'UPDATE')
         OR has_table_privilege(role_name, rel, 'DELETE')
         OR has_table_privilege(role_name, rel, 'TRUNCATE')
         OR has_table_privilege(role_name, rel, 'REFERENCES')
         OR has_table_privilege(role_name, rel, 'TRIGGER') THEN
        has_data_api_table_priv := true;
      END IF;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) AS a
    WHERE c.oid = rel_oid AND c.relacl IS NOT NULL AND a.grantee = 0
  ) THEN
    has_data_api_table_priv := true;
  END IF;

  has_data_api_column_priv := EXISTS (
    SELECT 1
    FROM information_schema.column_privileges cp
    WHERE cp.table_schema = 'public'
      AND cp.table_name = 'recipient_tax_profiles'
      AND cp.grantee IN ('PUBLIC', 'anon', 'authenticated', 'authenticator')
  );

  rls_ok := rls_on IS TRUE;

  IF has_service
     AND rls_ok
     AND force_rls IS NOT TRUE
     AND (array_length(pol_names, 1) IS NULL)
     AND NOT has_data_api_table_priv
     AND NOT has_data_api_column_priv THEN
    classification := 'ALREADY_CONTAINED';
  ELSIF has_member_pols
     AND has_expected_policy_bodies
     AND has_auth_dml
     AND has_service
     AND rls_ok
     AND force_rls IS NOT TRUE
     AND (array_length(extra_pol, 1) IS NULL) THEN
    classification := 'EXACT_EXPECTED_LEGACY';
  ELSE
    classification := 'UNSAFE/AMBIGUOUS';
    unsafe_reason := format(
      'rls=%s force_rls=%s member_policies=%s policy_bodies=%s extra_policies=%s authenticated_dml=%s service_role=%s data_api_table_priv=%s data_api_column_priv=%s',
      rls_on, force_rls, has_member_pols, has_expected_policy_bodies, extra_pol, has_auth_dml, has_service,
      has_data_api_table_priv, has_data_api_column_priv
    );
  END IF;

  RAISE NOTICE 'CLASSIFICATION=%', classification;

  IF classification = 'UNSAFE/AMBIGUOUS' THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: classification=UNSAFE/AMBIGUOUS (%)', unsafe_reason;
  END IF;

  IF classification = 'ALREADY_CONTAINED' THEN
    PERFORM set_config('checksops.containment_mutated', 'false', false);
    RAISE NOTICE 'recipient_tax_profiles containment: already applied, no-op';
    RETURN;
  END IF;

  IF NOT rls_ok THEN
    EXECUTE 'ALTER TABLE public.recipient_tax_profiles ENABLE ROW LEVEL SECURITY';
  END IF;

  REVOKE ALL ON TABLE public.recipient_tax_profiles FROM PUBLIC;
  REVOKE ALL ON TABLE public.recipient_tax_profiles FROM anon;
  REVOKE ALL ON TABLE public.recipient_tax_profiles FROM authenticated;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.recipient_tax_profiles FROM authenticator';
  END IF;

  FOR col IN
    SELECT a.attname
    FROM pg_attribute a
    WHERE a.attrelid = rel_oid AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    EXECUTE format('REVOKE ALL (%I) ON TABLE public.recipient_tax_profiles FROM PUBLIC', col.attname);
    EXECUTE format('REVOKE ALL (%I) ON TABLE public.recipient_tax_profiles FROM anon', col.attname);
    EXECUTE format('REVOKE ALL (%I) ON TABLE public.recipient_tax_profiles FROM authenticated', col.attname);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
      EXECUTE format('REVOKE ALL (%I) ON TABLE public.recipient_tax_profiles FROM authenticator', col.attname);
    END IF;
  END LOOP;

  DROP POLICY IF EXISTS "tenant members read recipient_tax_profiles" ON public.recipient_tax_profiles;
  DROP POLICY IF EXISTS "tenant members insert recipient_tax_profiles" ON public.recipient_tax_profiles;
  DROP POLICY IF EXISTS "tenant members update recipient_tax_profiles" ON public.recipient_tax_profiles;
  DROP POLICY IF EXISTS "tenant members delete recipient_tax_profiles" ON public.recipient_tax_profiles;

  IF NOT has_table_privilege('service_role', 'public.recipient_tax_profiles'::regclass, 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.recipient_tax_profiles'::regclass, 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.recipient_tax_profiles'::regclass, 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.recipient_tax_profiles'::regclass, 'DELETE') THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: service_role lost required table privileges';
  END IF;

  IF has_table_privilege('anon', 'public.recipient_tax_profiles'::regclass, 'SELECT')
     OR has_table_privilege('authenticated', 'public.recipient_tax_profiles'::regclass, 'SELECT')
     OR has_table_privilege('authenticated', 'public.recipient_tax_profiles'::regclass, 'INSERT')
     OR has_table_privilege('authenticated', 'public.recipient_tax_profiles'::regclass, 'UPDATE')
     OR has_table_privilege('authenticated', 'public.recipient_tax_profiles'::regclass, 'DELETE')
     OR has_table_privilege('authenticated', 'public.recipient_tax_profiles'::regclass, 'TRUNCATE')
     OR EXISTS (
       SELECT 1 FROM pg_class c
       CROSS JOIN LATERAL aclexplode(c.relacl) AS a
       WHERE c.oid = 'public.recipient_tax_profiles'::regclass
         AND c.relacl IS NOT NULL AND a.grantee = 0
     ) THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: Data API privileges remain after revoke';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policy p WHERE p.polrelid = 'public.recipient_tax_profiles'::regclass
  ) THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: policies remain after drop';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'recipient_tax_profiles' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: RLS is not enabled';
  END IF;

  EXECUTE $c$
    COMMENT ON TABLE public.recipient_tax_profiles IS
      'Direct Data API grants to PUBLIC/anon/authenticated are revoked. Use the dedicated server Tax/1099 handler. Do not grant browser roles back.';
  $c$;

  PERFORM set_config('checksops.containment_mutated', 'true', false);
  RAISE NOTICE 'recipient_tax_profiles containment: Data API privileges revoked; member policies dropped; service_role preserved';
END
$containment$;

COMMIT;

SELECT CASE
  WHEN current_setting('checksops.containment_mutated', true) = 'true'
  THEN pg_notify('pgrst', 'reload schema')
END;
