-- SQL 114: column-scoped UPDATE grant so Settings > Stakeholder Accounts can edit a
-- stakeholder on AWS. The page (src/components/disbursement/StakeholderAccountSettings.tsx)
--   - removes a non-payee stakeholder: is_active = false, is_primary = false;
--   - changes a stakeholder's type: account_type (for example homeowner to contractor),
--     clearing homeowner_name and homeowner_email when it stops being a homeowner;
-- each on its public.stakeholder_accounts row, with updated_at. On AWS those writes need a
-- /data/write route (a later code PR) and a column privilege for checksops, which no
-- migration grants: the restored database gave checksops SELECT only
-- (aws/db-copy/sql/02_grant_readonly_application_role.sql). PostgreSQL checks table and
-- column privileges before row-level security, so without this grant the UPDATE is refused
-- before any policy is evaluated.
--
-- Grants, as aws/write-path/sql/35_tranche3_write_grants.sql does for check_messages, to
-- checksops and authenticated:
--   UPDATE (is_active, is_primary, account_type, homeowner_name, homeowner_email, updated_at)
--     ON TABLE public.stakeholder_accounts
-- Does not GRANT table-wide UPDATE on stakeholder_accounts, nor UPDATE on any other column,
-- nor INSERT, DELETE, TRUNCATE, REFERENCES or TRIGGER. Does not GRANT to PUBLIC or anon.
-- Does not ENABLE/FORCE RLS or touch policies: aws_write_stakeholder_accounts
-- (aws/rls/sql/24_complete_write_policies.sql: FOR ALL TO authenticated,
-- USING / WITH CHECK aws_can_write_tenant(tenant_id)) remains the authorization boundary.
--
-- Idempotent: GRANT is a no-op when already held; the guard skips cleanly when the table, a
-- column or a grantee role is absent.
--
-- NOT APPLIED. Apply only through the guarded SQL path (AGENTS.md) after a read-only inspect,
-- staging first.

DO $$
DECLARE
  grantee text;
  col text;
BEGIN
  IF to_regclass('public.stakeholder_accounts') IS NULL THEN
    RAISE NOTICE 'SQL 114: public.stakeholder_accounts absent; skipped';
    RETURN;
  END IF;
  FOREACH col IN ARRAY ARRAY['is_active', 'is_primary', 'account_type', 'homeowner_name', 'homeowner_email', 'updated_at'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'stakeholder_accounts'
         AND column_name = col
    ) THEN
      RAISE NOTICE 'SQL 114: stakeholder_accounts.% absent; skipped', col;
      RETURN;
    END IF;
  END LOOP;
  FOREACH grantee IN ARRAY ARRAY['checksops', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
      EXECUTE format('GRANT UPDATE (is_active, is_primary, account_type, homeowner_name, homeowner_email, updated_at) ON TABLE public.stakeholder_accounts TO %I', grantee);
    ELSE
      RAISE NOTICE 'SQL 114: role % absent; skipped its grant', grantee;
    END IF;
  END LOOP;
END
$$;
