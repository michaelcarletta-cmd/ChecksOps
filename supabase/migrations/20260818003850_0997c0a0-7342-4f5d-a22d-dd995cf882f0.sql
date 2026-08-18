ALTER TABLE public.payment_provider_methods
  ADD COLUMN IF NOT EXISTS supported_rails jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS rail_payment_method_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS rtp_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS rails_synced_at timestamptz;

ALTER TABLE public.stakeholder_accounts
  ADD COLUMN IF NOT EXISTS moov_supported_rails jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS moov_rail_payment_method_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS moov_rtp_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS moov_rails_synced_at timestamptz;

ALTER TABLE public.payment_transfers
  ADD COLUMN IF NOT EXISTS requested_speed text,
  ADD COLUMN IF NOT EXISTS selected_rail text,
  ADD COLUMN IF NOT EXISTS rail_downgrade_reason text;

ALTER TABLE public.disbursement_splits
  ADD COLUMN IF NOT EXISTS requested_speed text,
  ADD COLUMN IF NOT EXISTS selected_rail text,
  ADD COLUMN IF NOT EXISTS rail_downgrade_reason text;