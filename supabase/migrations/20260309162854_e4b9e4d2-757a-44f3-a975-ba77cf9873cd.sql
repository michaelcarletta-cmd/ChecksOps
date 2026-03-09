
-- Governance columns for darwin_roof_tuning_heuristics
ALTER TABLE public.darwin_roof_tuning_heuristics
  ADD COLUMN IF NOT EXISTS min_sample_size integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS effective_from timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS expires_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS last_validation_support_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS staleness_days integer NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS max_adjustment_factor numeric NOT NULL DEFAULT 1.35,
  ADD COLUMN IF NOT EXISTS min_adjustment_factor numeric NOT NULL DEFAULT 0.65,
  ADD COLUMN IF NOT EXISTS max_confidence_penalty numeric NOT NULL DEFAULT 0.40,
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS conflict_group text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS governance_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS governance_notes text DEFAULT NULL;

-- Add comment
COMMENT ON COLUMN public.darwin_roof_tuning_heuristics.governance_status IS 'active, expired, stale, insufficient_evidence, capped, conflict_suppressed';
COMMENT ON COLUMN public.darwin_roof_tuning_heuristics.conflict_group IS 'Heuristics in the same conflict_group targeting the same field cannot both apply; highest priority wins';
COMMENT ON COLUMN public.darwin_roof_tuning_heuristics.staleness_days IS 'Days after last_validation_support_at before heuristic is auto-deactivated';
