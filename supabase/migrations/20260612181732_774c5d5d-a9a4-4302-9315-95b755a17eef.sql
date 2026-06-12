
ALTER TABLE public.disbursement_splits
  ALTER COLUMN stakeholder_account_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'actum',
  ADD COLUMN IF NOT EXISTS external_check_number text,
  ADD COLUMN IF NOT EXISTS recipient_name text,
  ADD COLUMN IF NOT EXISTS external_notes text;

DO $$ BEGIN
  ALTER TABLE public.disbursement_splits
    ADD CONSTRAINT disbursement_splits_method_check
    CHECK (method IN ('actum','external_check','wire','manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.check_intake_items
  ADD COLUMN IF NOT EXISTS pa_fee_pct numeric,
  ADD COLUMN IF NOT EXISTS pa_fee_amount numeric;
