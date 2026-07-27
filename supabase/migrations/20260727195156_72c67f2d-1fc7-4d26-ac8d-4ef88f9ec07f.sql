ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS plaid_funding_account_id text,
  ADD COLUMN IF NOT EXISTS plaid_same_day_funding boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tenants.plaid_funding_account_id IS 'Plaid Transfer funding account id (from Plaid dashboard) used to originate payouts.';
COMMENT ON COLUMN public.tenants.plaid_same_day_funding IS 'When true, payouts are originated same-day directly from the funding bank account instead of a pre-funded ledger balance.';