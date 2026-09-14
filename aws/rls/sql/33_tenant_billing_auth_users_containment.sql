-- 33_tenant_billing_auth_users_containment.sql
-- Unapplied operator package. Do not run from completeAuth, CI, deploy,
-- package scripts, Supabase Preview, or application startup.
-- Apply only with explicit authorization.
--
-- Monthly-fee auto-billing writes fail with:
--   42501 permission denied for table users
-- because leftover dump RLS on public.tenant_billing_accounts evaluates
--   SELECT id FROM auth.users ...
-- as the current role (authenticated / checksops). That role must not read
-- auth.users. A leftover FK to auth.users(id) on ach_authorized_by produces
-- the same error when that column is assigned.
--
-- Scope: public.tenant_billing_accounts only.
-- Does not GRANT SELECT on auth.users.
-- Does not retarget other auth.users FKs.
-- Does not edit oneshot runners, write-allowlist, or identity helpers.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

DO $apply$
DECLARE
  rec record;
  has_auth_users boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'auth' AND c.relname = 'users' AND c.relkind = 'r'
  ) INTO has_auth_users;

  IF has_auth_users THEN
    REVOKE ALL ON TABLE auth.users FROM PUBLIC;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      REVOKE ALL ON TABLE auth.users FROM authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops') THEN
      REVOKE ALL ON TABLE auth.users FROM checksops;
    END IF;
  END IF;

  IF to_regclass('public.tenant_billing_accounts') IS NULL THEN
    RAISE EXCEPTION 'public.tenant_billing_accounts is missing';
  END IF;

  FOR rec IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tenant_billing_accounts'
      AND (
        coalesce(qual, '') ~* 'auth\.users'
        OR coalesce(with_check, '') ~* 'auth\.users'
      )
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.tenant_billing_accounts',
      rec.policyname
    );
  END LOOP;

  DROP POLICY IF EXISTS "Platform admin manages all billing accounts"
    ON public.tenant_billing_accounts;

  FOR rec IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    JOIN pg_class ref ON c.confrelid = ref.oid
    JOIN pg_namespace rn ON ref.relnamespace = rn.oid
    WHERE n.nspname = 'public'
      AND t.relname = 'tenant_billing_accounts'
      AND c.contype = 'f'
      AND rn.nspname = 'auth'
      AND ref.relname = 'users'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.tenant_billing_accounts DROP CONSTRAINT %I',
      rec.conname
    );
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tenant_billing_accounts'
      AND column_name = 'routing_number'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.tenant_billing_accounts
      ALTER COLUMN routing_number DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tenant_billing_accounts'
      AND column_name = 'account_number_encrypted'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.tenant_billing_accounts
      ALTER COLUMN account_number_encrypted DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'tenant_billing_accounts'
      AND column_name = 'account_number_last4'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.tenant_billing_accounts
      ALTER COLUMN account_number_last4 DROP NOT NULL;
  END IF;

  ALTER TABLE public.tenant_billing_accounts
    DROP CONSTRAINT IF EXISTS tenant_billing_accounts_bank_source_check;
  ALTER TABLE public.tenant_billing_accounts
    ADD CONSTRAINT tenant_billing_accounts_bank_source_check
    CHECK (
      stakeholder_account_id IS NOT NULL
      OR (
        routing_number IS NOT NULL
        AND account_number_last4 IS NOT NULL
        AND account_number_encrypted IS NOT NULL
        AND account_holder_name IS NOT NULL
      )
    );

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.tenant_billing_accounts TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.tenant_billing_accounts TO checksops;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'tenant_billing_accounts'
      AND cmd IN ('ALL', 'INSERT')
      AND roles && ARRAY['authenticated']::name[]
  ) THEN
    EXECUTE $pol$
      CREATE POLICY tenant_billing_accounts_member_write
      ON public.tenant_billing_accounts
      FOR ALL TO authenticated
      USING (
        tenant_id IN (
          SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = auth.uid()
        )
      )
      WITH CHECK (
        tenant_id IN (
          SELECT tu.tenant_id FROM public.tenant_users tu WHERE tu.user_id = auth.uid()
        )
      )
    $pol$;
  END IF;
END
$apply$;

COMMIT;
