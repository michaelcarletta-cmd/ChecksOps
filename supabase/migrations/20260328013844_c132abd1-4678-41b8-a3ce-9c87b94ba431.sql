
-- Add geometry_source column to claim_roof_validations to track which footprint source was used
ALTER TABLE public.claim_roof_validations 
  ADD COLUMN IF NOT EXISTS geometry_source TEXT,
  ADD COLUMN IF NOT EXISTS geometry_source_score INTEGER,
  ADD COLUMN IF NOT EXISTS candidate_count INTEGER;

-- Create a view to aggregate accuracy by geometry source
CREATE OR REPLACE VIEW public.darwin_source_accuracy_stats AS
SELECT
  geometry_source,
  COUNT(*) as validation_count,
  ROUND(AVG(overall_accuracy_score)::numeric, 1) as avg_accuracy_score,
  ROUND(AVG(CASE WHEN pct_delta_squares IS NOT NULL THEN ABS(pct_delta_squares) END)::numeric, 1) as avg_pct_delta_squares,
  ROUND(AVG(CASE WHEN pct_delta_roof_area IS NOT NULL THEN ABS(pct_delta_roof_area) END)::numeric, 1) as avg_pct_delta_roof_area,
  ROUND(AVG(CASE WHEN pct_delta_footprint_area IS NOT NULL THEN ABS(pct_delta_footprint_area) END)::numeric, 1) as avg_pct_delta_footprint,
  ROUND(AVG(CASE WHEN pct_delta_eave_lf IS NOT NULL THEN ABS(pct_delta_eave_lf) END)::numeric, 1) as avg_pct_delta_eave,
  ROUND(AVG(CASE WHEN pct_delta_rake_lf IS NOT NULL THEN ABS(pct_delta_rake_lf) END)::numeric, 1) as avg_pct_delta_rake,
  ROUND(AVG(CASE WHEN pct_delta_ridge_lf IS NOT NULL THEN ABS(pct_delta_ridge_lf) END)::numeric, 1) as avg_pct_delta_ridge,
  ROUND(AVG(CASE WHEN pct_delta_hip_lf IS NOT NULL THEN ABS(pct_delta_hip_lf) END)::numeric, 1) as avg_pct_delta_hip,
  ROUND(AVG(CASE WHEN pct_delta_valley_lf IS NOT NULL THEN ABS(pct_delta_valley_lf) END)::numeric, 1) as avg_pct_delta_valley,
  ROUND(AVG(darwin_geometry_quality_score)::numeric, 0) as avg_geometry_quality,
  COUNT(CASE WHEN accuracy_grade = 'A' THEN 1 END) as grade_a_count,
  COUNT(CASE WHEN accuracy_grade = 'B' THEN 1 END) as grade_b_count,
  COUNT(CASE WHEN accuracy_grade = 'C' THEN 1 END) as grade_c_count,
  COUNT(CASE WHEN accuracy_grade = 'D' THEN 1 END) as grade_d_count,
  COUNT(CASE WHEN accuracy_grade = 'F' THEN 1 END) as grade_f_count,
  ROUND(AVG(CASE WHEN roof_form_match THEN 1 ELSE 0 END)::numeric * 100, 0) as roof_form_match_pct,
  ROUND(AVG(CASE WHEN pitch_match THEN 1 ELSE 0 END)::numeric * 100, 0) as pitch_match_pct
FROM public.claim_roof_validations
WHERE geometry_source IS NOT NULL
GROUP BY geometry_source
ORDER BY avg_accuracy_score DESC NULLS LAST;
