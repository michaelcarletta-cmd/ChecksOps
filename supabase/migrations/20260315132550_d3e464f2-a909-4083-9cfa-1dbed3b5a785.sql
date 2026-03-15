
-- Add document intelligence columns to claim_files
ALTER TABLE public.claim_files
  ADD COLUMN IF NOT EXISTS document_type text,
  ADD COLUMN IF NOT EXISTS document_subtype text,
  ADD COLUMN IF NOT EXISTS clean_text text,
  ADD COLUMN IF NOT EXISTS extraction_method text,
  ADD COLUMN IF NOT EXISTS text_quality_status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS confidence_score numeric,
  ADD COLUMN IF NOT EXISTS is_scanned boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS page_count integer,
  ADD COLUMN IF NOT EXISTS ready_for_analysis boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS needs_reprocessing boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS document_summary text,
  ADD COLUMN IF NOT EXISTS processed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS processing_error text;

-- Create index for Darwin consumption queries
CREATE INDEX IF NOT EXISTS idx_claim_files_ready_analysis ON public.claim_files (claim_id, ready_for_analysis) WHERE ready_for_analysis = true;
CREATE INDEX IF NOT EXISTS idx_claim_files_document_type ON public.claim_files (claim_id, document_type);
CREATE INDEX IF NOT EXISTS idx_claim_files_needs_reprocessing ON public.claim_files (needs_reprocessing) WHERE needs_reprocessing = true;
