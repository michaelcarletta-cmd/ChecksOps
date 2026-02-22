
-- Table to store Darwin health check results
CREATE TABLE public.darwin_health_checks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unknown',
  result JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID
);

ALTER TABLE public.darwin_health_checks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage health checks"
ON public.darwin_health_checks FOR ALL
USING (
  EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role IN ('admin','staff'))
);

CREATE INDEX idx_darwin_health_checks_claim ON public.darwin_health_checks(claim_id);
