
ALTER TABLE public.tenant_billing_accounts
  ADD COLUMN IF NOT EXISTS stakeholder_account_id uuid REFERENCES public.stakeholder_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_billing_accounts_stakeholder
  ON public.tenant_billing_accounts(stakeholder_account_id);
