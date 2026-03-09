
CREATE TABLE public.claim_roof_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  address text NOT NULL,
  geocoded_lat double precision,
  geocoded_lng double precision,
  footprint_area_sqft numeric,
  estimated_roof_area_sqft numeric,
  squares numeric,
  dominant_pitch text,
  ridge_lf numeric,
  hip_lf numeric,
  valley_lf numeric,
  eave_lf numeric,
  rake_lf numeric,
  facet_count integer,
  confidence_score numeric,
  review_required boolean NOT NULL DEFAULT true,
  manually_confirmed boolean NOT NULL DEFAULT false,
  confirmed_by uuid,
  confirmed_at timestamptz,
  overlay_image_url text,
  raw_geojson jsonb,
  ai_notes text,
  data_sources text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

ALTER TABLE public.claim_roof_measurements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view roof measurements"
  ON public.claim_roof_measurements FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff can insert roof measurements"
  ON public.claim_roof_measurements FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff can update roof measurements"
  ON public.claim_roof_measurements FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'admin'));

CREATE INDEX idx_claim_roof_measurements_claim_id ON public.claim_roof_measurements(claim_id);
