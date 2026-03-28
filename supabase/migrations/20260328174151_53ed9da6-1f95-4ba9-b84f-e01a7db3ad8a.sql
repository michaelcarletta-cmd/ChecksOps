
-- Create batch insert function for building footprints
-- Accepts arrays of values and inserts them with ST_GeomFromText
CREATE OR REPLACE FUNCTION public.insert_building_footprints_batch(
  p_sources text[],
  p_source_ids text[],
  p_states text[],
  p_wkts text[],
  p_centroid_lats double precision[],
  p_centroid_lngs double precision[],
  p_bboxes jsonb[],
  p_areas_sqft double precision[],
  p_vertex_counts integer[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  i integer;
  inserted_count integer := 0;
  skipped_count integer := 0;
  error_count integer := 0;
  errors text[] := '{}';
BEGIN
  FOR i IN 1..array_length(p_sources, 1) LOOP
    BEGIN
      INSERT INTO public.building_footprints (
        source, source_id, state, geometry,
        centroid_lat, centroid_lng, bbox, area_sqft, vertex_count
      ) VALUES (
        p_sources[i],
        p_source_ids[i],
        p_states[i],
        ST_GeomFromText(p_wkts[i], 4326),
        p_centroid_lats[i],
        p_centroid_lngs[i],
        p_bboxes[i],
        p_areas_sqft[i],
        p_vertex_counts[i]
      )
      ON CONFLICT DO NOTHING;

      IF FOUND THEN
        inserted_count := inserted_count + 1;
      ELSE
        skipped_count := skipped_count + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      error_count := error_count + 1;
      errors := array_append(errors, SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'inserted', inserted_count,
    'skipped', skipped_count,
    'errors', error_count,
    'error_messages', to_jsonb(errors[1:10])
  );
END;
$$;

-- Create ingestion log table
CREATE TABLE IF NOT EXISTS public.building_footprint_ingestion_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state text NOT NULL,
  source text NOT NULL DEFAULT 'microsoft',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  fetched_count integer DEFAULT 0,
  parsed_count integer DEFAULT 0,
  inserted_count integer DEFAULT 0,
  skipped_count integer DEFAULT 0,
  error_count integer DEFAULT 0,
  errors jsonb DEFAULT '[]'::jsonb,
  config jsonb DEFAULT '{}'::jsonb,
  created_by uuid
);

ALTER TABLE public.building_footprint_ingestion_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view ingestion logs"
  ON public.building_footprint_ingestion_logs
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Service role can insert ingestion logs"
  ON public.building_footprint_ingestion_logs
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Service role can update ingestion logs"
  ON public.building_footprint_ingestion_logs
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
