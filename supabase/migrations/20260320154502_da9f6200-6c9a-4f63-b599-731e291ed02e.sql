-- Index on claims table for created_at sorting
CREATE INDEX IF NOT EXISTS idx_claims_created_at
ON public.claims (created_at DESC);

-- Index on claims for status + created_at filtering
CREATE INDEX IF NOT EXISTS idx_claims_status_created_at
ON public.claims (status, created_at DESC);

-- Index on claim_master_state for claim_id lookup
CREATE INDEX IF NOT EXISTS idx_claim_master_state_claim_id
ON public.claim_master_state (claim_id);