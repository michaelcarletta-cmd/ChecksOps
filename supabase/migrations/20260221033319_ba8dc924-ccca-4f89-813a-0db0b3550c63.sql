
-- Add state_code column to claims table for structured state detection
ALTER TABLE public.claims ADD COLUMN IF NOT EXISTS state_code text;

-- Add index for filtering by state
CREATE INDEX IF NOT EXISTS idx_claims_state_code ON public.claims (state_code);
