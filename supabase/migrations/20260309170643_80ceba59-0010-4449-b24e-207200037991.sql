
-- Add evidence-based confirmation columns to claim_roof_measurements
ALTER TABLE public.claim_roof_measurements
  ADD COLUMN IF NOT EXISTS confirmation_level text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS confirmation_basis text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS confirmation_notes text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS confirmation_strength_score integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS confirmation_attachments jsonb DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN public.claim_roof_measurements.confirmation_level IS 'One of: reviewed, field_confirmed, vendor_confirmed, estimate_confirmed';
COMMENT ON COLUMN public.claim_roof_measurements.confirmation_basis IS 'What evidence the confirmation is based on (e.g. eagleview_report, field_measurement, vendor_report, visual_review)';
COMMENT ON COLUMN public.claim_roof_measurements.confirmation_strength_score IS '0-100 computed score based on evidence type and tolerance match';
COMMENT ON COLUMN public.claim_roof_measurements.confirmation_attachments IS 'Array of {name, path, type} for supporting files';
