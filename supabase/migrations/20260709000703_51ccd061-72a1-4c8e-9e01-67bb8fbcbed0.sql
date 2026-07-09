
-- ============================================================
-- contractor_profiles
-- ============================================================
CREATE TABLE public.contractor_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  bio text,
  trades text[] NOT NULL DEFAULT '{}',
  service_states text[] NOT NULL DEFAULT '{}',
  service_metros text[] NOT NULL DEFAULT '{}',
  license_number text,
  coi_expires_at date,
  avatar_url text,
  tier text NOT NULL DEFAULT 'guest' CHECK (tier IN ('guest','verified','pro')),
  is_directory_listed boolean NOT NULL DEFAULT false,
  directory_opt_in boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX contractor_profiles_directory_idx
  ON public.contractor_profiles (is_directory_listed, directory_opt_in, tier);
CREATE INDEX contractor_profiles_trades_idx
  ON public.contractor_profiles USING GIN (trades);
CREATE INDEX contractor_profiles_states_idx
  ON public.contractor_profiles USING GIN (service_states);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contractor_profiles TO authenticated;
GRANT ALL ON public.contractor_profiles TO service_role;

ALTER TABLE public.contractor_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Directory profiles readable by authenticated"
  ON public.contractor_profiles FOR SELECT
  TO authenticated
  USING (
    (is_directory_listed = true AND directory_opt_in = true)
    OR user_id = auth.uid()
    OR public.has_role(auth.uid(), 'admin')
  );

CREATE POLICY "Contractor manages own profile"
  ON public.contractor_profiles FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Admin manages any profile"
  ON public.contractor_profiles FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER contractor_profiles_updated_at
  BEFORE UPDATE ON public.contractor_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- contractor_reviews
-- ============================================================
CREATE TABLE public.contractor_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL REFERENCES public.contractor_profiles(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  claim_id uuid REFERENCES public.claims(id) ON DELETE SET NULL,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX contractor_reviews_contractor_idx ON public.contractor_reviews(contractor_id);
CREATE UNIQUE INDEX contractor_reviews_one_per_org_claim_idx
  ON public.contractor_reviews(contractor_id, org_id, claim_id)
  WHERE claim_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contractor_reviews TO authenticated;
GRANT ALL ON public.contractor_reviews TO service_role;

ALTER TABLE public.contractor_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Read reviews for directory contractors"
  ON public.contractor_reviews FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.contractor_profiles cp
      WHERE cp.id = contractor_reviews.contractor_id
        AND cp.is_directory_listed = true
        AND cp.directory_opt_in = true
    )
    OR public.has_role(auth.uid(), 'admin')
  );

CREATE POLICY "Org members can create reviews for their contractors"
  ON public.contractor_reviews FOR INSERT
  TO authenticated
  WITH CHECK (
    author_user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = contractor_reviews.org_id
        AND om.user_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1
      FROM public.claim_contractors cc
      JOIN public.claims c ON c.id = cc.claim_id
      JOIN public.contractor_profiles cp ON cp.id = contractor_reviews.contractor_id
      WHERE cc.contractor_id = cp.user_id
        AND c.org_id = contractor_reviews.org_id
    )
  );

CREATE POLICY "Authors update own reviews"
  ON public.contractor_reviews FOR UPDATE
  TO authenticated
  USING (author_user_id = auth.uid())
  WITH CHECK (author_user_id = auth.uid());

CREATE POLICY "Authors or admin delete reviews"
  ON public.contractor_reviews FOR DELETE
  TO authenticated
  USING (author_user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER contractor_reviews_updated_at
  BEFORE UPDATE ON public.contractor_reviews
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- contractor_claim_invites
-- ============================================================
CREATE TABLE public.contractor_claim_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id uuid NOT NULL REFERENCES public.contractor_profiles(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  invited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','expired','cancelled')),
  token text NOT NULL UNIQUE DEFAULT encode(extensions.gen_random_bytes(24), 'hex'),
  message text,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX contractor_claim_invites_pending_unique_idx
  ON public.contractor_claim_invites(contractor_id, claim_id)
  WHERE status = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contractor_claim_invites TO authenticated;
GRANT ALL ON public.contractor_claim_invites TO service_role;

ALTER TABLE public.contractor_claim_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members or contractor read invites"
  ON public.contractor_claim_invites FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = contractor_claim_invites.org_id
        AND om.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.contractor_profiles cp
      WHERE cp.id = contractor_claim_invites.contractor_id
        AND cp.user_id = auth.uid()
    )
    OR public.has_role(auth.uid(), 'admin')
  );

CREATE POLICY "Org members create invites"
  ON public.contractor_claim_invites FOR INSERT
  TO authenticated
  WITH CHECK (
    invited_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
      WHERE om.org_id = contractor_claim_invites.org_id
        AND om.user_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM public.claims c
      WHERE c.id = contractor_claim_invites.claim_id
        AND c.org_id = contractor_claim_invites.org_id
    )
  );

CREATE POLICY "Inviter, contractor, or admin updates invite"
  ON public.contractor_claim_invites FOR UPDATE
  TO authenticated
  USING (
    invited_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.contractor_profiles cp
      WHERE cp.id = contractor_claim_invites.contractor_id
        AND cp.user_id = auth.uid()
    )
    OR public.has_role(auth.uid(), 'admin')
  );

CREATE TRIGGER contractor_claim_invites_updated_at
  BEFORE UPDATE ON public.contractor_claim_invites
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- contractor_directory_view
-- ============================================================
CREATE OR REPLACE VIEW public.contractor_directory_view
WITH (security_invoker = true) AS
SELECT
  cp.id,
  cp.user_id,
  cp.display_name,
  cp.bio,
  cp.trades,
  cp.service_states,
  cp.service_metros,
  cp.license_number,
  cp.coi_expires_at,
  cp.avatar_url,
  cp.tier,
  cp.is_directory_listed,
  cp.directory_opt_in,
  COALESCE(jobs.jobs_count, 0)::int AS jobs_count,
  COALESCE(reviews.avg_rating, 0)::numeric(3,2) AS avg_rating,
  COALESCE(reviews.review_count, 0)::int AS review_count,
  cp.created_at,
  cp.updated_at
FROM public.contractor_profiles cp
LEFT JOIN LATERAL (
  SELECT COUNT(*)::int AS jobs_count
  FROM public.claim_contractors cc
  WHERE cc.contractor_id = cp.user_id
) jobs ON true
LEFT JOIN LATERAL (
  SELECT AVG(r.rating)::numeric AS avg_rating, COUNT(*)::int AS review_count
  FROM public.contractor_reviews r
  WHERE r.contractor_id = cp.id
) reviews ON true;

GRANT SELECT ON public.contractor_directory_view TO authenticated;
GRANT SELECT ON public.contractor_directory_view TO service_role;
