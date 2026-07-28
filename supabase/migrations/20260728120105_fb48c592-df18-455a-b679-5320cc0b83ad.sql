ALTER TABLE public.external_payment_recipients
  ADD COLUMN IF NOT EXISTS stakeholder_account_id uuid REFERENCES public.stakeholder_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS provider_bank_name text,
  ADD COLUMN IF NOT EXISTS provider_last_four text,
  ADD COLUMN IF NOT EXISTS bank_linked_at timestamptz;

CREATE INDEX IF NOT EXISTS external_payment_recipients_stakeholder_idx
  ON public.external_payment_recipients (stakeholder_account_id);