-- Staging/schema companion for aws/rls/sql/36_checkalt_tenant_split.sql.
-- Adds per-tenant business_unit only. RLS views/policies are applied via SQL 36.
-- Does not enable CheckAlt execution or rewrite deposit rows.

ALTER TABLE public.checkalt_tenant_accounts
  ADD COLUMN IF NOT EXISTS business_unit text;

COMMENT ON COLUMN public.checkalt_tenant_accounts.business_unit IS
  'Tenant-specific CheckAlt Business Unit. Not stored on the platform singleton.';
