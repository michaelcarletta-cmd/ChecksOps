
CREATE TABLE public.mortgage_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  check_id UUID REFERENCES public.claim_checks(id) ON DELETE SET NULL,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  release_date DATE NOT NULL,
  release_method TEXT DEFAULT 'check',
  mortgage_company_name TEXT,
  reference_number TEXT,
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.mortgage_releases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage mortgage releases"
ON public.mortgage_releases FOR ALL TO authenticated
USING (true) WITH CHECK (true);
