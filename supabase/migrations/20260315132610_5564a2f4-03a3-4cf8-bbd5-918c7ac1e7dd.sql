
-- Create claim_document_intelligence table for structured facts extraction
CREATE TABLE public.claim_document_intelligence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_file_id uuid NOT NULL REFERENCES public.claim_files(id) ON DELETE CASCADE,
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  document_type text NOT NULL,
  document_subtype text,
  summary text,
  key_dates jsonb DEFAULT '[]'::jsonb,
  key_entities jsonb DEFAULT '[]'::jsonb,
  coverage_position text,
  denial_reasons jsonb DEFAULT '[]'::jsonb,
  exclusions_cited jsonb DEFAULT '[]'::jsonb,
  testing_performed jsonb DEFAULT '[]'::jsonb,
  testing_missing jsonb DEFAULT '[]'::jsonb,
  estimate_totals jsonb,
  scope_positions jsonb DEFAULT '[]'::jsonb,
  citations jsonb DEFAULT '[]'::jsonb,
  building_components jsonb DEFAULT '[]'::jsonb,
  code_references jsonb DEFAULT '[]'::jsonb,
  manufacturer_references jsonb DEFAULT '[]'::jsonb,
  contradictions jsonb DEFAULT '[]'::jsonb,
  sender text,
  recipient text,
  cause_of_loss text,
  extracted_facts jsonb DEFAULT '{}'::jsonb,
  confidence_score numeric,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  UNIQUE(claim_file_id)
);

-- Indexes for Darwin consumption
CREATE INDEX idx_doc_intel_claim ON public.claim_document_intelligence (claim_id);
CREATE INDEX idx_doc_intel_type ON public.claim_document_intelligence (claim_id, document_type);

-- RLS
ALTER TABLE public.claim_document_intelligence ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage document intelligence"
  ON public.claim_document_intelligence
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
