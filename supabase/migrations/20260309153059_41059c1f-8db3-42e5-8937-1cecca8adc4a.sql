
ALTER TABLE public.claim_roof_measurements
ADD COLUMN IF NOT EXISTS inferred_roof_form text DEFAULT NULL,
ADD COLUMN IF NOT EXISTS roof_form_confidence numeric DEFAULT NULL,
ADD COLUMN IF NOT EXISTS roof_form_reasoning text DEFAULT NULL,
ADD COLUMN IF NOT EXISTS dominant_axis_bearing numeric DEFAULT NULL,
ADD COLUMN IF NOT EXISTS dominant_axis_length_ft numeric DEFAULT NULL,
ADD COLUMN IF NOT EXISTS perpendicular_axis_length_ft numeric DEFAULT NULL,
ADD COLUMN IF NOT EXISTS ridge_candidates jsonb DEFAULT NULL,
ADD COLUMN IF NOT EXISTS hip_valley_candidates jsonb DEFAULT NULL,
ADD COLUMN IF NOT EXISTS aspect_ratio numeric DEFAULT NULL;

COMMENT ON COLUMN public.claim_roof_measurements.inferred_roof_form IS 'Conservative roof form classification: gable, hip, cross_gable, complex, or unknown';
COMMENT ON COLUMN public.claim_roof_measurements.ridge_candidates IS 'Array of inferred ridge line candidates with geometry and confidence';
COMMENT ON COLUMN public.claim_roof_measurements.hip_valley_candidates IS 'Array of inferred hip/valley line candidates with geometry and confidence';
