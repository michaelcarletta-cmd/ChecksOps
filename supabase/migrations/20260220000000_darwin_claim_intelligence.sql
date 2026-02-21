-- Darwin Claim Intelligence: unified timeline, estimates/line items, payment applications,
-- generated assets, claim-level embeddings, disputes.
-- Existing: claims, claim_files, claim_payments, claim_settlements, claim_checks, emails, extracted_document_data.

-- 1) Claim events (unified timeline)
CREATE TABLE public.claim_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  summary TEXT,
  actor TEXT,
  source_artifact_id UUID REFERENCES public.claim_files(id) ON DELETE SET NULL,
  source_artifact_type TEXT,
  metadata_json JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_claim_events_claim_occurred ON public.claim_events(claim_id, occurred_at DESC);
ALTER TABLE public.claim_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "claim_events_select" ON public.claim_events FOR SELECT USING (true);
CREATE POLICY "claim_events_insert" ON public.claim_events FOR INSERT WITH CHECK (true);
CREATE POLICY "claim_events_update" ON public.claim_events FOR UPDATE USING (true);
CREATE POLICY "claim_events_delete" ON public.claim_events FOR DELETE USING (true);

-- 2) Estimates (can link to extracted_document_data via source_extracted_document_id)
CREATE TABLE public.claim_estimates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  vendor TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  source_extracted_document_id UUID REFERENCES public.extracted_document_data(id) ON DELETE SET NULL,
  total_rcv NUMERIC(14,2),
  total_acv NUMERIC(14,2),
  total_depr NUMERIC(14,2),
  metadata_json JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_claim_estimates_claim ON public.claim_estimates(claim_id);
ALTER TABLE public.claim_estimates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "claim_estimates_select" ON public.claim_estimates FOR SELECT USING (true);
CREATE POLICY "claim_estimates_insert" ON public.claim_estimates FOR INSERT WITH CHECK (true);
CREATE POLICY "claim_estimates_update" ON public.claim_estimates FOR UPDATE USING (true);
CREATE POLICY "claim_estimates_delete" ON public.claim_estimates FOR DELETE USING (true);

-- 3) Line items (per estimate)
CREATE TABLE public.estimate_line_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  estimate_id UUID NOT NULL REFERENCES public.claim_estimates(id) ON DELETE CASCADE,
  code TEXT,
  description TEXT,
  category TEXT,
  quantity NUMERIC(14,4) DEFAULT 1,
  unit TEXT,
  unit_price NUMERIC(14,2),
  rcv NUMERIC(14,2),
  acv NUMERIC(14,2),
  depreciation NUMERIC(14,2) DEFAULT 0,
  tax NUMERIC(14,2) DEFAULT 0,
  overhead NUMERIC(14,2) DEFAULT 0,
  profit NUMERIC(14,2) DEFAULT 0,
  coverage_type TEXT,
  room TEXT,
  metadata_json JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_estimate_line_items_estimate ON public.estimate_line_items(estimate_id);
CREATE INDEX idx_estimate_line_items_coverage ON public.estimate_line_items(estimate_id, coverage_type);
ALTER TABLE public.estimate_line_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "estimate_line_items_select" ON public.estimate_line_items FOR SELECT USING (true);
CREATE POLICY "estimate_line_items_insert" ON public.estimate_line_items FOR INSERT WITH CHECK (true);
CREATE POLICY "estimate_line_items_update" ON public.estimate_line_items FOR UPDATE USING (true);
CREATE POLICY "estimate_line_items_delete" ON public.estimate_line_items FOR DELETE USING (true);

-- 4) Extend claim_payments for coverage_type and reference (carrier payment tracking)
ALTER TABLE public.claim_payments
  ADD COLUMN IF NOT EXISTS coverage_type TEXT,
  ADD COLUMN IF NOT EXISTS reference TEXT,
  ADD COLUMN IF NOT EXISTS payer TEXT,
  ADD COLUMN IF NOT EXISTS payee TEXT;

-- 5) Payment applications (apply carrier payments to line items)
CREATE TABLE public.payment_applications (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  payment_id UUID NOT NULL REFERENCES public.claim_payments(id) ON DELETE CASCADE,
  line_item_id UUID NOT NULL REFERENCES public.estimate_line_items(id) ON DELETE CASCADE,
  applied_amount NUMERIC(14,2) NOT NULL,
  applied_to_field TEXT NOT NULL DEFAULT 'rcv',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(payment_id, line_item_id, applied_to_field)
);

CREATE INDEX idx_payment_applications_payment ON public.payment_applications(payment_id);
CREATE INDEX idx_payment_applications_line_item ON public.payment_applications(line_item_id);
ALTER TABLE public.payment_applications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "payment_applications_select" ON public.payment_applications FOR SELECT USING (true);
CREATE POLICY "payment_applications_insert" ON public.payment_applications FOR INSERT WITH CHECK (true);
CREATE POLICY "payment_applications_update" ON public.payment_applications FOR UPDATE USING (true);
CREATE POLICY "payment_applications_delete" ON public.payment_applications FOR DELETE USING (true);

-- 6) Disputes
CREATE TABLE public.claim_disputes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  issue_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  summary TEXT,
  related_line_items_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_claim_disputes_claim ON public.claim_disputes(claim_id);
ALTER TABLE public.claim_disputes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "claim_disputes_select" ON public.claim_disputes FOR SELECT USING (true);
CREATE POLICY "claim_disputes_insert" ON public.claim_disputes FOR INSERT WITH CHECK (true);
CREATE POLICY "claim_disputes_update" ON public.claim_disputes FOR UPDATE USING (true);
CREATE POLICY "claim_disputes_delete" ON public.claim_disputes FOR DELETE USING (true);

-- 7) Generated assets (operating manual, case study, marketing assets)
CREATE TABLE public.generated_assets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content_md TEXT,
  redacted BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata_json JSONB DEFAULT '{}'
);

CREATE INDEX idx_generated_assets_claim ON public.generated_assets(claim_id);
CREATE INDEX idx_generated_assets_type ON public.generated_assets(claim_id, asset_type);
ALTER TABLE public.generated_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "generated_assets_select" ON public.generated_assets FOR SELECT USING (true);
CREATE POLICY "generated_assets_insert" ON public.generated_assets FOR INSERT WITH CHECK (true);
CREATE POLICY "generated_assets_update" ON public.generated_assets FOR UPDATE USING (true);
CREATE POLICY "generated_assets_delete" ON public.generated_assets FOR DELETE USING (true);

-- 8) Claim-level embedding index (RAG per claim)
CREATE TABLE public.claim_embedding_chunks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  artifact_id UUID REFERENCES public.claim_files(id) ON DELETE CASCADE,
  chunk_text TEXT NOT NULL,
  embedding vector(1536),
  metadata_json JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_claim_embedding_chunks_claim ON public.claim_embedding_chunks(claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_embedding_chunks_embedding
  ON public.claim_embedding_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

ALTER TABLE public.claim_embedding_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "claim_embedding_chunks_select" ON public.claim_embedding_chunks FOR SELECT USING (true);
CREATE POLICY "claim_embedding_chunks_insert" ON public.claim_embedding_chunks FOR INSERT WITH CHECK (true);
CREATE POLICY "claim_embedding_chunks_update" ON public.claim_embedding_chunks FOR UPDATE USING (true);
CREATE POLICY "claim_embedding_chunks_delete" ON public.claim_embedding_chunks FOR DELETE USING (true);

-- Match claim chunks by embedding (claim-scoped RAG)
CREATE OR REPLACE FUNCTION public.match_claim_chunks(
  p_claim_id UUID,
  query_embedding vector(1536),
  match_count INT DEFAULT 20
)
RETURNS TABLE (
  id UUID,
  chunk_text TEXT,
  metadata_json JSONB,
  artifact_id UUID,
  similarity FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.chunk_text,
    c.metadata_json,
    c.artifact_id,
    (1 - (c.embedding <=> query_embedding))::FLOAT AS similarity
  FROM public.claim_embedding_chunks c
  WHERE c.claim_id = p_claim_id
    AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Trigger for claim_estimates updated_at
CREATE TRIGGER update_claim_estimates_updated_at
  BEFORE UPDATE ON public.claim_estimates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_claim_disputes_updated_at
  BEFORE UPDATE ON public.claim_disputes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
