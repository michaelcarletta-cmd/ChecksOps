ALTER TABLE public.payment_provider_accounts
  ADD COLUMN IF NOT EXISTS tos_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS tos_accepted_by uuid,
  ADD COLUMN IF NOT EXISTS tos_source text,
  ADD COLUMN IF NOT EXISTS fee_plan_code text,
  ADD COLUMN IF NOT EXISTS fee_plan_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS readiness jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS readiness_checked_at timestamptz;