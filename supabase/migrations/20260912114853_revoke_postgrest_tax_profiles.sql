-- Revoke PostgREST / Data API access to public.recipient_tax_profiles.
--
-- Created with: supabase migration new revoke_postgrest_tax_profiles
-- Transaction: this file is one unit of work (BEGIN … COMMIT). Apply the
-- entire file in one shot. Do not run statement-by-statement.
--
-- This migration does not SELECT, UPDATE, DELETE, or print table rows.
-- It does not read column `tin`. It does not create a public SECURITY DEFINER
-- function. It does not restore authenticated/anon grants.
--
-- Repeat-safe when the catalog already matches the contained end state.
-- Unexpected policies, grants, views, functions, or publications fail closed.

BEGIN;

DO $containment$
DECLARE
  rel          regclass;
  rel_oid      oid;
  nsp          text;
  owner_name   text;
  rls_on       boolean;
  force_rls    boolean;
  col_names    text[];
  missing_cols text[];
  tin_udt      text;
  pol          record;
  pol_names    text[];
  expected_pol text[] := ARRAY[
    'tenant members read recipient_tax_profiles',
    'tenant members insert recipient_tax_profiles',
    'tenant members update recipient_tax_profiles',
    'tenant members delete recipient_tax_profiles'
  ];
  extra_pol    text[];
  missing_pol  text[];
  grantee_name text;
  priv         text;
  unexpected_grant text;
  col          record;
  dep          record;
  fn           record;
  pub          record;
  job          record;
  role_name    text;
  data_api_roles text[] := ARRAY['anon', 'authenticated', 'authenticator'];
  allowed_grant_roles text[] := ARRAY[
    'postgres', 'supabase_admin', 'service_role', 'authenticated', 'anon', 'authenticator'
  ];
  has_auth_dml boolean;
  has_service  boolean;
  has_member_pols boolean;
  has_data_api_table_priv boolean;
  has_data_api_column_priv boolean;
  already_contained boolean;
  legacy_state boolean;
  rls_ok       boolean;
BEGIN
  rel := to_regclass('public.recipient_tax_profiles');
  IF rel IS NULL THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: table public.recipient_tax_profiles is missing';
  END IF;

  SELECT c.oid, n.nspname, pg_get_userbyid(c.relowner), c.relrowsecurity, c.relforcerowsecurity
    INTO rel_oid, nsp, owner_name, rls_on, force_rls
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = rel;

  IF nsp IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: table is not in public (found %)', nsp;
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
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: missing expected columns %', missing_cols;
  END IF;

  SELECT t.typname INTO tin_udt
  FROM pg_attribute a
  JOIN pg_type t ON t.oid = a.atttypid
  WHERE a.attrelid = rel_oid AND a.attname = 'tin' AND NOT a.attisdropped;
  IF tin_udt IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: column tin has unexpected type %', tin_udt;
  END IF;

  -- Views / materialized views that depend on the table (would expose rows/TIN).
  FOR dep IN
    SELECT DISTINCT n.nspname AS schema_name, c.relname AS object_name, c.relkind
    FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_class c ON c.oid = r.ev_class
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE d.refobjid = rel_oid
      AND c.oid <> rel_oid
      AND c.relkind IN ('v', 'm')
  LOOP
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: dependent % %.% must not expose this table',
      CASE dep.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'object' END,
      dep.schema_name, dep.object_name;
  END LOOP;

  -- Functions/procedures whose source names the table (no public RPC/DEFINER leak).
  FOR fn IN
    SELECT n.nspname AS schema_name, p.proname, p.prosecdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosrc ILIKE '%recipient_tax_profiles%'
  LOOP
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: function %.% references the table (security_definer=%)',
      fn.schema_name, fn.proname, fn.prosecdef;
  END LOOP;

  -- Realtime / logical publications would stream row images including tin.
  FOR pub IN
    SELECT pt.pubname
    FROM pg_publication_tables pt
    WHERE pt.schemaname = 'public' AND pt.tablename = 'recipient_tax_profiles'
  LOOP
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: table is in publication %', pub.pubname;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    FOR job IN
      SELECT jobid::text AS job_id
      FROM cron.job
      WHERE command ILIKE '%recipient_tax_profiles%'
    LOOP
      RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: pg_cron job % references the table', job.job_id;
    END LOOP;
  END IF;

  SELECT coalesce(array_agg(p.polname ORDER BY p.polname), ARRAY[]::text[])
    INTO pol_names
  FROM pg_policy p
  WHERE p.polrelid = rel_oid;

  extra_pol := ARRAY(
    SELECT p FROM unnest(pol_names) AS p
    WHERE NOT (p = ANY (expected_pol))
  );
  missing_pol := ARRAY(
    SELECT p FROM unnest(expected_pol) AS p
    WHERE NOT (p = ANY (pol_names))
  );
  has_member_pols := (pol_names @> expected_pol) AND (expected_pol @> pol_names);

  -- Unexpected role grants on the table (catalog only; no row access).
  FOR grantee_name, priv IN
    SELECT r.rolname, a.privilege_type
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) AS a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE c.oid = rel_oid
      AND c.relacl IS NOT NULL
      AND a.grantee <> 0
      AND NOT (r.rolname = ANY (allowed_grant_roles))
      AND r.rolname IS DISTINCT FROM owner_name
  LOOP
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: unexpected table grant % to role %',
      priv, grantee_name;
  END LOOP;

  -- PUBLIC grantee is oid 0 from aclexplode; also scan information_schema.
  IF EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants g
    WHERE g.table_schema = 'public'
      AND g.table_name = 'recipient_tax_profiles'
      AND g.grantee NOT IN (
        'postgres', 'supabase_admin', 'service_role', 'authenticated', 'anon',
        'authenticator', 'PUBLIC', owner_name
      )
  ) THEN
    SELECT g.grantee || ':' || g.privilege_type INTO unexpected_grant
    FROM information_schema.role_table_grants g
    WHERE g.table_schema = 'public'
      AND g.table_name = 'recipient_tax_profiles'
      AND g.grantee NOT IN (
        'postgres', 'supabase_admin', 'service_role', 'authenticated', 'anon',
        'authenticator', 'PUBLIC', owner_name
      )
    LIMIT 1;
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: unexpected table grant %', unexpected_grant;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: role authenticated is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: role anon is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: role service_role is missing';
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
    WHERE c.oid = rel_oid
      AND c.relacl IS NOT NULL
      AND a.grantee = 0
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
  already_contained :=
    has_service
    AND (array_length(pol_names, 1) IS NULL)
    AND NOT has_data_api_table_priv
    AND NOT has_data_api_column_priv;

  legacy_state :=
    has_member_pols
    AND has_auth_dml
    AND has_service
    AND (array_length(extra_pol, 1) IS NULL);

  IF already_contained THEN
    IF NOT rls_ok THEN
      EXECUTE 'ALTER TABLE public.recipient_tax_profiles ENABLE ROW LEVEL SECURITY';
      RAISE NOTICE 'recipient_tax_profiles containment: already revoked; enabled RLS';
    ELSE
      RAISE NOTICE 'recipient_tax_profiles containment: already applied, no-op';
    END IF;
    RETURN;
  END IF;

  IF NOT legacy_state THEN
    RAISE EXCEPTION 'recipient_tax_profiles containment failed closed: ambiguous catalog state (rls=%, member_policies=%, extra_policies=%, missing_policies=%, authenticated_dml=%, service_role=%, data_api_table_priv=%, data_api_column_priv=%)',
      rls_on, has_member_pols, extra_pol, missing_pol, has_auth_dml, has_service,
      has_data_api_table_priv, has_data_api_column_priv;
  END IF;

  -- Defense in depth. FORCE RLS is not set: table-owner maintenance and
  -- hosted backups must keep working. Data API roles are revoked below.
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
    EXECUTE format(
      'REVOKE ALL (%I) ON TABLE public.recipient_tax_profiles FROM PUBLIC',
      col.attname
    );
    EXECUTE format(
      'REVOKE ALL (%I) ON TABLE public.recipient_tax_profiles FROM anon',
      col.attname
    );
    EXECUTE format(
      'REVOKE ALL (%I) ON TABLE public.recipient_tax_profiles FROM authenticated',
      col.attname
    );
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
      EXECUTE format(
        'REVOKE ALL (%I) ON TABLE public.recipient_tax_profiles FROM authenticator',
        col.attname
      );
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
       SELECT 1
       FROM pg_class c
       CROSS JOIN LATERAL aclexplode(c.relacl) AS a
       WHERE c.oid = 'public.recipient_tax_profiles'::regclass
         AND c.relacl IS NOT NULL
         AND a.grantee = 0
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

  PERFORM pg_notify('pgrst', 'reload schema');
  RAISE NOTICE 'recipient_tax_profiles containment: Data API privileges revoked; member policies dropped; service_role preserved';
END
$containment$;

COMMIT;
