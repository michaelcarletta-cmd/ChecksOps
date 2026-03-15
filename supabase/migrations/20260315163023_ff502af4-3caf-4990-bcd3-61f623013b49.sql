
ALTER TABLE public.claim_files
ADD COLUMN IF NOT EXISTS classification_candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS classification_method TEXT,
ADD COLUMN IF NOT EXISTS classification_reasoning JSONB NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS classification_review_required BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS is_mixed_document BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS document_family TEXT,
ADD COLUMN IF NOT EXISTS automation_safe BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_claim_files_classification_review_required
  ON public.claim_files (classification_review_required);

CREATE INDEX IF NOT EXISTS idx_claim_files_automation_safe
  ON public.claim_files (automation_safe);

CREATE INDEX IF NOT EXISTS idx_claim_files_document_family
  ON public.claim_files (document_family);
