
-- Unique index on claim_payments for check dedup
CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_payments_check_dedup
  ON public.claim_payments(claim_id, check_number)
  WHERE check_number IS NOT NULL AND payment_method = 'insurance_check';
