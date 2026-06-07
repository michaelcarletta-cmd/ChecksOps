-- Add ALE (Additional Living Expenses) tracking to claim_settlements
ALTER TABLE public.claim_settlements
  ADD COLUMN IF NOT EXISTS ale_rcv DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ale_recoverable_depreciation DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ale_non_recoverable_depreciation DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Add supplement_expected to track the anticipated supplement total (optional target)
ALTER TABLE public.claim_settlements
  ADD COLUMN IF NOT EXISTS supplement_expected DECIMAL(12,2) NOT NULL DEFAULT 0;
