
-- 1. Homeowner check uploads
CREATE TABLE public.homeowner_check_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES public.homeowner_intro_requests(id) ON DELETE SET NULL,
  contractor_profile_id uuid NOT NULL REFERENCES public.contractor_profiles(id) ON DELETE CASCADE,
  contractor_user_id uuid NOT NULL,
  homeowner_email text NOT NULL,
  homeowner_user_id uuid,
  file_path text NOT NULL,
  file_mime text,
  note text,
  status text NOT NULL DEFAULT 'pending',
  converted_check_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_hcu_contractor ON public.homeowner_check_uploads (contractor_user_id, created_at DESC);
CREATE INDEX idx_hcu_homeowner_email ON public.homeowner_check_uploads (lower(homeowner_email), created_at DESC);
CREATE INDEX idx_hcu_lead ON public.homeowner_check_uploads (lead_id);

GRANT SELECT, INSERT, UPDATE ON public.homeowner_check_uploads TO authenticated;
GRANT ALL ON public.homeowner_check_uploads TO service_role;

ALTER TABLE public.homeowner_check_uploads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Contractor reads own uploads"
  ON public.homeowner_check_uploads
  FOR SELECT TO authenticated
  USING (contractor_user_id = auth.uid());

CREATE POLICY "Contractor updates own uploads"
  ON public.homeowner_check_uploads
  FOR UPDATE TO authenticated
  USING (contractor_user_id = auth.uid())
  WITH CHECK (contractor_user_id = auth.uid());

CREATE POLICY "Homeowner reads own uploads by email"
  ON public.homeowner_check_uploads
  FOR SELECT TO authenticated
  USING (lower(homeowner_email) = lower(coalesce(auth.jwt() ->> 'email', '')));

CREATE TRIGGER trg_hcu_updated_at
  BEFORE UPDATE ON public.homeowner_check_uploads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Let a signed-in homeowner view their own intro request (matched by email)
CREATE POLICY "Homeowner reads own intro request by email"
  ON public.homeowner_intro_requests
  FOR SELECT TO authenticated
  USING (lower(homeowner_email) = lower(coalesce(auth.jwt() ->> 'email', '')));
