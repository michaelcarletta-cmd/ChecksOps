
ALTER TABLE public.stakeholder_accounts
  ADD COLUMN IF NOT EXISTS authentecheck_session_url text,
  ADD COLUMN IF NOT EXISTS authentecheck_consumer_code text,
  ADD COLUMN IF NOT EXISTS authentecheck_order_id text,
  ADD COLUMN IF NOT EXISTS authentecheck_bank_name text,
  ADD COLUMN IF NOT EXISTS authentecheck_initiated_at timestamptz,
  ADD COLUMN IF NOT EXISTS authentecheck_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS authentecheck_postback jsonb;
