
-- Validation/benchmarking table for Darwin roof estimates
CREATE TABLE public.claim_roof_validations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL,
  estimate_id uuid NOT NULL,
  
  -- Source of truth metadata
  source_type text NOT NULL DEFAULT 'field_measurement',  -- field_measurement, vendor_report, eagleview, hover, other
  source_name text,  -- e.g. "EagleView Premium", "Field Inspection 3/5/2026"
  source_date date,
  source_document_url text,  -- file path if attached
  
  -- Actual (ground truth) measurements
  actual_footprint_area_sqft numeric,
  actual_roof_area_sqft numeric,
  actual_squares numeric,
  actual_dominant_pitch text,
  actual_ridge_lf numeric,
  actual_hip_lf numeric,
  actual_valley_lf numeric,
  actual_eave_lf numeric,
  actual_rake_lf numeric,
  actual_facet_count integer,
  actual_roof_form text,  -- gable, hip, cross_gable, complex, etc.
  
  -- Darwin's values at time of validation (snapshot)
  darwin_footprint_area_sqft numeric,
  darwin_roof_area_sqft numeric,
  darwin_squares numeric,
  darwin_dominant_pitch text,
  darwin_ridge_lf numeric,
  darwin_hip_lf numeric,
  darwin_valley_lf numeric,
  darwin_eave_lf numeric,
  darwin_rake_lf numeric,
  darwin_facet_count integer,
  darwin_roof_form text,
  darwin_confidence_score numeric,
  darwin_geometry_quality_score numeric,
  
  -- Computed deltas (absolute)
  delta_footprint_area numeric,
  delta_roof_area numeric,
  delta_squares numeric,
  delta_ridge_lf numeric,
  delta_hip_lf numeric,
  delta_valley_lf numeric,
  delta_eave_lf numeric,
  delta_rake_lf numeric,
  
  -- Computed deltas (percentage)
  pct_delta_footprint_area numeric,
  pct_delta_roof_area numeric,
  pct_delta_squares numeric,
  pct_delta_ridge_lf numeric,
  pct_delta_hip_lf numeric,
  pct_delta_valley_lf numeric,
  pct_delta_eave_lf numeric,
  pct_delta_rake_lf numeric,
  
  -- Boolean match flags
  pitch_match boolean,
  roof_form_match boolean,
  facet_count_match boolean,
  
  -- Overall accuracy score (0-100)
  overall_accuracy_score numeric,
  
  -- Categorical grade
  accuracy_grade text,  -- A (>90%), B (75-90%), C (60-75%), D (40-60%), F (<40%)
  
  -- Failure pattern notes
  failure_patterns jsonb DEFAULT '[]'::jsonb,
  staff_notes text,
  
  -- Metadata
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.claim_roof_validations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff and admin can manage roof validations"
ON public.claim_roof_validations
FOR ALL
TO authenticated
USING (
  public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin')
)
WITH CHECK (
  public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin')
);

-- Index for lookups
CREATE INDEX idx_roof_validations_claim ON public.claim_roof_validations(claim_id);
CREATE INDEX idx_roof_validations_estimate ON public.claim_roof_validations(estimate_id);
CREATE INDEX idx_roof_validations_grade ON public.claim_roof_validations(accuracy_grade);
