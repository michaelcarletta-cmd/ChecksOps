-- Catalog-only inventory for public.recipient_tax_profiles.
-- NOT THE APPLY FILE. NOT THE FAIL-CLOSED PREFLIGHT GATE.
-- The gate is supabase/security/preflight_gate_revoke_postgrest_tax_profiles.sql
-- The unapplied mutation is
--   supabase/security/unapplied-do-not-run/NOT_APPLIED_revoke_postgrest_tax_profiles.sql
--
-- Run against a target database by an authorized operator during preflight.
-- Do not SELECT from the table. Do not mention or return column tin values.
-- This file never mutates privileges or policies. It is not applied by this PR.

SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       pg_get_userbyid(c.relowner) AS table_owner,
       c.relkind AS relkind,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS force_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'recipient_tax_profiles';

SELECT a.attname AS column_name, t.typname AS type_name
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
WHERE n.nspname = 'public'
  AND c.relname = 'recipient_tax_profiles'
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY a.attnum;

SELECT coalesce(r.rolname, 'PUBLIC') AS grantee,
       a.privilege_type,
       a.is_grantable
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) AS a
LEFT JOIN pg_roles r ON r.oid = a.grantee
WHERE n.nspname = 'public'
  AND c.relname = 'recipient_tax_profiles'
  AND c.relacl IS NOT NULL
ORDER BY 1, 2;

SELECT grantee, privilege_type, column_name
FROM information_schema.column_privileges
WHERE table_schema = 'public'
  AND table_name = 'recipient_tax_profiles'
  AND grantee IN ('PUBLIC', 'anon', 'authenticated', 'authenticator', 'service_role', 'postgres')
ORDER BY grantee, column_name, privilege_type;

SELECT polname, polcmd, polroles::regrole[], pg_get_expr(polqual, polrelid) AS using_expr,
       pg_get_expr(polwithcheck, polrelid) AS with_check_expr
FROM pg_policy
WHERE polrelid = 'public.recipient_tax_profiles'::regclass
ORDER BY polname;

SELECT m.rolname AS member_role, g.rolname AS granted_role
FROM pg_auth_members am
JOIN pg_roles m ON m.oid = am.member
JOIN pg_roles g ON g.oid = am.roleid
WHERE m.rolname IN ('anon', 'authenticated', 'authenticator', 'service_role', 'postgres')
   OR g.rolname IN ('anon', 'authenticated', 'authenticator', 'service_role', 'postgres')
   OR m.rolname ILIKE 'aws_%'
   OR g.rolname ILIKE 'aws_%'
   OR m.rolname ILIKE 'checksops%'
   OR g.rolname ILIKE 'checksops%'
ORDER BY 1, 2;

SELECT n.nspname, c.relname, c.relkind
FROM pg_depend d
JOIN pg_rewrite r ON r.oid = d.objid
JOIN pg_class c ON c.oid = r.ev_class
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE d.refobjid = 'public.recipient_tax_profiles'::regclass
  AND c.relkind IN ('v', 'm');

SELECT n.nspname, c.relname, c.relkind
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'f'
  AND c.relname ILIKE '%recipient_tax_profiles%';

SELECT n.nspname, p.proname, p.prosecdef, p.prokind
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosrc ILIKE '%recipient_tax_profiles%';

SELECT tgname, pg_get_triggerdef(t.oid)
FROM pg_trigger t
WHERE t.tgrelid = 'public.recipient_tax_profiles'::regclass
  AND NOT t.tgisinternal;

SELECT pubname
FROM pg_publication_tables
WHERE schemaname = 'public' AND tablename = 'recipient_tax_profiles';
