-- Replace leftover tenant_billing_accounts policies that SELECT auth.users
-- as the current role (42501 permission denied for table users).
-- Platform-admin access uses is_platform_owner() (SECURITY DEFINER).
-- Do not GRANT SELECT on auth.users.
-- Does not drop the Supabase auth.users FK (valid on hosted Supabase).

DROP POLICY IF EXISTS "Platform admin manages all billing accounts"
  ON public.tenant_billing_accounts;

DROP POLICY IF EXISTS tenant_billing_accounts_platform_admin
  ON public.tenant_billing_accounts;

CREATE POLICY tenant_billing_accounts_platform_admin
ON public.tenant_billing_accounts
FOR ALL TO authenticated
USING (public.is_platform_owner())
WITH CHECK (public.is_platform_owner());

ALTER TABLE public.tenant_billing_accounts
  ALTER COLUMN routing_number DROP NOT NULL,
  ALTER COLUMN account_number_encrypted DROP NOT NULL,
  ALTER COLUMN account_number_last4 DROP NOT NULL;

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
