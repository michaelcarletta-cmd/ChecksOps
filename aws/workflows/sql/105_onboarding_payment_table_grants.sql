-- SQL 105: table grants on the four payment tables SQL 91's Moov onboarding policies cover
-- but never granted to checksops. SQL 91 (91_moov_onboarding.sql) added the policies
-- aws_onboarding_{insert,select,update}_payment_provider_accounts,
-- aws_onboarding_{insert,update}_payment_provider_methods,
-- aws_onboarding_{insert,update}_payment_method_verifications and
-- aws_onboarding_insert_payment_event_log, and granted the four moov_* tables, but these four
-- tables' only grants come from supabase migrations (to authenticated and service_role).
-- Without a grant PostgreSQL refuses checksops before any policy is evaluated: staging
-- 2026-10-20 12:18:20Z, moov-onboarding-save, "permission denied for table
-- payment_provider_accounts" on the first write after Moov accepted the account (SQL 104 fixed
-- the same gap for payment_idempotency_keys).
--
-- Grants, as SQL 91 does for its four onboarding tables and SQL 104 for
-- payment_idempotency_keys, to checksops and authenticated:
--   public.payment_provider_accounts     SELECT, INSERT, UPDATE
--   public.payment_provider_methods      SELECT, INSERT, UPDATE
--   public.payment_method_verifications  SELECT, INSERT, UPDATE
--   public.payment_event_log             SELECT, INSERT   (SQL 91 has an insert policy only)
-- Does not GRANT DELETE, TRUNCATE, REFERENCES or TRIGGER, does not GRANT to PUBLIC or anon,
-- and does not ENABLE/FORCE RLS or touch policies: SQL 91's policies remain the
-- authorization boundary.
--
-- Idempotent: GRANT is a no-op when already held; the guard skips a table or grantee role
-- that is absent.
--
-- NOT APPLIED. Apply only through the guarded SQL path (AGENTS.md) after a read-only inspect,
-- staging first.

DO $$
DECLARE
  grantee text;
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('public.payment_provider_accounts',    'SELECT, INSERT, UPDATE'),
      ('public.payment_provider_methods',     'SELECT, INSERT, UPDATE'),
      ('public.payment_method_verifications', 'SELECT, INSERT, UPDATE'),
      ('public.payment_event_log',            'SELECT, INSERT')
    ) AS v(relation, privileges)
  LOOP
    IF to_regclass(t.relation) IS NULL THEN
      RAISE NOTICE 'SQL 105: % absent; skipped', t.relation;
      CONTINUE;
    END IF;
    FOREACH grantee IN ARRAY ARRAY['checksops', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
        EXECUTE format('GRANT %s ON TABLE %s TO %I', t.privileges, t.relation, grantee);
      ELSE
        RAISE NOTICE 'SQL 105: role % absent; skipped its grant on %', grantee, t.relation;
      END IF;
    END LOOP;
  END LOOP;
END
$$;
