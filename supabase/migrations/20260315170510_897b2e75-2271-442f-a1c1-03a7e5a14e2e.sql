
CREATE TABLE IF NOT EXISTS public.claim_document_meaning (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES public.claim_files(id) ON DELETE CASCADE,
  segment_id UUID REFERENCES public.claim_file_segments(id) ON DELETE CASCADE,
  source_scope TEXT NOT NULL DEFAULT 'file',
  document_type TEXT NOT NULL,
  document_classification TEXT,
  meaning_version TEXT NOT NULL DEFAULT 'v1',

  coverage_position JSONB NOT NULL DEFAULT '{}'::jsonb,
  carrier_arguments JSONB NOT NULL DEFAULT '[]'::jsonb,
  financial_position JSONB NOT NULL DEFAULT '{}'::jsonb,
  deadlines JSONB NOT NULL DEFAULT '[]'::jsonb,
  requested_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  contradictions JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  strategic_weight TEXT,
  urgency TEXT,
  response_required BOOLEAN NOT NULL DEFAULT false,

  source_summary TEXT,
  confidence_score NUMERIC,
  raw_model_output JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_document_meaning_unique_file
  ON public.claim_document_meaning (file_id)
  WHERE segment_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_document_meaning_unique_segment
  ON public.claim_document_meaning (segment_id)
  WHERE segment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_claim_document_meaning_claim_id
  ON public.claim_document_meaning (claim_id);

CREATE INDEX IF NOT EXISTS idx_claim_document_meaning_source_scope
  ON public.claim_document_meaning (source_scope);

CREATE INDEX IF NOT EXISTS idx_claim_document_meaning_document_classification
  ON public.claim_document_meaning (document_classification);

CREATE INDEX IF NOT EXISTS idx_claim_document_meaning_response_required
  ON public.claim_document_meaning (response_required);

CREATE TABLE IF NOT EXISTS public.document_meaning_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES public.claim_files(id) ON DELETE CASCADE,
  segment_id UUID REFERENCES public.claim_file_segments(id) ON DELETE CASCADE,
  source_scope TEXT NOT NULL DEFAULT 'file',
  intelligence_id UUID REFERENCES public.claim_document_intelligence(id) ON DELETE CASCADE,
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
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_document_meaning_queue_unique_file
  ON public.document_meaning_queue (file_id)
  WHERE segment_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_document_meaning_queue_unique_segment
  ON public.document_meaning_queue (segment_id)
  WHERE segment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_document_meaning_queue_status_run_after
  ON public.document_meaning_queue (status, run_after, priority DESC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_document_meaning_queue_claim_id
  ON public.document_meaning_queue (claim_id);

CREATE OR REPLACE FUNCTION public.set_updated_at_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_claim_document_meaning_updated_at ON public.claim_document_meaning;
CREATE TRIGGER trg_claim_document_meaning_updated_at
BEFORE UPDATE ON public.claim_document_meaning
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at_timestamp();

DROP TRIGGER IF EXISTS trg_document_meaning_queue_updated_at ON public.document_meaning_queue;
CREATE TRIGGER trg_document_meaning_queue_updated_at
BEFORE UPDATE ON public.document_meaning_queue
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at_timestamp();

ALTER TABLE public.claim_document_meaning ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_meaning_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can view claim document meaning" ON public.claim_document_meaning;
CREATE POLICY "Staff can view claim document meaning"
  ON public.claim_document_meaning FOR SELECT
  USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

DROP POLICY IF EXISTS "Staff can insert claim document meaning" ON public.claim_document_meaning;
CREATE POLICY "Staff can insert claim document meaning"
  ON public.claim_document_meaning FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

DROP POLICY IF EXISTS "Staff can update claim document meaning" ON public.claim_document_meaning;
CREATE POLICY "Staff can update claim document meaning"
  ON public.claim_document_meaning FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

DROP POLICY IF EXISTS "Staff can view document meaning queue" ON public.document_meaning_queue;
CREATE POLICY "Staff can view document meaning queue"
  ON public.document_meaning_queue FOR SELECT
  USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

DROP POLICY IF EXISTS "Staff can insert document meaning queue" ON public.document_meaning_queue;
CREATE POLICY "Staff can insert document meaning queue"
  ON public.document_meaning_queue FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

DROP POLICY IF EXISTS "Staff can update document meaning queue" ON public.document_meaning_queue;
CREATE POLICY "Staff can update document meaning queue"
  ON public.document_meaning_queue FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

ALTER PUBLICATION supabase_realtime ADD TABLE public.claim_document_meaning;
ALTER PUBLICATION supabase_realtime ADD TABLE public.document_meaning_queue;
