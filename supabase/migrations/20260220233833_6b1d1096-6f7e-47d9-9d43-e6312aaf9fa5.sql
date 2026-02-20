
-- =============================================
-- WAR ROOM 2.0: Schema Migration
-- =============================================

-- 1A. Extend claim_strategic_insights with new columns
ALTER TABLE public.claim_strategic_insights
  ADD COLUMN IF NOT EXISTS procedural_compliance_score INTEGER,
  ADD COLUMN IF NOT EXISTS carrier_conduct_risk_score INTEGER,
  ADD COLUMN IF NOT EXISTS wsi_score INTEGER,
  ADD COLUMN IF NOT EXISTS wsi_components JSONB,
  ADD COLUMN IF NOT EXISTS litigation_readiness_score INTEGER,
  ADD COLUMN IF NOT EXISTS litigation_readiness_factors JSONB,
  ADD COLUMN IF NOT EXISTS pressure_index_score INTEGER,
  ADD COLUMN IF NOT EXISTS pressure_index_level TEXT,
  ADD COLUMN IF NOT EXISTS pressure_index_factors JSONB,
  ADD COLUMN IF NOT EXISTS strategic_memo JSONB,
  ADD COLUMN IF NOT EXISTS predicted_carrier_move JSONB,
  ADD COLUMN IF NOT EXISTS scenario_simulations JSONB;

-- 1B. New table: claim_predictive_analysis
CREATE TABLE IF NOT EXISTS public.claim_predictive_analysis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  prediction_type TEXT NOT NULL,
  prediction TEXT NOT NULL,
  confidence INTEGER DEFAULT 0,
  basis JSONB,
  predicted_timeline TEXT,
  actual_outcome TEXT,
  was_accurate BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

ALTER TABLE public.claim_predictive_analysis ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view predictive analysis"
  ON public.claim_predictive_analysis FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert predictive analysis"
  ON public.claim_predictive_analysis FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update predictive analysis"
  ON public.claim_predictive_analysis FOR UPDATE
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete predictive analysis"
  ON public.claim_predictive_analysis FOR DELETE
  USING (auth.uid() IS NOT NULL);

CREATE INDEX idx_claim_predictive_analysis_claim_id ON public.claim_predictive_analysis(claim_id);

-- 1C. New table: carrier_behavior_analytics
CREATE TABLE IF NOT EXISTS public.carrier_behavior_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  carrier_name TEXT NOT NULL UNIQUE,
  total_claims_analyzed INTEGER DEFAULT 0,
  avg_days_to_deny NUMERIC,
  avg_days_to_pay NUMERIC,
  initial_denial_rate NUMERIC,
  most_common_denial_reasons JSONB,
  reversal_rate_after_engineer NUMERIC,
  reversal_rate_after_supplement NUMERIC,
  litigation_frequency NUMERIC,
  avg_first_offer_vs_final NUMERIC,
  last_computed_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.carrier_behavior_analytics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view carrier analytics"
  ON public.carrier_behavior_analytics FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert carrier analytics"
  ON public.carrier_behavior_analytics FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update carrier analytics"
  ON public.carrier_behavior_analytics FOR UPDATE
  USING (auth.uid() IS NOT NULL);

CREATE INDEX idx_carrier_behavior_analytics_name ON public.carrier_behavior_analytics(carrier_name);

-- 1D. New table: claim_scenario_simulations
CREATE TABLE IF NOT EXISTS public.claim_scenario_simulations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  scenario_action TEXT NOT NULL,
  scenario_label TEXT NOT NULL,
  result_wsi INTEGER,
  result_litigation_readiness INTEGER,
  result_pressure_index INTEGER,
  result_win_probability_range TEXT,
  result_explanation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.claim_scenario_simulations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view scenario simulations"
  ON public.claim_scenario_simulations FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert scenario simulations"
  ON public.claim_scenario_simulations FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update scenario simulations"
  ON public.claim_scenario_simulations FOR UPDATE
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete scenario simulations"
  ON public.claim_scenario_simulations FOR DELETE
  USING (auth.uid() IS NOT NULL);

CREATE INDEX idx_claim_scenario_simulations_claim_id ON public.claim_scenario_simulations(claim_id);
