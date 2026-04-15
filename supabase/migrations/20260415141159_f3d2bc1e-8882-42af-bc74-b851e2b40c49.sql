
CREATE TABLE public.claim_document_dismantlers (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  source_file_id UUID,
  source_file_name TEXT,
  document_type TEXT NOT NULL DEFAULT 'general_claim_correspondence',
  report_summary TEXT,
  main_position TEXT,
  non_covered_theories JSONB DEFAULT '[]'::jsonb,
  limitations JSONB DEFAULT '[]'::jsonb,
  unsupported_assumptions JSONB DEFAULT '[]'::jsonb,
  contradictions JSONB DEFAULT '[]'::jsonb,
  omissions JSONB DEFAULT '[]'::jsonb,
  repairability_overreach JSONB DEFAULT '[]'::jsonb,
  coverage_weaknesses JSONB DEFAULT '[]'::jsonb,
  strongest_rebuttal_points JSONB DEFAULT '[]'::jsonb,
  evidence_to_gather_next JSONB DEFAULT '[]'::jsonb,
  draft_rebuttal_language TEXT,
  chunk_count INTEGER DEFAULT 0,
  successful_chunks INTEGER DEFAULT 0,
  failed_chunks INTEGER DEFAULT 0,
  model TEXT,
  cached BOOLEAN DEFAULT false,
  used_search BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.claim_document_dismantlers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view dismantler results"
  ON public.claim_document_dismantlers FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert dismantler results"
  ON public.claim_document_dismantlers FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can delete dismantler results"
  ON public.claim_document_dismantlers FOR DELETE TO authenticated USING (true);

CREATE INDEX idx_claim_document_dismantlers_claim_id ON public.claim_document_dismantlers(claim_id);
CREATE INDEX idx_claim_document_dismantlers_source_file_id ON public.claim_document_dismantlers(source_file_id);
