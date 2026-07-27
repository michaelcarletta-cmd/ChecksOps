ALTER TABLE public.stakeholder_accounts
  ADD COLUMN IF NOT EXISTS plaid_item_id text,
  ADD COLUMN IF NOT EXISTS plaid_account_id text,
  ADD COLUMN IF NOT EXISTS plaid_access_token text,
  ADD COLUMN IF NOT EXISTS plaid_institution_name text,
  ADD COLUMN IF NOT EXISTS plaid_account_mask text,
  ADD COLUMN IF NOT EXISTS plaid_linked_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification_source text NOT NULL DEFAULT 'authentecheck';

ALTER TABLE public.stakeholder_accounts
  DROP CONSTRAINT IF EXISTS stakeholder_accounts_verification_source_check;

ALTER TABLE public.stakeholder_accounts
  ADD CONSTRAINT stakeholder_accounts_verification_source_check
  CHECK (verification_source IN ('authentecheck', 'plaid', 'manual'));

CREATE INDEX IF NOT EXISTS idx_stakeholder_accounts_plaid_item
  ON public.stakeholder_accounts (plaid_item_id)
  WHERE plaid_item_id IS NOT NULL;

COMMENT ON COLUMN public.stakeholder_accounts.plaid_access_token IS
  'Plaid item access token. Server-side only: never expose via the Data API or select into client queries.';