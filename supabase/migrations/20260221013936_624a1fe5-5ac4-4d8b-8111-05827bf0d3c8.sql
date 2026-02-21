
-- ============================================================
-- CLAIM DOCUMENT CHUNKS: Vector-indexed claim file content
-- for cross-claim retrieval with rich structured metadata
-- ============================================================

-- Taxonomy enum for standardized tagging
CREATE TYPE public.claim_doc_loss_type AS ENUM (
  'wind', 'hail', 'water', 'fire', 'lightning', 'tornado', 'hurricane',
  'theft', 'vandalism', 'collapse', 'mold', 'freeze', 'other'
);

CREATE TYPE public.claim_doc_trade AS ENUM (
  'roof', 'siding', 'gutters', 'windows', 'doors', 'interior',
  'hvac', 'plumbing', 'electrical', 'foundation', 'fence',
  'deck', 'garage', 'landscaping', 'contents', 'other'
);

CREATE TYPE public.claim_doc_decision AS ENUM (
  'deny_full', 'deny_partial', 'accept', 'underpay', 'rfi',
  'pending', 'supplement_approved', 'supplement_denied', 'unknown'
);

CREATE TYPE public.claim_doc_evidence_type AS ENUM (
  'estimate', 'denial_letter', 'approval_letter', 'engineer_report',
  'moisture_map', 'core_sample', 'itel_report', 'ladder_assist',
  'photo_analysis', 'policy', 'correspondence', 'invoice',
  'supplement', 'rebuttal', 'demand', 'settlement', 'other'
);

CREATE TYPE public.darwin_source_mode AS ENUM ('internal_only', 'hybrid');

-- Main chunks table
CREATE TABLE public.claim_document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  file_id UUID REFERENCES public.claim_files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536),
  
  -- Structured taxonomy metadata
  carrier_name TEXT,
  loss_type public.claim_doc_loss_type,
  trade public.claim_doc_trade,
  decision_type public.claim_doc_decision,
  evidence_type public.claim_doc_evidence_type,
  
  -- Detailed fields for matching
  denial_rationale TEXT,
  policy_form TEXT,
  scope_decisions JSONB,
  cited_policy_sections TEXT[],
  cited_denial_reasons TEXT[],
  
  -- Outcome data (populated when claim closes)
  outcome_paid_amount NUMERIC(12,2),
  outcome_supplement_won BOOLEAN,
  outcome_appraisal_invoked BOOLEAN,
  outcome_reopened BOOLEAN,
  outcome_litigation BOOLEAN,
  outcome_resolution_type TEXT,
  
  -- Provenance
  state_code TEXT,
  loss_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for fast filtered vector search
CREATE INDEX idx_claim_doc_chunks_claim ON public.claim_document_chunks(claim_id);
CREATE INDEX idx_claim_doc_chunks_file ON public.claim_document_chunks(file_id);
CREATE INDEX idx_claim_doc_chunks_carrier ON public.claim_document_chunks(carrier_name);
CREATE INDEX idx_claim_doc_chunks_loss_type ON public.claim_document_chunks(loss_type);
CREATE INDEX idx_claim_doc_chunks_trade ON public.claim_document_chunks(trade);
CREATE INDEX idx_claim_doc_chunks_decision ON public.claim_document_chunks(decision_type);
CREATE INDEX idx_claim_doc_chunks_evidence ON public.claim_document_chunks(evidence_type);
CREATE INDEX idx_claim_doc_chunks_embedding ON public.claim_document_chunks 
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Enable RLS
ALTER TABLE public.claim_document_chunks ENABLE ROW LEVEL SECURITY;

-- Staff/admin can read all chunks for cross-claim search
CREATE POLICY "Staff can read all claim document chunks"
ON public.claim_document_chunks FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin')
);

-- Staff/admin can insert/update chunks
CREATE POLICY "Staff can manage claim document chunks"
ON public.claim_document_chunks FOR ALL
TO authenticated
USING (
  public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin')
);

-- ============================================================
-- CROSS-CLAIM VECTOR SEARCH FUNCTION
-- Semantic search with structured filters
-- ============================================================
CREATE OR REPLACE FUNCTION public.match_claim_document_chunks(
  query_embedding vector(1536),
  match_count INTEGER DEFAULT 20,
  filter_carrier TEXT DEFAULT NULL,
  filter_loss_type public.claim_doc_loss_type DEFAULT NULL,
  filter_trade public.claim_doc_trade DEFAULT NULL,
  filter_decision public.claim_doc_decision DEFAULT NULL,
  filter_evidence_type public.claim_doc_evidence_type DEFAULT NULL,
  exclude_claim_id UUID DEFAULT NULL,
  filter_state TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  claim_id UUID,
  file_id UUID,
  chunk_index INTEGER,
  carrier_name TEXT,
  loss_type public.claim_doc_loss_type,
  trade public.claim_doc_trade,
  decision_type public.claim_doc_decision,
  evidence_type public.claim_doc_evidence_type,
  denial_rationale TEXT,
  policy_form TEXT,
  outcome_paid_amount NUMERIC(12,2),
  outcome_resolution_type TEXT,
  state_code TEXT,
  loss_date DATE,
  similarity DOUBLE PRECISION
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.content,
    c.claim_id,
    c.file_id,
    c.chunk_index,
    c.carrier_name,
    c.loss_type,
    c.trade,
    c.decision_type,
    c.evidence_type,
    c.denial_rationale,
    c.policy_form,
    c.outcome_paid_amount,
    c.outcome_resolution_type,
    c.state_code,
    c.loss_date,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM claim_document_chunks c
  WHERE c.embedding IS NOT NULL
    AND (exclude_claim_id IS NULL OR c.claim_id != exclude_claim_id)
    AND (filter_carrier IS NULL OR lower(c.carrier_name) = lower(filter_carrier))
    AND (filter_loss_type IS NULL OR c.loss_type = filter_loss_type)
    AND (filter_trade IS NULL OR c.trade = filter_trade)
    AND (filter_decision IS NULL OR c.decision_type = filter_decision)
    AND (filter_evidence_type IS NULL OR c.evidence_type = filter_evidence_type)
    AND (filter_state IS NULL OR c.state_code = filter_state)
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================================
-- DARWIN SOURCE MODE per claim (internal_only vs hybrid)
-- ============================================================
ALTER TABLE public.claim_automations
  ADD COLUMN IF NOT EXISTS darwin_source_mode public.darwin_source_mode DEFAULT 'hybrid';

-- ============================================================
-- TRIGGER: Backfill outcome data to chunks when claim closes
-- ============================================================
CREATE OR REPLACE FUNCTION public.backfill_chunk_outcomes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  outcome_record RECORD;
BEGIN
  -- Only when claim is settled or closed
  IF NEW.status IN ('Claim Settled', 'Dead File') AND (OLD.status IS NULL OR OLD.status NOT IN ('Claim Settled', 'Dead File')) THEN
    -- Get outcome data
    SELECT * INTO outcome_record FROM claim_outcomes WHERE claim_id = NEW.id;
    
    IF FOUND THEN
      UPDATE claim_document_chunks SET
        outcome_paid_amount = outcome_record.final_settlement,
        outcome_resolution_type = outcome_record.resolution_type,
        outcome_supplement_won = (outcome_record.supplements_approved > 0),
        outcome_litigation = outcome_record.litigation_filed,
        updated_at = now()
      WHERE claim_id = NEW.id;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

CREATE TRIGGER backfill_chunk_outcomes_trigger
AFTER UPDATE ON public.claims
FOR EACH ROW
EXECUTE FUNCTION public.backfill_chunk_outcomes();
