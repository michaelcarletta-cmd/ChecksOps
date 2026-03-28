
-- Enable PostGIS if not already enabled
CREATE EXTENSION IF NOT EXISTS postgis;

-- Create building_footprints table for authoritative footprint data
CREATE TABLE public.building_footprints (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'microsoft',
  source_id TEXT,
  state TEXT NOT NULL,
  geometry GEOMETRY(Polygon, 4326) NOT NULL,
  centroid_lat DOUBLE PRECISION NOT NULL,
  centroid_lng DOUBLE PRECISION NOT NULL,
  bbox JSONB,
  area_sqft DOUBLE PRECISION NOT NULL,
  vertex_count INTEGER,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Spatial index for fast proximity queries
CREATE INDEX idx_building_footprints_geometry ON public.building_footprints USING GIST (geometry);

-- Index for state filtering
CREATE INDEX idx_building_footprints_state ON public.building_footprints (state);

-- Index for source filtering
CREATE INDEX idx_building_footprints_source ON public.building_footprints (source);

-- Composite index for centroid lookups
CREATE INDEX idx_building_footprints_centroid ON public.building_footprints (centroid_lat, centroid_lng);

-- Enable RLS
ALTER TABLE public.building_footprints ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read (public reference data)
CREATE POLICY "Authenticated users can read building footprints"
  ON public.building_footprints FOR SELECT TO authenticated USING (true);

-- Only service role can insert/update (ingestion pipeline)
CREATE POLICY "Service role can manage building footprints"
  ON public.building_footprints FOR ALL TO service_role USING (true) WITH CHECK (true);
