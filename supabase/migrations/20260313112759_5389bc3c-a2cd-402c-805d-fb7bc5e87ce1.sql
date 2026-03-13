
CREATE TABLE public.claim_intelligence_summary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id uuid REFERENCES public.claims(id) ON DELETE CASCADE NOT NULL,
  most_important_issue text,
  strongest_evidence jsonb DEFAULT '[]'::jsonb,
  largest_recovery_opportunity jsonb DEFAULT '{}'::jsonb,
  carrier_weakest_argument jsonb DEFAULT '{}'::jsonb,
  recommended_next_action jsonb DEFAULT '{}'::jsonb,
  missing_evidence jsonb DEFAULT '[]'::jsonb,
  confidence_score numeric DEFAULT 0,
  confidence_factors jsonb DEFAULT '{}'::jsonb,
  intelligence_sources jsonb DEFAULT '{}'::jsonb,
  raw_summary text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(claim_id)
);

ALTER TABLE public.claim_intelligence_summary ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read intelligence summaries"
  ON public.claim_intelligence_summary FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert intelligence summaries"
  ON public.claim_intelligence_summary FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update intelligence summaries"
  ON public.claim_intelligence_summary FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access to intelligence summaries"
  ON public.claim_intelligence_summary FOR ALL TO service_role USING (true) WITH CHECK (true);
