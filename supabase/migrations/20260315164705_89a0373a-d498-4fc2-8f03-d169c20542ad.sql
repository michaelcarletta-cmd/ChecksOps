
CREATE TABLE IF NOT EXISTS public.claim_file_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES public.claim_files(id) ON DELETE CASCADE,
  segment_index INTEGER NOT NULL,
  segment_label TEXT,
  start_page INTEGER,
  end_page INTEGER,
  text_excerpt TEXT,
  extracted_text TEXT,
  clean_text TEXT,
  segment_classification TEXT,
  classification_confidence NUMERIC,
  classification_candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  classification_reasoning JSONB NOT NULL DEFAULT '{}'::jsonb,
  review_required BOOLEAN NOT NULL DEFAULT false,
  automation_safe BOOLEAN NOT NULL DEFAULT false,
  document_family TEXT,
  source_method TEXT NOT NULL DEFAULT 'virtual_segmentation',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (file_id, segment_index)
);

CREATE INDEX IF NOT EXISTS idx_claim_file_segments_claim_id
  ON public.claim_file_segments (claim_id);

CREATE INDEX IF NOT EXISTS idx_claim_file_segments_file_id
  ON public.claim_file_segments (file_id);

CREATE INDEX IF NOT EXISTS idx_claim_file_segments_classification
  ON public.claim_file_segments (segment_classification);

CREATE INDEX IF NOT EXISTS idx_claim_file_segments_review_required
  ON public.claim_file_segments (review_required);

ALTER TABLE public.claim_document_intelligence
ADD COLUMN IF NOT EXISTS segment_id UUID REFERENCES public.claim_file_segments(id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS source_scope TEXT NOT NULL DEFAULT 'file';

CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_document_intelligence_unique_segment
  ON public.claim_document_intelligence (segment_id)
  WHERE segment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_claim_document_intelligence_source_scope
  ON public.claim_document_intelligence (source_scope);

ALTER TABLE public.document_intelligence_queue
ADD COLUMN IF NOT EXISTS segment_id UUID REFERENCES public.claim_file_segments(id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS source_scope TEXT NOT NULL DEFAULT 'file';

CREATE INDEX IF NOT EXISTS idx_document_intelligence_queue_segment_id
  ON public.document_intelligence_queue (segment_id);

ALTER TABLE public.claim_files
ADD COLUMN IF NOT EXISTS has_virtual_segments BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS segment_count INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS segmentation_status TEXT,
ADD COLUMN IF NOT EXISTS segmentation_summary JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_claim_files_has_virtual_segments
  ON public.claim_files (has_virtual_segments);

CREATE OR REPLACE FUNCTION public.set_updated_at_timestamp()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_claim_file_segments_updated_at ON public.claim_file_segments;
CREATE TRIGGER trg_claim_file_segments_updated_at
BEFORE UPDATE ON public.claim_file_segments
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at_timestamp();

ALTER TABLE public.claim_file_segments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff can view claim file segments" ON public.claim_file_segments;
CREATE POLICY "Staff can view claim file segments"
  ON public.claim_file_segments FOR SELECT
  USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

DROP POLICY IF EXISTS "Staff can insert claim file segments" ON public.claim_file_segments;
CREATE POLICY "Staff can insert claim file segments"
  ON public.claim_file_segments FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

DROP POLICY IF EXISTS "Staff can update claim file segments" ON public.claim_file_segments;
CREATE POLICY "Staff can update claim file segments"
  ON public.claim_file_segments FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'staff')
  );

ALTER PUBLICATION supabase_realtime ADD TABLE public.claim_file_segments;
