
-- 1) claim_events: unified timeline with document-driven date metadata
CREATE TABLE IF NOT EXISTS public.claim_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  summary TEXT,
  actor TEXT,
  source_artifact_id UUID,
  source_artifact_type TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}',
  -- Document-driven date fields
  date_source TEXT NOT NULL DEFAULT 'system_upload', -- 'document_extracted', 'system_upload', 'manual'
  date_confidence NUMERIC(3,2) DEFAULT 1.0, -- 0.00 to 1.00
  date_evidence TEXT, -- verbatim text where date was found
  doc_type TEXT, -- classification of source document (denial, estimate, etc.)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.claim_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "claim_events_select" ON public.claim_events FOR SELECT USING (true);
CREATE POLICY "claim_events_insert" ON public.claim_events FOR INSERT WITH CHECK (true);
CREATE POLICY "claim_events_update" ON public.claim_events FOR UPDATE USING (true);
CREATE POLICY "claim_events_delete" ON public.claim_events FOR DELETE USING (true);

CREATE INDEX idx_claim_events_claim_id ON public.claim_events(claim_id);
CREATE INDEX idx_claim_events_occurred_at ON public.claim_events(occurred_at);
CREATE INDEX idx_claim_events_event_type ON public.claim_events(event_type);

-- 2) Add date-related columns to extracted_document_data
ALTER TABLE public.extracted_document_data
  ADD COLUMN IF NOT EXISTS document_date DATE,
  ADD COLUMN IF NOT EXISTS loss_date DATE,
  ADD COLUMN IF NOT EXISTS service_period_start DATE,
  ADD COLUMN IF NOT EXISTS service_period_end DATE,
  ADD COLUMN IF NOT EXISTS check_issue_date DATE,
  ADD COLUMN IF NOT EXISTS received_date DATE,
  ADD COLUMN IF NOT EXISTS date_confidence NUMERIC(3,2) DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS date_evidence TEXT;

-- 3) Trigger to auto-update updated_at on claim_events
CREATE TRIGGER update_claim_events_updated_at
  BEFORE UPDATE ON public.claim_events
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- 4) Enable realtime for claim_events
ALTER PUBLICATION supabase_realtime ADD TABLE public.claim_events;
