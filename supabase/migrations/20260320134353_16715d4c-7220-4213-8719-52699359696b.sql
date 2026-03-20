-- Composite index for claim_events: claim_id + occurred_at desc
CREATE INDEX IF NOT EXISTS idx_claim_events_claim_id_occurred_at
ON public.claim_events (claim_id, occurred_at DESC);

-- Composite index for claim_payments: claim_id + created_at desc
CREATE INDEX IF NOT EXISTS idx_claim_payments_claim_id_created_at
ON public.claim_payments (claim_id, created_at DESC);