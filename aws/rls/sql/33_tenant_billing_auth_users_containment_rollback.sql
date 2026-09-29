-- Rollback for 33_tenant_billing_auth_users_containment.sql
-- Unapplied. Does not restore auth.users SELECT grants or dump policies
-- that query auth.users. Does not recreate an auth.users FK.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.tenant_billing_accounts
  DROP CONSTRAINT IF EXISTS tenant_billing_accounts_bank_source_check;

DROP POLICY IF EXISTS tenant_billing_accounts_member_write
  ON public.tenant_billing_accounts;

COMMIT;
