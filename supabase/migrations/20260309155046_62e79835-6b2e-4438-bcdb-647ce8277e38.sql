
-- Darwin Roof Tuning Heuristics table
CREATE TABLE public.darwin_roof_tuning_heuristics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  heuristic_key text NOT NULL UNIQUE,
  heuristic_type text NOT NULL DEFAULT 'adjustment',
  -- Segmentation dimensions
  segment_roof_form text,
  segment_geometry_source text,
  segment_quality_score_min numeric,
  segment_quality_score_max numeric,
  segment_aspect_ratio_min numeric,
  segment_aspect_ratio_max numeric,
  segment_confidence_min numeric,
  segment_confidence_max numeric,
  segment_carrier text,
  segment_region text,
  -- What this heuristic does
  action_type text NOT NULL DEFAULT 'adjust_confidence',
  adjustment_field text,
  adjustment_factor numeric,
  adjustment_absolute numeric,
  suppress_field text,
  suppress_below_confidence numeric,
  -- Evidence
  sample_size integer NOT NULL DEFAULT 0,
  avg_accuracy_score numeric,
  avg_pct_delta numeric,
  median_pct_delta numeric,
  failure_rate numeric,
  common_failures jsonb DEFAULT '[]'::jsonb,
  validation_ids jsonb DEFAULT '[]'::jsonb,
  evidence_summary text,
  -- Status
  is_active boolean NOT NULL DEFAULT false,
  auto_derived boolean NOT NULL DEFAULT true,
  manually_overridden boolean NOT NULL DEFAULT false,
  last_computed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

ALTER TABLE public.darwin_roof_tuning_heuristics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff and admins can read tuning heuristics"
  ON public.darwin_roof_tuning_heuristics FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('admin', 'staff')));

CREATE POLICY "Admins can manage tuning heuristics"
  ON public.darwin_roof_tuning_heuristics FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin'));

-- Add tuning_applied metadata to claim_roof_measurements
ALTER TABLE public.claim_roof_measurements
  ADD COLUMN IF NOT EXISTS tuning_applied jsonb,
  ADD COLUMN IF NOT EXISTS pre_tuning_values jsonb;
