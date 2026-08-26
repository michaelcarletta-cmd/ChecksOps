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
  0::integer AS jobs_count,
  (COALESCE(reviews.avg_rating, 0::numeric))::numeric(3,2) AS avg_rating,
  COALESCE(reviews.review_count, 0) AS review_count,
  cp.created_at,
  cp.updated_at
FROM public.contractor_profiles cp
LEFT JOIN LATERAL (
  SELECT avg(r.rating) AS avg_rating, count(*)::integer AS review_count
  FROM public.contractor_reviews r
  WHERE r.contractor_id = cp.id
) reviews ON true;

GRANT SELECT ON public.contractor_directory_view TO anon, authenticated, service_role;