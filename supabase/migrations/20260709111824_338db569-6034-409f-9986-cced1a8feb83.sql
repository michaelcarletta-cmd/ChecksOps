
CREATE TABLE public.homeowner_intro_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_profile_id uuid NOT NULL REFERENCES public.contractor_profiles(id) ON DELETE CASCADE,
  contractor_user_id uuid NOT NULL,
  homeowner_name text NOT NULL,
  homeowner_email text NOT NULL,
  homeowner_phone text,
  property_zip text,
  loss_type text,
  message text,
  status text NOT NULL DEFAULT 'new',
  contacted_at timestamptz,
  source text NOT NULL DEFAULT 'find_a_pro',
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_hir_contractor ON public.homeowner_intro_requests (contractor_user_id, created_at DESC);
CREATE INDEX idx_hir_profile ON public.homeowner_intro_requests (contractor_profile_id, created_at DESC);

GRANT SELECT, UPDATE ON public.homeowner_intro_requests TO authenticated;
GRANT INSERT ON public.homeowner_intro_requests TO anon, authenticated;
GRANT ALL ON public.homeowner_intro_requests TO service_role;

ALTER TABLE public.homeowner_intro_requests ENABLE ROW LEVEL SECURITY;

-- Anyone (including anonymous homeowners on the public directory) can submit an intro request,
-- but only against a profile that is currently published to the directory.
CREATE POLICY "Public can submit intro requests to listed pros"
  ON public.homeowner_intro_requests
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.contractor_profiles cp
      WHERE cp.id = contractor_profile_id
        AND cp.user_id = contractor_user_id
        AND cp.is_directory_listed = true
        AND cp.directory_opt_in = true
    )
  );

-- Contractors read/update only their own leads.
CREATE POLICY "Contractors read own leads"
  ON public.homeowner_intro_requests
  FOR SELECT
  TO authenticated
  USING (contractor_user_id = auth.uid());

CREATE POLICY "Contractors update own leads"
  ON public.homeowner_intro_requests
  FOR UPDATE
  TO authenticated
  USING (contractor_user_id = auth.uid())
  WITH CHECK (contractor_user_id = auth.uid());

CREATE TRIGGER trg_hir_updated_at
  BEFORE UPDATE ON public.homeowner_intro_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
