ALTER TABLE public.check_intake_items
  ADD COLUMN IF NOT EXISTS external_origin jsonb;

CREATE INDEX IF NOT EXISTS idx_check_intake_external_origin
  ON public.check_intake_items ((external_origin->>'source_check_id'))
  WHERE external_origin IS NOT NULL;