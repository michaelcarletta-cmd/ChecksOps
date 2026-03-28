
-- Create a database function to find nearest building footprint using PostGIS
CREATE OR REPLACE FUNCTION public.find_nearest_building_footprint(
  search_lat DOUBLE PRECISION,
  search_lng DOUBLE PRECISION,
  search_radius DOUBLE PRECISION DEFAULT 0.001
)
RETURNS TABLE (
  id UUID,
  source TEXT,
  source_id TEXT,
  state TEXT,
  centroid_lat DOUBLE PRECISION,
  centroid_lng DOUBLE PRECISION,
  bbox JSONB,
  area_sqft DOUBLE PRECISION,
  vertex_count INTEGER,
  geometry_json TEXT,
  distance_meters DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    bf.id,
    bf.source,
    bf.source_id,
    bf.state,
    bf.centroid_lat,
    bf.centroid_lng,
    bf.bbox,
    bf.area_sqft,
    bf.vertex_count,
    ST_AsGeoJSON(bf.geometry)::TEXT as geometry_json,
    ST_Distance(
      bf.geometry::geography,
      ST_SetSRID(ST_MakePoint(search_lng, search_lat), 4326)::geography
    ) as distance_meters
  FROM public.building_footprints bf
  WHERE ST_DWithin(
    bf.geometry::geography,
    ST_SetSRID(ST_MakePoint(search_lng, search_lat), 4326)::geography,
    search_radius * 111000  -- convert degrees to approximate meters
  )
  ORDER BY ST_Distance(
    bf.geometry::geography,
    ST_SetSRID(ST_MakePoint(search_lng, search_lat), 4326)::geography
  )
  LIMIT 5;
$$;
