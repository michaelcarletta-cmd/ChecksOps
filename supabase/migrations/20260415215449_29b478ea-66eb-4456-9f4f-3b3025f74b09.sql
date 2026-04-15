
-- 1. Extend claim_knowledge_library with authority-grade columns
ALTER TABLE public.claim_knowledge_library 
ADD COLUMN IF NOT EXISTS jurisdiction text DEFAULT 'national',
ADD COLUMN IF NOT EXISTS applicability_tags text[] DEFAULT '{}';

-- 2. Create violation detection table
CREATE TABLE IF NOT EXISTS public.claim_violation_detections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  violation_type text NOT NULL,
  severity text NOT NULL DEFAULT 'medium',
  statute_reference text,
  days_exceeded integer,
  description text NOT NULL,
  recommended_action text,
  source_event_ids uuid[] DEFAULT '{}',
  detected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.claim_violation_detections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view violation detections" ON public.claim_violation_detections
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Users can create violation detections" ON public.claim_violation_detections
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE INDEX idx_violation_detections_claim ON public.claim_violation_detections(claim_id);

-- 3. Create cross-document contradiction table
CREATE TABLE IF NOT EXISTS public.claim_contradiction_detections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  document_a_id uuid,
  document_a_name text,
  document_b_id uuid,
  document_b_name text,
  contradiction_type text NOT NULL,
  carrier_position_a text,
  carrier_position_b text,
  severity text NOT NULL DEFAULT 'medium',
  rebuttal_value text,
  detected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.claim_contradiction_detections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view contradiction detections" ON public.claim_contradiction_detections
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Users can create contradiction detections" ON public.claim_contradiction_detections
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE INDEX idx_contradiction_detections_claim ON public.claim_contradiction_detections(claim_id);
