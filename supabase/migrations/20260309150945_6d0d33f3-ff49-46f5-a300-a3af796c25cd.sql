
ALTER TABLE public.claim_roof_measurements
ADD COLUMN IF NOT EXISTS field_authority jsonb DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS footprint_polygon jsonb DEFAULT NULL,
ADD COLUMN IF NOT EXISTS footprint_perimeter_ft numeric DEFAULT NULL,
ADD COLUMN IF NOT EXISTS imagery_source text DEFAULT NULL,
ADD COLUMN IF NOT EXISTS imagery_date text DEFAULT NULL;

COMMENT ON COLUMN public.claim_roof_measurements.field_authority IS 'Tracks workflow authority per field: user_authoritative, geometry_authoritative, ai_provisional';
COMMENT ON COLUMN public.claim_roof_measurements.footprint_polygon IS 'GeoJSON polygon of detected building footprint from aerial imagery';
COMMENT ON COLUMN public.claim_roof_measurements.footprint_perimeter_ft IS 'Perimeter of detected footprint in feet';
COMMENT ON COLUMN public.claim_roof_measurements.imagery_source IS 'Source of aerial imagery used for footprint extraction';
COMMENT ON COLUMN public.claim_roof_measurements.imagery_date IS 'Date/vintage of aerial imagery used';
