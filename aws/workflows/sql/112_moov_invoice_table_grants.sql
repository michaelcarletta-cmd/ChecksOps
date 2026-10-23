-- SQL 112: table grants on the two Moov invoice tables the production invoice handler
-- (aws/functions/api/providers/production/moov-invoice.mjs, live since 2026-10-23, through
-- aws/functions/api/invoice-provider.mjs and invoice-actions.mjs) reads and writes:
--   public.moov_invoices           SELECT, INSERT, UPDATE, DELETE  (list, create, send, void,
--                                  status refresh, delete a draft)
--   public.moov_invoice_customers  SELECT, INSERT                  (find or create the Moov
--                                  customer account of a payer)
-- Both tables' only grants in this repository come from the supabase migration
-- 20260819015105 (SELECT, INSERT, UPDATE, DELETE to authenticated; ALL to service_role); no
-- migration grants checksops anything on them. PostgreSQL checks table privileges before
-- row-level security, so a missing grant refuses checksops before any policy is evaluated
-- (as SQL 104 and SQL 105 found for the payment tables). Whether production already holds
-- these lines is what the read-only inspect of this migration records; where every line is
-- held the inspect reports already_applied true and nothing is applied.
--
-- Grants, as SQL 105 does for the onboarding payment tables, to checksops and authenticated:
--   public.moov_invoices           SELECT, INSERT, UPDATE, DELETE
--   public.moov_invoice_customers  SELECT, INSERT
-- Does not GRANT TRUNCATE, REFERENCES or TRIGGER, does not GRANT to PUBLIC or anon, and does
-- not ENABLE/FORCE RLS or touch policies: the tables' policies remain the authorization
-- boundary.
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
      ('public.moov_invoices',          'SELECT, INSERT, UPDATE, DELETE'),
      ('public.moov_invoice_customers', 'SELECT, INSERT')
    ) AS v(relation, privileges)
  LOOP
    IF to_regclass(t.relation) IS NULL THEN
      RAISE NOTICE 'SQL 112: % absent; skipped', t.relation;
      CONTINUE;
    END IF;
    FOREACH grantee IN ARRAY ARRAY['checksops', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
        EXECUTE format('GRANT %s ON TABLE %s TO %I', t.privileges, t.relation, grantee);
      ELSE
        RAISE NOTICE 'SQL 112: role % absent; skipped its grant on %', grantee, t.relation;
      END IF;
    END LOOP;
  END LOOP;
END
$$;
