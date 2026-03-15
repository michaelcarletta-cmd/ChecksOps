
-- Darwin Document Intelligence patch - Safe additive migration

-- 1) Extend claim_files so darwin-process-document has a stable schema
ALTER TABLE public.claim_files
ADD COLUMN IF NOT EXISTS processed_by_darwin BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS darwin_processed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS processing_error TEXT,
ADD COLUMN IF NOT EXISTS extracted_text TEXT,
ADD COLUMN IF NOT EXISTS clean_text TEXT,
ADD COLUMN IF NOT EXISTS extraction_method TEXT,
ADD COLUMN IF NOT EXISTS text_quality_status TEXT,
ADD COLUMN IF NOT EXISTS is_scanned BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS page_count INTEGER,
ADD COLUMN IF NOT EXISTS document_classification TEXT,
ADD COLUMN IF NOT EXISTS classification_confidence NUMERIC,
ADD COLUMN IF NOT EXISTS classification_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS confidence_score NUMERIC,
ADD COLUMN IF NOT EXISTS document_type TEXT,
ADD COLUMN IF NOT EXISTS document_summary TEXT,
ADD COLUMN IF NOT EXISTS ready_for_analysis BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS needs_reprocessing BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_claim_files_claim_id_uploaded_at
  ON public.claim_files (claim_id, uploaded_at DESC);

CREATE INDEX IF NOT EXISTS idx_claim_files_document_classification
  ON public.claim_files (document_classification);

CREATE INDEX IF NOT EXISTS idx_claim_files_document_type
  ON public.claim_files (document_type);

CREATE INDEX IF NOT EXISTS idx_claim_files_ready_for_analysis
  ON public.claim_files (ready_for_analysis);

CREATE INDEX IF NOT EXISTS idx_claim_files_needs_reprocessing
  ON public.claim_files (needs_reprocessing);

-- 2) Normalized intelligence table
CREATE TABLE IF NOT EXISTS public.claim_document_intelligence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES public.claim_files(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  document_classification TEXT,
  source_summary TEXT,
  extracted_entities JSONB NOT NULL DEFAULT '{}'::jsonb,
  financial_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  timeline_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  action_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  coverage_signals JSONB NOT NULL DEFAULT '{}'::jsonb,
  parties JSONB NOT NULL DEFAULT '[]'::jsonb,
  intelligence_version TEXT NOT NULL DEFAULT 'v1',
  confidence_score NUMERIC,
  raw_model_output JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (file_id)
);

CREATE INDEX IF NOT EXISTS idx_claim_document_intelligence_claim_id
  ON public.claim_document_intelligence (claim_id);

CREATE INDEX IF NOT EXISTS idx_claim_document_intelligence_document_type
  ON public.claim_document_intelligence (document_type);

CREATE INDEX IF NOT EXISTS idx_claim_document_intelligence_updated_at
  ON public.claim_document_intelligence (updated_at DESC);

-- 3) Durable queue for downstream intelligence extraction
CREATE TABLE IF NOT EXISTS public.document_intelligence_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES public.claim_files(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 50,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (file_id)
);

CREATE INDEX IF NOT EXISTS idx_document_intelligence_queue_status_run_after
  ON public.document_intelligence_queue (status, run_after, priority DESC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_document_intelligence_queue_claim_id
  ON public.document_intelligence_queue (claim_id);

-- 4) updated_at trigger helper
CREATE OR REPLACE FUNCTION public.set_updated_at_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_claim_document_intelligence_updated_at ON public.claim_document_intelligence;
CREATE TRIGGER trg_claim_document_intelligence_updated_at
BEFORE UPDATE ON public.claim_document_intelligence
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at_timestamp();

DROP TRIGGER IF EXISTS trg_document_intelligence_queue_updated_at ON public.document_intelligence_queue;
CREATE TRIGGER trg_document_intelligence_queue_updated_at
BEFORE UPDATE ON public.document_intelligence_queue
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at_timestamp();

-- 5) Enable RLS
ALTER TABLE public.claim_document_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_intelligence_queue ENABLE ROW LEVEL SECURITY;

-- Staff/admin policies for claim_document_intelligence
DROP POLICY IF EXISTS "Staff can view claim document intelligence" ON public.claim_document_intelligence;
CREATE POLICY "Staff can view claim document intelligence"
  ON public.claim_document_intelligence FOR SELECT
  USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

DROP POLICY IF EXISTS "Staff can insert claim document intelligence" ON public.claim_document_intelligence;
CREATE POLICY "Staff can insert claim document intelligence"
  ON public.claim_document_intelligence FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

DROP POLICY IF EXISTS "Staff can update claim document intelligence" ON public.claim_document_intelligence;
CREATE POLICY "Staff can update claim document intelligence"
  ON public.claim_document_intelligence FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

-- Staff/admin policies for queue
DROP POLICY IF EXISTS "Staff can view document intelligence queue" ON public.document_intelligence_queue;
CREATE POLICY "Staff can view document intelligence queue"
  ON public.document_intelligence_queue FOR SELECT
  USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

DROP POLICY IF EXISTS "Staff can insert document intelligence queue" ON public.document_intelligence_queue;
CREATE POLICY "Staff can insert document intelligence queue"
  ON public.document_intelligence_queue FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

DROP POLICY IF EXISTS "Staff can update document intelligence queue" ON public.document_intelligence_queue;
CREATE POLICY "Staff can update document intelligence queue"
  ON public.document_intelligence_queue FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

-- 6) Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.claim_document_intelligence;
ALTER PUBLICATION supabase_realtime ADD TABLE public.document_intelligence_queue;
