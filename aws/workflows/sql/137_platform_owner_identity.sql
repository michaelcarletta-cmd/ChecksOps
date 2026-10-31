-- SQL 137: public.is_platform_owner() decided by the identity account only, and the identity
-- accounts no longer rewritable by the API login.
-- AWS only: nothing under supabase/migrations changes.
--
-- Why: security audit 2026-10-29, finding 15 (medium, database access only). is_platform_owner()
-- (aws/rls/sql/10_owner_helpers_from_identity.sql; no later migration redefines it) answers true
-- when the caller's identity_accounts row OR the caller's profiles row carries the platform-owner
-- mailbox checksopsadmin@gmail.com. checksops (the API login, a member of authenticated) can UPDATE
-- both columns: profiles by table-level UPDATE (aws/workflows/sql/66_staging_app_metadata_grants.sql,
-- aws/identity/sql/07_hire_mortgage_agent_grants.sql) and identity_accounts by table-level UPDATE
-- (07_hire_mortgage_agent_grants.sql). So a session holding the checksops credentials could make any
-- user the platform owner with one UPDATE of that user's profiles.email, and, on identity_accounts
-- (where identity_accounts_email_lower_key keeps the mailbox unique), by moving the owner's mailbox
-- to another row. Every platform-owner policy and API gate (is_master_owner() delegates to it) would
-- then follow.
--
-- What the API needs: no API path writes either email column. The only UPDATEs of profiles the API
-- runs are full_name / phone (write-app-metadata.mjs executeProfiles) and totp_enrolled_at
-- (admin-reset-totp.mjs); profiles.email is only inserted (tenant-admin.mjs, the mortgage desk
-- hire). identity_accounts is only read and inserted by checksops (tenant-admin.mjs,
-- INSERT ... ON CONFLICT (cognito_sub) DO NOTHING, which needs no UPDATE); it is updated only by the
-- SECURITY DEFINER invite function (SQL 90 / SQL 101, as its owner) and the admin-login identity
-- one-offs (aws/identity/oneshot/onboard.mjs, aws/identity/sql/09). Nothing in the API, the
-- workflow SQL or the scripts deletes or truncates identity_accounts.
--
-- What this file does:
-- 1) public.is_platform_owner(): same signature, result (boolean), LANGUAGE sql, STABLE, SECURITY
--    DEFINER, search_path = public, row_security = off, owner. The body keeps only the identity
--    branch: the caller (auth.uid(), the application user the API resolved from the Cognito sub) has
--    an identity_accounts row in status active or isolated_test whose email, lower-cased, is
--    checksopsadmin@gmail.com. The profiles branch is removed, so profiles.email no longer decides
--    anything here. How the owner is identified does not change: the same mailbox on the same
--    identity row, so today's owner is recognized exactly as before (precondition c below).
--    EXECUTE: revoked from PUBLIC and from anon and service_role where those roles exist; granted to
--    checksops and authenticated (aws/rls/sql/15_access_grants.sql); the owner keeps its own.
-- 2) public.identity_accounts: UPDATE, DELETE and TRUNCATE revoked from PUBLIC, checksops and
--    authenticated, and from anon where it exists. With the unique lower(email) index this makes the
--    identity row's mailbox fixed for the API login: it can neither rewrite an email nor delete the
--    owner's row to insert its own. SELECT and INSERT stay as they are. A table-level REVOKE also
--    removes those roles' column UPDATE grants on the table, if any.
--
-- Not changed: profiles' grants (its email column no longer matters to is_platform_owner(); narrowing
-- the table-level UPDATE to columns is a separate change); is_master_owner() (it delegates);
-- identity_accounts' SELECT and INSERT; every policy, table, column, index, trigger and row. The
-- API's own platform-owner refusals (tenant-admin.mjs USER_IS_PLATFORM_OWNER_SQL, admin-reset-totp.mjs
-- RESET_TOTP_TARGET_IS_PLATFORM_OWNER_SQL) and the SQL 90 / SQL 101 / SQL 133 guards still also read
-- profiles.email: they only protect the owner (a match refuses), and are not changed here.
--
-- Preconditions fail closed (nothing changes otherwise):
--   a. identity_accounts, profiles, their columns, auth.uid(), is_platform_owner() and the roles
--      checksops and authenticated exist (sql137_table_missing, sql137_column_missing,
--      sql137_function_missing, sql137_role_missing);
--   b. identity_accounts has a valid unique index on lower(email) (sql137_owner_email_not_unique);
--   c. exactly one identity_accounts row in status active or isolated_test carries the owner mailbox
--      (sql137_owner_identity_count), and no profiles row carries it without that identity row
--      (sql137_owner_profile_without_identity): every user is_platform_owner() recognizes before the
--      file is still recognized after it, and no other.
-- Transactions: like main's other aws/workflows/sql files this has no BEGIN/COMMIT; the guarded SQL
-- executor runs it inside one transaction.
-- Idempotent: CREATE OR REPLACE with the same body, GRANT of a held privilege and REVOKE of an absent
-- one are no-ops. Not applied by this change: staging first, then production, through the guarded SQL
-- path (AGENTS.md).

DO $sql137_preconditions$
DECLARE
  v_table text;
  v_column text;
  v_role text;
  v_owner_rows integer;
  v_profile_only integer;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['public.identity_accounts', 'public.profiles'] LOOP
    IF pg_catalog.to_regclass(v_table) IS NULL THEN
      RAISE EXCEPTION 'sql137_table_missing: % does not exist', v_table
        USING ERRCODE = '42P01';
    END IF;
  END LOOP;
  FOREACH v_column IN ARRAY ARRAY[
    'public.identity_accounts.application_user_id', 'public.identity_accounts.email',
    'public.identity_accounts.status', 'public.profiles.id', 'public.profiles.email'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = pg_catalog.to_regclass(pg_catalog.regexp_replace(v_column, '\.[a-z_]+$', ''))
         AND a.attname = pg_catalog.regexp_replace(v_column, '^.*\.', '')
         AND a.attnum > 0
         AND NOT a.attisdropped
    ) THEN
      RAISE EXCEPTION 'sql137_column_missing: % does not exist', v_column
        USING ERRCODE = '42703';
    END IF;
  END LOOP;
  IF pg_catalog.to_regprocedure('auth.uid()') IS NULL
     OR pg_catalog.to_regprocedure('public.is_platform_owner()') IS NULL THEN
    RAISE EXCEPTION 'sql137_function_missing: auth.uid() and public.is_platform_owner() must exist'
      USING ERRCODE = '42883';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['checksops', 'authenticated'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = v_role) THEN
      RAISE EXCEPTION 'sql137_role_missing: role % does not exist', v_role
        USING ERRCODE = '42704';
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index i
     WHERE i.indrelid = 'public.identity_accounts'::regclass
       AND i.indisunique
       AND i.indisvalid
       AND i.indnatts = 1
       AND pg_catalog.pg_get_indexdef(i.indexrelid, 1, true) = 'lower(email)'
  ) THEN
    RAISE EXCEPTION 'sql137_owner_email_not_unique: public.identity_accounts has no valid unique index on lower(email)'
      USING ERRCODE = '55000';
  END IF;
  SELECT count(*) INTO v_owner_rows
    FROM public.identity_accounts ia
   WHERE ia.status IN ('active', 'isolated_test')
     AND lower(ia.email) = 'checksopsadmin@gmail.com';
  IF v_owner_rows <> 1 THEN
    RAISE EXCEPTION 'sql137_owner_identity_count: % identity_accounts rows carry the platform-owner mailbox (expected exactly 1)', v_owner_rows
      USING ERRCODE = '55000';
  END IF;
  SELECT count(*) INTO v_profile_only
    FROM public.profiles p
   WHERE lower(p.email) = 'checksopsadmin@gmail.com'
     AND NOT EXISTS (
       SELECT 1 FROM public.identity_accounts ia
        WHERE ia.application_user_id = p.id
          AND ia.status IN ('active', 'isolated_test')
          AND lower(ia.email) = 'checksopsadmin@gmail.com'
     );
  IF v_profile_only <> 0 THEN
    RAISE EXCEPTION 'sql137_owner_profile_without_identity: % profiles rows carry the platform-owner mailbox without its identity row', v_profile_only
      USING ERRCODE = '55000';
  END IF;
END
$sql137_preconditions$;

-- 1) The platform owner from the identity account only.
CREATE OR REPLACE FUNCTION public.is_platform_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET row_security = off
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.identity_accounts ia
    WHERE ia.application_user_id = auth.uid()
      AND ia.status IN ('active', 'isolated_test')
      AND lower(ia.email) = 'checksopsadmin@gmail.com'
  );
$$;

COMMENT ON FUNCTION public.is_platform_owner() IS
  'Platform owner only when the resolved application identity (identity_accounts, active or isolated_test) carries checksopsadmin@gmail.com; profiles.email is not read (SQL 137).';

REVOKE ALL ON FUNCTION public.is_platform_owner() FROM PUBLIC;

DO $sql137_function_acl$
DECLARE
  v_grantee text;
BEGIN
  FOREACH v_grantee IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_grantee) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.is_platform_owner() FROM %I', v_grantee);
    END IF;
  END LOOP;
END
$sql137_function_acl$;

GRANT EXECUTE ON FUNCTION public.is_platform_owner() TO checksops, authenticated;

-- 2) The identity rows fixed for the API login: no UPDATE, DELETE or TRUNCATE.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.identity_accounts FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.identity_accounts FROM checksops, authenticated;

DO $sql137_table_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.identity_accounts FROM anon';
  END IF;
END
$sql137_table_acl$;
