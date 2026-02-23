
-- Add needs_text_backfill flag to claim_files
ALTER TABLE public.claim_files
  ADD COLUMN IF NOT EXISTS needs_text_backfill boolean NOT NULL DEFAULT true;

-- Create index for fast candidate queries
CREATE INDEX IF NOT EXISTS idx_claim_files_needs_backfill
  ON public.claim_files (id)
  WHERE needs_text_backfill = true;

-- Backfill existing rows: mark as NOT needing backfill if extracted_text >= 50 chars
UPDATE public.claim_files
SET needs_text_backfill = false
WHERE extracted_text IS NOT NULL
  AND extracted_text != ''
  AND length(extracted_text) >= 50;
