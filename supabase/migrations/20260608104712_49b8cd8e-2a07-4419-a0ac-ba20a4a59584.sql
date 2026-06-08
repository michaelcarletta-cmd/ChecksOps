ALTER TABLE public.claim_settlements
  ADD COLUMN IF NOT EXISTS ale_rcv NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ale_recoverable_depreciation NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ale_non_recoverable_depreciation NUMERIC DEFAULT 0;