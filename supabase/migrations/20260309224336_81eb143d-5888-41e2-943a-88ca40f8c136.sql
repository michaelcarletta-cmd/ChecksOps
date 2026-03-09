ALTER TABLE public.claim_roof_measurements
  ADD COLUMN IF NOT EXISTS roof_mass_decomposition jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS overhang_config jsonb DEFAULT '{"eave_overhang_ft":1.0,"rake_overhang_ft":0.75,"source":"default"}'::jsonb;