
-- 1. New service-area columns
ALTER TABLE public.contractor_profiles
  ADD COLUMN IF NOT EXISTS service_zip_prefixes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS home_base_lat numeric(9,6),
  ADD COLUMN IF NOT EXISTS home_base_lng numeric(9,6),
  ADD COLUMN IF NOT EXISTS service_radius_miles integer;

CREATE INDEX IF NOT EXISTS idx_contractor_profiles_zip_prefixes
  ON public.contractor_profiles USING gin (service_zip_prefixes);
CREATE INDEX IF NOT EXISTS idx_contractor_profiles_home_base
  ON public.contractor_profiles (home_base_lat, home_base_lng)
  WHERE home_base_lat IS NOT NULL AND home_base_lng IS NOT NULL;

-- 2. ZIP geocode cache
CREATE TABLE IF NOT EXISTS public.zip_geocache (
  zip text PRIMARY KEY,
  lat numeric(9,6) NOT NULL,
  lng numeric(9,6) NOT NULL,
  city text,
  state text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.zip_geocache TO anon, authenticated;
GRANT ALL ON public.zip_geocache TO service_role;

ALTER TABLE public.zip_geocache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "zip cache readable by all"
  ON public.zip_geocache FOR SELECT
  USING (true);

-- 3. Rebuild directory view with new fields
DROP VIEW IF EXISTS public.contractor_directory_view;
CREATE VIEW public.contractor_directory_view AS
SELECT
  cp.id,
  cp.user_id,
  cp.display_name,
  cp.bio,
  cp.trades,
  cp.service_states,
  cp.service_metros,
  cp.service_zip_prefixes,
  cp.home_base_lat,
  cp.home_base_lng,
  cp.service_radius_miles,
  cp.license_number,
  cp.coi_expires_at,
  cp.avatar_url,
  cp.tier,
  cp.is_directory_listed,
  cp.directory_opt_in,
  COALESCE(jobs.jobs_count, 0) AS jobs_count,
  (COALESCE(reviews.avg_rating, 0::numeric))::numeric(3,2) AS avg_rating,
  COALESCE(reviews.review_count, 0) AS review_count,
  cp.created_at,
  cp.updated_at
FROM contractor_profiles cp
LEFT JOIN LATERAL (
  SELECT count(*)::integer AS jobs_count
  FROM claim_contractors cc
  WHERE cc.contractor_id = cp.user_id
) jobs ON true
LEFT JOIN LATERAL (
  SELECT avg(r.rating) AS avg_rating, count(*)::integer AS review_count
  FROM contractor_reviews r
  WHERE r.contractor_id = cp.id
) reviews ON true;

GRANT SELECT ON public.contractor_directory_view TO anon, authenticated, service_role;

-- 4. Haversine + search function
CREATE OR REPLACE FUNCTION public.search_public_contractors(
  p_zip text DEFAULT NULL,
  p_lat numeric DEFAULT NULL,
  p_lng numeric DEFAULT NULL,
  p_trades text[] DEFAULT NULL,
  p_states text[] DEFAULT NULL,
  p_min_rating numeric DEFAULT 0,
  p_search text DEFAULT NULL,
  p_sort text DEFAULT 'rating',
  p_limit integer DEFAULT 24,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  display_name text,
  bio text,
  trades text[],
  service_states text[],
  service_zip_prefixes text[],
  service_radius_miles integer,
  tier text,
  avg_rating numeric,
  review_count integer,
  jobs_count integer,
  created_at timestamptz,
  distance_miles numeric,
  zip_prefix_match boolean,
  total_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT v.*,
      CASE
        WHEN p_lat IS NOT NULL AND p_lng IS NOT NULL
             AND v.home_base_lat IS NOT NULL AND v.home_base_lng IS NOT NULL
        THEN 3959 * 2 * asin(sqrt(
             power(sin(radians((v.home_base_lat - p_lat)/2)), 2)
           + cos(radians(p_lat)) * cos(radians(v.home_base_lat))
             * power(sin(radians((v.home_base_lng - p_lng)/2)), 2)
        ))
        ELSE NULL
      END AS distance_miles,
      CASE
        WHEN p_zip IS NOT NULL AND length(p_zip) >= 3
             AND array_length(v.service_zip_prefixes, 1) > 0
             AND left(p_zip, 3) = ANY(v.service_zip_prefixes)
        THEN true ELSE false
      END AS zip_prefix_match
    FROM contractor_directory_view v
    WHERE v.is_directory_listed = true
      AND v.directory_opt_in = true
      AND v.tier = 'pro'
      AND v.avg_rating >= COALESCE(p_min_rating, 0)
      AND (p_trades IS NULL OR array_length(p_trades,1) IS NULL OR v.trades && p_trades)
      AND (p_states IS NULL OR array_length(p_states,1) IS NULL OR v.service_states && p_states)
      AND (p_search IS NULL OR p_search = ''
           OR v.display_name ILIKE '%'||p_search||'%'
           OR v.bio ILIKE '%'||p_search||'%')
  ),
  filtered AS (
    SELECT * FROM base
    WHERE
      -- If we have a homeowner location, keep rows that either:
      --   (a) match ZIP prefix, or
      --   (b) are within their service_radius_miles, or
      --   (c) have no service-area configured (fallback)
      (p_zip IS NULL AND p_lat IS NULL)
      OR zip_prefix_match
      OR (distance_miles IS NOT NULL
          AND service_radius_miles IS NOT NULL
          AND distance_miles <= service_radius_miles)
      OR (array_length(service_zip_prefixes,1) IS NULL
          AND service_radius_miles IS NULL)
  ),
  counted AS (
    SELECT f.*, count(*) OVER () AS total_count FROM filtered f
  )
  SELECT
    id, display_name, bio, trades, service_states, service_zip_prefixes,
    service_radius_miles, tier, avg_rating, review_count, jobs_count,
    created_at, distance_miles, zip_prefix_match, total_count
  FROM counted
  ORDER BY
    zip_prefix_match DESC,
    CASE WHEN p_sort = 'rating' THEN avg_rating END DESC NULLS LAST,
    CASE WHEN p_sort = 'rating' THEN review_count END DESC NULLS LAST,
    CASE WHEN p_sort = 'jobs'   THEN jobs_count END DESC NULLS LAST,
    CASE WHEN p_sort = 'recent' THEN created_at END DESC NULLS LAST,
    distance_miles ASC NULLS LAST
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 24), 60))
  OFFSET GREATEST(0, COALESCE(p_offset, 0));
$$;

GRANT EXECUTE ON FUNCTION public.search_public_contractors(text, numeric, numeric, text[], text[], numeric, text, text, integer, integer)
  TO anon, authenticated, service_role;
