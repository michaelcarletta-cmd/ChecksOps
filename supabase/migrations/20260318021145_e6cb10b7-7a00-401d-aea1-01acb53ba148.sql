ALTER TABLE public.claim_roof_measurements
  ADD COLUMN IF NOT EXISTS roof_planar_area_sqft integer,
  ADD COLUMN IF NOT EXISTS roof_polygon_geojson jsonb,
  ADD COLUMN IF NOT EXISTS planar_area_gain_sqft integer,
  ADD COLUMN IF NOT EXISTS overhang_config jsonb;