ALTER TABLE public.disbursement_splits
  ADD COLUMN IF NOT EXISTS recipient_type text;