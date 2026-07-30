ALTER TABLE public.disbursement_splits
  ADD COLUMN IF NOT EXISTS moov_transfer_id text,
  ADD COLUMN IF NOT EXISTS moov_status text,
  ADD COLUMN IF NOT EXISTS moov_failure_reason text;

ALTER TABLE public.disbursement_batches
  ADD COLUMN IF NOT EXISTS moov_transfer_group_id uuid;

CREATE INDEX IF NOT EXISTS idx_disbursement_splits_moov_transfer_id
  ON public.disbursement_splits (moov_transfer_id)
  WHERE moov_transfer_id IS NOT NULL;