CREATE TABLE public.claim_additional_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

ALTER TABLE public.claim_additional_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage claim additional contacts"
  ON public.claim_additional_contacts
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);