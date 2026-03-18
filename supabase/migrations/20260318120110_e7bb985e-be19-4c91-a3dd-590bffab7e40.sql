ALTER TABLE public.claim_roof_measurements
  ADD COLUMN IF NOT EXISTS roof_shape_conflict boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS roof_shape_conflict_reason text,
  ADD COLUMN IF NOT EXISTS provisional_complexity_uplift_used numeric,
  ADD COLUMN IF NOT EXISTS shape_conflicted_roof_area_sqft integer,
  ADD COLUMN IF NOT EXISTS shape_conflicted_squares numeric,
  ADD COLUMN IF NOT EXISTS user_drawn_roof_polygon_geojson jsonb;