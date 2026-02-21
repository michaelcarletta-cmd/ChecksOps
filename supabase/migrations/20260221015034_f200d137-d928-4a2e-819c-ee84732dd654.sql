
-- Phase 2.5: Document analysis audit trail
-- Stores the full structured analysis Darwin produces for each uploaded document

CREATE TABLE public.document_analysis_results (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  file_id UUID REFERENCES public.claim_files(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL,
  
  -- Document classification
  document_type TEXT NOT NULL, -- denial / estimate / engineering_report / policy / correspondence / etc.
  carrier_name TEXT,
  claim_number_detected TEXT,
  document_date DATE,
  state_code TEXT,
  trade TEXT,
  loss_type TEXT,
  
  -- Carrier position & claim impact
  carrier_position TEXT, -- deny / limit / scope_reduce / delay / accept
  denial_rationales TEXT[] DEFAULT '{}', -- multi-label: "no direct physical loss", "wear and tear", etc.
  coverage_impact TEXT, -- free text: coverage basis analysis
  
  -- Evidence gaps
  evidence_gaps JSONB DEFAULT '[]', -- array of {gap: string, evidence_needed: string, priority: string}
  evidence_pack_type TEXT, -- "no_direct_physical_loss" / "wear_and_tear" / "repairable_not_replace" / "pre_existing"
  
  -- Recommended next step
  next_step TEXT,
  
  -- Full structured analysis (raw AI output)
  full_analysis TEXT,
  
  -- Precedent links (references to evidence cards used)
  precedent_claim_ids UUID[] DEFAULT '{}',
  precedent_summary JSONB DEFAULT '[]', -- array of {claim_number, carrier, what_worked, similarity}
  
  -- Source mode used
  source_mode TEXT DEFAULT 'internal_only', -- internal_only / hybrid
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.document_analysis_results ENABLE ROW LEVEL SECURITY;

-- RLS: Staff and admin can view all analysis results
CREATE POLICY "Staff can view document analysis results"
  ON public.document_analysis_results FOR SELECT
  USING (
    public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin')
  );

CREATE POLICY "Staff can insert document analysis results"
  ON public.document_analysis_results FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin')
  );

-- Service role can always insert (for edge functions)
CREATE POLICY "Service role full access to document analysis"
  ON public.document_analysis_results FOR ALL
  USING (auth.role() = 'service_role');

-- Index for fast lookup
CREATE INDEX idx_document_analysis_claim ON public.document_analysis_results(claim_id);
CREATE INDEX idx_document_analysis_file ON public.document_analysis_results(file_id);
CREATE INDEX idx_document_analysis_type ON public.document_analysis_results(document_type);

-- Trigger for updated_at
CREATE TRIGGER update_document_analysis_updated_at
  BEFORE UPDATE ON public.document_analysis_results
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();
