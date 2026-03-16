
CREATE TABLE public.claim_normal_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  label TEXT NOT NULL,
  monthly_amount NUMERIC NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  UNIQUE(claim_id, category)
);

ALTER TABLE public.claim_normal_bills ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view normal bills"
ON public.claim_normal_bills FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert normal bills"
ON public.claim_normal_bills FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update normal bills"
ON public.claim_normal_bills FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated users can delete normal bills"
ON public.claim_normal_bills FOR DELETE TO authenticated USING (true);
