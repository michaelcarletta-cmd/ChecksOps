
ALTER TABLE public.claim_files
ADD COLUMN IF NOT EXISTS packet_analysis JSONB NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS packet_page_count INTEGER,
ADD COLUMN IF NOT EXISTS packet_dominant_classification TEXT,
ADD COLUMN IF NOT EXISTS packet_mixed_confidence NUMERIC,
ADD COLUMN IF NOT EXISTS packet_review_required BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_claim_files_packet_dominant_classification
  ON public.claim_files (packet_dominant_classification);

CREATE INDEX IF NOT EXISTS idx_claim_files_packet_review_required
  ON public.claim_files (packet_review_required);
