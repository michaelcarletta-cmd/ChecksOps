ALTER TABLE public.claim_roof_measurements
ADD COLUMN IF NOT EXISTS geometry_quality_score numeric DEFAULT NULL,
ADD COLUMN IF NOT EXISTS edge_classifications jsonb DEFAULT NULL,
ADD COLUMN IF NOT EXISTS geometry_metadata jsonb DEFAULT NULL,
ADD COLUMN IF NOT EXISTS candidate_footprints jsonb DEFAULT NULL,
ADD COLUMN IF NOT EXISTS selected_candidate_index integer DEFAULT NULL;

COMMENT ON COLUMN public.claim_roof_measurements.geometry_quality_score IS 'Quality score (0-100) for the extracted footprint polygon';
COMMENT ON COLUMN public.claim_roof_measurements.edge_classifications IS 'Perimeter segments classified as likely_eave, likely_rake, or unknown';
COMMENT ON COLUMN public.claim_roof_measurements.geometry_metadata IS 'Source name, feature_id, retrieval_time, centroid_offset, polygon_hash';
COMMENT ON COLUMN public.claim_roof_measurements.candidate_footprints IS 'Array of all valid candidate footprints found from multiple sources';
COMMENT ON COLUMN public.claim_roof_measurements.selected_candidate_index IS 'Index into candidate_footprints of the selected polygon';