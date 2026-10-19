-- SQL 104: table grant on payment_idempotency_keys so Moov onboarding can write its
-- idempotency keys. SQL 91 (91_moov_onboarding.sql) added the policies
-- aws_onboarding_insert_payment_idempotency_keys and
-- aws_onboarding_update_payment_idempotency_keys but no table grant, and the table's only
-- grants come from supabase migration 20260727224957 (to service_role). Without a grant,
-- PostgreSQL refuses checksops ("permission denied for table payment_idempotency_keys")
-- before any policy is evaluated, so saving Moov onboarding fails.
--
-- Replaces #1062, which edited the already-applied SQL 91 (applied to staging 2026-10-17 and
-- production 2026-10-19; both runs are recorded against SQL 91's original bytes, and its
-- production pin is retired, so an edit to SQL 91 would never reach production). Per #1062
-- the same grant was applied to staging by hand, outside the guard: staging may already hold
-- it, and GRANT is then a no-op.
--
-- Grants SELECT, INSERT and UPDATE on public.payment_idempotency_keys to checksops and
-- authenticated, as SQL 91 does for its four onboarding tables. Does not GRANT DELETE,
-- TRUNCATE, REFERENCES or TRIGGER, does not GRANT to PUBLIC or anon, and does not ENABLE/FORCE
-- RLS or touch policies: SQL 91's policies remain the authorization boundary.
--
-- Idempotent: GRANT is a no-op when already held; the guard skips cleanly when the table or a
-- grantee role is absent.
--
-- NOT APPLIED. Apply only through the guarded SQL path (AGENTS.md) after a read-only inspect,
-- staging first.

DO $$
BEGIN
  IF to_regclass('public.payment_idempotency_keys') IS NULL THEN
    RAISE NOTICE 'SQL 104: public.payment_idempotency_keys absent; skipped';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'checksops') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.payment_idempotency_keys TO checksops';
  ELSE
    RAISE NOTICE 'SQL 104: role checksops absent; skipped its grant';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.payment_idempotency_keys TO authenticated';
  ELSE
    RAISE NOTICE 'SQL 104: role authenticated absent; skipped its grant';
  END IF;
END
$$;
