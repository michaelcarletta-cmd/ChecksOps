
ALTER TABLE public.darwin_roof_tuning_heuristics
  ADD COLUMN IF NOT EXISTS shadow_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shadow_mode_hits integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shadow_mode_predicted_impacts jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS shadow_mode_promoted_at timestamptz DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS shadow_mode_min_hits integer NOT NULL DEFAULT 5;
