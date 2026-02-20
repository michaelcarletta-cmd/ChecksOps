
-- War Room 3.0: Closed-Loop Intelligence Schema

-- 1. Extend claim_outcomes with strategic snapshots
ALTER TABLE public.claim_outcomes
  ADD COLUMN IF NOT EXISTS total_claimed_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS litigation_filed BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS bad_faith_alleged BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS carrier_reversal_occurred BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS final_pressure_index INTEGER,
  ADD COLUMN IF NOT EXISTS final_wsi INTEGER,
  ADD COLUMN IF NOT EXISTS final_litigation_readiness INTEGER,
  ADD COLUMN IF NOT EXISTS predicted_carrier_move_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS prediction_accuracy_flag BOOLEAN;

-- 2. Extend claim_strategic_insights with confidence & raw inputs
ALTER TABLE public.claim_strategic_insights
  ADD COLUMN IF NOT EXISTS confidence_scores JSONB,
  ADD COLUMN IF NOT EXISTS raw_inputs JSONB,
  ADD COLUMN IF NOT EXISTS weight_version TEXT DEFAULT 'v1',
  ADD COLUMN IF NOT EXISTS model_type TEXT DEFAULT 'hybrid';

-- 3. Prediction accuracy metrics
CREATE TABLE IF NOT EXISTS public.prediction_accuracy_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID REFERENCES public.claims(id) ON DELETE CASCADE,
  prediction_id UUID REFERENCES public.claim_predictive_analysis(id) ON DELETE SET NULL,
  predicted_move TEXT NOT NULL,
  actual_move TEXT,
  match BOOLEAN,
  days_difference INTEGER,
  confidence_at_prediction INTEGER,
  carrier_name TEXT,
  claim_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

ALTER TABLE public.prediction_accuracy_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read prediction metrics"
  ON public.prediction_accuracy_metrics FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert prediction metrics"
  ON public.prediction_accuracy_metrics FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated users can update prediction metrics"
  ON public.prediction_accuracy_metrics FOR UPDATE TO authenticated USING (true);

-- 4. Strategic snapshots (posture over time)
CREATE TABLE IF NOT EXISTS public.claim_strategic_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  wsi INTEGER,
  pressure_index INTEGER,
  pressure_level TEXT,
  litigation_readiness INTEGER,
  predicted_move JSONB,
  confidence_scores JSONB,
  raw_inputs JSONB,
  weight_version TEXT DEFAULT 'v1',
  strategic_drift_flag BOOLEAN DEFAULT false,
  drift_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.claim_strategic_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read snapshots"
  ON public.claim_strategic_snapshots FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert snapshots"
  ON public.claim_strategic_snapshots FOR INSERT TO authenticated WITH CHECK (true);

CREATE INDEX idx_strategic_snapshots_claim ON public.claim_strategic_snapshots(claim_id, created_at DESC);

-- 5. Scenario accuracy metrics
CREATE TABLE IF NOT EXISTS public.scenario_accuracy_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id UUID NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  scenario_simulation_id UUID REFERENCES public.claim_scenario_simulations(id) ON DELETE SET NULL,
  scenario_action TEXT NOT NULL,
  projected_wsi_delta INTEGER,
  projected_litigation_delta INTEGER,
  projected_pressure_delta INTEGER,
  actual_wsi_delta INTEGER,
  actual_litigation_delta INTEGER,
  actual_pressure_delta INTEGER,
  variance_wsi INTEGER,
  variance_litigation INTEGER,
  variance_pressure INTEGER,
  action_executed_at TIMESTAMPTZ,
  outcome_measured_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.scenario_accuracy_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read scenario metrics"
  ON public.scenario_accuracy_metrics FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can manage scenario metrics"
  ON public.scenario_accuracy_metrics FOR ALL TO authenticated USING (true);

-- 6. Strategic weight versions
CREATE TABLE IF NOT EXISTS public.strategic_weight_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_name TEXT NOT NULL UNIQUE,
  coverage_weight INTEGER NOT NULL DEFAULT 25,
  evidence_weight INTEGER NOT NULL DEFAULT 25,
  leverage_weight INTEGER NOT NULL DEFAULT 20,
  compliance_weight INTEGER NOT NULL DEFAULT 15,
  carrier_risk_weight INTEGER NOT NULL DEFAULT 15,
  effective_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.strategic_weight_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read weight versions"
  ON public.strategic_weight_versions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage weight versions"
  ON public.strategic_weight_versions FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Insert default weight version
INSERT INTO public.strategic_weight_versions (version_name, coverage_weight, evidence_weight, leverage_weight, compliance_weight, carrier_risk_weight, notes)
VALUES ('v1', 25, 25, 20, 15, 15, 'Initial default weights from War Room 2.0')
ON CONFLICT (version_name) DO NOTHING;

-- 7. Add confidence fields to claim_predictive_analysis
ALTER TABLE public.claim_predictive_analysis
  ADD COLUMN IF NOT EXISTS data_basis_count INTEGER,
  ADD COLUMN IF NOT EXISTS model_type TEXT DEFAULT 'hybrid';

-- 8. Add confidence to claim_scenario_simulations
ALTER TABLE public.claim_scenario_simulations
  ADD COLUMN IF NOT EXISTS confidence_score INTEGER,
  ADD COLUMN IF NOT EXISTS data_basis_count INTEGER,
  ADD COLUMN IF NOT EXISTS model_type TEXT DEFAULT 'hybrid',
  ADD COLUMN IF NOT EXISTS projected_wsi_delta INTEGER,
  ADD COLUMN IF NOT EXISTS projected_litigation_delta INTEGER,
  ADD COLUMN IF NOT EXISTS projected_pressure_delta INTEGER;
