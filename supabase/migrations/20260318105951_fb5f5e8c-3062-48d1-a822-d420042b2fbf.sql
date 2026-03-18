ALTER TABLE public.claim_roof_measurements
  ADD COLUMN IF NOT EXISTS slope_factor_used numeric,
  ADD COLUMN IF NOT EXISTS correction_factor_used numeric;