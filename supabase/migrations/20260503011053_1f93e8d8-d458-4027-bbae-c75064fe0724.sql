ALTER TABLE public.claim_checks
  ADD COLUMN IF NOT EXISTS deposit_confirmation_number text,
  ADD COLUMN IF NOT EXISTS deposit_confirmed_amount numeric,
  ADD COLUMN IF NOT EXISTS deposit_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS deposit_confirmed_by uuid;

CREATE INDEX IF NOT EXISTS idx_claim_checks_deposit_status
  ON public.claim_checks(deposit_status);