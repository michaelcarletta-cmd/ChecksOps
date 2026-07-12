
ALTER TABLE public.contractor_profiles
  ADD COLUMN IF NOT EXISTS google_place_id text,
  ADD COLUMN IF NOT EXISTS google_business_name text,
  ADD COLUMN IF NOT EXISTS google_rating numeric(2,1),
  ADD COLUMN IF NOT EXISTS google_review_count integer,
  ADD COLUMN IF NOT EXISTS google_reviews jsonb,
  ADD COLUMN IF NOT EXISTS google_reviews_url text,
  ADD COLUMN IF NOT EXISTS google_reviews_synced_at timestamptz;
