
-- Add versioning, change tracking, decomposed confidence, pre-scores, and trigger metadata
ALTER TABLE public.claim_intelligence_summary
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS previous_summary_id uuid REFERENCES public.claim_intelligence_summary(id),
  ADD COLUMN IF NOT EXISTS change_reason text,
  ADD COLUMN IF NOT EXISTS change_details jsonb DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS trigger_event text,
  ADD COLUMN IF NOT EXISTS trigger_metadata jsonb DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS pre_scores jsonb DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS evidence_confidence integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS financial_confidence integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS strategy_confidence integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rebuttal_confidence integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS learning_confidence integer DEFAULT 0;

-- Remove the unique constraint on claim_id so we can store version history
-- First find and drop it
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'claim_intelligence_summary_claim_id_key'
  ) THEN
    ALTER TABLE public.claim_intelligence_summary DROP CONSTRAINT claim_intelligence_summary_claim_id_key;
  END IF;
END $$;

-- Add an index for efficient latest-version lookups
CREATE INDEX IF NOT EXISTS idx_claim_intelligence_summary_claim_version
  ON public.claim_intelligence_summary (claim_id, version DESC);
