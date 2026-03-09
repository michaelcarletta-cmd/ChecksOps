
ALTER TABLE public.claim_roof_measurements
  ADD COLUMN IF NOT EXISTS pitch_band text,
  ADD COLUMN IF NOT EXISTS pitch_type text NOT NULL DEFAULT 'band',
  ADD COLUMN IF NOT EXISTS vision_classifications jsonb,
  ADD COLUMN IF NOT EXISTS suppression_records jsonb;

COMMENT ON COLUMN public.claim_roof_measurements.pitch_band IS 'Pitch band classification: flat, low, moderate, steep, very_steep, unknown';
COMMENT ON COLUMN public.claim_roof_measurements.pitch_type IS 'band = satellite/AI band estimate, exact = confirmed by validation or user override';
COMMENT ON COLUMN public.claim_roof_measurements.vision_classifications IS 'Structured satellite vision results: roof_form, pitch_band, visible_facets, obstructions with per-task confidence and abstain';
COMMENT ON COLUMN public.claim_roof_measurements.suppression_records IS 'Array of suppression records applied to vision results';
