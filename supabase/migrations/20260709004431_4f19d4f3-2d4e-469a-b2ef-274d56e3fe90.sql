CREATE TABLE public.homeowner_directory_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  zip text NOT NULL,
  contractor_id uuid REFERENCES public.contractor_profiles(id) ON DELETE SET NULL,
  action text NOT NULL DEFAULT 'browse',
  user_agent text,
  referrer text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT INSERT ON public.homeowner_directory_leads TO anon, authenticated;
GRANT ALL ON public.homeowner_directory_leads TO service_role;

ALTER TABLE public.homeowner_directory_leads ENABLE ROW LEVEL SECURITY;

-- Anyone can insert a lead (public form), but no one can read
CREATE POLICY "Anyone can submit a homeowner lead"
  ON public.homeowner_directory_leads
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE INDEX idx_homeowner_leads_email ON public.homeowner_directory_leads(email);
CREATE INDEX idx_homeowner_leads_created ON public.homeowner_directory_leads(created_at DESC);